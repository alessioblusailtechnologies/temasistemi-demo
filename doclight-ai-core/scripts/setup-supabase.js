import 'dotenv/config';
import { getClient } from '../supabase.js';

/**
 * Script per creare la tabella e la funzione di ricerca su Supabase.
 *
 * PREREQUISITI:
 * 1. Abilitare l'estensione pgvector nel progetto Supabase:
 *    Dashboard → Database → Extensions → cerca "vector" → Enable
 *
 * 2. Eseguire questo script:
 *    npm run setup-supabase
 *
 * OPPURE eseguire manualmente il SQL sotto nel SQL Editor di Supabase.
 */

const SETUP_SQL = `
-- 1. Abilita estensione pgvector (se non già attiva)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Crea tabella documenti
CREATE TABLE IF NOT EXISTS doclight_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_file TEXT UNIQUE NOT NULL,
    embedding vector(2000),
    metadata JSONB DEFAULT '{}'::jsonb,
    semantic_profile TEXT DEFAULT '',
    db JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Crea indice HNSW per ricerca vettoriale (cosine similarity)
CREATE INDEX IF NOT EXISTS idx_doclight_embedding
    ON doclight_documents
    USING hnsw (embedding vector_cosine_ops);

-- 4. Crea indici GIN per filtri JSONB
CREATE INDEX IF NOT EXISTS idx_doclight_metadata
    ON doclight_documents USING gin (metadata);

CREATE INDEX IF NOT EXISTS idx_doclight_db
    ON doclight_documents USING gin (db);

-- 5. Indice sul nome file
CREATE INDEX IF NOT EXISTS idx_doclight_nome_file
    ON doclight_documents (nome_file);

-- 6. Disabilita RLS per permettere accesso con anon key
--    (oppure crea policy personalizzate se serve controllo accessi)
ALTER TABLE doclight_documents DISABLE ROW LEVEL SECURITY;

-- 7. Funzione di ricerca per similarità vettoriale
CREATE OR REPLACE FUNCTION match_documents(
    query_embedding vector(2000),
    match_threshold float DEFAULT 0.15,
    match_count int DEFAULT 20
)
RETURNS TABLE (
    id uuid,
    nome_file text,
    metadata jsonb,
    semantic_profile text,
    db jsonb,
    similarity float
)
LANGUAGE sql STABLE
AS $$
    SELECT
        d.id,
        d.nome_file,
        d.metadata,
        d.semantic_profile,
        d.db,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM doclight_documents d
    WHERE 1 - (d.embedding <=> query_embedding) > match_threshold
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
$$;
`;

async function main() {
    console.log('=== Setup Supabase per DocLight AI ===');
    console.log(`URL: ${process.env.SUPABASE_URL}`);
    console.log('');

    const sb = getClient();

    // Esegui il SQL di setup tramite la funzione rpc o direttamente
    // Nota: Supabase non permette SQL arbitrario via client JS.
    // Il SQL va eseguito nel SQL Editor della dashboard Supabase.

    console.log('IMPORTANTE: Esegui il seguente SQL nel SQL Editor di Supabase Dashboard:');
    console.log('');
    console.log('─'.repeat(70));
    console.log(SETUP_SQL);
    console.log('─'.repeat(70));
    console.log('');

    // Verifica se la tabella esiste già
    const { data, error } = await sb
        .from('doclight_documents')
        .select('id')
        .limit(1);

    if (error) {
        console.log('La tabella "doclight_documents" NON esiste ancora.');
        console.log('Copia ed esegui il SQL sopra nel SQL Editor di Supabase.');
    } else {
        console.log('La tabella "doclight_documents" esiste già.');

        // Conta documenti
        const { count } = await sb
            .from('doclight_documents')
            .select('*', { count: 'exact', head: true });

        console.log(`Documenti presenti: ${count || 0}`);
    }

    console.log('\nSetup completato.');
}

main().catch(err => {
    console.error('Errore:', err);
    process.exit(1);
});
