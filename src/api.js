import { tr } from './i18n.jsx';
import { serverText } from './dayjob/server-text.js';

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
    throw new ApiError(0, tr('无法连接本地 Dayjob 服务。请确认 Dayjob 正在运行。', 'Cannot reach the local Dayjob service. Make sure Dayjob is running.'));
  }
  let value = null;
  try { value = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new ApiError(response.status, value?.error ? serverText(value.error) : tr(`请求失败（HTTP ${response.status}）`, `Request failed (HTTP ${response.status})`));
  return value;
}

// A reply written as lines of JSON while it is being made (the assistant): onEvent gets each line as it arrives.
// Aborting the signal ends the reply on the server too.
export async function apiLines(path, { body, signal, onEvent }) {
  let response;
  try {
    response = await fetch(path, { method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json', 'X-Dayjob-Token': token || '' },
      body: JSON.stringify(body ?? {}), signal });
  } catch (failure) {
    if (failure.name === 'AbortError') throw failure;
    throw new ApiError(0, tr('无法连接本地 Dayjob 服务。请确认 Dayjob 正在运行。', 'Cannot reach the local Dayjob service. Make sure Dayjob is running.'));
  }
  if (!response.ok) {
    let value = null;
    try { value = await response.json(); } catch { /* handled below */ }
    throw new ApiError(response.status, value?.error ? serverText(value.error) : tr(`请求失败（HTTP ${response.status}）`, `Request failed (HTTP ${response.status})`));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let event = null;
      try { event = JSON.parse(line); } catch { /* a broken line is skipped */ }
      if (event) onEvent(event);
    }
  }
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
