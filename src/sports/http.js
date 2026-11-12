import { collections } from './collections.js';
function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
/**
 * Limites com folga em relação aos planos gratuitos:
 *  - SportAPI: 1.000/dia e 7.000/mês (a partir de 01/12/2026)
 *  - ESPN: sem chave nem cota declarada; ~150 chamadas por coleta diária.
 *  - OpenF1 e Jolpica: sem chave; limitamos por cortesia.
 *  - TheSportsDB: 30/min na chave grátis; a coleta de escudos espaça as chamadas.
 */
export function budgetFor(provider) {
  switch (provider) {
    case 'sportapi':
      return {
        daily: envInt('SPORTAPI_DAILY_BUDGET', 220),
        monthly: envInt('SPORTAPI_MONTHLY_BUDGET', 6800)
      };
    case 'openf1':
    case 'jolpica':
      return { daily: 400 };
    case 'thesportsdb':
      return { daily: 1000 };
    case 'espn':
      return { daily: envInt('ESPN_DAILY_BUDGET', 3000) };
  }
}
export class BudgetExceededError extends Error {
  constructor(provider, detail) {
    super(`Orçamento de chamadas esgotado para ${provider}: ${detail}`);
    this.name = 'BudgetExceededError';
  }
}
export class ProviderError extends Error {
  provider;
  status;
  constructor(provider, status, message) {
    super(`${provider} respondeu ${status}: ${message}`);
    this.provider = provider;
    this.status = status;
    this.name = 'ProviderError';
  }
}
function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
export class ApiClient {
  db;
  /** Chamadas feitas nesta execução, por provedor (vai para o resumo do job). */
  calls = {};
  constructor(db) {
    this.db = db;
  }
  async remainingBudget(provider) {
    const budget = budgetFor(provider);
    const usage = collections(this.db).apiUsage;
    const day = utcDay();
    const today = await usage.findOne({ _id: `usage:${provider}:${day}` });
    let remaining = budget.daily - (today?.calls ?? 0);
    if (budget.monthly) {
      const [month] = await usage
        .aggregate([
          { $match: { provider, month: day.slice(0, 7) } },
          { $group: { _id: null, total: { $sum: '$calls' } } }
        ])
        .toArray();
      remaining = Math.min(remaining, budget.monthly - (month?.total ?? 0));
    }
    return remaining;
  }
  async record(provider, remainingHeader) {
    const day = utcDay();
    const remaining = remainingHeader ? Number.parseInt(remainingHeader, 10) : undefined;
    await collections(this.db).apiUsage.updateOne(
      { _id: `usage:${provider}:${day}` },
      {
        $inc: { calls: 1 },
        $set: {
          provider,
          day,
          month: day.slice(0, 7),
          updatedAt: new Date(),
          ...(Number.isFinite(remaining) ? { remaining } : {})
        }
      },
      { upsert: true }
    );
    this.calls[provider] = (this.calls[provider] ?? 0) + 1;
  }
  async getJson(provider, url, headers = {}) {
    const left = await this.remainingBudget(provider);
    if (left <= 0) throw new BudgetExceededError(provider, url);
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'kings-sports-ingest/1.0', ...headers },
      signal: AbortSignal.timeout(15_000)
    });
    // Toda chamada conta para o provedor, inclusive erros.
    await this.record(
      provider,
      response.headers.get('x-ratelimit-remaining') ?? response.headers.get('x-ratelimit-requests-remaining')
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(provider, response.status, text.slice(0, 300));
    }
    return await response.json();
  }
}
