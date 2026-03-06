import { createClient } from '@supabase/supabase-js';

let client = null;

export function getClient() {
    if (client) return client;
    client = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
    );
    return client;
}

/**
 * Ricerca vettoriale pura sui chunk.
 * Raggruppa i risultati per documento e arricchisce con metadati.
 */
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

    // Raggruppa per documento
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
                    entry.semantic_profile = doc.semantic_profile || '';
                }
            }
        }
    }

    return [...docMap.values()]
        .sort((a, b) => b.bestSimilarity - a.bestSimilarity)
        .slice(0, topK)
        .map(r => ({
            nome_file: r.nome_file,
            score: r.bestSimilarity,
            score_percent: +(r.bestSimilarity * 100).toFixed(1),
            metadata: r.metadata || {},
            semantic_profile: r.semantic_profile || '',
            matching_chunks: r.chunks.slice(0, 3),
        }));
}
