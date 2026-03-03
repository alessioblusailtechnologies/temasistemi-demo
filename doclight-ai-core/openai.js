import OpenAI, { toFile } from 'openai';
import {
    SYSTEM_PROMPT_EXTRACT_TEXT,
    SYSTEM_PROMPT_SEMANTIC_PROFILE,
    SYSTEM_PROMPT_EXTRACT_METADATA,
    SYSTEM_PROMPT_SEARCH_QUERY,
} from './prompt-util.js';

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * Genera embedding vettoriale da testo
 * @param {string} text
 * @returns {Promise<number[]>} vettore 3072 dimensioni
 */
export async function embedText(text) {
    const res = await ai.embeddings.create({
        model: 'text-embedding-3-large',
        input: text,
    });
    return res.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Estrazione testo da documenti
// ---------------------------------------------------------------------------

/**
 * Estrae il testo da un file binario usando GPT-4o.
 * - PDF e immagini: inviati come base64 image (vision)
 * - Testo plain: restituito direttamente
 *
 * @param {Buffer} fileBuffer   contenuto binario del file
 * @param {string} mimeType     mime type (application/pdf, image/png, ecc.)
 * @param {string} fileName     nome file per contesto
 * @returns {Promise<string>}   testo estratto
 */
export async function extractTextFromFile(fileBuffer, mimeType, fileName) {
    if (!fileBuffer || fileBuffer.length === 0) {
        return '[Documento vuoto - nessun contenuto binario disponibile]';
    }

    const mime = (mimeType || '').toLowerCase();

    // Assicura che il filename abbia l'estensione corretta per OpenAI
    const safeFileName = ensureExtension(fileName, mime);

    // Testo plain / XML / HTML → decodifica diretta
    if (mime.startsWith('text/') || mime.includes('xml') || mime.includes('html') || mime.includes('json')) {
        return fileBuffer.toString('utf-8');
    }

    // CSV
    if (mime.includes('csv')) {
        return fileBuffer.toString('utf-8');
    }

    // PDF → upload file + Responses API (supporta PDF nativamente)
    if (mime.includes('pdf')) {
        const file = await ai.files.create({
            file: await toFile(fileBuffer, safeFileName, { type: 'application/pdf' }),
            purpose: 'assistants',
        });

        try {
            const resp = await ai.responses.create({
                model: 'gpt-4o-mini',
                temperature: 0.1,
                instructions: SYSTEM_PROMPT_EXTRACT_TEXT,
                input: [
                    {
                        role: 'user',
                        content: [
                            { type: 'input_file', file_id: file.id },
                            { type: 'input_text', text: `Estrai tutto il testo dal seguente documento: "${fileName}"` },
                        ],
                    },
                ],
            });
            return resp.output_text?.trim() || '';
        } finally {
            await ai.files.del(file.id).catch(() => {});
        }
    }

    // Immagini → GPT-4o vision (base64)
    const supportedImages = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    if (supportedImages.some(s => mime.includes(s.split('/')[1]))) {
        const base64 = fileBuffer.toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;

        const resp = await ai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.1,
            max_tokens: 16000,
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

    // Formati Office (docx, xlsx, pptx) → upload file + Responses API
    const officeTypes = ['spreadsheet', 'wordprocessing', 'presentation', 'msword', 'ms-excel', 'ms-powerpoint'];
    if (officeTypes.some(t => mime.includes(t))) {
        const file = await ai.files.create({
            file: await toFile(fileBuffer, safeFileName, { type: mimeType }),
            purpose: 'assistants',
        });

        try {
            const resp = await ai.responses.create({
                model: 'gpt-4o-mini',
                temperature: 0.1,
                instructions: SYSTEM_PROMPT_EXTRACT_TEXT,
                input: [
                    {
                        role: 'user',
                        content: [
                            { type: 'input_file', file_id: file.id },
                            { type: 'input_text', text: `Estrai tutto il testo dal seguente documento: "${fileName}"` },
                        ],
                    },
                ],
            });
            return resp.output_text?.trim() || '';
        } finally {
            await ai.files.del(file.id).catch(() => {});
        }
    }

    return `[Formato non supportato: ${mimeType}]`;
}

// ---------------------------------------------------------------------------
// Profilo semantico (breve, per embedding)
// ---------------------------------------------------------------------------

/**
 * Genera un profilo semantico breve dal testo estratto + metadati DB
 * @param {string} extractedText  testo estratto dal documento
 * @param {object} dbMetadata     metadati dal database (DS_DOC, CD_TIP, ecc.)
 * @returns {Promise<string>}     profilo semantico 3-5 frasi
 */
export async function generateSemanticProfile(extractedText, dbMetadata) {
    const context = [
        `Tipo documento DocLight: ${dbMetadata.TIPO_DOCUMENTO || 'n/d'}`,
        `Descrizione DB: ${dbMetadata.DESCRIZIONE || 'n/d'}`,
        `Abstract DB: ${dbMetadata.ABSTRACT || 'n/d'}`,
        `Data documento: ${dbMetadata.DATA_DOCUMENTO || 'n/d'}`,
        `Utente: ${dbMetadata.UTENTE || 'n/d'}`,
    ].join('\n');

    const resp = await ai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 500,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_SEMANTIC_PROFILE },
            {
                role: 'user',
                content: `METADATI DATABASE:\n${context}\n\nTESTO DOCUMENTO:\n${truncateText(extractedText, 12000)}`,
            },
        ],
    });
    return resp.choices[0].message.content?.trim() || '';
}

