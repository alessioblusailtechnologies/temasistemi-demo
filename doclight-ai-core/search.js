import 'dotenv/config';
import { embedText, interpretSearchQuery } from './openai.js';
import { searchDocuments } from './supabase.js';
import { getClient } from './supabase.js';

// ---------------------------------------------------------------------------
// Ricerca ibrida: semantica + filtri strutturati
// ---------------------------------------------------------------------------

/**
 * Esegue una ricerca ibrida su Supabase:
 * 1. Interpreta la query con GPT-4o (estrae parte semantica + filtri)
 * 2. Genera embedding della query semantica
 * 3. Cerca in Supabase con vector + filtri
 *
 * @param {string} userQuery  query in linguaggio naturale
 * @param {number} [topK=20]  numero risultati
 * @returns {Promise<Array>}  risultati con score e metadati
 */
export async function hybridSearch(userQuery, topK = 20) {
    console.log(`\n[search] Query: "${userQuery}"`);

    // 1. Interpreta query con AI
    console.log('[search] Interpretazione query...');
    const interpreted = await interpretSearchQuery(userQuery);
    console.log('[search] Interpretato:', JSON.stringify(interpreted, null, 2));

    const semanticQuery = interpreted.semantic_query || userQuery;
    const filters = interpreted.filters || {};

    // 2. Genera embedding della query semantica
    console.log('[search] Generazione embedding query...');
    const queryVector = await embedText(semanticQuery);

    // 3. Costruisci filtro Supabase
    const searchFilter = buildSupabaseFilter(filters);

    // 4. Cerca in Supabase
    console.log('[search] Ricerca vettoriale in Supabase...');
    const results = await searchDocuments(queryVector, searchFilter, topK);

    console.log(`[search] ${results.length} risultati trovati`);
    return results;
}

/**
 * Ricerca solo semantica (senza interpretazione filtri AI)
 */
export async function semanticSearch(query, topK = 20) {
    const queryVector = await embedText(query);
    return searchDocuments(queryVector, null, topK);
}

/**
 * Ricerca con filtri manuali
 */
export async function filteredSearch(query, manualFilters, topK = 20) {
    const queryVector = await embedText(query);
    return searchDocuments(queryVector, manualFilters, topK);
}

// ---------------------------------------------------------------------------
// Costruzione filtri Supabase dal formato AI
// ---------------------------------------------------------------------------

function buildSupabaseFilter(filters) {
    if (!filters || (!filters.must && !filters.should && !filters.must_not)) {
        return null;
    }

    const searchFilter = {};

    if (filters.must && filters.must.length > 0) {
        searchFilter.must = filters.must.map(convertCondition);
    }
    if (filters.should && filters.should.length > 0) {
        searchFilter.should = filters.should.map(convertCondition);
    }
    if (filters.must_not && filters.must_not.length > 0) {
        searchFilter.must_not = filters.must_not.map(convertCondition);
    }

    return Object.keys(searchFilter).length > 0 ? searchFilter : null;
}

function convertCondition(cond) {
    if (cond.match) {
        return { key: cond.key, match: cond.match };
    }
    if (cond.range) {
        return { key: cond.key, range: cond.range };
    }
    // Fulltext match per campi testo
    if (cond.match_text) {
        return { key: cond.key, match: { text: cond.match_text } };
    }
    return cond;
}

// ---------------------------------------------------------------------------
// Formattazione risultati
// ---------------------------------------------------------------------------

function formatResults(results) {
    return results.map((r, i) => {
        const lines = [
            `\n--- Risultato #${i + 1} (score: ${r.score.toFixed(4)}, ${r.scorePercent}%) ---`,
            `File: ${r.nomeFile}`,
            `Profilo: ${r.semanticProfile}`,
        ];

        if (r.metadata) {
            if (r.metadata.tipo_documento) lines.push(`Tipo: ${r.metadata.tipo_documento}`);
            if (r.metadata.data_documento) lines.push(`Data: ${r.metadata.data_documento}`);
            if (r.metadata.oggetto) lines.push(`Oggetto: ${r.metadata.oggetto}`);
            if (r.metadata.emittente?.ragione_sociale) lines.push(`Emittente: ${r.metadata.emittente.ragione_sociale}`);
            if (r.metadata.destinatario?.ragione_sociale) lines.push(`Destinatario: ${r.metadata.destinatario.ragione_sociale}`);
            if (r.metadata.importi?.totale) lines.push(`Importo: ${r.metadata.importi.totale} ${r.metadata.importi.valuta || 'EUR'}`);
            if (r.metadata.parole_chiave?.length) lines.push(`Keywords: ${r.metadata.parole_chiave.join(', ')}`);
        }

        if (r.db) {
            lines.push(`[DB] Tipo: ${r.db.tipo_documento}, Società: ${r.db.societa}, Utente: ${r.db.utente}`);
        }

        return lines.join('\n');
    });
}

// ---------------------------------------------------------------------------
// Main - Demo ricerca interattiva
// ---------------------------------------------------------------------------

async function main() {
    const query = process.argv[2];
    if (!query) {
        console.log('Uso: node search.js "la tua query di ricerca"');
        console.log('');
        console.log('Esempi:');
        console.log('  node search.js "fatture fornitori 2024"');
        console.log('  node search.js "contratti di manutenzione impianti"');
        console.log('  node search.js "documenti con importo superiore a 50000 euro"');
        console.log('  node search.js "DDT spedizioni mese scorso"');
        process.exit(0);
    }

    // Verifica connessione Supabase
    getClient();

    const results = await hybridSearch(query, 10);
    const formatted = formatResults(results);

    console.log('\n===== RISULTATI RICERCA =====');
    formatted.forEach(r => console.log(r));

    if (results.length === 0) {
        console.log('\nNessun risultato trovato per la query.');
    }
}

main().catch(err => {
    console.error('Errore:', err);
    process.exit(1);
});
