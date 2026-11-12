import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './helpers/fake-mongo.js';
import { runJob } from '../src/sports/run.js';
import { createSportsScheduler, DAILY_MAX_AGE_MS } from '../src/sports/scheduler.js';
import { createSportsDatabase } from '../src/sports/mongo.js';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

function sportsDocs(db) {
  return db.collection('sports').docs;
}

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function espnEvent({ id, date, state = 'in', name = 'STATUS_FIRST_HALF', clock = "23'", home = '1', away = '0' }) {
  return {
    id,
    date,
    status: { type: { name, state, shortDetail: clock }, displayClock: clock, period: 1 },
    competitions: [
      {
        venue: { fullName: 'Maracanã' },
        competitors: [
          { homeAway: 'home', score: home, team: { id: '1', displayName: 'Flamengo', abbreviation: 'FLA', logo: 'https://x/fla.png' } },
          { homeAway: 'away', score: away, team: { id: '2', displayName: 'Palmeiras', abbreviation: 'PAL', logo: 'https://x/pal.png' } }
        ]
      }
    ]
  };
}

test('live job makes no provider call when there is no game in progress', async () => {
  const db = createFakeDb();
  await withFetch(
    () => {
      throw new Error('fetch não deveria ser chamado');
    },
    async (calls) => {
      const summary = await runJob(db, 'live');
      assert.equal(calls.length, 0);
      assert.equal(summary.fixtures, 0);
      assert.deepEqual(summary.errors, []);
      assert.ok(summary.skipped.includes('ESPN: nenhum jogo em andamento'));
    }
  );
  // Idle live runs are not recorded, so the collection only holds no run documents.
  assert.equal(sportsDocs(db).filter((doc) => doc.type === 'ingest_run').length, 0);
  // Indexes are created on the shared collection, all scoped by type.
  assert.ok(db.collection('sports').indexes.length > 0);
});

test('live job updates the score of an active ESPN fixture and records API usage', async () => {
  const db = createFakeDb();
  const kickoff = new Date(Date.now() - 20 * 60 * 1000);
  sportsDocs(db).push({
    _id: 'espn:401',
    type: 'fixture',
    sport: 'futebol',
    competition: 'brasileirao-serie-a',
    kind: 'match',
    kickoff,
    status: 'scheduled',
    updatedAt: new Date(0)
  });

  await withFetch(
    (url) => {
      assert.match(url, /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/soccer\/bra\.1\/scoreboard\?dates=\d{8}&limit=300$/);
      return jsonResponse({ events: [espnEvent({ id: '401', date: kickoff.toISOString(), home: '2', away: '1' })] });
    },
    async (calls) => {
      const summary = await runJob(db, 'live');
      assert.equal(calls.length, 1);
      assert.equal(summary.fixtures, 1);
      assert.deepEqual(summary.errors, []);
      assert.equal(summary.calls.espn, 1);
    }
  );

  const fixture = sportsDocs(db).find((doc) => doc._id === 'espn:401');
  assert.equal(fixture.type, 'fixture');
  assert.equal(fixture.status, 'live');
  assert.deepEqual(fixture.score, { home: 2, away: 1 });
  assert.equal(fixture.clock, "23'");
  assert.equal(fixture.home.name, 'Flamengo');
  assert.ok(fixture.updatedAt > new Date(0));

  const usage = sportsDocs(db).find((doc) => doc.type === 'api_usage');
  assert.equal(usage.provider, 'espn');
  assert.equal(usage.calls, 1);
  assert.equal(sportsDocs(db).filter((doc) => doc.type === 'ingest_run').length, 1);

  // A second run right away respects the ESPN minimum interval.
  await withFetch(
    () => {
      throw new Error('fetch não deveria ser chamado');
    },
    async (calls) => {
      const summary = await runJob(db, 'live');
      assert.equal(calls.length, 0);
      assert.ok(summary.skipped.includes('ESPN: intervalo mínimo'));
    }
  );
});

test('provider errors are reported in the summary instead of crashing the job', async () => {
  const db = createFakeDb();
  sportsDocs(db).push({
    _id: 'espn:402',
    type: 'fixture',
    sport: 'futebol',
    competition: 'brasileirao-serie-a',
    kind: 'match',
    kickoff: new Date(Date.now() - 5 * 60 * 1000),
    status: 'live',
    updatedAt: new Date(0)
  });
  await withFetch(
    () => new Response('indisponível', { status: 503 }),
    async () => {
      const summary = await runJob(db, 'live');
      assert.equal(summary.fixtures, 0);
      assert.equal(summary.errors.length, 1);
      assert.match(summary.errors[0], /espn respondeu 503/);
    }
  );
});

