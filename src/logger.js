const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = process.env.LOG_LEVEL || 'info', timeZone = process.env.TIME_ZONE || 'America/Rio_Branco') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const logger = {};

  for (const [name, value] of Object.entries(LEVELS)) {
    logger[name] = (message, fields = {}) => {
      if (value < threshold) return;
      const now = new Date();
      const localTime = new Intl.DateTimeFormat('sv-SE', {
        timeZone,
        dateStyle: 'short',
        timeStyle: 'medium',
        hour12: false
      }).format(now);
      const safeFields = { ...fields };
      for (const key of Object.keys(safeFields)) {
        if (/token|authorization|secret|password/i.test(key)) safeFields[key] = '[REDACTED]';
      }
      const line = JSON.stringify({ timestamp: now.toISOString(), localTime, timeZone, level: name, message, ...safeFields });
      (name === 'error' ? console.error : name === 'warn' ? console.warn : console.log)(line);
    };
  }

  return logger;
}
