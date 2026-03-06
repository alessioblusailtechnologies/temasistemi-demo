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
 * Arricchisce la query utente con sinonimi e contesto semantico.
 */
export async function interpretSearchQuery(query) {
    const resp = await ai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_completion_tokens: 500,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_SEARCH_QUERY },
            { role: 'user', content: query },
        ],
        response_format: { type: 'json_object' },
    });

    try {
        return JSON.parse(resp.choices[0].message.content);
    } catch {
        return { semantic_query: query };
    }
}
