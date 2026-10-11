import 'dotenv/config';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createLogger } from './logger.js';
import { createScheduler } from './scheduler.js';
import { createNewsletterClient } from './clients/newsletter.js';
import { createWorkerControlClient } from './clients/control.js';
import { getServerBinding } from './server-config.js';
import { createWorkerStore } from './store.js';

const logger = createLogger();
const workerStore = await createWorkerStore();
const savedConfig = workerStore.getConfig();
const storedIntervalMs = savedConfig?.intervalMs;
const defaultIntervalMs = Number(process.env.CHECK_INTERVAL_MS || 10800000);
const initialIntervalMs = Number.isSafeInteger(storedIntervalMs) && storedIntervalMs >= 60 * 60 * 1000 && storedIntervalMs <= 168 * 60 * 60 * 1000
  ? storedIntervalMs
  : defaultIntervalMs;
const localSchedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false';
const restoredEnabled = savedConfig?.enabled ?? localSchedulerEnabled;
const storedNextRunAt = savedConfig?.nextRunAt ? new Date(savedConfig.nextRunAt) : null;
const nextRunWasMissed = Boolean(storedNextRunAt && Number.isFinite(storedNextRunAt.getTime()) && storedNextRunAt.getTime() <= Date.now());
const restoredNextRunAt = storedNextRunAt && Number.isFinite(storedNextRunAt.getTime()) && storedNextRunAt.getTime() > Date.now()
  ? storedNextRunAt
  : null;
let scheduleMode = savedConfig?.scheduleMode === 'custom' && restoredNextRunAt && !nextRunWasMissed
  ? 'custom'
  : 'automatic';
if (nextRunWasMissed) {
  logger.warn('O próximo horário salvo já venceu; ele será ignorado para evitar um disparo inesperado', {
    missedNextRunAt: storedNextRunAt.toISOString()
  });
}
const app = express();
app.use(express.urlencoded({ extended: false, limit: '2kb' }));
app.use(express.json({ limit: '2kb' }));

const newsletterClient = createNewsletterClient({
  baseUrl: process.env.NEWSLETTER_API_BASE_URL,
  path: process.env.NEWSLETTER_API_PATH,
  method: (process.env.NEWSLETTER_API_METHOD || '').toUpperCase(),
  token: process.env.NEWSLETTER_API_TOKEN,
  timeoutMs: Number(process.env.NEWSLETTER_API_TIMEOUT_MS || 10000),
  maxRetries: Number(process.env.NEWSLETTER_API_MAX_RETRIES || 3),
  retryBaseMs: Number(process.env.NEWSLETTER_API_RETRY_BASE_MS || 500)
});
const controlClient = createWorkerControlClient({
  baseUrl: process.env.NEWSLETTER_API_BASE_URL,
  token: process.env.WORKER_CONTROL_SECRET,
  timeoutMs: Number(process.env.WORKER_CONTROL_TIMEOUT_MS || 10000),
  configPath: process.env.WORKER_CONFIG_PATH,
  heartbeatPath: process.env.WORKER_HEARTBEAT_PATH
});
const workerId = randomUUID();
const monitorUsername = process.env.MONITOR_USERNAME?.trim();
const monitorPassword = process.env.MONITOR_PASSWORD;
const monitorEnabled = Boolean(monitorUsername && monitorPassword);
const monitorPage = readFileSync(new URL('./monitor.html', import.meta.url), 'utf8');
const monitorSessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'worker_monitor_session';
const savedHealth = workerStore.getHealth();
const previousRun = workerStore.getLatestRun();
let lastRunStatus = previousRun?.status ?? null;
let lastRunErrorCode = previousRun?.errorCode ?? null;
let lastRunDurationMs = savedHealth.lastRunDurationMs;
let lastSuccessfulRunAt = savedHealth.lastSuccessfulRunAt;
let consecutiveFailures = savedHealth.consecutiveFailures;
let lastControlSyncAt = null;
let lastControlSyncStatus = null;
let lastControlSyncErrorCode = null;
let shuttingDown = false;

function recordRun(startedAt, status, errorCode = null) {
  const completedAt = new Date();
  lastRunDurationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
  workerStore.recordRun({
    startedAt,
    completedAt,
    durationMs: lastRunDurationMs,
    status,
    errorCode,
    health: { lastSuccessfulRunAt, lastRunDurationMs, consecutiveFailures }
  });
  scheduleMode = 'automatic';
  persistSchedulerConfig();
}

