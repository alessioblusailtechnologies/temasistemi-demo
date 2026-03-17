import 'dotenv/config';
import { getClient } from '../supabase.js';

const SETUP_SQL = `
-- ═══ TABELLE AGENTS ═══

-- 1. Tabella agents (definizione agenti)
CREATE TABLE IF NOT EXISTS doclight_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'scheduled')),
    cron_expression TEXT,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE doclight_agents DISABLE ROW LEVEL SECURITY;

-- 2. Tabella esecuzioni agents
CREATE TABLE IF NOT EXISTS doclight_agent_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES doclight_agents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    result TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_executions_agent_id ON doclight_agent_executions (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_executions_started_at ON doclight_agent_executions (started_at DESC);
ALTER TABLE doclight_agent_executions DISABLE ROW LEVEL SECURITY;

-- 3. Trigger per aggiornare updated_at automaticamente
CREATE OR REPLACE FUNCTION update_agent_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_updated_at ON doclight_agents;
CREATE TRIGGER trg_agent_updated_at
    BEFORE UPDATE ON doclight_agents
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_updated_at();
`;

async function main() {
    console.log('=== Setup tabelle Agents per DocLight AI ===');
    console.log(`URL: ${process.env.SUPABASE_URL}\n`);

    console.log('Esegui questo SQL nel SQL Editor di Supabase:\n');
    console.log('─'.repeat(70));
    console.log(SETUP_SQL);
    console.log('─'.repeat(70));

    const sb = getClient();

    // Verifica se le tabelle esistono già
    const { error: e1 } = await sb.from('doclight_agents').select('id').limit(1);
    const { error: e2 } = await sb.from('doclight_agent_executions').select('id').limit(1);

    if (e1 || e2) {
        console.log('\nTabelle agents NON trovate. Esegui il SQL sopra nel SQL Editor di Supabase.');
    } else {
        const { count: agentCount } = await sb.from('doclight_agents').select('*', { count: 'exact', head: true });
        const { count: execCount } = await sb.from('doclight_agent_executions').select('*', { count: 'exact', head: true });
        console.log(`\nAgents: ${agentCount || 0}, Esecuzioni: ${execCount || 0}`);
        console.log('Tabelle già presenti!');
    }
}

main().catch(err => { console.error('Errore:', err); process.exit(1); });
