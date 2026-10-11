export function createNewsletterClient(config, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const ready = Boolean(config.baseUrl && config.path && config.method && config.token);
  return {
    isConfigured: ready,
    async request() {
      if (!ready) throw new Error('Integração não configurada: confirme o contrato e preencha NEWSLETTER_API_*');
      const url = new URL(config.path.replace(/^\//, ''), config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`);
      let lastError;
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          const headers = { accept: 'application/json' };
          if (config.token) headers.authorization = `Bearer ${config.token}`;
          const response = await fetchImpl(url, { method: config.method, headers, signal: controller.signal });
          if (response.ok) return { status: response.status, data: await response.json() };
          if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(`API respondeu HTTP ${response.status}`);
          const retryAfter = Number(response.headers.get('retry-after'));
          lastError = new Error(`API respondeu HTTP ${response.status}`);
          if (attempt < config.maxRetries) await sleep(retryAfter > 0 ? retryAfter * 1000 : config.retryBaseMs * 2 ** attempt);
        } catch (error) {
          lastError = error;
          if (error.message.startsWith('API respondeu HTTP ') && ![408, 425, 429, 500, 502, 503, 504].some(code => error.message.endsWith(String(code)))) throw error;
          if (attempt < config.maxRetries) await sleep(config.retryBaseMs * 2 ** attempt);
        } finally { clearTimeout(timeout); }
      }
      throw lastError;
    }
  };
}

