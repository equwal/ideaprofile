import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { flow, laneAt, phases, stats } from '../src/flow.js';
import * as store from 'ideahook/store';

const T = (h) => `2026-09-21T${String(h).padStart(2, '0')}:00:00.000Z`;

test('timeline phases follow the inbox, the queue, and the work', () => {
  const base = { id: 1, created: T(1), status: 'inbox' };
  assert.deepEqual(phases(base), [{ phase: 'inbox', from: T(1), to: null }]);
  const queued = { ...base, status: 'triaged', triage: { at: T(2) } };
  assert.deepEqual(phases(queued), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'queued', from: T(2), to: null },
  ]);
  const done = { ...queued, status: 'done', started: T(3), closed: T(5) };
  assert.deepEqual(phases(done), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'queued', from: T(2), to: T(3) },
    { phase: 'doing', from: T(3), to: T(5) },
  ]);
  // Done before start times were recorded: the work bar is a guess, and says so.
  assert.deepEqual(phases({ ...queued, status: 'done', closed: T(5) }), [
    { phase: 'inbox', from: T(1), to: T(2) },
    { phase: 'doing', from: T(2), to: T(5), estimated: true },
  ]);
  assert.deepEqual(phases({ ...base, status: 'dropped', closed: T(4) }), [{ phase: 'inbox', from: T(1), to: T(4) }]);
});

// ---- the Flow view: lane over time, cumulative flow, and the tiles ----

const iso = (ms) => new Date(ms).toISOString();
const NOW = 4_000_000;

/** An idea with ordered times: created ≤ triaged ≤ started ≤ closed, each stage optional. */
const ideaArb = fc
  .record({
    id: fc.integer({ min: 1, max: 1000 }),
    created: fc.integer({ min: 0, max: 1_000_000 }),
    gaps: fc.tuple(fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 500_000 })),
    stage: fc.constantFrom('inbox', 'triaged', 'doing', 'done', 'dropped'),
    triaged: fc.boolean(),
    hasStart: fc.boolean(),
    verdict: fc.constantFrom('do', 'maybe', 'skip'),
  })
  .map(({ id, created, gaps, stage, triaged, hasStart, verdict }) => {
    const idea = { id, created: iso(created), status: stage === 'triaged' ? 'triaged' : stage, updated: iso(created) };
    let t = created;
    if (stage === 'triaged' || (triaged && stage !== 'inbox')) idea.triage = { at: iso((t += gaps[0])), verdict };
    if (hasStart && ['doing', 'done', 'dropped'].includes(stage)) idea.started = iso((t += gaps[1]));
    if (stage === 'done' || stage === 'dropped') idea.closed = iso((t += gaps[2]));
    idea.updated = iso(t);
    return idea;
  });

test('laneAt() agrees with lane() once every time is in the past, and is null before the idea exists', () => {
  fc.assert(
    fc.property(ideaArb, (idea) => {
      assert.equal(laneAt(idea, NOW), store.lane(idea));
      assert.equal(laneAt(idea, Date.parse(idea.created) - 1), null);
      assert.notEqual(laneAt(idea, Date.parse(idea.created)), null);
    }),
  );
});

test('laneAt() walks the stages in order', () => {
  const idea = { id: 1, created: T(1), status: 'done', triage: { at: T(2), verdict: 'do' }, started: T(3), closed: T(5) };
  const at = (h) => laneAt(idea, Date.parse(T(h)));
  assert.deepEqual([at(0), at(1), at(2), at(3), at(4), at(5), at(9)], [null, 'inbox', 'do', 'doing', 'doing', 'done', 'done']);
  // In work before ideamine recorded start times: the work is estimated from the triage, like phases().
  assert.equal(laneAt({ id: 2, created: T(1), status: 'doing', triage: { at: T(2), verdict: 'do' } }, Date.parse(T(3))), 'doing');
  assert.equal(laneAt({ id: 2, created: T(1), status: 'doing', triage: { at: T(2), verdict: 'do' } }, Date.parse(T(1))), 'inbox');
});

test('flow(): at every sample, the lanes add up to the ideas that existed then', () => {
  fc.assert(
    fc.property(fc.array(ideaArb, { minLength: 0, maxLength: 30 }), fc.integer({ min: 2, max: 80 }), (ideas, samples) => {
      const { times, series } = flow(ideas, { samples, now: NOW });
      assert.deepEqual(Object.keys(series).sort(), [...store.LANES].sort());
      for (const lane of store.LANES) assert.equal(series[lane].length, times.length);
      if (!ideas.length) return assert.equal(times.length, 0);
      assert.ok(times.length >= 2 && times.length <= samples);
      assert.equal(times[times.length - 1], iso(NOW));
      for (let k = 0; k < times.length; k++) {
        const t = Date.parse(times[k]);
        if (k > 0) assert.ok(t > Date.parse(times[k - 1]), 'times are strictly increasing');
        const total = store.LANES.reduce((sum, lane) => sum + series[lane][k], 0);
        assert.equal(total, ideas.filter((i) => Date.parse(i.created) <= t).length);
      }
    }),
  );
});

test('stats(): open count, the last 7 days, medians, the oldest open idea, and the model mix', () => {
  const now = Date.parse('2026-09-22T00:00:00.000Z');
  const day = (n, h = 0) => new Date(now - n * 86400000 + h * 3600000).toISOString();
  const ideas = [
    { id: 1, created: day(10), status: 'inbox' },
    { id: 2, created: day(9), status: 'triaged', triage: { at: day(8), verdict: 'do', model: 'haiku', size: 's' } },
    { id: 3, created: day(9), status: 'triaged', triage: { at: day(8), verdict: 'skip', model: 'opus', size: 'l' } },
    { id: 4, created: day(6), status: 'doing', triage: { at: day(5), verdict: 'do', model: 'sonnet', size: 'm' }, started: day(4) },
    { id: 5, created: day(8), status: 'done', started: day(3), closed: day(1) },
    { id: 6, created: day(30), status: 'done', started: day(20), closed: day(10) },
    { id: 7, created: day(2), status: 'dropped', closed: day(1) },
  ];
  const s = stats(ideas, { now });
  assert.equal(s.open, 3); // #1 inbox, #2 do, #4 doing
  assert.deepEqual([s.done_7d, s.dropped_7d], [1, 1]);
  assert.equal(s.lead_median_ms, (7 + 20) / 2 * 86400000); // #5: 7 days, #6: 20 days
  assert.equal(s.cycle_median_ms, (2 + 10) / 2 * 86400000);
  assert.equal(s.oldest_open_ms, 10 * 86400000);
  assert.deepEqual(s.models, { haiku: 1, sonnet: 1, opus: 0, fable: 0 });
  assert.deepEqual(s.sizes, { xs: 0, s: 1, m: 1, l: 0, xl: 0 });
  const empty = stats([], { now });
  assert.deepEqual([empty.open, empty.lead_median_ms, empty.cycle_median_ms, empty.oldest_open_ms], [0, null, null, null]);
});
