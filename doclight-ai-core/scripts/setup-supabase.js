import 'dotenv/config';
import { getClient } from '../supabase.js';

const SETUP_SQL = `
-- 1. Estensione pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Tabella documenti (solo metadati, no embedding)
DROP TABLE IF EXISTS doclight_chunks;
DROP TABLE IF EXISTS doclight_documents;

CREATE TABLE doclight_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_file TEXT UNIQUE NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    semantic_profile TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_doc_nome_file ON doclight_documents (nome_file);
ALTER TABLE doclight_documents DISABLE ROW LEVEL SECURITY;

-- 3. Tabella chunk (embedding 3072 dims, scansione sequenziale per massima precisione)
CREATE TABLE doclight_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_file TEXT NOT NULL,
    chunk_index INT NOT NULL,
    chunk_type TEXT DEFAULT 'contenuto',
    chunk_summary TEXT DEFAULT '',
    chunk_text TEXT NOT NULL,
    embedding vector(3072),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(nome_file, chunk_index)
);

CREATE INDEX idx_chunks_nome_file ON doclight_chunks (nome_file);
ALTER TABLE doclight_chunks DISABLE ROW LEVEL SECURITY;

-- NOTA: Non usiamo indice HNSW (limite 2000 dims su Supabase).
-- La scansione sequenziale dà risultati ESATTI (non approssimati).
-- Per dataset > 50K chunk, aggiungere indice IVFFlat:
-- CREATE INDEX idx_chunks_embedding ON doclight_chunks
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 4. Funzione di ricerca vettoriale
CREATE OR REPLACE FUNCTION match_chunks(
    query_embedding vector(3072),
    match_threshold float DEFAULT 0.15,
    match_count int DEFAULT 50
)
RETURNS TABLE (
    chunk_id uuid,
    nome_file text,
    chunk_type text,
    chunk_summary text,
    chunk_text text,
    similarity float
)
LANGUAGE sql STABLE
AS $$
    SELECT
        id AS chunk_id,
        nome_file,
        chunk_type,
        chunk_summary,
        chunk_text,
        1 - (embedding <=> query_embedding) AS similarity
    FROM doclight_chunks
    WHERE 1 - (embedding <=> query_embedding) > match_threshold
    ORDER BY embedding <=> query_embedding
    LIMIT match_count;
$$;
`;

async function main() {
    console.log('=== Setup Supabase per DocLight AI ===');
    console.log(`URL: ${process.env.SUPABASE_URL}\n`);

    console.log('Esegui questo SQL nel SQL Editor di Supabase:\n');
    console.log('─'.repeat(70));
    console.log(SETUP_SQL);
    console.log('─'.repeat(70));

    const sb = getClient();

    const { error: e1 } = await sb.from('doclight_documents').select('id').limit(1);
    const { error: e2 } = await sb.from('doclight_chunks').select('id').limit(1);

    if (e1 || e2) {
        console.log('\nTabelle NON trovate. Esegui il SQL sopra.');
    } else {
        const { count: docCount } = await sb.from('doclight_documents').select('*', { count: 'exact', head: true });
        const { count: chunkCount } = await sb.from('doclight_chunks').select('*', { count: 'exact', head: true });
        console.log(`\nDocumenti: ${docCount || 0}, Chunk: ${chunkCount || 0}`);
    }
}

main().catch(err => { console.error('Errore:', err); process.exit(1); });
