import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

let client = null;

/**
 * Inizializza il client Supabase
 */
export function getClient() {
    if (client) return client;
    client = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
    );
    return client;
}

const TABLE = 'doclight_documents';

// ---------------------------------------------------------------------------
// Verifica connessione
// ---------------------------------------------------------------------------

/**
 * Verifica che la tabella esista e la connessione funzioni
 */
export async function ensureTable() {
    const sb = getClient();
    const { error } = await sb.from(TABLE).select('id').limit(1);
    if (error) {
        throw new Error(`[supabase] Connessione fallita o tabella "${TABLE}" non trovata: ${error.message}`);
    }
    console.log(`[supabase] Tabella "${TABLE}" verificata`);
}

// ---------------------------------------------------------------------------
// Upsert documenti
// ---------------------------------------------------------------------------

/**
 * Inserisce/aggiorna un documento nella tabella Supabase.
 */
export async function upsertDocument({ id, vector, metadata, semanticProfile, db }) {
    const sb = getClient();
    const { error } = await sb.from(TABLE).upsert({
        id: stringToUuid(id),
        nome_file: id,
        embedding: JSON.stringify(vector),
        metadata: metadata || {},
        semantic_profile: semanticProfile || '',
        db: db || {},
    }, { onConflict: 'nome_file' });

    if (error) {
        console.error(`[supabase] Upsert fallito per "${id}":`, error.message);
        throw error;
    }
}

/**
 * Upsert batch di documenti
 */
export async function upsertDocumentsBatch(documents) {
    const sb = getClient();
    const rows = documents.map(doc => ({
        id: stringToUuid(doc.id),
        nome_file: doc.id,
        embedding: JSON.stringify(doc.vector),
        metadata: doc.metadata || {},
        semantic_profile: doc.semanticProfile || '',
        db: doc.db || {},
    }));

    const { error } = await sb.from(TABLE).upsert(rows, { onConflict: 'nome_file' });
    if (error) throw error;
}

// ---------------------------------------------------------------------------
// Ricerca
// ---------------------------------------------------------------------------

/**
 * Ricerca vettoriale con filtri opzionali
 * @param {number[]} queryVector   embedding della query
 * @param {object} [filter]        filtri (must/should/must_not)
 * @param {number} [topK=20]       numero risultati
 * @returns {Promise<Array>}       risultati con score e payload
 */
export async function searchDocuments(queryVector, filter = null, topK = 20) {
    const sb = getClient();

    // Se ci sono filtri, recupera più risultati per compensare il filtraggio post-query
    const fetchCount = filter ? Math.min(topK * 5, 200) : topK;

    const { data, error } = await sb.rpc('match_documents', {
        query_embedding: JSON.stringify(queryVector),
        match_threshold: 0.15,
        match_count: fetchCount,
    });

    if (error) {
        console.error('[supabase] Ricerca fallita:', error.message);
        throw error;
    }

    let results = data || [];

    // Applica filtri in JavaScript
    if (filter && Object.keys(filter).length > 0) {
        results = applyFilters(results, filter);
    }

    return results.slice(0, topK).map(r => ({
        score: r.similarity,
        scorePercent: +(r.similarity * 100).toFixed(1),
        nomeFile: r.nome_file,
        metadata: r.metadata,
        db: r.db,
        semanticProfile: r.semantic_profile,
    }));
}

/**
 * Recupera un documento per nome file
 */
export async function getDocumentByName(nomeFile) {
    const sb = getClient();
    const { data, error } = await sb
        .from(TABLE)
        .select('nome_file, metadata, semantic_profile, db')
        .eq('nome_file', nomeFile)
        .limit(1)
        .single();

    if (error) return null;
    return data;
}

// ---------------------------------------------------------------------------
// Filtri (must/should/must_not → JavaScript)
// ---------------------------------------------------------------------------

function applyFilters(results, filter) {
    return results.filter(doc => {
        // must: tutte le condizioni devono essere vere (AND)
        if (filter.must?.length) {
            if (!filter.must.every(c => matchCondition(doc, c))) return false;
        }

        // must_not: nessuna condizione deve essere vera (NOT)
        if (filter.must_not?.length) {
            if (filter.must_not.some(c => matchCondition(doc, c))) return false;
        }

        // should: almeno una condizione deve essere vera (OR)
        if (filter.should?.length) {
            if (!filter.should.some(c => matchCondition(doc, c))) return false;
        }

        return true;
    });
}

function matchCondition(doc, condition) {
    const value = getNestedValue(doc, condition.key);

    // Match esatto (keyword)
    if (condition.match?.value !== undefined) {
        if (value == null) return false;
        return String(value).toLowerCase() === String(condition.match.value).toLowerCase();
    }

    // Match parziale (text)
    if (condition.match?.text !== undefined) {
        if (value == null) return false;
        return String(value).toLowerCase().includes(String(condition.match.text).toLowerCase());
    }

    // Range (numerico o data)
    if (condition.range) {
        if (value == null) return false;
        const numVal = parseFloat(value);

        if (!isNaN(numVal)) {
            // Confronto numerico
            if (condition.range.gte !== undefined && numVal < parseFloat(condition.range.gte)) return false;
            if (condition.range.lte !== undefined && numVal > parseFloat(condition.range.lte)) return false;
        } else {
            // Confronto date
            const dateVal = new Date(value);
            if (isNaN(dateVal.getTime())) return false;
            if (condition.range.gte && dateVal < new Date(condition.range.gte)) return false;
            if (condition.range.lte && dateVal > new Date(condition.range.lte)) return false;
        }
        return true;
    }

    return true;
}

function getNestedValue(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/**
 * Converte una stringa in un UUID deterministico
 */
function stringToUuid(str) {
    const hash = crypto.createHash('md5').update(str).digest('hex');
    return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        '4' + hash.substring(13, 16),
        '8' + hash.substring(17, 20),
        hash.substring(20, 32),
    ].join('-');
}
