import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';
import { createNewsletterClient } from '../src/clients/newsletter.js';
import { createWorkerControlClient } from '../src/clients/control.js';
import { getServerBinding } from '../src/server-config.js';

test('server lets Node and the hosting platform choose the host and port by default', () => {
  assert.deepEqual(getServerBinding({}), { host: undefined, port: 0 });
  assert.deepEqual(getServerBinding({ HOST: ' ', PORT: '' }), { host: undefined, port: 0 });
});

test('server accepts runtime-provided host and port and rejects invalid ports', () => {
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
  const scheduler = createScheduler({ intervalMs: 10800000, task: () => { calls++; return new Promise(r => { release = r; }); }, logger: { warn() {}, error() {} }, now: () => 1000, setTimer: (fn, ms) => { callback = fn; assert.equal(ms, 10800000); return 1; }, clearTimer() {} });
  scheduler.start(); const first = scheduler.tick(); await scheduler.tick(); assert.equal(calls, 1); release(); await first;
  scheduler.stop(); assert.equal(typeof callback, 'function');
});

test('scheduler restores a persisted next run and preserves it when the interval changes', () => {
  let delay;
  const target = new Date(1_060_000);
  const scheduler = createScheduler({
    intervalMs: 10800000,
    initialNextRunAt: target,
    now: () => 1_000_000,
    task: async () => {},
    logger: { warn() {}, error() {} },
    setTimer: (_fn, ms) => { delay = ms; return 1; },
    clearTimer() {}
  });

  scheduler.start();
  assert.equal(scheduler.getState().nextRunAt, target.toISOString());
  scheduler.setIntervalMs(6 * 60 * 60 * 1000, { preserveNextRunAt: true });
  assert.equal(scheduler.getState().nextRunAt, target.toISOString());
  assert.equal(delay, 60_000);
  scheduler.stop();
});

test('scheduler can wait for an active task to finish', async () => {
  let release;
  const scheduler = createScheduler({
    intervalMs: 10800000,
    task: () => new Promise(resolve => { release = resolve; }),
    logger: { warn() {}, error() {} },
    setTimer: () => 1,
    clearTimer() {}
  });
  scheduler.start();
  const running = scheduler.tick();
  const idle = scheduler.waitForIdle();
  assert.equal(scheduler.getState().running, true);
  release();
  await Promise.all([running, idle]);
  assert.equal(scheduler.getState().running, false);
  scheduler.stop();
});

test('scheduler accepts a custom next run time while enabled', () => {
  let delay;
  const target = new Date(Date.now() + 60_000);
  const scheduler = createScheduler({ intervalMs: 10800000, task: async () => {}, logger: { warn() {}, error() {} }, setTimer: (_fn, ms) => { delay = ms; return 1; }, clearTimer() {} });
  scheduler.start();
  const scheduled = scheduler.setNextRunAt(target);
  assert.equal(scheduled, target.toISOString());
  assert.equal(scheduler.getState().nextRunAt, target.toISOString());
  assert.ok(delay > 0 && delay <= 60_000);
  scheduler.stop();
});

test('scheduler rejects custom next run times when disabled or invalid', () => {
  const scheduler = createScheduler({ intervalMs: 10800000, task: async () => {}, logger: { warn() {}, error() {} } });
  assert.throws(() => scheduler.setNextRunAt(new Date(Date.now() + 60_000)), /Ative o agendador/);
  scheduler.start();
  assert.throws(() => scheduler.setNextRunAt('not-a-date'), /inválida/);
  assert.throws(() => scheduler.setNextRunAt(new Date(Date.now() - 60_000)), /futuro/);
  scheduler.stop();
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
