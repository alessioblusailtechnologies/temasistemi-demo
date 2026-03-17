import OpenAI from 'openai';
import {
    SYSTEM_PROMPT_SEARCH_QUERY,
    SYSTEM_PROMPT_CHAT_EXTRACT_QUERY,
    SYSTEM_PROMPT_CHAT,
    SYSTEM_PROMPT_AGENT_PLAN,
    SYSTEM_PROMPT_AGENT_REPORT,
} from './prompt-util.js';

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function embedText(text) {
    const res = await ai.embeddings.create({
        model: 'text-embedding-3-large',
        input: text,
        dimensions: 3072,
    });
    return res.data[0].embedding;
}

/**
 * Arricchisce la query utente con sinonimi/contesto semantico
 * ed estrae filtri strutturati (date, importi, tipo documento).
 *
 * @returns {{ semantic_query: string, filters: object }}
 */
export async function interpretSearchQuery(query) {
    const today = new Date().toISOString().split('T')[0];

    const resp = await ai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_completion_tokens: 800,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_SEARCH_QUERY },
            { role: 'user', content: `(data odierna: ${today})\n\n${query}` },
        ],
        response_format: { type: 'json_object' },
    });

    try {
        const parsed = JSON.parse(resp.choices[0].message.content);
        return {
            semantic_query: parsed.semantic_query || query,
            filters: normalizeFilters(parsed.filters),
        };
    } catch {
        return { semantic_query: query, filters: {} };
    }
}

/**
 * Estrae una query di ricerca dall'ultimo messaggio + cronologia conversazione.
 * Serve per i follow-up ("e quelli del 2024?") dove il contesto è nella cronologia.
 *
 * @param {string} message  - Ultimo messaggio utente
 * @param {Array}  history  - Cronologia [{role:'user'|'assistant', content:string}]
 * @returns {{ search_query: string, needs_search: boolean }}
 */
export async function extractChatSearchQuery(message, history = []) {
    const historyText = history.length > 0
        ? `Cronologia conversazione:\n${history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 300)}`).join('\n')}\n\n`
        : '';

    const resp = await ai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_completion_tokens: 300,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_CHAT_EXTRACT_QUERY },
            { role: 'user', content: `${historyText}Ultimo messaggio: "${message}"` },
        ],
        response_format: { type: 'json_object' },
    });

    try {
        return JSON.parse(resp.choices[0].message.content);
    } catch {
        return { search_query: message, needs_search: true };
    }
}

/**
 * Genera una risposta conversazionale in streaming, con contesto documentale RAG.
 *
 * @param {string} message   - Messaggio utente
 * @param {Array}  history   - Cronologia conversazione
 * @param {string} context   - Contesto documentale (chunk rilevanti formattati)
 * @returns {AsyncIterable}  - Stream di delta di testo
 */
export async function streamChatResponse(message, history = [], context = '') {
    const today = new Date().toISOString().split('T')[0];

    const systemContent = context
        ? `${SYSTEM_PROMPT_CHAT}\n\nData odierna: ${today}\n\n--- DOCUMENTI RECUPERATI ---\n${context}\n--- FINE DOCUMENTI ---`
        : `${SYSTEM_PROMPT_CHAT}\n\nData odierna: ${today}\n\nNessun documento è stato trovato per questa richiesta.`;

    const messages = [
        { role: 'system', content: systemContent },
        ...history.slice(-10), // ultimi 10 messaggi per non sforare il contesto
        { role: 'user', content: message },
    ];

    return ai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.3,
        max_completion_tokens: 2000,
        stream: true,
        messages,
    });
}

/**
 * Analizza il prompt dell'agent e produce un piano di esecuzione:
 * quali documenti cercare, in che formato generare l'output, a chi inviarlo.
 *
 * @param {string} prompt - Il prompt libero dell'agent
 * @returns {Promise<{search_query: string, output_format: string, report_title: string, email_to: string|null, email_subject: string|null}>}
 */
export async function planAgentExecution(prompt) {
    const today = new Date().toISOString().split('T')[0];

    const resp = await ai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.1,
        max_completion_tokens: 800,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_AGENT_PLAN },
            { role: 'user', content: `(data odierna: ${today})\n\nPrompt agent:\n${prompt}` },
        ],
        response_format: { type: 'json_object' },
    });

    try {
        const parsed = JSON.parse(resp.choices[0].message.content);
        return {
            search_query: parsed.search_query || prompt,
            output_format: parsed.output_format || 'text',
            report_title: parsed.report_title || 'Report DocLight',
            email_to: parsed.email_to || null,
            email_subject: parsed.email_subject || null,
        };
    } catch {
        return {
            search_query: prompt,
            output_format: 'text',
            report_title: 'Report DocLight',
            email_to: null,
            email_subject: null,
        };
    }
}

/**
 * Genera il contenuto testuale del report basandosi sui documenti trovati.
 *
 * @param {string} prompt       - Il prompt originale dell'agent
 * @param {string} context      - Contesto documentale (documenti trovati formattati)
 * @param {number} docCount     - Numero di documenti trovati
 * @returns {Promise<string>}   - Contenuto del report in markdown
 */
export async function generateAgentReport(prompt, context, docCount) {
    const today = new Date().toLocaleDateString('it-IT', {
        day: '2-digit', month: 'long', year: 'numeric',
    });

    const userMessage = context
        ? `Prompt dell'utente: ${prompt}\n\nData: ${today}\nDocumenti trovati: ${docCount}\n\n--- DOCUMENTI ---\n${context}\n--- FINE DOCUMENTI ---`
        : `Prompt dell'utente: ${prompt}\n\nData: ${today}\nNessun documento trovato nell'archivio.`;

    const resp = await ai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.3,
        max_completion_tokens: 4000,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_AGENT_REPORT },
            { role: 'user', content: userMessage },
        ],
    });

    return resp.choices[0].message.content || 'Report non generato.';
}

/**
 * Normalizza i filtri: rimuove valori null/undefined e valida i formati.
 */
function normalizeFilters(raw) {
    if (!raw || typeof raw !== 'object') return {};

    const filters = {};

    if (raw.data_da && /^\d{4}-\d{2}-\d{2}$/.test(raw.data_da)) {
        filters.data_da = raw.data_da;
    }
    if (raw.data_a && /^\d{4}-\d{2}-\d{2}$/.test(raw.data_a)) {
        filters.data_a = raw.data_a;
    }
    if (raw.tipo_documento && typeof raw.tipo_documento === 'string') {
        filters.tipo_documento = raw.tipo_documento.toLowerCase();
    }
    if (typeof raw.importo_min === 'number' && raw.importo_min > 0) {
        filters.importo_min = raw.importo_min;
    }
    if (typeof raw.importo_max === 'number' && raw.importo_max > 0) {
        filters.importo_max = raw.importo_max;
    }

    return filters;
}
