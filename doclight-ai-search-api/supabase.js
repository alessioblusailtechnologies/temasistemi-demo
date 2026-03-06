import { createClient } from '@supabase/supabase-js';

let client = null;

export function getClient() {
    if (client) return client;
    client = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
    );
    return client;
}

/**
 * Ricerca vettoriale con filtri opzionali.
 * Restituisce risultati con score e payload (nome_file, metadata, semantic_profile).
 */
export async function searchDocuments(queryVector, filter = null, topK = 20) {
    const sb = getClient();

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
        score_percent: +(r.similarity * 100).toFixed(1),
        nome_file: r.nome_file,
        metadata: r.metadata,
        semantic_profile: r.semantic_profile,
    }));
}

// ---------------------------------------------------------------------------
// Filtri (must/should/must_not → JavaScript)
// ---------------------------------------------------------------------------

function applyFilters(results, filter) {
    return results.filter(doc => {
        if (filter.must?.length) {
            if (!filter.must.every(c => matchCondition(doc, c))) return false;
        }
        if (filter.must_not?.length) {
            if (filter.must_not.some(c => matchCondition(doc, c))) return false;
        }
        if (filter.should?.length) {
            if (!filter.should.some(c => matchCondition(doc, c))) return false;
        }
        return true;
    });
}

function matchCondition(doc, condition) {
    const value = getNestedValue(doc, condition.key);

    if (condition.match?.value !== undefined) {
        if (value == null) return false;
        return String(value).toLowerCase() === String(condition.match.value).toLowerCase();
    }

    if (condition.match?.text !== undefined) {
        if (value == null) return false;
        return String(value).toLowerCase().includes(String(condition.match.text).toLowerCase());
    }

    if (condition.range) {
        if (value == null) return false;
        const numVal = parseFloat(value);
        if (!isNaN(numVal)) {
            if (condition.range.gte !== undefined && numVal < parseFloat(condition.range.gte)) return false;
            if (condition.range.lte !== undefined && numVal > parseFloat(condition.range.lte)) return false;
        } else {
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
