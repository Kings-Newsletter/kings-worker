import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';
import { createNewsletterClient } from '../src/clients/newsletter.js';
import { createWorkerControlClient } from '../src/clients/control.js';
import { getServerBinding } from '../src/server-config.js';

test('server uses localhost and an operating-system-selected port by default', () => {
  assert.deepEqual(getServerBinding({}), { host: 'localhost', port: 0 });
  assert.deepEqual(getServerBinding({ HOST: ' localhost ', PORT: '' }), { host: 'localhost', port: 0 });
});

test('server accepts a runtime-provided host and port and rejects invalid ports', () => {
  assert.deepEqual(getServerBinding({ HOST: 'worker.internal', PORT: '4312' }), { host: 'worker.internal', port: 4312 });
  assert.throws(() => getServerBinding({ PORT: '65536' }), /PORT deve ser um número inteiro/);
});

test('worker control requires HTTPS except for localhost development', () => {
  assert.equal(createWorkerControlClient({ baseUrl: 'https://newsletter.example', token: 'secret' }).isConfigured, true);
  assert.equal(createWorkerControlClient({ baseUrl: 'http://localhost:3000', token: 'secret' }).isConfigured, true);
  assert.equal(createWorkerControlClient({ baseUrl: 'http://newsletter.example', token: 'secret' }).isConfigured, false);
});

test('scheduler uses configured interval and avoids overlapping ticks', async () => {
  let callback; let calls = 0; let release;
  const scheduler = createScheduler({ intervalMs: 10800000, task: () => { calls++; return new Promise(r => { release = r; }); }, logger: { warn() {}, error() {} }, setTimer: (fn, ms) => { callback = fn; assert.equal(ms, 10800000); return 1; }, clearTimer() {} });
  scheduler.start(); const first = scheduler.tick(); await scheduler.tick(); assert.equal(calls, 1); release(); await first;
  scheduler.stop(); assert.equal(typeof callback, 'function');
});

test('client remains disabled until all endpoint details are configured', async () => {
  const client = createNewsletterClient({}); assert.equal(client.isConfigured, false);
  await assert.rejects(client.request(), /não configurada/);
});

test('client sends configured bearer token and returns parsed response', async () => {
  let request;
  const client = createNewsletterClient({ baseUrl: 'https://example.test', path: '/api/notify-news', method: 'POST', token: 'test-secret', maxRetries: 0, timeoutMs: 1000 }, { fetchImpl: async (url, options) => { request = { url: String(url), options }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  assert.deepEqual(await client.request(), { status: 200, data: { ok: true } });
  assert.equal(request.options.headers.authorization, 'Bearer test-secret'); assert.equal(request.options.method, 'POST'); assert.equal(request.url, 'https://example.test/api/notify-news');
});

test('client retries transient server failures', async () => {
  let calls = 0;
  const client = createNewsletterClient({ baseUrl: 'https://example.test', path: '/api/notify-news', method: 'POST', token: 'test-secret', maxRetries: 1, timeoutMs: 1000, retryBaseMs: 0 }, { sleep: async () => {}, fetchImpl: async () => { calls++; return calls === 1 ? { ok: false, status: 503, headers: { get: () => null } } : { ok: true, status: 200, json: async () => ({}) }; } });
  await client.request(); assert.equal(calls, 2);
});