function manualTimers() {
  const intervals = [];
  const timeouts = [];
  return {
    intervals,
    timeouts,
    setInterval: (fn, ms) => {
      const timer = { fn, ms };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      const index = intervals.indexOf(timer);
      if (index >= 0) intervals.splice(index, 1);
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = timeouts.indexOf(timer);
      if (index >= 0) timeouts.splice(index, 1);
    }
  };
}

test('sports scheduler registers live, daily and season timers and clears them on stop', () => {
  const timers = manualTimers();
  const scheduler = createSportsScheduler({
    getDb: async () => createFakeDb(),
    runJob: async () => ({ fixtures: 0, standings: 0, calls: {}, errors: [] }),
    logger: quietLogger,
    ...timers
  });
  scheduler.start();
  assert.deepEqual(
    timers.intervals.map((timer) => timer.ms),
    [15_000, 30 * 60 * 1000, 2 * 60 * 1000]
  );
  assert.equal(timers.timeouts.length, 1);
  assert.equal(scheduler.getState().enabled, true);
  scheduler.stop();
  assert.equal(timers.intervals.length, 0);
  assert.equal(timers.timeouts.length, 0);
  assert.equal(scheduler.getState().enabled, false);
});

test('sports scheduler never overlaps live runs and keeps live independent from long jobs', async () => {
  const timers = manualTimers();
  const releases = {};
  const calls = [];
  const scheduler = createSportsScheduler({
    getDb: async () => createFakeDb(),
    runJob: (_db, job) => {
      calls.push(job);
      return new Promise((resolve) => {
        releases[job] = () => resolve({ fixtures: 0, standings: 0, calls: {}, errors: [] });
      });
    },
    logger: quietLogger,
    ...timers
  });
  scheduler.start();

  const season = scheduler.season();
  const firstLive = scheduler.live();
  const secondLive = scheduler.live();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['season', 'live']);
  assert.equal(scheduler.getState().running.live, true);
  assert.equal(scheduler.getState().running.batch, true);

  releases.live();
  await Promise.all([firstLive, secondLive]);
  assert.equal(scheduler.getState().running.live, false);
  assert.equal(scheduler.getState().jobs.live.lastStatus, 'succeeded');

  // While season still runs, another batch job is skipped.
  await scheduler.dailyIfStale();
  assert.deepEqual(calls, ['season', 'live']);

  releases.season();
  await season;
  await scheduler.waitForIdle();
  scheduler.stop();
});

test('sports scheduler runs daily and crests only when the last daily run is stale', async () => {
  const db = createFakeDb();
  const now = Date.UTC(2026, 10, 12, 12);
  const calls = [];
  const scheduler = createSportsScheduler({
    getDb: async () => db,
    runJob: async (_db, job) => {
      calls.push(job);
      return { fixtures: 0, standings: 0, calls: {}, errors: [] };
    },
    logger: quietLogger,
    now: () => now,
    ...manualTimers()
  });
  scheduler.start();

  sportsDocs(db).push({ type: 'ingest_run', job: 'daily', startedAt: new Date(now - 60 * 60 * 1000) });
  await scheduler.dailyIfStale();
  assert.deepEqual(calls, []);

  sportsDocs(db).length = 0;
  sportsDocs(db).push({ type: 'ingest_run', job: 'daily', startedAt: new Date(now - DAILY_MAX_AGE_MS - 1) });
  await scheduler.dailyIfStale();
  assert.deepEqual(calls, ['daily', 'crests']);
  scheduler.stop();
});

test('sports scheduler records failures without stopping', async () => {
  const errors = [];
  const scheduler = createSportsScheduler({
    getDb: async () => {
      throw new Error('sem conexão');
    },
    runJob: async () => ({}),
    logger: { ...quietLogger, error: (message, fields) => errors.push({ message, fields }) },
    ...manualTimers()
  });
  scheduler.start();
  await scheduler.live();
  await scheduler.live();
  const state = scheduler.getState().jobs.live;
  assert.equal(state.lastStatus, 'failed');
  assert.equal(state.lastError, 'sem conexão');
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(errors.length, 1);
  assert.equal(scheduler.getState().enabled, true);
  scheduler.stop();
});

test('sports database reuses one connection and retries after a failed connect', async () => {
  let created = 0;
  let fail = true;
  const database = createSportsDatabase({
    uri: 'mongodb://example',
    dbName: 'kings_newsletter',
    clientFactory: () => {
      created += 1;
      return {
        async connect() {
          if (fail) throw new Error('falhou');
        },
        db: (name) => ({ name }),
        async close() {}
      };
    }
  });
  await assert.rejects(database.getDb(), /falhou/);
  fail = false;
  const [a, b] = await Promise.all([database.getDb(), database.getDb()]);
  assert.equal(a.name, 'kings_newsletter');
  assert.equal(a, b);
  assert.equal(created, 2);
  await database.close();
  assert.equal(createSportsDatabase({ uri: '' }).isConfigured, false);
});
