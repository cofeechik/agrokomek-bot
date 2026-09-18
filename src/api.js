export class ServiceError extends Error {
  constructor(service, status, options = {}) {
    super(`${service} request failed (${status})`);
    this.service = service;
    this.status = status;
    this.retryAfter = options.retryAfter || 0;
  }
}

export async function telegram(token, method, body = {}, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000),
    });
  } catch { throw new ServiceError('Telegram', 'network'); }
  let data;
  try { data = await response.json(); } catch { throw new ServiceError('Telegram', response.status); }
  if (!response.ok || !data.ok) throw new ServiceError('Telegram', data.error_code || response.status);
  return data.result;
}

export async function geminiRequest(key, path, body, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(75000),
    });
  } catch { throw new ServiceError('Gemini', 'network'); }
  let data;
  try { data = await response.json(); } catch { throw new ServiceError('Gemini', response.status); }
  if (!response.ok) {
    const retryHeader = Number(response.headers.get('retry-after')) || 0;
    const retryDetail = data?.error?.details?.find(detail => typeof detail?.retryDelay === 'string')?.retryDelay;
    const retrySeconds = retryDetail?.match(/^(\d+(?:\.\d+)?)s$/)?.[1];
    throw new ServiceError('Gemini', response.status, { retryAfter: retryHeader || Number(retrySeconds) || 0 });
  }
  return data;
}

export async function boundedBytes(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('Image download rejected');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) { throw new Error('Image exceeds limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
