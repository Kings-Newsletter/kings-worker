/**
 * Conexão do King's Sports com o MongoDB.
 *
 * Usa o mesmo cluster e banco da King's Newsletter, mas só a coleção do Sports
 * (SPORTS_MONGODB_COLLECTION, padrão `sports`; ver collections.js).
 */
export function createSportsDatabase({
  uri = process.env.MONGODB_URI,
  dbName = process.env.SPORTS_MONGODB_DB || 'kings_newsletter',
  clientFactory
} = {}) {
  let client = null;
  let dbPromise = null;

  return {
    get isConfigured() {
      return Boolean(uri?.trim());
    },

    async getDb() {
      if (!uri?.trim()) throw new Error('MONGODB_URI não configurada.');
      if (!dbPromise) {
        dbPromise = (async () => {
          let createClient = clientFactory;
          if (!createClient) {
            const { MongoClient } = await import('mongodb');
            createClient = (connectionUri) =>
              new MongoClient(connectionUri, {
                appName: 'kings-sports-ingest',
                maxPoolSize: 10,
                serverSelectionTimeoutMS: 10000
              });
          }
          client = createClient(uri);
          await client.connect();
          return client.db(dbName);
        })().catch(async (error) => {
          const failed = client;
          client = null;
          dbPromise = null;
          if (failed) await failed.close().catch(() => {});
          throw error;
        });
      }
      return dbPromise;
    },

    async close() {
      const current = client;
      client = null;
      dbPromise = null;
      if (current) await current.close().catch(() => {});
    }
  };
}
