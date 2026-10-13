import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSubscriberStore, normalizeSubscriberEmail } from '../src/clients/subscribers.js';

function fakeMongo() {
  const documents = new Map();
  let connected = false;
  let indexOptions;
  const collection = {
    async createIndex(keys, options) {
      indexOptions = { keys, options };
      return 'email_1';
    },
    async findOne(filter) {
      const document = documents.get(filter.email);
      if (!document) return null;
      return { _id: document.email, email: document.email, confirmed: document.confirmed };
    },
    async updateOne(filter, update, options = {}) {
      let document = documents.get(filter.email);
      const matches = Boolean(document) && (
        filter.confirmed?.$ne === true ? document.confirmed !== true :
        filter.confirmed === true ? document.confirmed === true : true
      );
      if (!matches && document && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      if (!matches && document && options.upsert) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      if (!matches && !document && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      if (!document && options.upsert) {
        document = { ...update.$setOnInsert };
        documents.set(filter.email, document);
      }
      Object.assign(document, update.$set || {});
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: options.upsert && !matches ? 1 : 0 };
    },
    find(_filter, options) {
      return {
        sort() { return this; },
        limit() { return this; },
        async toArray() {
          return [...documents.values()].map(({ email, confirmed, subscribedAt, confirmedAt }) => ({ email, confirmed, subscribedAt, confirmedAt }))
            .filter(document => options.projection.email && document.email);
        }
      };
    }
  };
  const client = {
    async connect() { connected = true; },
    db(name) {
      assert.equal(name, 'kings_newsletter');
      return { collection(name) { assert.equal(name, 'subscribers'); return collection; } };
    },
    async close() { connected = false; }
  };
  return { documents, client, get connected() { return connected; }, get indexOptions() { return indexOptions; } };
}

function createTestStore() {
  const mongo = fakeMongo();
  const store = createSubscriberStore({
    uri: 'mongodb://test.invalid',
    clientFactory: () => mongo.client,
    now: () => new Date('2026-10-13T12:00:00.000Z'),
    tokenFactory: () => 'a'.repeat(64)
  });
  return { mongo, store };
}

test('normalizes email and rejects invalid values', () => {
  assert.equal(normalizeSubscriberEmail('  NEWS@Example.COM '), 'news@example.com');
  assert.equal(normalizeSubscriberEmail('bad-address'), null);
  assert.equal(normalizeSubscriberEmail('x'.repeat(250) + '@example.com'), null);
  assert.equal(normalizeSubscriberEmail(null), null);
});

test('connects only to the expected database and creates a unique email index', async () => {
  const { mongo, store } = createTestStore();
  await store.list();
  assert.equal(mongo.connected, true);
  assert.deepEqual(mongo.indexOptions, { keys: { email: 1 }, options: { unique: true } });
  await store.close();
  assert.equal(mongo.connected, false);
});

test('lists only public subscriber fields and never exposes unsubscribe tokens', async () => {
  const { mongo, store } = createTestStore();
  mongo.documents.set('reader@example.com', {
    email: 'reader@example.com',
    confirmed: true,
    subscribedAt: new Date('2026-10-01T00:00:00.000Z'),
    confirmedAt: new Date('2026-10-01T00:00:00.000Z'),
    unsubscribeTokenHash: 'must-not-leak',
    confirmationTokenHash: 'must-not-leak-either'
  });
  const [subscriber] = await store.list();
  assert.deepEqual(Object.keys(subscriber).sort(), ['confirmed', 'confirmedAt', 'email', 'subscribedAt']);
  assert.equal(subscriber.email, 'reader@example.com');
  assert.equal(subscriber.confirmed, true);
  await store.close();
});

test('reports missing MongoDB configuration without trying to connect', async () => {
  const store = createSubscriberStore({ uri: '' });
  assert.equal(store.isConfigured, false);
  await assert.rejects(store.list(), /MONGODB_URI não configurada/);
});

test('adds an immediately confirmed subscriber and stores only a token hash', async () => {
  const { mongo, store } = createTestStore();
  assert.deepEqual(await store.add('  Reader@Example.com '), { status: 'added' });
  const subscriber = mongo.documents.get('reader@example.com');
  assert.equal(subscriber.confirmed, true);
  assert.equal(subscriber.confirmedAt.toISOString(), '2026-10-13T12:00:00.000Z');
  assert.equal(subscriber.subscribedAt.toISOString(), '2026-10-13T12:00:00.000Z');
  assert.equal(subscriber.confirmationTokenHash, null);
  assert.equal(subscriber.confirmationTokenExpiresAt, null);
  assert.equal(subscriber.unsubscribeTokenHash, createHash('sha256').update('a'.repeat(64)).digest('hex'));
  assert.notEqual(subscriber.unsubscribeTokenHash, 'a'.repeat(64));
  await store.close();
});

test('rejects invalid email without opening a database connection', async () => {
  const { mongo, store } = createTestStore();
  assert.deepEqual(await store.add('invalid'), { status: 'invalid_email' });
  assert.equal(mongo.connected, false);
  assert.equal(mongo.documents.size, 0);
  await store.close();
});

test('reports an existing confirmed email instead of overwriting its unsubscribe token', async () => {
  const { mongo, store } = createTestStore();
  mongo.documents.set('reader@example.com', { email: 'reader@example.com', confirmed: true, unsubscribeTokenHash: 'existing-hash' });
  assert.deepEqual(await store.add('reader@example.com'), { status: 'already_subscribed' });
  assert.equal(mongo.documents.get('reader@example.com').unsubscribeTokenHash, 'existing-hash');
  await store.close();
});

test('reactivates an inactive subscriber and refreshes its unsubscribe token', async () => {
  const { mongo, store } = createTestStore();
  mongo.documents.set('reader@example.com', { email: 'reader@example.com', confirmed: false, unsubscribeTokenHash: 'old-hash' });
  assert.deepEqual(await store.add('reader@example.com'), { status: 'added' });
  assert.equal(mongo.documents.get('reader@example.com').confirmed, true);
  assert.notEqual(mongo.documents.get('reader@example.com').unsubscribeTokenHash, 'old-hash');
  await store.close();
});

test('deactivates without deleting the subscriber record', async () => {
  const { mongo, store } = createTestStore();
  mongo.documents.set('reader@example.com', { email: 'reader@example.com', confirmed: true });
  assert.deepEqual(await store.deactivate('reader@example.com'), { status: 'deactivated' });
  assert.equal(mongo.documents.get('reader@example.com').confirmed, false);
  assert.deepEqual(await store.deactivate('reader@example.com'), { status: 'already_inactive' });
  assert.equal(mongo.documents.has('reader@example.com'), true);
  assert.deepEqual(await store.deactivate('missing@example.com'), { status: 'not_found' });
  await store.close();
});
