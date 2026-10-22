import fs from 'node:fs';
import { createHttp } from '../server/jobs/scrapers/http-client.mjs';
import { openDatabase } from '../server/jobs/db.mjs';
import { createRepository } from '../server/jobs/repository.mjs';

export const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// A fetch that answers from a list of [match, response] routes and records calls.
export function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body, headers: options.headers });
    const route = routes.find(([match]) => (typeof match === 'function' ? match(String(url), options) : String(url).includes(match)));
    if (!route) return new Response('not found', { status: 404 });
    const answer = typeof route[1] === 'function' ? await route[1](String(url), options, calls) : route[1];
    if (answer instanceof Error) throw answer;
    const { status = 200, body = '', url: finalUrl } = answer;
    const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' } });
    Object.defineProperty(response, 'url', { value: finalUrl || String(url) });
    return response;
  };
  return { fetch, calls };
}

export function fakeHttp(routes) {
  const { fetch, calls } = fakeFetch(routes);
  const sleeps = [];
  return { http: createHttp({ fetch, sleep: async ms => { sleeps.push(ms); }, retries: 1 }), calls, sleeps };
}

export function memoryRepo(now = () => new Date('2026-10-21T16:00:00Z')) {
  const { db } = openDatabase(':memory:');
  return { db, repo: createRepository(db, { now }) };
}

export function clock(start) {
  let time = new Date(start).getTime();
  const now = () => new Date(time);
  now.advance = ms => { time += ms; };
  now.set = value => { time = new Date(value).getTime(); };
  return now;
}
