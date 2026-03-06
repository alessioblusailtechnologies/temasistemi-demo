import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

let client = null;

export function getClient() {
    if (client) return client;
    client = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
    );
    return client;
}

// ---------------------------------------------------------------------------
// Verifica connessione
// ---------------------------------------------------------------------------

export async function ensureTable() {
    const sb = getClient();
    const { error: e1 } = await sb.from('doclight_documents').select('id').limit(1);
    if (e1) throw new Error(`[supabase] Tabella "doclight_documents" non trovata: ${e1.message}`);
    const { error: e2 } = await sb.from('doclight_chunks').select('id').limit(1);
    if (e2) throw new Error(`[supabase] Tabella "doclight_chunks" non trovata: ${e2.message}`);
    console.log('[supabase] Connessione OK');
}

// ---------------------------------------------------------------------------
// Upsert documento (solo metadati, no embedding)
// ---------------------------------------------------------------------------

export async function upsertDocument({ id, metadata, semanticProfile }) {
    const sb = getClient();
    const { error } = await sb.from('doclight_documents').upsert({
        id: stringToUuid(id),
        nome_file: id,
        metadata: metadata || {},
        semantic_profile: semanticProfile || '',
    }, { onConflict: 'nome_file' });

    if (error) {
        console.error(`[supabase] Upsert documento fallito per "${id}":`, error.message);
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Upsert chunk
// ---------------------------------------------------------------------------

export async function upsertChunks(nomeFile, chunks) {
    const sb = getClient();

    // Elimina chunk esistenti per questo documento
    await sb.from('doclight_chunks').delete().eq('nome_file', nomeFile);

    // Inserisci nuovi chunk in batch
    const rows = chunks.map((chunk, index) => ({
        nome_file: nomeFile,
        chunk_index: index,
        chunk_type: chunk.type || 'contenuto',
        chunk_summary: chunk.summary || '',
        chunk_text: chunk.text || '',
        embedding: JSON.stringify(chunk.embedding),
    }));

    for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await sb.from('doclight_chunks').insert(batch);
        if (error) {
            console.error(`[supabase] Insert chunk fallito per "${nomeFile}":`, error.message);
            throw error;
        }
    }
}

// ---------------------------------------------------------------------------
// Ricerca vettoriale pura
// ---------------------------------------------------------------------------

export async function searchDocuments(queryVector, topK = 20) {
    const sb = getClient();

    const { data, error } = await sb.rpc('match_chunks', {
        query_embedding: JSON.stringify(queryVector),
        match_threshold: 0.15,
        match_count: Math.min(topK * 4, 200),
    });

    if (error) {
        console.error('[supabase] Ricerca fallita:', error.message);
        throw error;
    }

    const results = data || [];

    // Raggruppa chunk per documento, prendi il miglior score
    const docMap = new Map();
    for (const chunk of results) {
        if (!docMap.has(chunk.nome_file)) {
            docMap.set(chunk.nome_file, {
                nome_file: chunk.nome_file,
                bestSimilarity: chunk.similarity,
                chunks: [],
            });
        }
        const doc = docMap.get(chunk.nome_file);
        if (chunk.similarity > doc.bestSimilarity) {
            doc.bestSimilarity = chunk.similarity;
        }
        doc.chunks.push({
            type: chunk.chunk_type,
            summary: chunk.chunk_summary,
            text: chunk.chunk_text,
            similarity: chunk.similarity,
        });
    }

    // Recupera metadati documento
    const docNames = [...docMap.keys()];
    if (docNames.length > 0) {
        const { data: docs } = await sb
            .from('doclight_documents')
            .select('nome_file, metadata, semantic_profile')
            .in('nome_file', docNames);

        if (docs) {
            for (const doc of docs) {
                const entry = docMap.get(doc.nome_file);
                if (entry) {
                    entry.metadata = doc.metadata || {};
                    entry.semanticProfile = doc.semantic_profile || '';
                }
            }
        }
    }

    // Ordina per miglior similarity e ritorna
    return [...docMap.values()]
        .sort((a, b) => b.bestSimilarity - a.bestSimilarity)
        .slice(0, topK)
        .map(r => ({
            nomeFile: r.nome_file,
            score: r.bestSimilarity,
            scorePercent: +(r.bestSimilarity * 100).toFixed(1),
            metadata: r.metadata || {},
            semanticProfile: r.semanticProfile || '',
            matchingChunks: r.chunks.slice(0, 3),
        }));
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function stringToUuid(str) {
    const hash = crypto.createHash('md5').update(str).digest('hex');
    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        '4' + hash.substring(13, 16),
        '8' + hash.substring(17, 20),
        hash.substring(20, 32),
    ].join('-');
}
