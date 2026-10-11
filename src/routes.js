// The HTTP routes of the server role for the prompt log, the token use of every machine, and the
// memories of a memstated daemon. The ideamine web server mounts them with routes().

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from 'ideahook/config';
import * as store from 'ideahook/store';
import * as usage from './usage.js';

const DAY = 86400000;
const promptsPath = () => path.join(store.home(), 'prompts.jsonl');
const usagePath = () => path.join(store.home(), 'usage.json');
const field = (v, max = 300) => (v == null ? null : String(v).slice(0, max));

// ---- prompts ----

let promptCache = null;

/** The prompt log: one JSON line for each prompt. The copy in memory is kept until the file changes. */
function loadPrompts() {
  const st = fs.statSync(promptsPath(), { throwIfNoEntry: false });
  if (!st) return { prompts: [], ids: new Set() };
  if (promptCache?.mtime === st.mtimeMs && promptCache.size === st.size) return promptCache;
  const prompts = [];
  for (const line of fs.readFileSync(promptsPath(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      prompts.push(JSON.parse(line));
    } catch {
      // A line that a crash cut in half.
    }
  }
  promptCache = { mtime: st.mtimeMs, size: st.size, prompts, ids: new Set(prompts.map((p) => p.id)) };
  return promptCache;
}

/** Add prompts that the log does not have yet. A prompt without an id, a time, or a text is skipped. */
function addPrompts(list) {
  if (!Array.isArray(list)) throw new Error('prompts must be a list');
  const { ids } = loadPrompts();
  const add = [];
  let skipped = 0;
  for (const p of list) {
    const bad = !p || typeof p.id !== 'string' || !p.id || typeof p.prompt !== 'string' || Number.isNaN(Date.parse(p.at));
    if (bad) skipped++;
    if (bad || ids.has(p.id)) continue;
    ids.add(p.id);
    add.push({ id: p.id.slice(0, 64), at: new Date(p.at).toISOString(), host: field(p.host, 100), session: field(p.session, 100), cwd: field(p.cwd), prompt: p.prompt });
  }
  if (add.length) store.withLock(() => fs.appendFileSync(promptsPath(), add.map((p) => `${JSON.stringify(p)}\n`).join('')));
  return { added: add.length, skipped };
}

/** The prompts of the last `days` days (all prompts for 0), oldest first. */
function listPrompts(days) {
  const since = days > 0 ? Date.now() - days * DAY : 0;
  return loadPrompts().prompts.filter((p) => Date.parse(p.at) >= since).sort((a, b) => a.at.localeCompare(b.at));
}

// ---- token use and price ----

/** The rows that the machines sent, by machine id. */
function loadUsage() {
  try {
    const data = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    if (data && data.version === 1 && data.machines) return data;
  } catch {
    // No machine sent rows yet.
  }
  return { version: 1, machines: {} };
}

/** Keep the rows of one machine. The new rows take the place of the rows from before. */
function saveUsage({ machine, host, rows }) {
  if (typeof machine !== 'string' || !machine || !Array.isArray(rows)) throw new Error('a machine id and its rows must come together');
  const clean = rows
    .filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.day)) && typeof r.project === 'string' && typeof r.model === 'string')
    .map((r) => ({
      day: r.day,
      project: String(r.project).slice(0, 300),
      model: String(r.model).slice(0, 60),
      messages: Number(r.messages) || 0,
      input: Number(r.input) || 0,
      output: Number(r.output) || 0,
      read: Number(r.read) || 0,
      write5m: Number(r.write5m) || 0,
      write1h: Number(r.write1h) || 0,
      cost: Number(r.cost) || 0,
    }));
  const data = loadUsage();
  data.machines[machine.slice(0, 64)] = { host: field(host, 100), at: new Date().toISOString(), rows: clean };
  store.withLock(() => store.writeAtomic(usagePath(), `${JSON.stringify(data)}\n`));
  return { rows: clean.length, machines: Object.keys(data.machines).length };
}

/** Every row of every machine, each one with the machine that sent it. */
function usageRows() {
  const out = [];
  for (const [machine, m] of Object.entries(loadUsage().machines)) {
    for (const r of m.rows || []) out.push({ ...r, machine, host: m.host });
  }
  return out;
}

/** The rows of this machine, read from the transcripts of Claude Code. */
const localUsage = () => usage.scan().rows.map((r) => ({ ...r, machine: 'here', host: os.hostname() }));

// ---- memories (memstated) ----

/** A read from the memstated daemon at memstate_url. */
async function memstate(route, body) {
  const base = config.get('memstate_url');
  if (!base) throw new Error('this server shows no memories. Set memstate_url, for example: ideamine config memstate_url http://127.0.0.1:8765');
  const url = `${base.replace(/\/+$/, '')}${route}`;
  const init = { signal: AbortSignal.timeout(8000) };
  if (body) Object.assign(init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(`cannot reach memstated at ${base}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`memstated answered ${res.status}: ${json?.error || 'no reason'}`);
  return json;
}

// The Memory tab reads memstated. It never writes there.
const MEMORY = {
  /** Every project, and every current memory without its text, for the list and the timeline. */
  async overview() {
    const { projects } = await memstate('/api/v1/projects');
    const memories = [];
    for (const p of projects) {
      const { memories: list } = await memstate('/api/v1/keypaths', { project_id: p.id });
      for (const m of list) memories.push({ id: m.id, project_id: p.id, keypath: m.keypath, category: m.category || null, version: m.version, created_at: m.created_at });
    }
    return { projects, memories };
  },
  /** The current memories of one project, with their text. */
  async project(query) {
    const { memories } = await memstate('/api/v1/keypaths', { project_id: query.get('id') || '', include_content: true });
    return { memories };
  },
  /** Every version of one memory, oldest first. */
  async history(query) {
    const { versions } = await memstate('/api/v1/memories/history', { project_id: query.get('project') || '', keypath: query.get('keypath') || '' });
    return { versions };
  },
};

/** Which tabs this server can fill. The web server also shows them when another server holds the data. */
export const live = () => ({
  prompts: fs.existsSync(promptsPath()),
  memory: !!config.get('memstate_url'),
  usage: fs.existsSync(usage.transcriptsDir()) || Object.keys(loadUsage().machines).length > 0,
});

/**
 * Answer a route of this part. `ctx` has `route` ("GET /api/usage"), `query` (URLSearchParams),
 * and the `send(res, status, body)` and `readJson(req)` of the web server. Resolves to false for a
 * route that is not here. The web server reports an error that it throws.
 */
export async function routes(req, res, { route, query, send, readJson }) {
  if (route === 'GET /api/usage') {
    const sent = usageRows();
    return send(res, 200, { ok: true, rows: sent.length ? sent : localUsage() });
  }
  if (route === 'POST /api/usage') return send(res, 200, { ok: true, ...saveUsage(await readJson(req)) });
  if (route === 'POST /api/prompts') return send(res, 200, { ok: true, ...addPrompts((await readJson(req)).prompts) });
  if (route === 'GET /api/prompts') return send(res, 200, { ok: true, prompts: listPrompts(Number(query.get('days')) || 0) });
  const memory = route.startsWith('GET /api/memory/') && route.slice('GET /api/memory/'.length);
  if (memory && Object.hasOwn(MEMORY, memory)) return send(res, 200, { ok: true, ...(await MEMORY[memory](query)) });
  return false;
}
