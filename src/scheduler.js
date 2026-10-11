export function createScheduler({ intervalMs, task, logger, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, initialNextRunAt = null, initialLastRunAt = null }) {
  let currentIntervalMs = intervalMs;
  let enabled = false;
  let running = false;
  let timer;
  const idleResolvers = new Set();
  let lastRunAt = initialLastRunAt && Number.isFinite(new Date(initialLastRunAt).getTime())
    ? new Date(initialLastRunAt)
    : null;
  let nextRunAt = initialNextRunAt && Number.isFinite(new Date(initialNextRunAt).getTime())
    ? new Date(initialNextRunAt)
    : null;

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
      for (const resolve of idleResolvers) resolve();
      idleResolvers.clear();
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
    setIntervalMs(value, { preserveNextRunAt = false } = {}) {
      if (!Number.isSafeInteger(value) || value < 60 * 60 * 1000 || value > 168 * 60 * 60 * 1000) {
        throw new RangeError('O intervalo do agendador deve ficar entre 1 e 168 horas.');
      }
      if (currentIntervalMs === value) return;
      currentIntervalMs = value;
      if (enabled && running) {
        if (!preserveNextRunAt) nextRunAt = new Date(lastRunAt.getTime() + currentIntervalMs);
      } else if (enabled) {
        if (!preserveNextRunAt) nextRunAt = null;
        scheduleNext();
      }
    },
    setNextRunAt(value) {
      const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
      if (!Number.isFinite(date.getTime())) throw new TypeError('A data do próximo disparo é inválida.');
      if (date.getTime() <= now()) throw new RangeError('O próximo disparo precisa estar no futuro.');
      if (!enabled) throw new Error('Ative o agendador antes de alterar o próximo disparo.');
      nextRunAt = date;
      if (!running) scheduleNext();
      return nextRunAt.toISOString();
    },
    async tick() { return tick(); },
    waitForIdle() {
      return running ? new Promise(resolve => idleResolvers.add(resolve)) : Promise.resolve();
    },
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