function persistSchedulerConfig(mode = scheduleMode) {
  if (shuttingDown) return null;
  const state = scheduler.getState();
  return workerStore.saveConfig({
    enabled: state.enabled,
    intervalMs: state.intervalMs,
    nextRunAt: state.nextRunAt,
    scheduleMode: mode
  });
}

function equalSecret(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const token = match.slice(SESSION_COOKIE.length + 1);
  const expiresAt = monitorSessions.get(token);
  if (!expiresAt) return null;
  if (expiresAt <= Date.now()) {
    monitorSessions.delete(token);
    return null;
  }
  return token;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/monitor; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
}

function requireMonitorAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (!monitorEnabled) return res.status(404).json({ error: 'Monitor não configurado.' });
  const token = readSession(req);
  if (!token) return res.status(401).json({ error: 'Sessão expirada ou não autenticada.' });
  return next();
}

app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'kings-newsletter-worker',
  timestamp: new Date().toISOString()
}));

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!monitorEnabled) return res.status(404).send('Monitor não configurado.');
  return res.type('html').send(monitorPage);
});

app.get('/monitor', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!monitorEnabled) return res.status(404).send('Monitor não configurado.');
  return res.type('html').send(monitorPage);
});

app.post('/monitor/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!monitorEnabled) return res.status(404).json({ error: 'Monitor não configurado.' });
  if (!equalSecret(req.body?.username, monitorUsername) || !equalSecret(req.body?.password, monitorPassword)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  const token = randomBytes(32).toString('base64url');
  monitorSessions.set(token, Date.now() + SESSION_TTL_MS);
  setSessionCookie(req, res, token, SESSION_TTL_MS / 1000);
  return res.json({ authenticated: true });
});

app.post('/monitor/logout', requireMonitorAuth, (req, res) => {
  const token = readSession(req);
  if (token) monitorSessions.delete(token);
  setSessionCookie(req, res, '', 0);
  return res.json({ loggedOut: true });
});

app.get('/monitor/status', requireMonitorAuth, (_req, res) => {
  res.json({
    service: 'kings-newsletter-worker',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    apiConfigured: newsletterClient.isConfigured,
    controlConfigured: controlClient.isConfigured,
    storageConfigured: true,
    storageType: 'sqlite',
    scheduler: scheduler.getState(),
    lastRunStatus,
    lastRunErrorCode,
    health: {
      lastSuccessfulRunAt,
      lastRunDurationMs,
      consecutiveFailures
    },
    recentRuns: workerStore.getRecentRuns(50),
    lastControlSyncAt,
    lastControlSyncStatus,
    lastControlSyncErrorCode
  });
});

app.post('/monitor/schedule', requireMonitorAuth, (req, res) => {
  const nextRunAt = req.body?.nextRunAt;
  if (typeof nextRunAt !== 'string' || nextRunAt.length > 40) {
    return res.status(400).json({ error: 'Informe uma data e horário válidos.' });
  }
  const date = new Date(nextRunAt);
  if (!Number.isFinite(date.getTime())) {
    return res.status(400).json({ error: 'A data informada é inválida.' });
  }
  if (date.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'O próximo disparo precisa estar no futuro.' });
  }
  if (date.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'A data deve estar dentro dos próximos 366 dias.' });
  }
  try {
    const scheduledAt = scheduler.setNextRunAt(date);
    scheduleMode = 'custom';
    persistSchedulerConfig();
    logger.info('Próximo disparo atualizado pelo monitor', { nextRunAt: scheduledAt });
    return res.json({ nextRunAt: scheduledAt });
  } catch (error) {
    const status = /agendador/i.test(error.message) ? 409 : 400;
    return res.status(status).json({ error: error.message });
  }
});

