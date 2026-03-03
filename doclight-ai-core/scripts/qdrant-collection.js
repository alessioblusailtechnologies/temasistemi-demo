import 'dotenv/config';
import { ensureCollection, getClient } from '../qdrant.js';

/**
 * Script per creare/verificare la collection Qdrant con tutti gli indici.
 * Eseguire una sola volta prima dell'ingestion:
 *
 *   npm run setup-qdrant
 */
async function main() {
    console.log('=== Setup Collection Qdrant ===');
    console.log(`URL: ${process.env.QDRANT_URL}`);
    console.log(`Collection: ${process.env.QDRANT_COLLECTION}`);
    console.log('');

    getClient();
    await ensureCollection();

    // Verifica
    const client = getClient();
    const info = await client.getCollection(process.env.QDRANT_COLLECTION || 'doclight_documents');
    console.log('\nInfo collection:');
    console.log(`  Vectors: ${info.vectors_count}`);
    console.log(`  Points: ${info.points_count}`);
    console.log(`  Status: ${info.status}`);
    console.log(`  Vector size: ${info.config?.params?.vectors?.size}`);
    console.log(`  Distance: ${info.config?.params?.vectors?.distance}`);

    console.log('\nSetup completato.');
}

main().catch(err => {
    console.error('Errore:', err);
    process.exit(1);
});
