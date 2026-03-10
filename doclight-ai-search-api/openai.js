import OpenAI from 'openai';
import { SYSTEM_PROMPT_SEARCH_QUERY } from './prompt-util.js';

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
