import 'dotenv/config';
import {
    initPool,
    closePool,
    countDocuments,
    getDocumentsBatch,
    getAttachments,
} from './oracle-db.js';
import {
    extractTextFromFile,
    analyzeDocument,
    embedTexts,
    isRefusal,
} from './openai.js';
import {
    ensureTable,
    upsertDocument,
    upsertChunks,
} from './supabase.js';

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);
const MAX_DOCUMENTS = parseInt(process.env.MAX_DOCUMENTS || '0', 10);

// ---------------------------------------------------------------------------
// Pipeline di ingestion per un singolo documento
// ---------------------------------------------------------------------------

async function processDocument(doc) {
    const docName = doc.NOME_FILE;
    const mimeType = doc.MIME_TYPE || 'application/octet-stream';
    const fileBuffer = doc.FILE_CONTENT;

    console.log(`\n--- [${docName}] Inizio (${mimeType}, ${doc.DOC_SIZE || '?'} bytes) ---`);

    // 1. Estrai testo dal file
    console.log(`  [1/4] Estrazione testo...`);
    let extractedText;
    try {
        extractedText = await extractTextFromFile(fileBuffer, mimeType, docName);
    } catch (err) {
        console.error(`  [ERRORE] Estrazione fallita:`, err.message);
        extractedText = '';
    }

    if (isRefusal(extractedText)) {
        console.warn(`  [WARN] Estrazione rifiutata, uso metadati DB come fallback`);
        extractedText = buildFallbackText(doc);
    }
    console.log(`  [1/4] Testo: ${extractedText.length} caratteri`);

    // 2. Analisi completa con LLM (tipo, metadati, profilo semantico, chunk)
    console.log(`  [2/4] Analisi documento con LLM...`);
    const dbMetadata = {
        NOME_FILE: docName,
        DESCRIZIONE: doc.DESCRIZIONE,
        TIPO_DOCUMENTO: doc.TIPO_DOCUMENTO,
        DATA_INSERIMENTO: doc.DATA_INSERIMENTO,
        DATA_DOCUMENTO: doc.DATA_DOCUMENTO,
        UTENTE: doc.UTENTE,
        SOCIETA: doc.SOCIETA,
        ABSTRACT: doc.ABSTRACT,
    };

    let analysis;
    try {
        analysis = await analyzeDocument(extractedText, dbMetadata);
    } catch (err) {
        console.error(`  [ERRORE] Analisi fallita:`, err.message);
        analysis = {
            tipo_documento: 'altro',
            semantic_profile: doc.DESCRIZIONE || docName,
            metadata: {},
            chunks: [{ type: 'contenuto', summary: doc.DESCRIZIONE || docName, text: extractedText }],
        };
    }

    console.log(`  [2/4] Tipo: ${analysis.tipo_documento}, ${analysis.chunks.length} chunk, profilo: "${(analysis.semantic_profile || '').substring(0, 80)}..."`);

    // 3. Embedding di ogni chunk (batch)
    console.log(`  [3/4] Embedding ${analysis.chunks.length} chunk...`);
    const chunkTexts = analysis.chunks.map(chunk =>
        buildChunkEmbeddingText(chunk, analysis)
    );

    let embeddings;
    try {
        embeddings = await embedTexts(chunkTexts);
    } catch (err) {
        console.error(`  [ERRORE] Embedding fallito:`, err.message);
        return null;
    }

    const embeddedChunks = analysis.chunks.map((chunk, i) => ({
        ...chunk,
        embedding: embeddings[i],
    }));
    console.log(`  [3/4] ${embeddings.length} embedding (${embeddings[0]?.length} dims)`);

    // 4. Salva in Supabase
    console.log(`  [4/4] Salvataggio...`);
    try {
        await upsertDocument({
            id: docName,
            metadata: analysis.metadata || {},
            semanticProfile: analysis.semantic_profile || '',
        });
        await upsertChunks(docName, embeddedChunks);
    } catch (err) {
        console.error(`  [ERRORE] Salvataggio fallito:`, err.message);
        return null;
    }
    console.log(`  [4/4] Salvato: ${embeddedChunks.length} chunk`);

    // Processa allegati
    try {
        const attachments = await getAttachments(docName);
        if (attachments.length > 0) {
            console.log(`  [+] ${attachments.length} allegati...`);
            for (const att of attachments) {
                await processDocument({
                    ...att,
                    SOCIETA: doc.SOCIETA,
                    DATA_INSERIMENTO: doc.DATA_INSERIMENTO,
                    DATA_DOCUMENTO: doc.DATA_DOCUMENTO,
                    DATA_RIFERIMENTO: doc.DATA_RIFERIMENTO,
                    UTENTE: doc.UTENTE,
                    ABSTRACT: '',
                    FLAG_ALLEGATO: 'S',
                    LIVELLO_RISERVATEZZA: doc.LIVELLO_RISERVATEZZA,
                });
            }
        }
    } catch (err) {
        console.warn(`  [WARN] Allegati per ${docName}:`, err.message);
    }

    console.log(`--- [${docName}] OK (${embeddedChunks.length} chunk) ---`);
    return { docName, chunksCount: embeddedChunks.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log('=== DocLight AI - Ingestion Pipeline ===');
    console.log(`Batch: ${BATCH_SIZE}, Max: ${MAX_DOCUMENTS || 'tutti'}\n`);

    await initPool();
    await ensureTable();

    const totalInDb = await countDocuments();
    const totalDocs = MAX_DOCUMENTS > 0 ? Math.min(MAX_DOCUMENTS, totalInDb) : totalInDb;
    console.log(`Documenti in DB: ${totalInDb}, da elaborare: ${totalDocs}`);

    let processed = 0, errors = 0, totalChunks = 0, offset = 0;

    while (offset < totalDocs) {
        const batchSize = Math.min(BATCH_SIZE, totalDocs - offset);
        console.log(`\n========== Batch ${Math.floor(offset / BATCH_SIZE) + 1} (offset: ${offset}) ==========`);

        const batch = await getDocumentsBatch({ offset, limit: batchSize });
        if (batch.length === 0) break;

        for (const doc of batch) {
            try {
                const result = await processDocument(doc);
                if (result) { processed++; totalChunks += result.chunksCount; }
                else errors++;
            } catch (err) {
                console.error(`[FATALE] ${doc.NOME_FILE}:`, err);
                errors++;
            }
        }

        offset += batchSize;
        console.log(`\nProgresso: ${processed} doc (${totalChunks} chunk), ${errors} errori, ${offset}/${totalDocs}`);
    }

    await closePool();
    console.log(`\n=== Completato: ${processed} doc, ${totalChunks} chunk, ${errors} errori ===`);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function buildFallbackText(doc) {
    const parts = [];
    if (doc.DESCRIZIONE) parts.push(doc.DESCRIZIONE);
    if (doc.ABSTRACT) parts.push(doc.ABSTRACT);
    if (doc.TIPO_DOCUMENTO) parts.push(`Tipo: ${doc.TIPO_DOCUMENTO}`);
    if (doc.NOME_FILE) parts.push(`File: ${doc.NOME_FILE}`);
    return parts.join('\n') || '[Contenuto non disponibile]';
}

/**
 * Costruisce il testo per l'embedding di un chunk.
 * Prepende il contesto del documento per dare significato al chunk anche in isolamento.
 */
function buildChunkEmbeddingText(chunk, analysis) {
    const context = [];
    if (analysis.tipo_documento) context.push(`Tipo: ${analysis.tipo_documento}`);
    if (analysis.metadata?.emittente?.ragione_sociale) context.push(`Emittente: ${analysis.metadata.emittente.ragione_sociale}`);
    if (analysis.metadata?.destinatario?.ragione_sociale) context.push(`Destinatario: ${analysis.metadata.destinatario.ragione_sociale}`);
    if (analysis.metadata?.data_documento) context.push(`Data: ${analysis.metadata.data_documento}`);
    if (analysis.metadata?.oggetto) context.push(`Oggetto: ${analysis.metadata.oggetto}`);
    if (analysis.metadata?.parole_chiave?.length) context.push(`Keywords: ${analysis.metadata.parole_chiave.join(', ')}`);

    const parts = [];
    if (context.length) parts.push(`[${context.join(' | ')}]`);
    if (chunk.summary) parts.push(chunk.summary);
    if (chunk.text) parts.push(chunk.text.substring(0, 18000));

    return parts.filter(Boolean).join('\n\n');
}

main().catch(err => {
    console.error('Errore fatale:', err);
    process.exit(1);
});
