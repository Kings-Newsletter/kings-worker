export function createScheduler({ intervalMs, task, logger, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let currentIntervalMs = intervalMs;
  let enabled = false;
  let running = false;
  let timer;
  let lastRunAt = null;
  let nextRunAt = null;

  const cancelTimer = () => {
    if (timer) clearTimer(timer);
    timer = undefined;
  };

  const clearScheduledRun = () => {
    cancelTimer();
    nextRunAt = null;
  };

  const scheduleNext = () => {
    if (!enabled || running) return;
    cancelTimer();
    if (!nextRunAt) nextRunAt = new Date(now() + currentIntervalMs);
    const delay = Math.max(0, nextRunAt.getTime() - now());
    timer = setTimer(() => {
      timer = undefined;
      nextRunAt = null;
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (running) {
      logger.warn('Execução ignorada: verificação anterior ainda está ativa');
      return;
    }
    clearScheduledRun();
    running = true;
    lastRunAt = new Date(now());
    nextRunAt = enabled ? new Date(lastRunAt.getTime() + currentIntervalMs) : null;
    try {
      return await task();
    } catch (error) {
      logger.error('Falha na verificação', { error: error.message });
      return undefined;
    } finally {
      running = false;
      scheduleNext();
    }
  };

  return {
    start() {
      if (enabled) return;
      enabled = true;
      scheduleNext();
    },
    stop() {
      enabled = false;
      clearScheduledRun();
    },
    setEnabled(value) {
      if (value) this.start();
      else this.stop();
    },
    setIntervalMs(value) {
      if (!Number.isSafeInteger(value) || value < 60 * 60 * 1000 || value > 168 * 60 * 60 * 1000) {
        throw new RangeError('O intervalo do agendador deve ficar entre 1 e 168 horas.');
      }
      if (currentIntervalMs === value) return;
      currentIntervalMs = value;
      if (enabled && running) nextRunAt = new Date(lastRunAt.getTime() + currentIntervalMs);
      else if (enabled) {
        nextRunAt = null;
        scheduleNext();
      }
    },
    async tick() { return tick(); },
    getState() {
      return {
        enabled,
        running,
        intervalMs: currentIntervalMs,
        lastRunAt: lastRunAt?.toISOString() || null,
        nextRunAt: nextRunAt?.toISOString() || null
      };
    }
  };
}
