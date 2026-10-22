export class ScrapeError extends Error {
  constructor(message, { status = null, blocked = false } = {}) {
    super(message);
    this.status = status;
    this.blocked = blocked;
  }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const jitter = ([low, high]) => Math.round((low + Math.random() * (high - low)) * 1000);

// One place for timeouts, polite retries and the "blocked" hint, shared by
// every board. Tests pass their own fetch and sleep.
export function createHttp({ fetch: fetchImpl = globalThis.fetch, sleep: wait = sleep, timeoutMs = 20000, retries = 2 } = {}) {
  async function request(url, { method = 'GET', headers = {}, body, expect = 'text', allowStatus = [] } = {}) {
    let attempt = 0;
    for (;;) {
      let response;
      try {
        response = await fetchImpl(url, {
          method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt < retries) { attempt += 1; await wait(1500 * attempt); continue; }
        throw new ScrapeError(`Network error: ${error.message}`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        attempt += 1;
        await wait(4000 * attempt);
        continue;
      }
      if (!response.ok && !allowStatus.includes(response.status)) {
        const blocked = response.status === 403 || response.status === 429 || response.status === 999;
        throw new ScrapeError(`HTTP ${response.status}${blocked ? ' (the site is limiting requests; try again later)' : ''}`,
          { status: response.status, blocked });
      }
      const payload = expect === 'json' ? await response.json().catch(() => {
        throw new ScrapeError('The site returned something that is not JSON.');
      }) : await response.text();
      return { status: response.status, url: response.url || url, body: payload };
    }
  }
  return { request, sleep: wait };
}
