import { QdrantClient } from '@qdrant/js-client-rest';

let client = null;

export function getClient() {
    if (client) return client;
    client = new QdrantClient({
        url: process.env.QDRANT_URL || 'http://localhost:6333',
        apiKey: process.env.QDRANT_API_KEY || undefined,
    });
    return client;
}

const COLLECTION = () => process.env.QDRANT_COLLECTION || 'doclight_documents';

/**
 * Ricerca vettoriale con filtri opzionali.
 * Restituisce risultati con score e payload (nome_file, metadata, semantic_profile).
 */
export async function searchDocuments(queryVector, filter = null, topK = 20) {
    const qc = getClient();
    const params = {
        vector: { name: 'content', vector: queryVector },
        limit: topK,
        with_payload: true,
        score_threshold: 0.15,
    };

    if (filter && Object.keys(filter).length > 0) {
        params.filter = filter;
    }

    const results = await qc.search(COLLECTION(), params);

    return results.map(r => ({
        score: r.score,
        score_percent: +(r.score * 100).toFixed(1),
        nome_file: r.payload.nome_file,
        metadata: r.payload.metadata,
        semantic_profile: r.payload.semantic_profile,
    }));
}
