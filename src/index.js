import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createLogger } from './logger.js';
import { createScheduler } from './scheduler.js';
import { createNewsletterClient } from './clients/newsletter.js';
import { createWorkerControlClient } from './clients/control.js';
import { getServerBinding } from './server-config.js';

const logger = createLogger();
const app = express();
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
const localSchedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false';
let lastRunStatus = null;
let lastRunErrorCode = null;

app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'kings-newsletter-worker',
  timestamp: new Date().toISOString()
}));

const runCheck = async () => {
  if (!newsletterClient.isConfigured) {
    lastRunStatus = 'skipped';
    lastRunErrorCode = 'NEWSLETTER_API_NOT_CONFIGURED';
    logger.warn('Verificação não executada: integração sem configuração documentada');
    return;
  }
  lastRunStatus = 'running';
  lastRunErrorCode = null;
  try {
    const result = await newsletterClient.request();
    lastRunStatus = result.data?.sent ? 'succeeded' : 'skipped';
    logger.info('Resposta recebida da API', { status: result.status, runStatus: lastRunStatus });
  } catch (error) {
    lastRunStatus = 'failed';
    const statusCode = error.message.match(/HTTP (\d{3})/i)?.[1];
    lastRunErrorCode = statusCode ? `API_HTTP_${statusCode}` : 'API_REQUEST_FAILED';
    throw error;
  }
};

const scheduler = createScheduler({
  intervalMs: Number(process.env.CHECK_INTERVAL_MS || 10800000),
  task: runCheck,
  logger
});

async function synchronizeControl() {
  if (!controlClient.isConfigured) return;
  try {
    const config = await controlClient.fetchConfig();
    if (!Number.isInteger(config.intervalHours) || config.intervalHours < 1 || config.intervalHours > 168 || typeof config.enabled !== 'boolean') {
      throw new Error('Configuração de agendamento inválida recebida do site.');
    }
    scheduler.setIntervalMs(config.intervalHours * 60 * 60 * 1000);
    scheduler.setEnabled(localSchedulerEnabled && config.enabled);
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
    logger.debug('Configuração do painel sincronizada', { revision: config.revision, intervalHours: config.intervalHours, enabled: state.enabled });
  } catch (error) {
    const statusCode = error.message.match(/HTTP (\d{3})/i)?.[1];
    logger.warn('Falha ao sincronizar com o painel', { errorCode: statusCode ? `CONTROL_HTTP_${statusCode}` : 'CONTROL_SYNC_FAILED' });
  }
}

const controlPollMs = Math.max(10_000, Math.min(300_000, Number(process.env.WORKER_CONTROL_POLL_MS || 30_000)));
let controlTimer;
const { host, port } = getServerBinding();
const server = app.listen(port, host, () => {
  const address = server.address();
  logger.info('Servidor iniciado', {
    host,
    port: typeof address === 'object' && address ? address.port : port,
    schedulerEnabled: localSchedulerEnabled,
    apiConfigured: newsletterClient.isConfigured,
    controlConfigured: controlClient.isConfigured
  });
  if (controlClient.isConfigured) {
    void synchronizeControl();
    controlTimer = setInterval(() => void synchronizeControl(), controlPollMs);
  } else if (localSchedulerEnabled) {
    scheduler.start();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  scheduler.stop();
  if (controlTimer) clearInterval(controlTimer);
  server.close(() => process.exit(0));
});
