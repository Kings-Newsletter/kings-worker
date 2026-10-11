import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerStore } from '../src/store.js';

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kings-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'worker.db');
}

test('persists scheduler configuration, health and run history across restarts', async t => {
  const dbPath = temporaryDatabase(t);
  const store = await createWorkerStore({ dbPath });
  const startedAt = new Date('2026-10-11T10:00:00.000Z');
  const completedAt = new Date('2026-10-11T10:00:02.500Z');

  store.saveConfig({
    enabled: true,
    intervalMs: 3 * 60 * 60 * 1000,
    nextRunAt: '2026-10-11T15:00:00.000Z',
    scheduleMode: 'custom'
  });
  store.recordRun({
    startedAt,
    completedAt,
    durationMs: 2500,
    status: 'failed',
    errorCode: 'API_HTTP_503',
    health: {
      lastSuccessfulRunAt: '2026-10-11T07:00:00.000Z',
      lastRunDurationMs: 2500,
      consecutiveFailures: 2
    }
  });
  store.close();

  const reopened = await createWorkerStore({ dbPath });
  const restoredConfig = reopened.getConfig();
  assert.equal(restoredConfig.enabled, true);
  assert.equal(restoredConfig.intervalMs, 3 * 60 * 60 * 1000);
  assert.equal(restoredConfig.nextRunAt, '2026-10-11T15:00:00.000Z');
  assert.equal(restoredConfig.scheduleMode, 'custom');
  assert.ok(Number.isFinite(new Date(restoredConfig.updatedAt).getTime()));
  assert.equal(reopened.getRecentRuns(1)[0].status, 'failed');
  assert.equal(reopened.getRecentRuns(1)[0].errorCode, 'API_HTTP_503');
  assert.equal(reopened.getHealth().consecutiveFailures, 2);
  assert.equal(reopened.getHealth().lastSuccessfulRunAt, '2026-10-11T07:00:00.000Z');
  reopened.close();
});

test('removes records older than the configured retention period on startup', async t => {
  const dbPath = temporaryDatabase(t);
  const firstNow = () => new Date('2026-01-01T00:00:00.000Z');
  const first = await createWorkerStore({ dbPath, retentionDays: 90, now: firstNow });
  first.recordRun({
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-01T00:00:01.000Z'),
    durationMs: 1000,
    status: 'succeeded',
    health: {
      lastSuccessfulRunAt: '2026-01-01T00:00:01.000Z',
      lastRunDurationMs: 1000,
      consecutiveFailures: 0
    }
  });
  first.close();

  const second = await createWorkerStore({
    dbPath,
    retentionDays: 90,
    now: () => new Date('2026-04-15T00:00:00.000Z')
  });
  assert.equal(second.getRecentRuns(50).length, 0);
  second.close();
});
