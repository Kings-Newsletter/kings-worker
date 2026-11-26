import test from 'node:test';
import assert from 'node:assert/strict';
import { brasilia, createLegisWarmup } from '../src/legis/aquecimento.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** Horário de Brasília (UTC-3) num dia fixo. */
const em = (hora, minuto = 0) => Date.UTC(2026, 10, 26, hora + 3, minuto);

function fakeTimers() {
  return {
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {}
  };
}

function okFetch(calls, body = { ok: true, etapas: [{ etapa: 'x', ok: 1, falhas: 0, ms: 5 }] }) {
  return async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return { ok: true, status: 200, json: async () => body };
  };
}

function warmup({ clock, calls, fetch }) {
  const w = createLegisWarmup({
    baseUrl: 'https://portal.test/',
    secret: 's3gredo',
    logger: silent,
    fetch: fetch ?? okFetch(calls),
    now: () => clock.t,
    ...fakeTimers()
  });
  w.start();
  return w;
}

test('brasilia converts to the São Paulo time zone', () => {
  assert.deepEqual(brasilia(em(5, 30)), { date: '2026-11-26', hour: 5 });
  assert.deepEqual(brasilia(Date.UTC(2026, 10, 27, 1, 0)), { date: '2026-11-26', hour: 22 });
});

test('nothing runs before 6h in Brasília', async () => {
  const calls = [];
  const clock = { t: em(5, 59) };
  const w = warmup({ clock, calls });
  await w.tick();
  assert.equal(calls.length, 0);
});

test('at 6h it warms radar and perfis with the secret, then radar only every 30 min', async () => {
  const calls = [];
  const clock = { t: em(6, 0) };
  const w = warmup({ clock, calls });

  await w.tick();
  assert.deepEqual(
    calls.map((c) => c.url).sort(),
    ['https://portal.test/legis/api/aquecer?parte=perfis', 'https://portal.test/legis/api/aquecer?parte=radar']
  );
  assert.ok(calls.every((c) => c.auth === 'Bearer s3gredo'));

  clock.t = em(6, 10);
  await w.tick();
  assert.equal(calls.length, 2, 'radar waits 30 min; perfis already ran today');

  clock.t = em(6, 31);
  await w.tick();
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /parte=radar$/);
  assert.equal(w.getState().jobs.radar.lastStatus, 'succeeded');
});

test('radar stops at 22h and perfis runs again on the next day', async () => {
  const calls = [];
  const clock = { t: em(6, 0) };
  const w = warmup({ clock, calls });
  await w.tick();

  clock.t = em(22, 5);
  await w.tick();
  assert.equal(calls.length, 2);

  clock.t = em(6, 0) + 24 * 60 * 60 * 1000;
  await w.tick();
  assert.deepEqual(calls.slice(2).map((c) => c.url.split('=')[1]).sort(), ['perfis', 'radar']);
});

test('a rejected secret is reported as a failure without stopping the schedule', async () => {
  const calls = [];
  const clock = { t: em(9, 0) };
  const w = warmup({
    clock,
    calls,
    fetch: async (url) => {
      calls.push({ url });
      return { ok: false, status: 401, json: async () => ({ erro: 'Não autorizado.' }) };
    }
  });
  await w.tick();
  const { radar, perfis } = w.getState().jobs;
  assert.equal(radar.lastStatus, 'failed');
  assert.match(radar.lastError, /LEGIS_CRON_SECRET/);
  assert.equal(perfis.consecutiveFailures, 1);

  // Perfis falhou há menos de 30 min: não tenta de novo ainda.
  clock.t = em(9, 10);
  await w.tick();
  assert.equal(calls.filter((c) => /perfis/.test(c.url)).length, 1);

  clock.t = em(9, 41);
  await w.tick();
  assert.equal(calls.filter((c) => /perfis/.test(c.url)).length, 2);
});

test('a source failing inside the portal marks the run as partial', async () => {
  const calls = [];
  const clock = { t: em(10, 0) };
  const w = warmup({
    clock,
    calls,
    fetch: okFetch(calls, { ok: false, etapas: [{ etapa: 'Radar: notícias de STF, STJ, TSE e TST', ok: 3, falhas: 1, ms: 9 }] })
  });
  await w.tick();
  const radar = w.getState().jobs.radar;
  assert.equal(radar.lastStatus, 'partial');
  assert.match(radar.lastError, /STF, STJ/);
});

test('without portal URL or secret it stays off', () => {
  const w = createLegisWarmup({ baseUrl: '', secret: '', logger: silent, ...fakeTimers() });
  w.start();
  assert.equal(w.isConfigured, false);
  assert.equal(w.getState().enabled, false);
});
