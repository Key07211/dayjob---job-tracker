let token = null;

export function setToken(value) { token = value; }

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Every write carries the per-launch token that /api/bootstrap hands out.
export async function api(path, { method = 'GET', body } = {}) {
  const write = method !== 'GET';
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json', 'X-Dayjob-Token': token || '' } : {}) },
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, '无法连接本地 Dayjob 服务。请确认 Dayjob 正在运行。');
  }
  let value = null;
  try { value = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new ApiError(response.status, value?.error || `请求失败（HTTP ${response.status}）`);
  return value;
}

export function query(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, value === true ? '1' : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