const runCheck = async () => {
  const startedAt = new Date();
  lastRunStatus = 'running';
  lastRunErrorCode = null;

  if (!newsletterClient.isConfigured) {
    lastRunStatus = 'skipped';
    lastRunErrorCode = 'NEWSLETTER_API_NOT_CONFIGURED';
    recordRun(startedAt, lastRunStatus, lastRunErrorCode);
    logger.warn('Verificação não executada: integração sem configuração documentada');
    return;
  }

  let result;
  try {
    result = await newsletterClient.request();
  } catch (error) {
    lastRunStatus = 'failed';
    const statusCode = error.message.match(/HTTP (\d{3})/i)?.[1];
    lastRunErrorCode = statusCode ? `API_HTTP_${statusCode}` : 'API_REQUEST_FAILED';
    consecutiveFailures += 1;
    recordRun(startedAt, lastRunStatus, lastRunErrorCode);
    throw error;
  }

  lastRunStatus = result.data?.sent ? 'succeeded' : 'skipped';
  lastRunErrorCode = null;
  lastSuccessfulRunAt = new Date().toISOString();
  consecutiveFailures = 0;
  recordRun(startedAt, lastRunStatus);
  logger.info('Resposta recebida da API', { status: result.status, runStatus: lastRunStatus });
};

const scheduler = createScheduler({
  intervalMs: initialIntervalMs,
  initialNextRunAt: restoredNextRunAt,
  initialLastRunAt: previousRun?.startedAt ?? null,
  task: runCheck,
  logger
});
async function synchronizeControl() {
  if (!controlClient.isConfigured) return;
  lastControlSyncAt = new Date().toISOString();
  lastControlSyncStatus = 'running';
  lastControlSyncErrorCode = null;
  try {
    const config = await controlClient.fetchConfig();
    if (!Number.isInteger(config.intervalHours) || config.intervalHours < 1 || config.intervalHours > 168 || typeof config.enabled !== 'boolean') {
      throw new Error('Configuração de agendamento inválida recebida do site.');
    }
    scheduler.setIntervalMs(config.intervalHours * 60 * 60 * 1000, {
      preserveNextRunAt: scheduleMode === 'custom'
    });
    scheduler.setEnabled(localSchedulerEnabled && config.enabled);
    if (!scheduler.getState().enabled) scheduleMode = 'automatic';
    persistSchedulerConfig();
    const state = scheduler.getState();
    await controlClient.sendHeartbeat({
      workerId,
      enabled: state.enabled,
      running: state.running,
      intervalMs: state.intervalMs,
      lastRunAt: state.lastRunAt,
      nextRunAt: state.nextRunAt,
      lastRunStatus,
      lastRunErrorCode
    });
    lastControlSyncStatus = 'succeeded';
    logger.debug('Configuração do painel sincronizada', { revision: config.revision, intervalHours: config.intervalHours, enabled: state.enabled });
  } catch (error) {
    lastControlSyncStatus = 'failed';
    const statusCode = error.message.match(/HTTP (\d{3})/i)?.[1];
    lastControlSyncErrorCode = statusCode ? `CONTROL_HTTP_${statusCode}` : 'CONTROL_SYNC_FAILED';
    logger.warn('Falha ao sincronizar com o painel', { errorCode: lastControlSyncErrorCode });
  }
}

const controlPollMs = Math.max(10_000, Math.min(300_000, Number(process.env.WORKER_CONTROL_POLL_MS || 30000)));
let controlTimer;
const { host, port } = getServerBinding();
const onListening = () => {
  const address = server.address();
  logger.info('Servidor iniciado', {
    host: typeof address === 'object' && address ? address.address : host ?? 'platform-default',
    port: typeof address === 'object' && address ? address.port : port,
    schedulerEnabled: localSchedulerEnabled,
    apiConfigured: newsletterClient.isConfigured,
    controlConfigured: controlClient.isConfigured,
    storageType: 'sqlite',
    storagePath: workerStore.path,
    monitorEnabled
  });
  if (controlClient.isConfigured) {
    void synchronizeControl();
    controlTimer = setInterval(() => void synchronizeControl(), controlPollMs);
  } else if (localSchedulerEnabled && restoredEnabled) {
    scheduler.start();
    persistSchedulerConfig();
  } else {
    persistSchedulerConfig('automatic');
  }
};
const server = host ? app.listen(port, host, onListening) : app.listen(port, onListening);

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  if (controlTimer) clearInterval(controlTimer);
  const serverClosed = new Promise(resolve => server.close(resolve));
  void Promise.all([serverClosed, scheduler.waitForIdle()]).finally(() => {
    workerStore.close();
    process.exit(0);
  });
});
