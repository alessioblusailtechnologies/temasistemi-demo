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
    generateSemanticProfile,
    extractStructuredMetadata,
    embedText,
} from './openai.js';
import {
    ensureCollection,
    upsertDocument,
} from './qdrant.js';

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10);
const MAX_DOCUMENTS = parseInt(process.env.MAX_DOCUMENTS || '0', 10); // 0 = tutti

// ---------------------------------------------------------------------------
// Pipeline di ingestion per un singolo documento
// ---------------------------------------------------------------------------

async function processDocument(doc) {
    const docName = doc.NOME_FILE;
    const mimeType = doc.MIME_TYPE || 'application/octet-stream';
    const fileBuffer = doc.FILE_CONTENT;

    console.log(`\n--- [${docName}] Inizio elaborazione (${mimeType}, ${doc.DOC_SIZE || '?'} bytes) ---`);

    // 1. Estrai testo dal contenuto binario
    console.log(`  [1/5] Estrazione testo...`);
    let extractedText;
    try {
        extractedText = await extractTextFromFile(fileBuffer, mimeType, docName);
    } catch (err) {
        console.error(`  [ERRORE] Estrazione testo fallita per ${docName}:`, err.message);
        extractedText = `[Errore estrazione: ${err.message}]`;
    }
    console.log(`  [1/5] Testo estratto: ${extractedText.length} caratteri`);

    // Metadati dal database Oracle
    const dbMetadata = {
        NOME_FILE: docName,
        DESCRIZIONE: doc.DESCRIZIONE,
        TIPO_DOCUMENTO: doc.TIPO_DOCUMENTO,
        DATA_INSERIMENTO: doc.DATA_INSERIMENTO,
        DATA_DOCUMENTO: doc.DATA_DOCUMENTO,
        DATA_RIFERIMENTO: doc.DATA_RIFERIMENTO,
        UTENTE: doc.UTENTE,
        SOCIETA: doc.SOCIETA,
        ABSTRACT: doc.ABSTRACT,
        FLAG_ALLEGATO: doc.FLAG_ALLEGATO,
        LIVELLO_RISERVATEZZA: doc.LIVELLO_RISERVATEZZA,
        MIME_TYPE: mimeType,
        DOC_SIZE: doc.DOC_SIZE,
        CONTENT_TYPE: doc.CONTENT_TYPE,
    };

    // 2. Genera profilo semantico
    console.log(`  [2/5] Generazione profilo semantico...`);
    let semanticProfile;
    try {
        semanticProfile = await generateSemanticProfile(extractedText, dbMetadata);
    } catch (err) {
        console.error(`  [ERRORE] Profilo semantico fallito:`, err.message);
        semanticProfile = doc.DESCRIZIONE || docName;
    }
    console.log(`  [2/5] Profilo: "${semanticProfile.substring(0, 100)}..."`);

    // 3. Estrai metadati strutturati
    console.log(`  [3/5] Estrazione metadati strutturati...`);
    let structuredMetadata;
    try {
        structuredMetadata = await extractStructuredMetadata(extractedText, dbMetadata);
    } catch (err) {
        console.error(`  [ERRORE] Estrazione metadati fallita:`, err.message);
        structuredMetadata = {};
    }
    console.log(`  [3/5] Metadati:`, JSON.stringify(structuredMetadata).substring(0, 200));

    // 4. Genera embedding dal profilo semantico
    console.log(`  [4/5] Generazione embedding...`);
    const textToEmbed = [
        semanticProfile,
        structuredMetadata.oggetto || '',
        (structuredMetadata.parole_chiave || []).join(', '),
    ].filter(Boolean).join('\n');

    let embedding;
    try {
        embedding = await embedText(textToEmbed);
    } catch (err) {
        console.error(`  [ERRORE] Embedding fallito:`, err.message);
        return null;
    }
    console.log(`  [4/5] Embedding generato: ${embedding.length} dimensioni`);

    // 5. Salva in Qdrant
    console.log(`  [5/5] Salvataggio in Qdrant...`);
    try {
        await upsertDocument({
            id: docName,
            vector: embedding,
            metadata: structuredMetadata,
            semanticProfile,
        });
    } catch (err) {
        console.error(`  [ERRORE] Salvataggio Qdrant fallito:`, err.message);
        return null;
    }
    console.log(`  [5/5] Salvato in Qdrant`);

    // 6. Processa eventuali allegati
    try {
        const attachments = await getAttachments(docName);
        if (attachments.length > 0) {
            console.log(`  [+] ${attachments.length} allegati trovati, elaborazione...`);
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
        console.warn(`  [WARN] Errore recupero allegati per ${docName}:`, err.message);
    }

    console.log(`--- [${docName}] Completato ---`);
    return { docName, semanticProfile, structuredMetadata };
}

// ---------------------------------------------------------------------------
// Main - Pipeline di ingestion batch
// ---------------------------------------------------------------------------

async function main() {
    console.log('=== DocLight AI Core - Ingestion Pipeline ===');
    console.log(`Batch size: ${BATCH_SIZE}, Max documenti: ${MAX_DOCUMENTS || 'tutti'}`);
    console.log('');

    // Inizializzazione
    await initPool();
    await ensureCollection();

    // Conta documenti
    const totalInDb = await countDocuments();
    const totalDocs = MAX_DOCUMENTS > 0 ? Math.min(MAX_DOCUMENTS, totalInDb) : totalInDb;
    console.log(`Documenti in DB: ${totalInDb}, da elaborare: ${totalDocs}`);

    let processed = 0;
    let errors = 0;
    let offset = 0;

    while (offset < totalDocs) {
        const currentBatchSize = Math.min(BATCH_SIZE, totalDocs - offset);
        console.log(`\n========== Batch ${Math.floor(offset / BATCH_SIZE) + 1} (offset: ${offset}) ==========`);

        const batch = await getDocumentsBatch({ offset, limit: currentBatchSize });

        if (batch.length === 0) {
            console.log('Nessun altro documento da elaborare.');
            break;
        }

        for (const doc of batch) {
            try {
                const result = await processDocument(doc);
                if (result) {
                    processed++;
                } else {
                    errors++;
                }
            } catch (err) {
                console.error(`[ERRORE FATALE] Documento ${doc.NOME_FILE}:`, err);
                errors++;
            }
        }

        offset += currentBatchSize;
        console.log(`\nProgresso: ${processed} elaborati, ${errors} errori, ${offset}/${totalDocs} processati`);
    }

    // Cleanup
    await closePool();

    console.log('\n=== Ingestion completata ===');
    console.log(`Totale elaborati: ${processed}`);
    console.log(`Totale errori: ${errors}`);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function formatDate(d) {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString().split('T')[0];
    return String(d);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch(err => {
    console.error('Errore fatale:', err);
    process.exit(1);
});
