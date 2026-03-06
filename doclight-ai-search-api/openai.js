import OpenAI from 'openai';
import { SYSTEM_PROMPT_SEARCH_QUERY } from './prompt-util.js';

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Genera embedding vettoriale da testo
 */
export async function embedText(text) {
    const res = await ai.embeddings.create({
        model: 'text-embedding-3-large',
        input: text,
        dimensions: 2000,
    });
    return res.data[0].embedding;
}

/**
 * Interpreta una query utente in linguaggio naturale.
 * Restituisce la parte semantica + filtri strutturati per la ricerca.
 */
export async function interpretSearchQuery(query) {
    const today = new Date().toISOString().split('T')[0];
    const systemPrompt = SYSTEM_PROMPT_SEARCH_QUERY + `\n\nDATA ODIERNA: ${today}. Usa questa data per risolvere riferimenti temporali relativi (es. "ultimo mese", "quest'anno", "ultimi 3 mesi").`;

    const resp = await ai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 1000,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
        ],
        response_format: { type: 'json_object' },
    });

    try {
        return JSON.parse(resp.choices[0].message.content);
    } catch {
        return { semantic_query: query, filters: {} };
    }
}
