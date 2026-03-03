import { QdrantClient } from '@qdrant/js-client-rest';
import crypto from 'crypto';

let client = null;

/**
 * Inizializza il client Qdrant
 */
export function getClient() {
    if (client) return client;
    client = new QdrantClient({
        url: process.env.QDRANT_URL || 'http://localhost:6333',
        apiKey: process.env.QDRANT_API_KEY || undefined,
    });
    return client;
}

const COLLECTION = () => process.env.QDRANT_COLLECTION || 'doclight_documents';
const VECTOR_SIZE = 3072; // text-embedding-3-large

// ---------------------------------------------------------------------------
// Collection management
// ---------------------------------------------------------------------------

/**
 * Crea la collection Qdrant con indici ottimizzati per i metadati
 */
export async function ensureCollection() {
    const qc = getClient();
    const collections = await qc.getCollections();
    const exists = collections.collections.some(c => c.name === COLLECTION());

    if (!exists) {
        await qc.createCollection(COLLECTION(), {
            vectors: {
                content: {
                    size: VECTOR_SIZE,
                    distance: 'Cosine',
                },
            },
            optimizers_config: {
                default_segment_number: 2,
            },
        });

        // Indici payload per filtri strutturati
        const payloadIndexes = [
            // Metadati AI
            { field: 'metadata.tipo_documento', schema: 'keyword' },
            { field: 'metadata.data_documento', schema: 'datetime' },
            { field: 'metadata.data_scadenza', schema: 'datetime' },
            { field: 'metadata.importi.totale', schema: 'float' },
            { field: 'metadata.emittente.ragione_sociale', schema: 'text' },
            { field: 'metadata.destinatario.ragione_sociale', schema: 'text' },
            { field: 'metadata.emittente.partita_iva', schema: 'keyword' },
            { field: 'metadata.parole_chiave', schema: 'keyword' },
            { field: 'metadata.numero_documento', schema: 'keyword' },
            // Metadati DB Oracle
            { field: 'db.tipo_documento', schema: 'keyword' },
            { field: 'db.societa', schema: 'keyword' },
            { field: 'db.data_inserimento', schema: 'datetime' },
            { field: 'db.data_documento', schema: 'datetime' },
            { field: 'db.data_riferimento', schema: 'datetime' },
            { field: 'db.utente', schema: 'keyword' },
            { field: 'db.flag_allegato', schema: 'keyword' },
            { field: 'db.mime_type', schema: 'keyword' },
        ];

        for (const idx of payloadIndexes) {
            try {
                await qc.createPayloadIndex(COLLECTION(), {
                    field_name: idx.field,
                    field_schema: idx.schema,
                });
            } catch (e) {
                console.warn(`[qdrant] Indice ${idx.field} non creato:`, e.message);
            }
        }

        console.log(`[qdrant] Collection "${COLLECTION()}" creata con indici`);
    } else {
        console.log(`[qdrant] Collection "${COLLECTION()}" già esistente`);
    }
}

// ---------------------------------------------------------------------------
// Upsert documenti
// ---------------------------------------------------------------------------

/**
 * Inserisce/aggiorna un documento nella collection Qdrant.
 * Payload snello: solo nome file, metadati strutturati e profilo semantico.
 */
export async function upsertDocument({ id, vector, metadata, semanticProfile, db }) {
    const qc = getClient();
    const pointId = stringToPointId(id);
    try {
        await qc.upsert(COLLECTION(), {
            wait: true,
            points: [
                {
                    id: pointId,
                    vector: { content: vector },
                    payload: {
                        nome_file: id,
                        metadata: metadata || {},
                        semantic_profile: semanticProfile || '',
                        db: db || {},
                    },
                },
            ],
        });
    } catch (err) {
        console.error(`[qdrant] Upsert fallito per "${id}" (pointId: ${pointId}):`, err?.data || err?.message || err);
        throw err;
    }
}

/**
 * Upsert batch di documenti
 */
export async function upsertDocumentsBatch(documents) {
    const qc = getClient();
    const points = documents.map(doc => ({
        id: stringToPointId(doc.id),
        vector: { content: doc.vector },
        payload: {
            nome_file: doc.id,
            metadata: doc.metadata || {},
            semantic_profile: doc.semanticProfile || '',
            db: doc.db || {},
        },
    }));

    await qc.upsert(COLLECTION(), { wait: true, points });
}

// ---------------------------------------------------------------------------
// Ricerca
// ---------------------------------------------------------------------------

/**
 * Ricerca vettoriale con filtri opzionali
 * @param {number[]} queryVector   embedding della query
 * @param {object} [filter]        filtri Qdrant (must/should/must_not)
 * @param {number} [topK=20]       numero risultati
 * @returns {Promise<Array>}       risultati con score e payload
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
        scorePercent: +(r.score * 100).toFixed(1),
        nomeFile: r.payload.nome_file,
        metadata: r.payload.metadata,
        db: r.payload.db,
        semanticProfile: r.payload.semantic_profile,
    }));
}

/**
 * Recupera un documento per nome file
 */
export async function getDocumentByName(nomeFile) {
    const qc = getClient();
    const results = await qc.scroll(COLLECTION(), {
        filter: {
            must: [{ key: 'nome_file', match: { value: nomeFile } }],
        },
        limit: 1,
        with_payload: true,
        with_vector: false,
    });
    return results.points?.[0]?.payload || null;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/**
 * Converte una stringa in un UUID v5 deterministico per Qdrant
 * Qdrant accetta UUID string come point ID
 */
function stringToPointId(str) {
    const hash = crypto.createHash('md5').update(str).digest('hex');
    // Formato UUID: 8-4-4-4-12
    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        '4' + hash.substring(13, 16),   // versione 4
        '8' + hash.substring(17, 20),   // variante
        hash.substring(20, 32),
    ].join('-');
}

