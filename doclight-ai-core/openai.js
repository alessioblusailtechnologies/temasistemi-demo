import OpenAI, { toFile } from 'openai';
import {
    SYSTEM_PROMPT_EXTRACT_TEXT,
    SYSTEM_PROMPT_ANALYZE_DOCUMENT,
    SYSTEM_PROMPT_SEARCH_QUERY,
} from './prompt-util.js';

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Modelli configurabili via env
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || 'gpt-4.1';
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'gpt-4.1';
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMS = 3072;

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export async function embedText(text) {
    const res = await ai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMS,
    });
    return res.data[0].embedding;
}

export async function embedTexts(texts) {
    if (texts.length === 0) return [];
    const batchSize = 100;
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const res = await ai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: batch,
            dimensions: EMBEDDING_DIMS,
        });
        allEmbeddings.push(...res.data.map(d => d.embedding));
    }

    return allEmbeddings;
}

// ---------------------------------------------------------------------------
// Estrazione testo da file
// ---------------------------------------------------------------------------

export async function extractTextFromFile(fileBuffer, mimeType, fileName) {
    if (!fileBuffer || fileBuffer.length === 0) {
        return '';
    }

    let mime = (mimeType || '').toLowerCase();

    // Se MIME generico, deducilo dall'estensione
    if (!mime || mime === 'application/octet-stream') {
        mime = guessMimeFromExtension(fileName) || mime;
    }

    const safeFileName = ensureExtension(fileName, mime);

    // Testo plain / XML / HTML / CSV → decodifica diretta
    if (mime.startsWith('text/') || mime.includes('xml') || mime.includes('html') || mime.includes('json') || mime.includes('csv')) {
        return fileBuffer.toString('utf-8');
    }

    // PDF → upload + Responses API
    if (mime.includes('pdf')) {
        const file = await ai.files.create({
            file: await toFile(fileBuffer, safeFileName, { type: 'application/pdf' }),
            purpose: 'assistants',
        });

        try {
            let text = await extractViaResponsesApi(file.id, fileName, EXTRACTION_MODEL);
            if (isRefusal(text)) {
                console.warn(`    [RETRY] ${EXTRACTION_MODEL} rifiutato, retry con gpt-4o...`);
                text = await extractViaResponsesApi(file.id, fileName, 'gpt-4o');
            }
            return text;
        } finally {
            await ai.files.del(file.id).catch(() => {});
        }
    }

    // Immagini → Vision API
    const imageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp'];
    if (imageTypes.some(s => mime.includes(s.split('/')[1]))) {
        let text = await extractViaVision(fileBuffer, mimeType, fileName, EXTRACTION_MODEL);
        if (isRefusal(text)) {
            console.warn(`    [RETRY] Vision rifiutato, retry con gpt-4o...`);
            text = await extractViaVision(fileBuffer, mimeType, fileName, 'gpt-4o');
        }
        return text;
    }

    // Office (docx, xlsx, pptx, doc, xls, ppt) → upload + Responses API
    const officeTypes = ['spreadsheet', 'wordprocessing', 'presentation', 'msword', 'ms-excel', 'ms-powerpoint'];
    if (officeTypes.some(t => mime.includes(t))) {
        const file = await ai.files.create({
            file: await toFile(fileBuffer, safeFileName, { type: mimeType }),
            purpose: 'assistants',
        });

        try {
            let text = await extractViaResponsesApi(file.id, fileName, EXTRACTION_MODEL);
            if (isRefusal(text)) {
                console.warn(`    [RETRY] ${EXTRACTION_MODEL} rifiutato per Office, retry con gpt-4o...`);
                text = await extractViaResponsesApi(file.id, fileName, 'gpt-4o');
            }
            return text;
        } finally {
            await ai.files.del(file.id).catch(() => {});
        }
    }

    return `[Formato non supportato: ${mimeType}]`;
}

// ---------------------------------------------------------------------------
// Analisi documento (metadati + chunk in un'unica chiamata)
// ---------------------------------------------------------------------------

/**
 * Analizza il documento e restituisce tipo, profilo semantico, metadati e chunk.
 * Un'unica chiamata LLM per massima coerenza e efficienza.
 */
