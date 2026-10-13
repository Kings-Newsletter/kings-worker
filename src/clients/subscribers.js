import { createHash, randomBytes } from 'node:crypto';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const DATABASE_NAME = 'kings_newsletter';
const COLLECTION_NAME = 'subscribers';

export function normalizeSubscriberEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSubscriberStore({
  uri = process.env.MONGODB_URI,
  clientFactory,
  now = () => new Date(),
  tokenFactory = () => randomBytes(32).toString('hex')
} = {}) {
  let client;
  let collection;
  let connectionPromise;

  async function connect() {
    if (collection) return collection;
    if (!uri?.trim()) throw new Error('MONGODB_URI não configurada.');
    if (!connectionPromise) {
      connectionPromise = (async () => {
        let createClient = clientFactory;
        if (!createClient) {
          const { MongoClient } = await import('mongodb');
          createClient = connectionUri => new MongoClient(connectionUri, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            maxPoolSize: 5
          });
        }
        client = createClient(uri);
        await client.connect();
        const db = client.db(DATABASE_NAME);
        const subscribers = db.collection(COLLECTION_NAME);
        await subscribers.createIndex({ email: 1 }, { unique: true });
        collection = subscribers;
        return collection;
      })().catch(error => {
        connectionPromise = null;
        client = null;
        throw error;
      });
    }
    return connectionPromise;
  }

  async function list() {
    const subscribers = await connect();
    const documents = await subscribers.find(
      {},
      { projection: { _id: 0, email: 1, confirmed: 1, subscribedAt: 1, confirmedAt: 1 } }
    ).sort({ subscribedAt: -1 }).limit(500).toArray();
    return documents.map(document => ({
      email: document.email,
      confirmed: document.confirmed === true,
      subscribedAt: document.subscribedAt ?? null,
      confirmedAt: document.confirmedAt ?? null
    }));
  }

  async function add(value) {
    const email = normalizeSubscriberEmail(value);
    if (!email) return { status: 'invalid_email' };

    const subscribers = await connect();
    const timestamp = now();
    const token = tokenFactory();
    if (typeof token !== 'string' || token.length < 32) {
      throw new Error('O gerador de token retornou um valor inválido.');
    }

    try {
      await subscribers.updateOne(
        { email, confirmed: { $ne: true } },
        {
          $set: {
            confirmed: true,
            confirmedAt: timestamp,
            confirmationTokenHash: null,
            confirmationTokenExpiresAt: null,
            unsubscribeTokenHash: hashToken(token),
            updatedAt: timestamp
          },
          $setOnInsert: {
            email,
            subscribedAt: timestamp,
            createdAt: timestamp
          }
        },
        { upsert: true }
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await subscribers.findOne({ email }, { projection: { _id: 1, confirmed: 1 } });
      if (existing?.confirmed === true) return { status: 'already_subscribed' };
      throw error;
    }

    return { status: 'added' };
  }

  async function deactivate(value) {
    const email = normalizeSubscriberEmail(value);
    if (!email) return { status: 'invalid_email' };

    const subscribers = await connect();
    const result = await subscribers.updateOne(
      { email, confirmed: true },
      { $set: { confirmed: false, updatedAt: now() } }
    );
    if (result.modifiedCount > 0) return { status: 'deactivated' };

    const existing = await subscribers.findOne({ email }, { projection: { _id: 1, confirmed: 1 } });
    return existing ? { status: 'already_inactive' } : { status: 'not_found' };
  }

  async function close() {
    if (client) await client.close();
    client = null;
    collection = null;
    connectionPromise = null;
  }

  return { isConfigured: Boolean(uri?.trim()), connect, list, add, deactivate, close };
}
