import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { embedText, interpretSearchQuery } from './openai.js';
import { searchDocuments, getClient } from './qdrant.js';
import { initPool, getDocumentsMetadataBatch, getAttachmentNames, getDocumentContent } from './oracle-db.js';

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
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

        // 1. Interpreta la query con AI → parte semantica + filtri
        const interpreted = await interpretSearchQuery(query.trim());
        const semanticQuery = interpreted.semantic_query || query;
        const filters = interpreted.filters || {};

        // 2. Genera embedding della query semantica
        const queryVector = await embedText(semanticQuery);

        // 3. Costruisci filtro Qdrant
        const qdrantFilter = buildQdrantFilter(filters);

        // 4. Cerca in Qdrant
        const qdrantResults = await searchDocuments(queryVector, qdrantFilter, top_k);

        // 5. Arricchisci con metadati da Oracle
        const docNames = qdrantResults.map(r => r.nome_file);
        let oracleMetadata = [];
        try {
            oracleMetadata = await getDocumentsMetadataBatch(docNames);
        } catch (err) {
            console.warn('[search] Oracle metadata fetch fallito:', err.message);
        }

        // Mappa Oracle metadata per nome file
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

        // 6. Componi risultati finali
        const results = qdrantResults.map(qr => ({
            nome_file: qr.nome_file,
            score: qr.score,
            score_percent: qr.score_percent,
            semantic_profile: qr.semantic_profile,
            metadata_ai: qr.metadata,
            metadata_db: oracleMap.get(qr.nome_file) || null,
        }));

        const elapsed = Date.now() - startTime;

        return res.json({
            query: query.trim(),
            interpreted: {
                semantic_query: semanticQuery,
                filters,
            },
            results,
            total: results.length,
            elapsed_ms: elapsed,
        });

    } catch (err) {
        console.error('[search] Errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/document/:name/download  — scarica/apri il file nel browser
// ---------------------------------------------------------------------------

app.get('/api/document/:name/download', async (req, res) => {
    try {
        const doc = await getDocumentContent(req.params.name);

        if (!doc || !doc.content) {
            return res.status(404).json({ error: 'Documento non trovato o contenuto vuoto.' });
        }

        // Content-Disposition: inline → il browser prova ad aprirlo; attachment → forza il download
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
// Filtri Qdrant
// ---------------------------------------------------------------------------

function buildQdrantFilter(filters) {
    if (!filters || (!filters.must && !filters.should && !filters.must_not)) {
        return null;
    }

    const qdrantFilter = {};
    if (filters.must?.length) qdrantFilter.must = filters.must.map(convertCondition);
    if (filters.should?.length) qdrantFilter.should = filters.should.map(convertCondition);
    if (filters.must_not?.length) qdrantFilter.must_not = filters.must_not.map(convertCondition);

    return Object.keys(qdrantFilter).length > 0 ? qdrantFilter : null;
}

function convertCondition(cond) {
    if (cond.match) return { key: cond.key, match: cond.match };
    if (cond.range) return { key: cond.key, range: cond.range };
    if (cond.match_text) return { key: cond.key, match: { text: cond.match_text } };
    return cond;
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
// Startup
// ---------------------------------------------------------------------------

async function start() {
    // Init Oracle pool
    await initPool();

    // Init Qdrant client
    getClient();

    app.listen(PORT, () => {
        console.log(`DocLight AI Search API avviata su http://localhost:${PORT}`);
        console.log(`  POST /api/search          { "query": "testo libero", "top_k": 20 }`);
        console.log(`  GET  /api/document/:name/download`);
        console.log(`  GET  /api/document/:name/attachments`);
        console.log(`  GET  /api/health`);
    });
}

start().catch(err => {
    console.error('Errore avvio server:', err);
    process.exit(1);
});
