export function createWorkerControlClient(config, { fetchImpl = fetch } = {}) {
  let safeTransport = false;
  try {
    const base = new URL(config.baseUrl);
    safeTransport = base.protocol === 'https:' ||
      (base.protocol === 'http:' && base.hostname === 'localhost');
  } catch {
    safeTransport = false;
  }
  const ready = Boolean(config.baseUrl && config.token && safeTransport);

  async function request(path, method, body) {
    if (!ready) throw new Error('Controle remoto não configurado.');
    const baseUrl = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
    const url = new URL(path.replace(/^\//, ''), baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 10000);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.token}`,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Controle remoto respondeu HTTP ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    isConfigured: ready,
    fetchConfig() { return request(config.configPath || '/api/worker/config', 'GET'); },
    sendHeartbeat(state) { return request(config.heartbeatPath || '/api/worker/heartbeat', 'POST', state); }
  };
}
