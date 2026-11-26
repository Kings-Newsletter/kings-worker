/**
 * Aquecimento dos caches do portal King's Legis e King's Radar (kings-legis na Vercel).
 *
 * O portal lê direto das fontes oficiais (Câmara, Senado, TSE, Imprensa Nacional e
 * tribunais) e guarda o resultado em cache. Para a primeira visita não esperar pelas
 * fontes, este agendador chama a rota de aquecimento do portal:
 *
 *  - radar:  GET {LEGIS_PORTAL_URL}/legis/api/aquecer?parte=radar
 *            a cada 30 min, das 6h às 22h (edição do DOU e notícias dos tribunais);
 *  - perfis: GET {LEGIS_PORTAL_URL}/legis/api/aquecer?parte=perfis
 *            uma vez por dia, a partir das 6h (arquivos pesados das fichas de políticos).
 *
 * Horários no fuso de Brasília. Cada job tem a sua trava: o perfis (1 a 3 min) nunca
 * atrasa o radar. A chamada leva `Authorization: Bearer <LEGIS_CRON_SECRET>`, o mesmo
 * valor de CRON_SECRET configurado no projeto da Vercel.
 */

const JOBS = ['radar', 'perfis'];
const TIME_ZONE = 'America/Sao_Paulo';
const FAILURE_LOG_EVERY = 10;

function emptyJobState() {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastStatus: null,
    lastError: null,
    consecutiveFailures: 0,
    runs: 0,
    lastReport: null
  };
}

/** Hora (0–23) e data (AAAA-MM-DD) em Brasília. */
export function brasilia(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function createLegisWarmup({
  baseUrl,
  secret,
  logger,
  fetch: fetchFn = globalThis.fetch,
  radarEveryMs = 30 * 60 * 1000,
  radarFromHour = 6,
  radarToHour = 22,
  perfisFromHour = 6,
  checkEveryMs = 60 * 1000,
  startDelayMs = 10_000,
  radarTimeoutMs = 60_000,
  perfisTimeoutMs = 5 * 60 * 1000,
  now = () => Date.now(),
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout
}) {
  const url = (baseUrl || '').replace(/\/+$/, '');
  const isConfigured = Boolean(url && secret);
  const jobs = Object.fromEntries(JOBS.map((job) => [job, emptyJobState()]));
  const busy = { radar: false, perfis: false };
  const active = new Set();
  let enabled = false;
  let timer = null;
  let startTimer = null;
  let lastPerfisDate = null;

  function track(promise) {
    active.add(promise);
    promise.finally(() => active.delete(promise));
    return promise;
  }

  async function call(job) {
    const controller = new AbortController();
    const timeout = setTimeoutFn(() => controller.abort(), job === 'perfis' ? perfisTimeoutMs : radarTimeoutMs);
    try {
      const response = await fetchFn(`${url}/legis/api/aquecer?parte=${job}`, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        signal: controller.signal
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        throw new Error(response.status === 401 ? 'Portal recusou o segredo (401): confira LEGIS_CRON_SECRET' : `Portal respondeu ${response.status}`);
      }
      return body;
    } finally {
      clearTimeoutFn(timeout);
    }
  }

  async function run(job) {
    if (busy[job] || !enabled) return null;
    busy[job] = true;
    const state = jobs[job];
    const startedAt = now();
    state.lastRunAt = new Date(startedAt).toISOString();
    state.runs += 1;
    try {
      const report = await call(job);
      const etapas = Array.isArray(report?.etapas) ? report.etapas : [];
      const falhas = etapas.filter((e) => e.falhas > 0);
      state.lastDurationMs = Math.max(0, now() - startedAt);
      state.lastStatus = report?.ok === false || falhas.length ? 'partial' : 'succeeded';
      state.lastError = falhas.length ? falhas.map((e) => e.etapa).join('; ') : null;
      state.lastSuccessAt = new Date(now()).toISOString();
      state.lastReport = etapas.map(({ etapa, ok, falhas: f, ms }) => ({ etapa, ok, falhas: f, ms }));
      if (state.consecutiveFailures > 0) logger.info('Aquecimento do portal recuperado', { job, failuresBefore: state.consecutiveFailures });
      state.consecutiveFailures = 0;
      if (job === 'perfis' || falhas.length) {
        logger[falhas.length ? 'warn' : 'info']('Aquecimento do portal concluído', {
          job,
          durationMs: state.lastDurationMs,
          etapas: etapas.length,
          falhas: falhas.length || undefined,
          primeiraFalha: falhas[0]?.etapa
        });
      }
      return report;
    } catch (error) {
      state.lastDurationMs = Math.max(0, now() - startedAt);
      state.lastStatus = 'failed';
      state.lastError = error?.name === 'AbortError' ? 'O portal não respondeu dentro do tempo limite' : error instanceof Error ? error.message : String(error);
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures === 1 || state.consecutiveFailures % FAILURE_LOG_EVERY === 0) {
        logger.error('Falha no aquecimento do portal', { job, error: state.lastError, consecutiveFailures: state.consecutiveFailures });
      }
      return null;
    } finally {
      busy[job] = false;
    }
  }

  /** Decide o que rodar agora. Chamado a cada minuto. */
  function tick() {
    if (!enabled) return Promise.resolve();
    const agora = now();
    const { date, hour } = brasilia(agora);
    const tarefas = [];

    const lastRadar = jobs.radar.lastRunAt ? Date.parse(jobs.radar.lastRunAt) : 0;
    if (hour >= radarFromHour && hour < radarToHour && agora - lastRadar >= radarEveryMs) {
      tarefas.push(run('radar'));
    }

    // Perfis: uma vez por dia; uma falha tenta de novo no tick seguinte com espera de 30 min.
    const lastPerfis = jobs.perfis.lastRunAt ? Date.parse(jobs.perfis.lastRunAt) : 0;
    const perfisFalhou = jobs.perfis.lastStatus === 'failed' && agora - lastPerfis < 30 * 60 * 1000;
    if (hour >= perfisFromHour && lastPerfisDate !== date && !perfisFalhou) {
      tarefas.push(
        run('perfis').then((r) => {
          if (r) lastPerfisDate = date;
          return r;
        })
      );
    }

    return track(Promise.all(tarefas));
  }

  function start() {
    if (enabled || !isConfigured) return;
    enabled = true;
    logger.info('Aquecimento do portal ligado', { portal: url });
    startTimer = setTimeoutFn(() => {
      startTimer = null;
      void tick();
    }, startDelayMs);
    timer = setIntervalFn(() => void tick(), checkEveryMs);
    timer?.unref?.();
    startTimer?.unref?.();
  }

  function stop() {
    enabled = false;
    if (startTimer) clearTimeoutFn(startTimer);
    startTimer = null;
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  async function waitForIdle() {
    while (active.size > 0) await Promise.allSettled([...active]);
  }

  function getState() {
    return {
      configured: isConfigured,
      enabled,
      portal: url || null,
      radarEveryMs,
      radarWindow: `${radarFromHour}h–${radarToHour}h`,
      perfisFromHour,
      running: { ...busy },
      jobs: structuredClone(jobs)
    };
  }

  return { start, stop, tick, run, waitForIdle, getState, isConfigured };
}
