import { getClient } from './supabase.js';
import { embedText, interpretSearchQuery, planAgentExecution, generateAgentReport } from './openai.js';
import { searchDocuments } from './supabase.js';
import { getDocumentsMetadataBatch, getFilteredDocNames } from './oracle-db.js';
import { sendEmail } from './mailer.js';
import { buildPdf } from './pdf-builder.js';

const executionsTable = 'doclight_agent_executions';

/**
 * Esegue un agent: pianifica, cerca documenti, genera output, esegue azioni.
 * Aggiorna lo stato dell'esecuzione in Supabase man mano.
 *
 * @param {object} agent - L'agent da eseguire (da doclight_agents)
 * @param {string} executionId - ID dell'esecuzione in corso
 */
export async function executeAgent(agent, executionId) {
    const sb = getClient();
    const log = (msg) => console.log(`[agent:${agent.name}] ${msg}`);

    try {
        // ── 1. Aggiorna stato → running ──
        await updateExecution(sb, executionId, { status: 'running' });
        log('Avviato — analizzo il prompt…');

        // ── 2. Pianifica con LLM ──
        const plan = await planAgentExecution(agent.prompt);
        log(`Piano: cerca="${plan.search_query}", output=${plan.output_format}, email=${plan.email_to || 'no'}`);

        // ── 3. Cerca documenti ──
        let documents = [];
        let context = '';

        if (plan.search_query) {
            log('Cerco documenti…');

            const interpreted = await interpretSearchQuery(plan.search_query);
            const semanticQuery = interpreted.semantic_query || plan.search_query;
            const filters = interpreted.filters || {};
            const hasFilters = Object.keys(filters).length > 0;

            const [queryVector, allowedDocNames] = await Promise.all([
                embedText(semanticQuery),
                hasFilters ? getFilteredDocNames(filters).catch(() => null) : Promise.resolve(null),
            ]);

            let searchResults = await searchDocuments(queryVector, allowedDocNames ? 60 : 30);

            if (allowedDocNames) {
                searchResults = searchResults.filter(r => allowedDocNames.has(r.nome_file));
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

            // Arricchisci con metadati Oracle
            if (searchResults.length > 0) {
                const docNames = searchResults.map(r => r.nome_file);
                let oracleMetadata = [];
                try {
                    oracleMetadata = await getDocumentsMetadataBatch(docNames);
                } catch { /* ignora */ }

                const oracleMap = new Map();
                for (const row of oracleMetadata) {
                    oracleMap.set(row.NOME_FILE, row);
                }

                documents = searchResults.map(r => {
                    const om = oracleMap.get(r.nome_file);
                    return {
                        nome_file: r.nome_file,
                        score: r.score,
                        tipo_documento: r.metadata?.tipo_documento || om?.TIPO_DOCUMENTO || '',
                        data_documento: r.metadata?.data_documento || formatDate(om?.DATA_DOCUMENTO) || '',
                        semantic_profile: r.semantic_profile || '',
                        emittente: r.metadata?.emittente?.ragione_sociale || '',
                        destinatario: r.metadata?.destinatario?.ragione_sociale || '',
                        importo_totale: r.metadata?.importi?.totale || null,
                        descrizione: om?.DESCRIZIONE || r.metadata?.oggetto || '',
                        chunks: r.matching_chunks?.slice(0, 2) || [],
                    };
                });

                // Costruisci contesto testuale per il LLM
                context = documents.map((doc, i) => {
                    let entry = `[${i + 1}] ${doc.nome_file}`;
                    if (doc.tipo_documento) entry += ` | Tipo: ${doc.tipo_documento}`;
                    if (doc.data_documento) entry += ` | Data: ${doc.data_documento}`;
                    if (doc.emittente) entry += ` | Emittente: ${doc.emittente}`;
                    if (doc.destinatario) entry += ` | Destinatario: ${doc.destinatario}`;
                    if (doc.importo_totale) entry += ` | Importo: €${doc.importo_totale.toLocaleString('it-IT')}`;
                    if (doc.descrizione) entry += `\n   Descrizione: ${doc.descrizione}`;
                    if (doc.semantic_profile) entry += `\n   Profilo: ${doc.semantic_profile}`;
                    if (doc.chunks.length > 0) {
                        entry += `\n   Contenuto: ${doc.chunks.map(c => c.text).join(' ').substring(0, 500)}`;
                    }
                    return entry;
                }).join('\n\n');
            }

            log(`Trovati ${documents.length} documenti`);
        }

        // ── 4. Genera report con LLM ──
        log('Genero il report…');
        const reportContent = await generateAgentReport(agent.prompt, context, documents.length);

        // ── 5. Genera PDF se richiesto ──
        let pdfBuffer = null;
        if (plan.output_format === 'pdf' || plan.email_to) {
            log('Genero PDF…');
            pdfBuffer = await buildPdf(plan.report_title || agent.name, reportContent, documents);
        }

        // ── 6. Invia email se richiesto ──
        if (plan.email_to) {
            log(`Invio email a ${plan.email_to}…`);
            await sendEmail({
                to: plan.email_to,
                subject: plan.email_subject || `Report: ${agent.name}`,
                text: `Report generato dall'agent "${agent.name}".\n\nVedi il PDF allegato per il report completo.\n\nRiepilogo:\n${reportContent.substring(0, 500)}...`,
                html: `<p>Report generato dall'agent <strong>"${agent.name}"</strong>.</p><p>Vedi il PDF allegato per il report completo.</p>`,
                attachments: pdfBuffer ? [{
                    filename: `${slugify(plan.report_title || agent.name)}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                }] : [],
            });
            log('Email inviata');
        }

        // ── 7. Completa esecuzione ──
        const resultSummary = buildResultSummary(plan, documents.length, reportContent);

        await updateExecution(sb, executionId, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            result: resultSummary,
        });

        log('Completato con successo');

    } catch (err) {
        console.error(`[agent:${agent.name}] Errore:`, err);
        await updateExecution(sb, executionId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            error: err.message || 'Errore sconosciuto',
        });
    }
}

// ── Helpers ──

async function updateExecution(sb, id, fields) {
    const { error } = await sb.from(executionsTable).update(fields).eq('id', id);
    if (error) console.error('[agent] Errore aggiornamento esecuzione:', error.message);
}

function buildResultSummary(plan, docCount, reportContent) {
    const parts = [];
    parts.push(`Documenti trovati: ${docCount}`);
    if (plan.output_format === 'pdf') parts.push('Report PDF generato');
    if (plan.email_to) parts.push(`Email inviata a: ${plan.email_to}`);
    parts.push('');
    parts.push(reportContent.substring(0, 1000));
    return parts.join('\n');
}

function formatDate(d) {
    if (!d) return null;
    if (d instanceof Date) return d.toISOString().split('T')[0];
    return String(d);
}

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .substring(0, 60);
}
