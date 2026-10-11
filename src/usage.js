// Token use and price for each project, from ccusage (MIT). ccusage reads the Claude Code
// transcripts in ~/.claude/projects and prices them with a price list that it keeps current.
// The rows keep the shape that the Usage tab and the ideamine server already use, plus `cost`.
//
// The price is the price of the API. A Claude subscription does not bill for each token, so for a
// subscription the number is what the same work would cost through the API.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/** The folder with the transcripts of Claude Code. */
export const transcriptsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

/** The name of the model without the date at its end, for example claude-haiku-4-5-20251001. */
export const modelName = (raw) => String(raw || '').trim().replace(/-\d{8}$/, '');

/** The price of a row in dollars: ccusage prices each row when it makes it. */
export const cost = (row) => row.cost || 0;

const ccusageCli = () => path.join(path.dirname(createRequire(import.meta.url).resolve('ccusage/package.json')), 'src', 'cli.js');

/** `ccusage claude daily --json --instances`: { projects: { <folder of the project>: [one entry per day] } }. */
function runCcusage() {
  const r = spawnSync(process.execPath, [ccusageCli(), 'claude', 'daily', '--json', '--instances'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120000,
  });
  if (r.status !== 0) throw new Error(`ccusage failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

/**
 * ccusage names a project by its transcript folder (C--work-app), which cannot be turned back into a
 * path. The first line with a `cwd` in the folder tells the real path.
 */
function projectPath(dir, name) {
  try {
    for (const f of fs.readdirSync(path.join(dir, name))) {
      if (!f.endsWith('.jsonl')) continue;
      const head = fs.readFileSync(path.join(dir, name, f), 'utf8').slice(0, 65536);
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } catch {
    // A folder that is gone, or has no transcript with a path: keep the folder name.
  }
  return name;
}

/**
 * The rows for each day, project, and model. `run` returns the JSON of ccusage; a test passes its own.
 * ccusage does not count answers or the 1-hour cache writes apart, so `messages` is 0 and all cache
 * writes are in `write5m`.
 */
export function scan({ dir = transcriptsDir(), run = runCcusage } = {}) {
  const rows = [];
  for (const [name, days] of Object.entries(run().projects || {})) {
    const project = projectPath(dir, name);
    for (const d of days) {
      for (const m of d.modelBreakdowns || []) {
        rows.push({
          day: d.date,
          project,
          model: modelName(m.modelName),
          messages: 0,
          input: m.inputTokens || 0,
          output: m.outputTokens || 0,
          read: m.cacheReadTokens || 0,
          write5m: m.cacheCreationTokens || 0,
          write1h: 0,
          cost: m.cost || 0,
        });
      }
    }
  }
  return { rows, files: new Set(rows.map((r) => r.project)).size, read: rows.length };
}

/** The rows of the last `days` days, newest day first. 0 days means every day. */
export function since(rows, days) {
  if (!days) return rows;
  const day = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return rows.filter((r) => r.day >= day);
}

/** One row for each project: the tokens, the price, and the price for each model. */
export function byProject(rows) {
  const out = new Map();
  const add = (to, r) => {
    for (const k of ['messages', 'input', 'output', 'read', 'write5m', 'write1h', 'cost']) to[k] += r[k] || 0;
  };
  const empty = (extra) => ({ ...extra, messages: 0, input: 0, output: 0, read: 0, write5m: 0, write1h: 0, cost: 0 });
  for (const r of rows) {
    const p = out.get(r.project) || empty({ project: r.project, models: {} });
    const m = p.models[r.model] || empty({ model: r.model });
    add(p, r);
    add(m, r);
    p.models[r.model] = m;
    out.set(r.project, p);
  }
  return [...out.values()].sort((a, b) => b.cost - a.cost);
}
