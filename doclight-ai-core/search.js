import 'dotenv/config';
import { embedText, interpretSearchQuery } from './openai.js';
import { searchDocuments } from './supabase.js';
import { getClient } from './supabase.js';

// ---------------------------------------------------------------------------
// Ricerca semantica pura (vettoriale)
// ---------------------------------------------------------------------------

/**
 * Esegue una ricerca semantica:
 * 1. Interpreta la query con GPT (arricchimento semantico)
 * 2. Genera embedding della query arricchita
 * 3. Cerca in Supabase con cosine similarity
 *
 * @param {string} userQuery  query in linguaggio naturale
 * @param {number} [topK=20]  numero risultati
 * @returns {Promise<Array>}  risultati con score e metadati
 */
export async function semanticSearch(userQuery, topK = 20) {
    console.log(`\n[search] Query: "${userQuery}"`);

    // 1. Arricchisci semanticamente la query
    console.log('[search] Interpretazione query...');
    const interpreted = await interpretSearchQuery(userQuery);
    const semanticQuery = interpreted.semantic_query || userQuery;
    console.log(`[search] Query arricchita: "${semanticQuery}"`);

    // 2. Genera embedding della query arricchita
    console.log('[search] Generazione embedding query...');
    const queryVector = await embedText(semanticQuery);

    // 3. Cerca in Supabase (ricerca vettoriale pura)
    console.log('[search] Ricerca vettoriale in Supabase...');
    const results = await searchDocuments(queryVector, topK);

    console.log(`[search] ${results.length} risultati trovati`);
    return results;
}

// ---------------------------------------------------------------------------
// Formattazione risultati
// ---------------------------------------------------------------------------

function formatResults(results) {
    return results.map((r, i) => {
        const lines = [
            `\n--- Risultato #${i + 1} (score: ${r.score.toFixed(4)}, ${r.score_percent.toFixed(1)}%) ---`,
            `File: ${r.nome_file}`,
        ];

        if (r.semantic_profile) lines.push(`Profilo: ${r.semantic_profile}`);

        if (r.metadata) {
            if (r.metadata.tipo_documento) lines.push(`Tipo: ${r.metadata.tipo_documento}`);
            if (r.metadata.data_documento) lines.push(`Data: ${r.metadata.data_documento}`);
            if (r.metadata.oggetto) lines.push(`Oggetto: ${r.metadata.oggetto}`);
            if (r.metadata.emittente?.ragione_sociale) lines.push(`Emittente: ${r.metadata.emittente.ragione_sociale}`);
            if (r.metadata.destinatario?.ragione_sociale) lines.push(`Destinatario: ${r.metadata.destinatario.ragione_sociale}`);
            if (r.metadata.importi?.totale) lines.push(`Importo: ${r.metadata.importi.totale} ${r.metadata.importi.valuta || 'EUR'}`);
            if (r.metadata.parole_chiave?.length) lines.push(`Keywords: ${r.metadata.parole_chiave.join(', ')}`);
        }

        if (r.matching_chunks?.length) {
            lines.push(`Chunk rilevanti:`);
            for (const ch of r.matching_chunks) {
                lines.push(`  - [${ch.type}] ${ch.summary} (${(ch.similarity * 100).toFixed(1)}%)`);
            }
        }

        return lines.join('\n');
    });
}

// ---------------------------------------------------------------------------
// Main - Demo ricerca
// ---------------------------------------------------------------------------

async function main() {
    const query = process.argv[2];
    if (!query) {
        console.log('Uso: node search.js "la tua query di ricerca"');
        console.log('');
        console.log('Esempi:');
        console.log('  node search.js "fatture fornitori 2024"');
        console.log('  node search.js "contratti di manutenzione impianti"');
        console.log('  node search.js "normative sicurezza sul lavoro"');
        process.exit(0);
    }

    getClient();

    const results = await semanticSearch(query, 10);
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