// ---------------------------------------------------------------------------
// Estrazione metadati strutturati
// ---------------------------------------------------------------------------

/**
 * Estrae metadati strutturati (date, importi, soggetti, ecc.) dal testo
 * @param {string} extractedText  testo estratto dal documento
 * @param {object} dbMetadata     metadati dal database
 * @returns {Promise<object>}     JSON con metadati strutturati
 */
export async function extractStructuredMetadata(extractedText, dbMetadata) {
    const context = [
        `Nome file: ${dbMetadata.NOME_FILE || 'n/d'}`,
        `Tipo documento DocLight: ${dbMetadata.TIPO_DOCUMENTO || 'n/d'}`,
        `Descrizione DB: ${dbMetadata.DESCRIZIONE || 'n/d'}`,
        `Data inserimento: ${dbMetadata.DATA_INSERIMENTO || 'n/d'}`,
        `Data documento: ${dbMetadata.DATA_DOCUMENTO || 'n/d'}`,
    ].join('\n');

    const resp = await ai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.1,
        max_tokens: 4000,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT_EXTRACT_METADATA },
            {
                role: 'user',
                content: `METADATI DATABASE:\n${context}\n\nTESTO DOCUMENTO:\n${truncateText(extractedText, 12000)}`,
            },
        ],
        response_format: { type: 'json_object' },
    });

    try {
        return JSON.parse(resp.choices[0].message.content);
    } catch {
        console.error('[openai] Errore parsing JSON metadati:', resp.choices[0].message.content);
        return {};
    }
}

// ---------------------------------------------------------------------------
// Interpretazione query di ricerca
// ---------------------------------------------------------------------------

/**
 * Interpreta una query in linguaggio naturale e genera filtri Qdrant
 * @param {string} query  query utente
 * @returns {Promise<{semantic_query: string, filters: object}>}
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

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function truncateText(text, maxChars) {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + '\n\n[... testo troncato per limite token ...]';
}

const MIME_TO_EXT = {
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/tiff': '.tiff',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/html': '.html',
    'text/xml': '.xml',
    'application/xml': '.xml',
    'application/json': '.json',
    'application/rtf': '.rtf',
};

/**
 * Assicura che il filename abbia l'estensione corretta in base al mime type.
 * OpenAI rifiuta file senza estensione riconosciuta.
 */
function ensureExtension(name, mime) {
    if (!name) name = 'document';
    // Se ha già un'estensione nota, ok
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
        const ext = name.substring(dotIdx).toLowerCase();
        if (Object.values(MIME_TO_EXT).includes(ext)) return name;
    }
    // Aggiunge estensione dal mime type
    const ext = MIME_TO_EXT[mime] || MIME_TO_EXT[Object.keys(MIME_TO_EXT).find(k => mime.includes(k.split('/')[1]))] || '.bin';
    return name + ext;
}
