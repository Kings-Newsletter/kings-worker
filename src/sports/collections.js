/**
 * Armazenamento do King's Sports.
 *
 * Tudo fica em UMA coleção (`sports`, ou MONGODB_COLLECTION) dentro do banco da
 * King's Newsletter. Cada documento tem um campo `type` que separa os tipos:
 * fixture, standings, history, api_usage, ingest_run, kv, crest, stats e article.
 * O portal nunca lê nem escreve nas coleções da Newsletter.
 *
 * A coleta e os importadores escrevem nesta coleção.
 */
export const COLLECTION_NAME = process.env.SPORTS_MONGODB_COLLECTION || 'sports';
/**
 * Visão de um tipo dentro da coleção compartilhada: injeta `type` em toda
 * consulta e escrita, para que um tipo nunca enxergue documentos de outro.
 */
class TypedView {
  collection;
  type;
  constructor(collection, type) {
    this.collection = collection;
    this.type = type;
  }
  scope(filter = {}) {
    return { ...filter, type: this.type };
  }
  find(filter = {}) {
    return this.collection.find(this.scope(filter));
  }
  findOne(filter) {
    return this.collection.findOne(this.scope(filter));
  }
  updateOne(filter, update, options) {
    const scoped = update;
    return this.collection.updateOne(
      this.scope(filter),
      { ...scoped, $set: { ...(scoped.$set ?? {}), type: this.type } },
      options
    );
  }
  deleteMany(filter) {
    return this.collection.deleteMany(this.scope(filter));
  }
  insertOne(doc) {
    return this.collection.insertOne({ ...doc, type: this.type });
  }
  aggregate(pipeline) {
    return this.collection.aggregate([{ $match: { type: this.type } }, ...pipeline]);
  }
  bulkWrite(operations, options) {
    const scoped = operations.map((operation) => {
      const op = operation;
      if ('updateOne' in op) {
        const update = op.updateOne.update;
        return {
          updateOne: {
            ...op.updateOne,
            filter: { ...op.updateOne.filter, type: this.type },
            update: { ...update, $set: { ...(update.$set ?? {}), type: this.type } }
          }
        };
      }
      if ('replaceOne' in op) {
        return {
          replaceOne: {
            ...op.replaceOne,
            filter: { ...op.replaceOne.filter, type: this.type },
            replacement: { ...op.replaceOne.replacement, type: this.type }
          }
        };
      }
      throw new Error('Operação não suportada na coleção compartilhada.');
    });
    return this.collection.bulkWrite(scoped, options);
  }
}
export function collections(db) {
  const shared = db.collection(COLLECTION_NAME);
  return {
    articles: new TypedView(shared, 'article'),
    fixtures: new TypedView(shared, 'fixture'),
    standings: new TypedView(shared, 'standings'),
    history: new TypedView(shared, 'history'),
    apiUsage: new TypedView(shared, 'api_usage'),
    ingestRuns: new TypedView(shared, 'ingest_run'),
    kv: new TypedView(shared, 'kv'),
    crests: new TypedView(shared, 'crest'),
    stats: new TypedView(shared, 'stats')
  };
}
let indexesReady = null;
/** Cria os índices uma vez por processo (idempotente). Todos começam por `type`. */
export function ensureIndexes(db) {
  if (!indexesReady) {
    const shared = db.collection(COLLECTION_NAME);
    indexesReady = Promise.all([
      shared.createIndex({ type: 1, kickoff: 1 }),
      shared.createIndex({ type: 1, sport: 1, kickoff: 1 }),
      shared.createIndex({ type: 1, competition: 1, kickoff: 1 }),
      shared.createIndex({ type: 1, status: 1, kickoff: 1 }),
      shared.createIndex({ type: 1, homeKey: 1, date: -1 }),
      shared.createIndex({ type: 1, awayKey: 1, date: -1 }),
      shared.createIndex({ type: 1, provider: 1, month: 1 }),
      shared.createIndex({ type: 1, publishedAt: -1 }),
      shared.createIndex({ type: 1, sport: 1, publishedAt: -1 }),
      shared.createIndex({ type: 1, competition: 1, publishedAt: -1 }),
      // Só documentos de execução têm `startedAt`: expiram em 30 dias.
      shared.createIndex({ startedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 })
    ]).then(() => undefined);
    indexesReady.catch(() => {
      indexesReady = null;
    });
  }
  return indexesReady;
}
