import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as usage from '../src/usage.js';

// What `ccusage claude daily --json --instances` prints: one entry for each day of each project folder.
const ccusage = () => ({
  projects: {
    'C--work-app': [
      {
        date: '2026-09-22',
        modelBreakdowns: [
          { modelName: 'claude-opus-5', inputTokens: 10, outputTokens: 1e6, cacheReadTokens: 5, cacheCreationTokens: 7, cost: 25 },
          { modelName: 'claude-haiku-4-5-20251001', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.01 },
        ],
      },
    ],
    'C--other': [{ date: '2026-09-20', modelBreakdowns: [{ modelName: 'claude-opus-5', outputTokens: 1e6, cost: 30 }] }],
  },
});

test('scan() turns the ccusage JSON into rows with the folder path, the model without its date, and the price', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideaprofile-usage-'));
  try {
    fs.mkdirSync(path.join(dir, 'C--work-app'));
    fs.writeFileSync(path.join(dir, 'C--work-app', 's.jsonl'), '{"type":"user"}\n{"type":"user","cwd":"C:\\\\work\\\\app"}\n');
    const { rows, files } = usage.scan({ dir, run: ccusage });
    assert.equal(files, 2);
    assert.equal(rows.length, 3);
    const opus = rows.find((r) => r.model === 'claude-opus-5' && r.day === '2026-09-22');
    assert.deepEqual(
      [opus.project, opus.input, opus.output, opus.read, opus.write5m, opus.write1h, usage.cost(opus)],
      ['C:\\work\\app', 10, 1e6, 5, 7, 0, 25],
    );
    assert.ok(rows.some((r) => r.model === 'claude-haiku-4-5')); // the date is gone
    assert.equal(rows.find((r) => r.day === '2026-09-20').project, 'C--other'); // no transcript: the folder name stays
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('byProject and since group the rows the way the page shows them', () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const rows = [
    { day: today, project: 'p1', model: 'claude-opus-5', output: 1e6, messages: 2, cost: 25 },
    { day: today, project: 'p1', model: 'claude-sonnet-5', output: 1e6, messages: 1, cost: 10 },
    { day: old, project: 'p2', model: 'claude-opus-5', output: 2e6, messages: 5, cost: 50 },
  ];
  assert.equal(usage.since(rows, 30).length, 2);
  assert.equal(usage.since(rows, 0).length, 3);
  const [first, second] = usage.byProject(rows);
  assert.deepEqual([first.project, first.cost], ['p2', 50]); // the most expensive project first
  assert.deepEqual([second.project, second.cost, second.messages], ['p1', 35, 3]);
  assert.deepEqual(Object.keys(second.models).sort(), ['claude-opus-5', 'claude-sonnet-5']);
});

test('the real ccusage reads a transcript of Claude Code and prices it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ideaprofile-cc-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    const folder = path.join(home, 'projects', 'C--demo');
    fs.mkdirSync(folder, { recursive: true });
    const line = {
      type: 'assistant',
      cwd: 'C:\\demo',
      sessionId: 's1',
      requestId: 'r1',
      timestamp: '2026-09-22T10:00:00.000Z',
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1000000, output_tokens: 1000000 } },
    };
    fs.writeFileSync(path.join(folder, 's1.jsonl'), `${JSON.stringify(line)}\n`);
    process.env.CLAUDE_CONFIG_DIR = home;
    const { rows } = usage.scan({ dir: path.join(home, 'projects') });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].project, rows[0].day, rows[0].input, rows[0].output], ['C:\\demo', '2026-09-22', 1e6, 1e6]);
    assert.ok(rows[0].cost > 0);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
