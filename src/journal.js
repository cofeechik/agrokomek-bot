import { randomUUID } from 'node:crypto';

// Only the server accesses this table; every user-facing operation is scoped to chat_id.
export class Journal {
  constructor(url, secret, fetcher = fetch) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid journal URL');
    this.url = `${parsed.origin}/rest/v1/agro_observations`;
    this.secret = secret;
    this.fetcher = fetcher;
  }
  async request(method, params, body) {
    const headers = { apikey: this.secret, 'content-type': 'application/json', Prefer: 'return=representation,resolution=ignore-duplicates' };
    // Legacy service_role is a JWT; modern sb_secret keys use only apikey.
    if (!this.secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${this.secret}`;
    let response;
    try {
      response = await this.fetcher(`${this.url}?${new URLSearchParams(params)}`, {
        method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('Journal unavailable'); }
    if (!response.ok) throw new Error(`Journal request failed (${response.status})`);
    if (response.status === 204) return [];
    return response.json();
  }
  async list(chatId, offset = 0, limit = 6) {
    return this.request('GET', { chat_id: `eq.${String(chatId)}`, select: '*', order: 'created_at.desc,id.desc', offset: String(offset), limit: String(limit) });
  }
  async get(chatId, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const rows = await this.request('GET', { chat_id: `eq.${String(chatId)}`, id: `eq.${id}`, limit: '1' });
    return rows[0] || null;
  }
  async add(chatId, entry) {
    const row = { ...entry, id: randomUUID(), chat_id: String(chatId), created_at: new Date().toISOString() };
    return this.request('POST', { on_conflict: 'chat_id,message_id' }, row);
  }
  async delete(chatId) {
    await this.request('DELETE', { chat_id: `eq.${String(chatId)}` });
  }
}

export function summarizeObservations(rows) {
  const trends = { improved: 0, stable: 0, worse: 0, uncertain: 0 };
  const crops = {};
  let urgent = 0, uncertain = 0;
  for (const row of rows) {
    crops[row.crop] = (crops[row.crop] || 0) + 1;
    const result = row.assessment;
    if ('trend' in result) {
      const trend = result.status === 'comparison' && Object.hasOwn(trends, result.trend) ? result.trend : 'uncertain';
      trends[trend]++;
    } else if (result.urgency === 'today') urgent++;
    if (!['assessment', 'comparison'].includes(result.status)) uncertain++;
  }
  return { count: rows.length, crops, trends, urgent, uncertain };
}
