// The Flow view: the phases of an idea, the lane of an idea over time, cumulative flow, and the tiles.
import { lane, LANES, MODEL_ALIASES, SIZES } from 'ideahook/store';

/** The earliest of the given times; null when none is set. */
const earliest = (...times) => times.filter(Boolean).sort()[0] || null;

/**
 * Bars for the timeline: the time an idea waited in the inbox, waited in the queue, and was in work.
 * `to: null` means "until now". Ideas that started before ideamine recorded start times get an
 * `estimated` work bar from the triage (or the creation) to the end.
 */
export function phases(idea) {
  const triaged = idea.triage?.at || null;
  const started = idea.started || null;
  const closed = idea.closed || null;
  const out = [];
  const add = (phase, from, to, estimated = false) => {
    if (from && (!to || to >= from)) out.push(estimated ? { phase, from, to, estimated } : { phase, from, to });
  };
  if (!started && (idea.status === 'doing' || idea.status === 'done')) {
    if (triaged) add('inbox', idea.created, triaged);
    add('doing', triaged || idea.created, closed, true);
    return out;
  }
  add('inbox', idea.created, earliest(triaged, started, closed));
  if (triaged && (!started || triaged < started)) add('queued', triaged, started || closed);
  if (started) add('doing', started, closed);
  return out;
}

const DAY = 86400000;
const OPEN_LANES = ['inbox', 'do', 'maybe', 'doing'];

/**
 * The lane of an idea at time `t` (ms), with the same rules as phases(): null before the idea
 * exists. A done idea without a recorded close time closed at its last update.
 */
export function laneAt(idea, t) {
  const at = (time) => (time ? Date.parse(time) : NaN);
  if (!(t >= at(idea.created))) return null;
  const closedStatus = idea.status === 'done' || idea.status === 'dropped';
  if (closedStatus && t >= at(idea.closed || idea.updated)) return idea.status;
  if (t >= at(idea.started)) return 'doing';
  const triaged = at(idea.triage?.at);
  if (!idea.started && idea.status === 'doing' && t >= (triaged || at(idea.created))) return 'doing';
  if (t >= triaged) return idea.triage?.verdict || 'maybe';
  return 'inbox';
}

/**
 * Cumulative flow: `times` (ISO, up to `samples` evenly spaced from the first idea to now) and
 * `series`, a count for each lane at each time. At every time, the lanes add up to the ideas that
 * existed then.
 */
export function flow(ideas, { samples = 60, now = Date.now() } = {}) {
  const series = Object.fromEntries(LANES.map((l) => [l, []]));
  const starts = ideas.map((i) => Date.parse(i.created)).filter(Number.isFinite);
  if (!starts.length) return { times: [], series };
  const first = Math.min(...starts, now);
  const span = Math.max(now - first, 1);
  const n = Math.max(2, Math.min(samples, span + 1)); // a step of 1 ms at least, so the times differ
  const times = [];
  for (let k = 0; k < n; k++) {
    const t = first + Math.round((span * k) / (n - 1));
    times.push(new Date(t).toISOString());
    for (const l of LANES) series[l].push(0);
    for (const idea of ideas) {
      const l = laneAt(idea, t);
      if (l && series[l]) series[l][k]++;
    }
  }
  return { times, series };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The tiles of the Flow view: what is open, what closed in the last 7 days, and how long ideas take. */
export function stats(ideas, { now = Date.now() } = {}) {
  const week = now - 7 * DAY;
  const open = ideas.filter((i) => OPEN_LANES.includes(lane(i)));
  const closedSince = (status) => ideas.filter((i) => i.status === status && Date.parse(i.closed) >= week).length;
  const done = ideas.filter((i) => i.status === 'done' && i.closed);
  const count = (keys, pick) => Object.fromEntries(keys.map((k) => [k, open.filter((i) => pick(i) === k).length]));
  return {
    open: open.length,
    done_7d: closedSince('done'),
    dropped_7d: closedSince('dropped'),
    lead_median_ms: median(done.map((i) => Date.parse(i.closed) - Date.parse(i.created))),
    cycle_median_ms: median(done.filter((i) => i.started).map((i) => Date.parse(i.closed) - Date.parse(i.started))),
    oldest_open_ms: open.length ? Math.max(...open.map((i) => now - Date.parse(i.created))) : null,
    models: count(MODEL_ALIASES, (i) => i.triage?.model),
    sizes: count(SIZES, (i) => i.triage?.size),
  };
}

