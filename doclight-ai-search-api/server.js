import 'dotenv/config';
import express from 'express';
import { embedText, interpretSearchQuery, extractChatSearchQuery, streamChatResponse } from './openai.js';
import { searchDocuments, getClient } from './supabase.js';
import { initPool, getDocumentsMetadataBatch, getFilteredDocNames, getAttachmentNames, getDocumentContent } from './oracle-db.js';
import { executeAgent } from './agent-executor.js';

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

        // 1. Arricchisci semanticamente la query + estrai filtri strutturati
        const interpreted = await interpretSearchQuery(query.trim());
        const semanticQuery = interpreted.semantic_query || query;
        const filters = interpreted.filters || {};
        const hasFilters = Object.keys(filters).length > 0;

        console.log('[search] Filtri estratti:', JSON.stringify(filters));

        // 2. In parallelo: genera embedding + applica filtri su Oracle
        const [queryVector, allowedDocNames] = await Promise.all([
            embedText(semanticQuery),
            hasFilters ? getFilteredDocNames(filters).catch(err => {
                console.warn('[search] Filtro Oracle fallito:', err.message);
                return null;
            }) : Promise.resolve(null),
        ]);

        // 3. Ricerca vettoriale sui chunk (fetch più risultati se ci sono filtri)
        const fetchCount = allowedDocNames ? Math.max(top_k * 3, 60) : top_k;
        let searchResults = await searchDocuments(queryVector, fetchCount);

        // 4. Applica filtri strutturati ai risultati vettoriali
        if (allowedDocNames) {
            searchResults = searchResults.filter(r => allowedDocNames.has(r.nome_file));
            searchResults = searchResults.slice(0, top_k);
            console.log(`[search] Dopo filtro DB: ${searchResults.length} risultati (da ${fetchCount} candidati, ${allowedDocNames.size} doc matchano filtri)`);
        }

        // 5. Applica filtro importo sui metadati AI (se presenti)
        if (filters.importo_min || filters.importo_max) {
            searchResults = searchResults.filter(r => {
                const totale = r.metadata?.importi?.totale;
                if (totale == null) return true; // mantieni se non ha info importo
                if (filters.importo_min && totale < filters.importo_min) return false;
                if (filters.importo_max && totale > filters.importo_max) return false;
                return true;
            });
        }

        // 6. Arricchisci con metadati da Oracle
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

        // 7. Componi risultati
        const results = searchResults.map(r => ({
            nome_file: r.nome_file,
            score: r.score,
            score_percent: r.score_percent,
            semantic_profile: r.semantic_profile,
            metadata_ai: r.metadata,
            metadata_db: oracleMap.get(r.nome_file) || null,
            matching_chunks: r.matching_chunks,
        }));

        // 8. Costruisci descrizione filtri per il frontend
        const appliedFilters = buildFilterLabels(filters);

        return res.json({
            query: query.trim(),
            semantic_query: semanticQuery,
            filters: appliedFilters,
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
// POST /api/chat  (SSE streaming)
// ---------------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Il campo "message" è obbligatorio.' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
        // 1. Estrai query di ricerca dal contesto conversazionale
        const extracted = await extractChatSearchQuery(message.trim(), history);

        let context = '';
        let sources = [];

        if (extracted.needs_search && extracted.search_query) {
            send({ type: 'status', content: 'Cerco nei documenti...' });

            // 2. Riusa la pipeline di ricerca: interpreta + filtri + embedding + vector search
            const interpreted = await interpretSearchQuery(extracted.search_query);
            const semanticQuery = interpreted.semantic_query || extracted.search_query;
            const filters = interpreted.filters || {};
            const hasFilters = Object.keys(filters).length > 0;

            const [queryVector, allowedDocNames] = await Promise.all([
                embedText(semanticQuery),
                hasFilters ? getFilteredDocNames(filters).catch(() => null) : Promise.resolve(null),
            ]);

            let searchResults = await searchDocuments(queryVector, allowedDocNames ? 30 : 10);

            if (allowedDocNames) {
                searchResults = searchResults.filter(r => allowedDocNames.has(r.nome_file));
                searchResults = searchResults.slice(0, 10);
            }

            if (filters.importo_min || filters.importo_max) {
                searchResults = searchResults.filter(r => {
                    const totale = r.metadata?.importi?.totale;
                    if (totale == null) return true;
                    if (filters.importo_min && totale < filters.importo_min) return false;
                    if (filters.importo_max && totale > filters.importo_max) return false;
                    return true;
                });
            }

            // 3. Costruisci contesto RAG dai chunk più rilevanti
            if (searchResults.length > 0) {
                // Arricchisci con metadati Oracle per dare contesto al LLM
                const docNames = searchResults.map(r => r.nome_file);
                let oracleMetadata = [];
                try {
                    oracleMetadata = await getDocumentsMetadataBatch(docNames);
                } catch { /* ignora */ }
                const oracleMap = new Map();
                for (const row of oracleMetadata) {
                    oracleMap.set(row.NOME_FILE, row);
                }

                const contextParts = [];
                for (const doc of searchResults.slice(0, 8)) {
                    const oracleMeta = oracleMap.get(doc.nome_file);
                    const dataDoc = oracleMeta?.DATA_DOCUMENTO
                        ? formatDate(oracleMeta.DATA_DOCUMENTO)
                        : (doc.metadata?.data_documento || '');
                    const tipo = doc.metadata?.tipo_documento || oracleMeta?.TIPO_DOCUMENTO || '';

                    let header = `[Documento: ${doc.nome_file}]`;
                    if (tipo) header += ` Tipo: ${tipo}`;
                    if (dataDoc) header += ` Data: ${dataDoc}`;
                    if (doc.semantic_profile) header += `\nProfilo: ${doc.semantic_profile}`;

                    const chunkTexts = doc.matching_chunks
                        .slice(0, 2)
                        .map(c => c.text)
                        .join('\n');

                    contextParts.push(`${header}\n${chunkTexts}`);

                    sources.push({
                        nome_file: doc.nome_file,
                        score: doc.score,
                        score_percent: doc.score_percent,
                        tipo_documento: tipo,
                        data_documento: dataDoc,
                        semantic_profile: doc.semantic_profile,
                    });
                }
                context = contextParts.join('\n\n---\n\n');
            }

            send({ type: 'status', content: `${searchResults.length} documenti trovati` });
        }

        // 4. Genera risposta conversazionale in streaming
        send({ type: 'status', content: 'Genero la risposta...' });

        const stream = await streamChatResponse(message.trim(), history, context);

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
                send({ type: 'delta', content: delta });
            }
        }

        // 5. Invia sorgenti e chiudi
        send({ type: 'sources', sources });
        send({ type: 'done' });

    } catch (err) {
        console.error('[chat] Errore:', err);
        send({ type: 'error', message: err.message || 'Errore interno' });
    } finally {
        res.end();
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
// AGENTS CRUD
// ---------------------------------------------------------------------------

const agentsTable = 'doclight_agents';
const executionsTable = 'doclight_agent_executions';

// GET /api/agents — lista agents
app.get('/api/agents', async (_req, res) => {
    try {
        const sb = getClient();
        const { data, error } = await sb
            .from(agentsTable)
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        return res.json(data);
    } catch (err) {
        console.error('[agents] Lista errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/agents/:id — singolo agent
app.get('/api/agents/:id', async (req, res) => {
    try {
        const sb = getClient();
        const { data, error } = await sb
            .from(agentsTable)
            .select('*')
            .eq('id', req.params.id)
            .single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Agent non trovato' });
        return res.json(data);
    } catch (err) {
        console.error('[agents] Get errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /api/agents — crea agent
app.post('/api/agents', async (req, res) => {
    try {
        const { name, prompt, trigger_type, cron_expression, enabled } = req.body;
        if (!name || !prompt) {
            return res.status(400).json({ error: 'I campi "name" e "prompt" sono obbligatori.' });
        }
        if (trigger_type === 'scheduled' && !cron_expression) {
            return res.status(400).json({ error: 'Il campo "cron_expression" è obbligatorio per agenti schedulati.' });
        }
        const sb = getClient();
        const { data, error } = await sb
            .from(agentsTable)
            .insert({
                name: name.trim(),
                prompt: prompt.trim(),
                trigger_type: trigger_type || 'manual',
                cron_expression: cron_expression || null,
                enabled: enabled !== false,
            })
            .select()
            .single();
        if (error) throw error;
        return res.status(201).json(data);
    } catch (err) {
        console.error('[agents] Creazione errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// PUT /api/agents/:id — aggiorna agent
app.put('/api/agents/:id', async (req, res) => {
    try {
        const { name, prompt, trigger_type, cron_expression, enabled } = req.body;
        const sb = getClient();
        const { data, error } = await sb
            .from(agentsTable)
            .update({
                name: name?.trim(),
                prompt: prompt?.trim(),
                trigger_type,
                cron_expression: cron_expression || null,
                enabled,
            })
            .eq('id', req.params.id)
            .select()
            .single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Agent non trovato' });
        return res.json(data);
    } catch (err) {
        console.error('[agents] Aggiornamento errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// DELETE /api/agents/:id — elimina agent
app.delete('/api/agents/:id', async (req, res) => {
    try {
        const sb = getClient();
        const { error } = await sb
            .from(agentsTable)
            .delete()
            .eq('id', req.params.id);
        if (error) throw error;
        return res.status(204).send();
    } catch (err) {
        console.error('[agents] Eliminazione errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /api/agents/:id/run — esegui agent manualmente (sincrono)
app.post('/api/agents/:id/run', async (req, res) => {
    try {
        const sb = getClient();

        // Verifica che l'agent esista
        const { data: agent, error: agentErr } = await sb
            .from(agentsTable)
            .select('*')
            .eq('id', req.params.id)
            .single();
        if (agentErr || !agent) {
            return res.status(404).json({ error: 'Agent non trovato' });
        }

        // Crea esecuzione in stato "pending"
        const { data: execution, error: execErr } = await sb
            .from(executionsTable)
            .insert({
                agent_id: agent.id,
                status: 'pending',
            })
            .select()
            .single();
        if (execErr) throw execErr;

        // Esecuzione sincrona — il client aspetta il risultato
        await executeAgent(agent, execution.id);

        // Leggi l'esecuzione aggiornata
        const { data: completed } = await sb
            .from(executionsTable)
            .select('*')
            .eq('id', execution.id)
            .single();

        return res.json(completed || execution);

    } catch (err) {
        console.error('[agents] Esecuzione errore:', err);
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/agents/:id/executions — storico esecuzioni
app.get('/api/agents/:id/executions', async (req, res) => {
    try {
        const sb = getClient();
        const { data, error } = await sb
            .from(executionsTable)
            .select('*')
            .eq('agent_id', req.params.id)
            .order('started_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        return res.json(data);
    } catch (err) {
        console.error('[agents] Esecuzioni errore:', err);
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

/**
 * Costruisce un array di filtri applicati con etichette leggibili per il frontend.
 */
function buildFilterLabels(filters) {
    if (!filters || !Object.keys(filters).length) return [];

    const applied = [];

    if (filters.data_da || filters.data_a) {
        const da = filters.data_da ? formatDateIT(filters.data_da) : null;
        const a = filters.data_a ? formatDateIT(filters.data_a) : null;

        let label;
        if (da && a) {
            if (filters.data_da === filters.data_a) {
                label = da;
            } else {
                label = `${da} — ${a}`;
            }
        } else if (da) {
            label = `dal ${da}`;
        } else {
            label = `fino al ${a}`;
        }

        applied.push({ type: 'data', label, data_da: filters.data_da, data_a: filters.data_a });
    }

    if (filters.tipo_documento) {
        const typeMap = {
            fattura: 'Fattura', contratto: 'Contratto', ordine: 'Ordine',
            ddt: 'DDT', nota_credito: 'Nota di Credito', preventivo: 'Preventivo',
            bolla: 'Bolla', lettera: 'Lettera', circolare: 'Circolare',
            verbale: 'Verbale', delibera: 'Delibera', normativa: 'Normativa',
            registro_contabile: 'Registro Contabile', rapporto_intervento: 'Rapporto Intervento',
            documento_tecnico: 'Doc. Tecnico',
        };
        applied.push({
            type: 'tipo_documento',
            label: typeMap[filters.tipo_documento] || filters.tipo_documento,
            value: filters.tipo_documento,
        });
    }

    if (filters.importo_min != null || filters.importo_max != null) {
        let label;
        if (filters.importo_min != null && filters.importo_max != null) {
            label = `${filters.importo_min.toLocaleString('it-IT')} — ${filters.importo_max.toLocaleString('it-IT')} €`;
        } else if (filters.importo_min != null) {
            label = `> ${filters.importo_min.toLocaleString('it-IT')} €`;
        } else {
            label = `< ${filters.importo_max.toLocaleString('it-IT')} €`;
        }
        applied.push({
            type: 'importo',
            label,
            importo_min: filters.importo_min ?? null,
            importo_max: filters.importo_max ?? null,
        });
    }

    return applied;
}

function formatDateIT(isoStr) {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
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
        console.log(`  POST /api/chat     { "message": "testo", "history": [] }  (SSE)`);
        console.log(`  GET  /api/document/:name/download`);
        console.log(`  GET  /api/document/:name/attachments`);
        console.log(`  GET  /api/agents`);
        console.log(`  POST /api/agents`);
        console.log(`  PUT  /api/agents/:id`);
        console.log(`  DEL  /api/agents/:id`);
        console.log(`  POST /api/agents/:id/run`);
        console.log(`  GET  /api/agents/:id/executions`);
        console.log(`  GET  /api/health`);
    });
}

start().catch(err => {
    console.error('Errore avvio:', err);
    process.exit(1);
});