export async function analyzeDocument(extractedText, dbMetadata) {
    // Contesto aggiuntivo dal database Oracle
    const context = [];
    if (dbMetadata?.TIPO_DOCUMENTO) context.push(`Tipo DocLight: ${dbMetadata.TIPO_DOCUMENTO}`);
    if (dbMetadata?.DESCRIZIONE) context.push(`Descrizione: ${dbMetadata.DESCRIZIONE}`);
    if (dbMetadata?.ABSTRACT) context.push(`Abstract: ${dbMetadata.ABSTRACT}`);
    if (dbMetadata?.DATA_DOCUMENTO) context.push(`Data documento: ${dbMetadata.DATA_DOCUMENTO}`);
    if (dbMetadata?.UTENTE) context.push(`Utente: ${dbMetadata.UTENTE}`);

    const contextStr = context.length > 0 ? `METADATI DAL DATABASE:\n${context.join('\n')}\n\n` : '';

    const resp = await ai.chat.completions.create({
        model: ANALYSIS_MODEL,
        temperature: 0.1,
        max_completion_tokens: 16000,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_ANALYZE_DOCUMENT },
            {
                role: 'user',
                content: `${contextStr}TESTO DOCUMENTO:\n${truncateText(extractedText, 200000)}`,
            },
        ],
        response_format: { type: 'json_object' },
    });

    try {
        const result = JSON.parse(resp.choices[0].message.content);

        // Validazione minima
        if (!result.chunks || !Array.isArray(result.chunks) || result.chunks.length === 0) {
            result.chunks = [{
                type: 'contenuto',
                summary: result.semantic_profile || result.metadata?.oggetto || 'Contenuto del documento',
                text: extractedText,
            }];
        }

        return result;
    } catch {
        console.error('[openai] Errore parsing analisi documento');
        return {
            tipo_documento: 'altro',
            semantic_profile: dbMetadata?.DESCRIZIONE || '',
            metadata: {},
            chunks: [{
                type: 'contenuto',
                summary: dbMetadata?.DESCRIZIONE || 'Contenuto del documento',
                text: extractedText,
            }],
        };
    }
}

// ---------------------------------------------------------------------------
// Interpretazione query di ricerca
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers estrazione
// ---------------------------------------------------------------------------

const REFUSAL_PATTERNS = [
    'non posso estrarre', 'non posso leggere', 'non posso accedere',
    'non posso analizzare', 'non sono in grado', 'non ho accesso',
    'impossibile estrarre', 'impossibile leggere', 'copiarlo e incollarlo',
    'incollarlo qui', 'cannot extract', 'cannot read', 'i cannot',
    'i\'m unable', 'unable to extract', 'unable to read',
    'non è possibile', 'non riesco',
];

export function isRefusal(text) {
    if (!text || text.length < 20) return true;
    const lower = text.toLowerCase();
    return REFUSAL_PATTERNS.some(p => lower.includes(p));
}

async function extractViaResponsesApi(fileId, fileName, model) {
    const resp = await ai.responses.create({
        model,
        temperature: 0.1,
        instructions: SYSTEM_PROMPT_EXTRACT_TEXT,
        input: [{
            role: 'user',
            content: [
                { type: 'input_file', file_id: fileId },
                { type: 'input_text', text: `Estrai tutto il testo dal seguente documento: "${fileName}"` },
            ],
        }],
    });
    return resp.output_text?.trim() || '';
}

async function extractViaVision(fileBuffer, mimeType, fileName, model) {
    const base64 = fileBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const resp = await ai.chat.completions.create({
        model,
        temperature: 0.1,
        max_completion_tokens: 16000,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_EXTRACT_TEXT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `Estrai tutto il testo dal seguente documento: "${fileName}"` },
                    { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                ],
            },
        ],
    });
    return resp.choices[0].message.content?.trim() || '';
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function truncateText(text, maxChars) {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + '\n\n[... testo troncato ...]';
}

const EXT_TO_MIME = {
    '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.bmp': 'image/bmp',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
    '.xml': 'text/xml', '.json': 'application/json', '.rtf': 'application/rtf',
};

function guessMimeFromExtension(fileName) {
    if (!fileName) return null;
    const dotIdx = fileName.lastIndexOf('.');
    if (dotIdx < 0) return null;
    return EXT_TO_MIME[fileName.substring(dotIdx).toLowerCase()] || null;
}

const MIME_TO_EXT = Object.fromEntries(
    Object.entries(EXT_TO_MIME).map(([ext, mime]) => [mime, ext])
);

function ensureExtension(name, mime) {
    if (!name) name = 'document';
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
        const ext = name.substring(dotIdx).toLowerCase();
        if (Object.keys(EXT_TO_MIME).includes(ext)) return name;
    }
    const ext = MIME_TO_EXT[mime] || '.bin';
    return name + ext;
}
