import initSqlJs from 'sql.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(moduleDirectory, '../node_modules/sql.js/dist/sql-wasm.wasm');

function createStateHelpers(db) {
  return {
    get(key) {
      const statement = db.prepare('SELECT value FROM worker_state WHERE key = ?');
      try {
        statement.bind([key]);
        return statement.step() ? JSON.parse(statement.getAsObject().value) : null;
      } finally {
        statement.free();
      }
    },
    set(key, value) {
      const statement = db.prepare(
        'INSERT INTO worker_state (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      try {
        statement.run([key, JSON.stringify(value)]);
      } finally {
        statement.free();
      }
    }
  };
}

export async function createWorkerStore({
  dbPath = process.env.WORKER_DB_PATH || resolve(process.cwd(), 'data', 'worker.db'),
  retentionDays = Number(process.env.WORKER_HISTORY_RETENTION_DAYS || 90),
  now = () => new Date()
} = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new RangeError('WORKER_HISTORY_RETENTION_DAYS deve ficar entre 1 e 3650.');
  }

  const resolvedPath = resolve(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });

  const SQL = await initSqlJs({ locateFile: file => file.endsWith('.wasm') ? wasmPath : file });
  const db = existsSync(resolvedPath)
    ? new SQL.Database(new Uint8Array(readFileSync(resolvedPath)))
    : new SQL.Database();

  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS worker_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL,
      interval_ms INTEGER NOT NULL,
      next_run_at TEXT,
      schedule_mode TEXT NOT NULL DEFAULT 'automatic',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worker_runs_started_at
      ON worker_runs(started_at DESC);
  `);

  function persist() {
    const tempPath = `${resolvedPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, Buffer.from(db.export()), { mode: 0o600 });
    renameSync(tempPath, resolvedPath);
  }

  function queryOne(sql, params = []) {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      return statement.step() ? statement.getAsObject() : null;
    } finally {
      statement.free();
    }
  }

  function queryAll(sql, params = []) {
    const statement = db.prepare(sql);
    const rows = [];
    try {
      statement.bind(params);
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  const state = createStateHelpers(db);

  function saveConfig(config) {
    if (typeof config?.enabled !== 'boolean') {
      throw new TypeError('O estado enabled da configuração precisa ser booleano.');
    }
    if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 60 * 60 * 1000 || config.intervalMs > 168 * 60 * 60 * 1000) {
      throw new RangeError('O intervalo persistido precisa ficar entre 1 e 168 horas.');
    }
    if (config.nextRunAt !== null && config.nextRunAt !== undefined && !Number.isFinite(new Date(config.nextRunAt).getTime())) {
      throw new TypeError('O próximo disparo persistido é inválido.');
    }
    const scheduleMode = config.scheduleMode === 'custom' ? 'custom' : 'automatic';
    const nextRunAt = config.nextRunAt ? new Date(config.nextRunAt).toISOString() : null;
    db.run(
      `INSERT INTO worker_config (id, enabled, interval_ms, next_run_at, schedule_mode, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         interval_ms = excluded.interval_ms,
         next_run_at = excluded.next_run_at,
         schedule_mode = excluded.schedule_mode,
         updated_at = excluded.updated_at`,
      [config.enabled ? 1 : 0, config.intervalMs, nextRunAt, scheduleMode, now().toISOString()]
    );
    persist();
    return getConfig();
  }

  function getConfig() {
    const row = queryOne('SELECT enabled, interval_ms, next_run_at, schedule_mode, updated_at FROM worker_config WHERE id = 1');
    if (!row) return null;
    return {
      enabled: Boolean(row.enabled),
      intervalMs: Number(row.interval_ms),
      nextRunAt: row.next_run_at || null,
      scheduleMode: row.schedule_mode,
      updatedAt: row.updated_at
    };
  }

  function getHealth() {
    return {
      lastSuccessfulRunAt: state.get('lastSuccessfulRunAt'),
      lastRunDurationMs: state.get('lastRunDurationMs'),
      consecutiveFailures: state.get('consecutiveFailures') ?? 0
    };
  }

  function getRecentRuns(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    return queryAll(
      `SELECT started_at, completed_at, duration_ms, status, error_code
       FROM worker_runs ORDER BY id DESC LIMIT ${safeLimit}`
    ).map(row => ({
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: Number(row.duration_ms),
      status: row.status,
      errorCode: row.error_code || null
    }));
  }

  function recordRun({ startedAt, completedAt = now(), durationMs, status, errorCode = null, health }) {
    if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
      throw new TypeError('O horário de início da execução é inválido.');
    }
    if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
      throw new TypeError('O horário de término da execução é inválido.');
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new RangeError('A duração da execução é inválida.');
    }
    if (!['succeeded', 'failed', 'skipped'].includes(status)) {
      throw new TypeError('O resultado da execução é inválido.');
    }

    db.run('BEGIN TRANSACTION');
    try {
      db.run(
        'INSERT INTO worker_runs (started_at, completed_at, duration_ms, status, error_code) VALUES (?, ?, ?, ?, ?)',
        [startedAt.toISOString(), completedAt.toISOString(), durationMs, status, errorCode]
      );
      state.set('lastRunDurationMs', durationMs);
      state.set('consecutiveFailures', health.consecutiveFailures);
      state.set('lastSuccessfulRunAt', health.lastSuccessfulRunAt);
      const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      db.run('DELETE FROM worker_runs WHERE completed_at < ?', [cutoff]);
      db.run('COMMIT');
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      throw error;
    }
    persist();
    return getRecentRuns(50);
  }

  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.run('DELETE FROM worker_runs WHERE completed_at < ?', [cutoff]);
  persist();

  return {
    path: resolvedPath,
    getConfig,
    saveConfig,
    getHealth,
    getLatestRun() { return getRecentRuns(1)[0] || null; },
    getRecentRuns,
    recordRun,
    close() {
      persist();
      db.close();
    }
  };
}
