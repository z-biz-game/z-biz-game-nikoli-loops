// Everything the player earns survives a reload: best times, daily streak, settings.
// localStorage is the only store here — no account, no server.

const KEY = 'nikoli-loops.save.v1';

const shape = {
  settings: { sound: true, reduceMotion: false },
  records: {},   // "nonogram:10" → { bestMs, bestMoves, solves, noHintSolves }
  daily: {},     // "2026-09-27" → { nonogram: true, ... }
  stats: { solves: 0, noHint: 0, hints: 0 },
  streak: { day: '', count: 0, best: 0 },
};

let cache = null;

function blank() {
  return {
    settings: { ...shape.settings },
    records: {},
    daily: {},
    stats: { ...shape.stats },
    streak: { ...shape.streak },
  };
}

function read() {
  if (cache) return cache;
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { raw = null; }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      cache = {
        settings: { ...shape.settings, ...(p.settings || {}) },
        records: p.records || {},
        daily: p.daily || {},
        stats: { ...shape.stats, ...(p.stats || {}) },
        streak: { ...shape.streak, ...(p.streak || {}) },
      };
      return cache;
    } catch { /* corrupt or written by a newer build — start clean */ }
  }
  cache = blank();
  return cache;
}

function write() {
  try { localStorage.setItem(KEY, JSON.stringify(read())); } catch { /* private mode: play on, nothing persists */ }
}

// A streak is consecutive calendar days with at least one daily solved, so the
// boundary test is "the day before this one", not "24 hours ago".
function dayBefore(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export const store = {
  get settings() { return read().settings; },
  set(key, value) {
    read().settings[key] = value;
    write();
  },
  record(id) { return read().records[id] || null; },
  totalSolves() { return read().stats.solves; },
  statsObj() { return { ...read().stats }; },
  // A streak is alive if it was extended today or yesterday — the counter has not
  // silently died at midnight.
  streak(day = '') {
    const s = read().streak;
    return { ...s, alive: !!s.day && (s.day === day || s.day === dayBefore(day)) };
  },
  // Returns the new streak length when this completion started a new day's entry.
  markDaily(day, mode) {
    const db = read().daily;
    const had = db[day] || (db[day] = {});
    const fresh = !Object.keys(had).length;
    had[mode] = true;
    let bumped = 0;
    if (fresh) {
      const s = read().streak;
      s.count = s.day === dayBefore(day) ? s.count + 1 : 1;
      s.day = day;
      s.best = Math.max(s.best, s.count);
      bumped = s.count;
    }
    write();
    return bumped;
  },
  dailyDone(day) { return { ...(read().daily[day] || {}) }; },
  finish(id, { ms, moves, hints = 0 }) {
    const db = read().records;
    const prev = db[id] || { bestMs: 0, bestMoves: 0, solves: 0, noHintSolves: 0 };
    const cur = {
      solves: prev.solves + 1,
      noHintSolves: prev.noHintSolves + (hints ? 0 : 1),
      bestMs: !prev.bestMs || ms < prev.bestMs ? ms : prev.bestMs,
      bestMoves: !prev.bestMoves || moves < prev.bestMoves ? moves : prev.bestMoves,
    };
    db[id] = cur;
    const st = read().stats;
    st.solves += 1;
    st.hints += hints;
    if (!hints) st.noHint += 1;
    write();
    return cur;
  },
  exportText() { return JSON.stringify(read()); },
  importText(text) {
    const p = JSON.parse(text);
    if (!p || typeof p !== 'object' || !p.records) throw new Error('not a nikoli save');
    cache = {
      settings: { ...shape.settings, ...(p.settings || {}) },
      records: p.records,
      daily: p.daily || {},
      stats: { ...shape.stats, ...(p.stats || {}) },
      streak: { ...shape.streak, ...(p.streak || {}) },
    };
    write();
  },
  reset() { cache = blank(); write(); },
};
