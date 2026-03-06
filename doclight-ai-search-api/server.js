import 'dotenv/config';
import express from 'express';
import { embedText, interpretSearchQuery } from './openai.js';
import { searchDocuments, getClient } from './supabase.js';
import { initPool, getDocumentsMetadataBatch, getAttachmentNames, getDocumentContent } from './oracle-db.js';

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// POST /api/search
// ---------------------------------------------------------------------------

app.post('/api/search', async (req, res) => {
    const startTime = Date.now();

    try {
        const { query, top_k = 20 } = req.body;

        if (!query || typeof query !== 'string' || !query.trim()) {
            return res.status(400).json({ error: 'Il campo "query" è obbligatorio.' });
        }

        // 1. Arricchisci semanticamente la query
        const interpreted = await interpretSearchQuery(query.trim());
        const semanticQuery = interpreted.semantic_query || query;

        // 2. Genera embedding della query arricchita
        const queryVector = await embedText(semanticQuery);

        // 3. Ricerca vettoriale sui chunk
        const searchResults = await searchDocuments(queryVector, top_k);

        // 4. Arricchisci con metadati da Oracle
        const docNames = searchResults.map(r => r.nome_file);
        let oracleMetadata = [];
        try {
            oracleMetadata = await getDocumentsMetadataBatch(docNames);
        } catch (err) {
            console.warn('[search] Oracle metadata fetch fallito:', err.message);
        }

        const oracleMap = new Map();
        for (const row of oracleMetadata) {
            oracleMap.set(row.NOME_FILE, {
                descrizione: row.DESCRIZIONE,
                tipo_documento: row.TIPO_DOCUMENTO,
                data_inserimento: formatDate(row.DATA_INSERIMENTO),
                data_documento: formatDate(row.DATA_DOCUMENTO),
                data_riferimento: formatDate(row.DATA_RIFERIMENTO),
                utente: row.UTENTE,
                societa: row.SOCIETA,
                abstract: row.ABSTRACT,
                flag_allegato: row.FLAG_ALLEGATO,
                livello_riservatezza: row.LIVELLO_RISERVATEZZA,
                mime_type: row.MIME_TYPE,
                doc_size: row.DOC_SIZE,
                content_type: row.CONTENT_TYPE,
            });
        }

        // 5. Componi risultati
        const results = searchResults.map(r => ({
            nome_file: r.nome_file,
            score: r.score,
            score_percent: r.score_percent,
            semantic_profile: r.semantic_profile,
            metadata_ai: r.metadata,
            metadata_db: oracleMap.get(r.nome_file) || null,
            matching_chunks: r.matching_chunks,
        }));

        return res.json({
            query: query.trim(),
            semantic_query: semanticQuery,
            results,
            total: results.length,
            elapsed_ms: Date.now() - startTime,
        });

    } catch (err) {
        console.error('[search] Errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/document/:name/download
// ---------------------------------------------------------------------------

app.get('/api/document/:name/download', async (req, res) => {
    try {
        const doc = await getDocumentContent(req.params.name);
        if (!doc || !doc.content) {
            return res.status(404).json({ error: 'Documento non trovato o contenuto vuoto.' });
        }
        res.setHeader('Content-Type', doc.mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.name)}"`);
        res.setHeader('Content-Length', doc.content.length);
        return res.send(doc.content);
    } catch (err) {
        console.error('[download] Errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/document/:name/attachments
// ---------------------------------------------------------------------------

app.get('/api/document/:name/attachments', async (req, res) => {
    try {
        const attachments = await getAttachmentNames(req.params.name);
        return res.json({ nome_file: req.params.name, attachments, total: attachments.length });
    } catch (err) {
        console.error('[attachments] Errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function formatDate(d) {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString().split('T')[0];
    return String(d);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
    await initPool();
    getClient();

    app.listen(PORT, () => {
        console.log(`DocLight AI Search API su http://localhost:${PORT}`);
        console.log(`  POST /api/search   { "query": "testo", "top_k": 20 }`);
        console.log(`  GET  /api/document/:name/download`);
        console.log(`  GET  /api/document/:name/attachments`);
        console.log(`  GET  /api/health`);
    });
}

start().catch(err => {
    console.error('Errore avvio:', err);
    process.exit(1);
});
