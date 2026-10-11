import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { routes } from '../src/routes.js';
import { startFakeMemstate } from './fixtures/fake-memstate.js';

let server;
let url;

const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const readJson = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

beforeEach(async () => {
  process.env.IDEAMINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideaprofile-routes-'));
  process.env.CLAUDE_CONFIG_DIR = process.env.IDEAMINE_HOME; // no transcripts here
  delete process.env.IDEAMINE_MEMSTATE_URL;
  server = http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://x');
    try {
      if ((await routes(req, res, { route: `${req.method} ${pathname}`, query: searchParams, send, readJson })) === false) send(res, 404, { ok: false });
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

const post = async (route, body) =>
  (await fetch(new URL(route, url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (route) => (await fetch(new URL(route, url))).json();

test('the prompts of every machine are kept once each, and given by days, oldest first', async () => {
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const prompts = [
    { id: 'a', at: at(5), prompt: 'old one', host: 'pc' },
    { id: 'b', at: at(0), prompt: 'fix the tests', host: 'pc' },
    { id: 'c', prompt: 'no time' },
  ];
  assert.deepEqual(await post('api/prompts', { prompts }), { ok: true, added: 2, skipped: 1 });
  assert.equal((await post('api/prompts', { prompts })).added, 0);
  assert.deepEqual((await get('api/prompts')).prompts.map((p) => p.id), ['a', 'b']);
  assert.deepEqual((await get('api/prompts?days=1')).prompts.map((p) => p.prompt), ['fix the tests']);
});

test('usage rows replace the rows of their machine, keep the price, and drop a bad row', async () => {
  const row = { day: '2026-09-22', project: '/work/app', model: 'claude-opus-5', input: 1, output: 2, read: 3, write5m: 4, cost: 1.5 };
  assert.equal((await post('api/usage', { machine: 'm1', host: 'pc1', rows: [row] })).rows, 1);
  assert.equal((await get('api/usage')).rows[0].cost, 1.5);
  assert.equal((await post('api/usage', { machine: 'm1', host: 'pc1', rows: [row, { ...row, day: '2026-09-21' }] })).rows, 2);
  assert.equal((await post('api/usage', { machine: 'm2', host: 'pc2', rows: [row] })).machines, 2);
  assert.equal((await get('api/usage')).rows.length, 3);
  assert.equal((await post('api/usage', { rows: [] })).error, 'a machine id and its rows must come together');
  assert.equal((await post('api/usage', { machine: 'm3', rows: [{ day: 'not a day' }] })).rows, 0);
});

test('the memory routes read memstated and never write there', async () => {
  const memstate = await startFakeMemstate();
  process.env.IDEAMINE_MEMSTATE_URL = memstate.url;
  try {
    assert.deepEqual((await get('api/memory/overview')).projects.map((p) => p.id), ['ideamine']);
    assert.equal((await get('api/memory/project?id=ideamine')).memories[0].content, 'Built the dashboard.');
    assert.equal((await get('api/memory/history?project=ideamine&keypath=task.summary.2026_09_21')).versions.length, 2);
    assert.ok(memstate.requests.every((r) => /^(GET \/api\/v1\/projects|POST \/api\/v1\/(keypaths|memories\/history))$/.test(r)), memstate.requests.join(', '));
    await memstate.close();
    assert.match((await get('api/memory/overview')).error, /cannot reach memstated/);
  } finally {
    await memstate.close().catch(() => {});
  }
  delete process.env.IDEAMINE_MEMSTATE_URL;
  assert.match((await get('api/memory/overview')).error, /this server shows no memories/);
});

test('a route of another part is not answered', async () => {
  assert.equal((await fetch(new URL('api/start', url), { method: 'POST' })).status, 404);
});
