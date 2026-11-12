/**
 * Banco MongoDB mínimo em memória para testes: cobre só as operações e os
 * operadores usados pela coleta do Sports.
 */

function get(doc, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

function compare(a, b) {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchesCondition(value, condition) {
  if (condition instanceof RegExp) return typeof value === 'string' && condition.test(value);
  if (condition && typeof condition === 'object' && !(condition instanceof Date) && !Array.isArray(condition)) {
    const keys = Object.keys(condition);
    if (keys.length > 0 && keys.every((key) => key.startsWith('$'))) {
      return keys.every((op) => {
        const arg = condition[op];
        switch (op) {
          case '$in':
            return arg.some((item) => compare(item, value) === 0);
          case '$nin':
            return !arg.some((item) => compare(item, value) === 0);
          case '$gte':
            return value != null && compare(value, arg) >= 0;
          case '$gt':
            return value != null && compare(value, arg) > 0;
          case '$lte':
            return value != null && compare(value, arg) <= 0;
          case '$lt':
            return value != null && compare(value, arg) < 0;
          case '$ne':
            return compare(value, arg) !== 0;
          case '$exists':
            return (value !== undefined) === Boolean(arg);
          case '$regex':
            return typeof value === 'string' && new RegExp(arg, condition.$options).test(value);
          case '$options':
            return true;
          default:
            throw new Error(`Operador não suportado no banco de teste: ${op}`);
        }
      });
    }
  }
  if (value instanceof Date || condition instanceof Date) return compare(value, condition) === 0;
  return value === condition;
}

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((sub) => matches(doc, sub));
    if (key === '$and') return condition.every((sub) => matches(doc, sub));
    return matchesCondition(get(doc, key), condition);
  });
}

function applyUpdate(doc, update) {
  for (const [key, value] of Object.entries(update.$set ?? {})) doc[key] = value;
  for (const [key, value] of Object.entries(update.$inc ?? {})) doc[key] = (doc[key] ?? 0) + value;
  for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
  return doc;
}

function seedFromFilter(filter) {
  return Object.fromEntries(Object.entries(filter).filter(([key, value]) => !key.startsWith('$') && (typeof value !== 'object' || value === null || value instanceof Date)));
}

class FakeCursor {
  constructor(docs) {
    this.docs = docs;
  }
  sort(spec) {
    const [[key, dir]] = Object.entries(spec);
    this.docs.sort((a, b) => compare(get(a, key), get(b, key)) * dir);
    return this;
  }
  limit(count) {
    this.docs = this.docs.slice(0, count);
    return this;
  }
  project() {
    return this;
  }
  async toArray() {
    return this.docs.map((doc) => structuredClone(doc));
  }
}

export class FakeCollection {
  constructor() {
    this.docs = [];
    this.indexes = [];
  }
  async createIndex(spec, options) {
    this.indexes.push({ spec, options });
    return 'index';
  }
  find(filter = {}) {
    return new FakeCursor(this.docs.filter((doc) => matches(doc, filter)));
  }
  async findOne(filter = {}) {
    const doc = this.docs.find((item) => matches(item, filter));
    return doc ? structuredClone(doc) : null;
  }
  async insertOne(doc) {
    this.docs.push(structuredClone(doc));
    return { acknowledged: true };
  }
  async updateOne(filter, update, options = {}) {
    const doc = this.docs.find((item) => matches(item, filter));
    if (doc) {
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    const created = applyUpdate(seedFromFilter(filter), { ...update, $set: { ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) } });
    this.docs.push(created);
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
  }
  async deleteMany(filter) {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matches(doc, filter));
    return { deletedCount: before - this.docs.length };
  }
  aggregate(pipeline) {
    let docs = this.docs.slice();
    for (const stage of pipeline) {
      if (stage.$match) docs = docs.filter((doc) => matches(doc, stage.$match));
      else if (stage.$group) {
        const [[field, spec]] = Object.entries(stage.$group).filter(([key]) => key !== '_id');
        const source = spec.$sum.replace(/^\$/, '');
        docs = docs.length ? [{ _id: null, [field]: docs.reduce((sum, doc) => sum + (get(doc, source) ?? 0), 0) }] : [];
      } else throw new Error('Estágio de agregação não suportado no banco de teste.');
    }
    return new FakeCursor(docs);
  }
  async bulkWrite(operations) {
    let upserted = 0;
    let modified = 0;
    for (const op of operations) {
      if (op.updateOne) {
        const result = await this.updateOne(op.updateOne.filter, op.updateOne.update, op.updateOne);
        upserted += result.upsertedCount;
        modified += result.modifiedCount;
      } else if (op.replaceOne) {
        const index = this.docs.findIndex((doc) => matches(doc, op.replaceOne.filter));
        if (index >= 0) {
          this.docs[index] = structuredClone(op.replaceOne.replacement);
          modified += 1;
        } else if (op.replaceOne.upsert) {
          this.docs.push(structuredClone(op.replaceOne.replacement));
          upserted += 1;
        }
      }
    }
    return { upsertedCount: upserted, modifiedCount: modified, matchedCount: modified };
  }
}

export function createFakeDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new FakeCollection());
      return collections.get(name);
    },
    collections
  };
}
