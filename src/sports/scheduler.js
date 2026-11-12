import { collections } from './collections.js';

/**
 * Agendador da coleta do King's Sports.
 *
 *  - live:   a cada SPORTS_LIVE_EVERY_SEC (15 s), com trava própria: não espera
 *            a coleta diária nem a da temporada. Só chama um provedor quando há
 *            jogo em andamento e respeita o intervalo mínimo de cada fonte.
 *  - daily:  ao iniciar, se a última execução tiver mais de 12 h; depois verifica
 *            de novo a cada 30 min.
 *  - crests: logo depois de cada daily.
 *  - season: calendário da temporada inteira; cada liga é renovada uma vez por
 *            semana. O job para em ~45 s e continua na chamada seguinte, então
 *            roda a cada 2 min até terminar e fica barato depois disso.
 *
 * daily, crests e season compartilham uma trava; live tem a sua. Assim uma
 * coleta longa nunca atrasa placar e relógio.
 */

export const DAILY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const JOBS = ['live', 'daily', 'crests', 'season'];
const FAILURE_LOG_EVERY = 40;

function emptyJobState() {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastStatus: null,
    lastError: null,
    consecutiveFailures: 0,
    runs: 0
  };
}

export function createSportsScheduler({
  getDb,
  runJob,
  logger,
  liveEveryMs = 15_000,
  dailyCheckMs = 30 * 60 * 1000,
  seasonEveryMs = 2 * 60 * 1000,
  startDelayMs = 5_000,
  now = () => Date.now(),
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout
}) {
  const jobs = Object.fromEntries(JOBS.map((job) => [job, emptyJobState()]));
  const timers = [];
  let startTimer = null;
  let enabled = false;
  let busy = false;
  let liveBusy = false;
  const active = new Set();

  function track(promise) {
    active.add(promise);
    promise.finally(() => active.delete(promise));
    return promise;
  }

  async function run(job) {
    const state = jobs[job];
    const startedAt = now();
    state.lastRunAt = new Date(startedAt).toISOString();
    state.runs += 1;
    try {
      const db = await getDb();
      const summary = await runJob(db, job);
      const errors = summary.errors ?? [];
      state.lastDurationMs = Math.max(0, now() - startedAt);
      state.lastStatus = errors.length === 0 ? 'succeeded' : 'partial';
      state.lastError = errors[0] ?? null;
      state.lastSuccessAt = new Date(now()).toISOString();
      if (state.consecutiveFailures > 0) {
        logger.info('Coleta do Sports recuperada', { job, failuresBefore: state.consecutiveFailures });
      }
      state.consecutiveFailures = 0;
      const calls = Object.entries(summary.calls ?? {})
        .map(([provider, count]) => `${provider}:${count}`)
        .join(' ');
      const worthLogging =
        errors.length > 0 ||
        (job === 'live' && summary.fixtures > 0) ||
        (job === 'season' && (summary.season?.done?.length || summary.season?.pending?.length)) ||
        job === 'daily' ||
        job === 'crests';
      if (worthLogging) {
        logger[errors.length > 0 ? 'warn' : 'info']('Coleta do Sports concluída', {
          job,
          fixtures: summary.fixtures,
          standings: summary.standings,
          calls: calls || undefined,
          seasonDone: summary.season?.done?.length,
          seasonPending: summary.season?.pending?.length,
          errorCount: errors.length || undefined,
          firstError: errors[0]
        });
      }
      return summary;
    } catch (error) {
      state.lastDurationMs = Math.max(0, now() - startedAt);
      state.lastStatus = 'failed';
      state.lastError = error instanceof Error ? error.message : String(error);
      state.consecutiveFailures += 1;
      // O ao vivo roda a cada 15 s: registra a primeira falha e depois só de tempos em tempos.
      if (state.consecutiveFailures === 1 || state.consecutiveFailures % FAILURE_LOG_EVERY === 0) {
        logger.error('Falha na coleta do Sports', {
          job,
          error: state.lastError,
          consecutiveFailures: state.consecutiveFailures
        });
      }
      return null;
    }
  }

  function guarded(task) {
    if (busy || !enabled) return Promise.resolve();
    busy = true;
    return track(
      (async () => {
        try {
          await task();
        } finally {
          busy = false;
        }
      })()
    );
  }

  async function lastDailyAt() {
    const db = await getDb();
    const [last] = await collections(db).ingestRuns.find({ job: 'daily' }).sort({ startedAt: -1 }).limit(1).toArray();
    return last?.startedAt instanceof Date ? last.startedAt.getTime() : null;
  }

  function dailyIfStale() {
    return guarded(async () => {
      let last;
      try {
        last = await lastDailyAt();
      } catch (error) {
        jobs.daily.lastStatus = 'failed';
        jobs.daily.lastError = error instanceof Error ? error.message : String(error);
        logger.error('Falha ao consultar a última coleta diária do Sports', { error: jobs.daily.lastError });
        return;
      }
      if (last && now() - last < DAILY_MAX_AGE_MS) return;
      await run('daily');
      if (enabled) await run('crests');
    });
  }

  function season() {
    return guarded(() => run('season'));
  }

  function live() {
    if (liveBusy || !enabled) return Promise.resolve();
    liveBusy = true;
    return track(
      (async () => {
        try {
          await run('live');
        } finally {
          liveBusy = false;
        }
      })()
    );
  }

  function start() {
    if (enabled) return;
    enabled = true;
    logger.info('Coleta do Sports ligada', { liveEverySeconds: liveEveryMs / 1000 });
    startTimer = setTimeoutFn(() => {
      startTimer = null;
      void dailyIfStale()
        .then(season)
        .then(live);
    }, startDelayMs);
    timers.push(setIntervalFn(() => void live(), liveEveryMs));
    timers.push(setIntervalFn(() => void dailyIfStale().then(season), dailyCheckMs));
    timers.push(setIntervalFn(() => void season(), seasonEveryMs));
    for (const timer of timers) timer?.unref?.();
    startTimer?.unref?.();
  }

  function stop() {
    enabled = false;
    if (startTimer) clearTimeoutFn(startTimer);
    startTimer = null;
    for (const timer of timers.splice(0)) clearIntervalFn(timer);
  }

  async function waitForIdle() {
    while (active.size > 0) await Promise.allSettled([...active]);
  }

  function getState() {
    return {
      enabled,
      liveEveryMs,
      running: { live: liveBusy, batch: busy },
      jobs: structuredClone(jobs)
    };
  }

  return { start, stop, waitForIdle, getState, live, dailyIfStale, season };
}
