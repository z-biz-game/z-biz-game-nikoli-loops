// Everything the player earns survives a reload: best times, daily streak, settings.
// localStorage is the only store here — no account, no server.

const KEY = 'nikoli-loops.save.v1';

const shape = {
  // reduceMotion: null = 跟随系统（prefers-reduced-motion），true/false = 玩家显式选过
  settings: { sound: true, reduceMotion: null },
  records: {},   // "nonogram:10" → { bestMs, bestMoves, solves, noHintSolves }
  daily: {},     // "2026-09-27" → { nonogram: true, ... }
  stats: { solves: 0, noHint: 0, hints: 0 },
  streak: { day: '', count: 0, best: 0 },
};

const DAY_MS = 86400000;

// ---- 两段式解码 ------------------------------------------------------------------
// 第一段：JSON.parse 单独 try（整串垃圾 → 只丢整串，回到 blank）。
// 第二段：每个字段各自 normalize，坏一条丢一条 —— 原先写的是
//   { ...shape.records, ...JSON.parse(raw).records }
// 这类"默认值 + 展开"的写法，records 只要是个字符串/数字，后面 finish() 里的
// db[id] = cur 就在严格模式下抛 TypeError，玩家赢下这一局的那一瞬间整个界面冻死。
// 现在：类型不对就当没有，越界值夹回来，null 记录只丢它自己。
function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v, lo, hi, dflt = 0) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function flag(v, dflt) {
  return typeof v === 'boolean' ? v : dflt;
}

function normSettings(raw) {
  const src = isObj(raw) ? raw : {};
  const rm = src.reduceMotion;
  return {
    sound: flag(src.sound, shape.settings.sound),
    // 只有玩家显式表过态（true/false）才覆盖系统；其余一律回到"跟随系统"
    reduceMotion: typeof rm === 'boolean' ? rm : null,
  };
}

function normRecord(r) {
  if (!isObj(r)) return null;                       // 这一条丢了，别的照旧
  return {
    bestMs: num(r.bestMs, 0, 365 * DAY_MS, 0),
    bestMoves: num(r.bestMoves, 0, 1e6, 0),
    solves: num(r.solves, 0, 1e6, 0),
    noHintSolves: num(r.noHintSolves, 0, 1e6, 0),
  };
}

function normRecords(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const id of Object.keys(raw)) {
    const rec = normRecord(raw[id]);
    if (rec) out[String(id).slice(0, 64)] = rec;
  }
  return out;
}

function normDaily(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const day of Object.keys(raw)) {
    const entry = raw[day];
    if (!isObj(entry)) continue;
    const kept = {};
    for (const kind of Object.keys(entry)) if (entry[kind]) kept[String(kind).slice(0, 32)] = true;
    if (Object.keys(kept).length) out[String(day).slice(0, 32)] = kept;
  }
  return out;
}

function normStats(raw) {
  const src = isObj(raw) ? raw : {};
  return {
    solves: num(src.solves, 0, 1e7, 0),
    noHint: num(src.noHint, 0, 1e7, 0),
    hints: num(src.hints, 0, 1e7, 0),
  };
}

function normStreak(raw) {
  const src = isObj(raw) ? raw : {};
  const day = typeof src.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.day) ? src.day : '';
  return { day, count: num(src.count, 0, 1e5, 0), best: num(src.best, 0, 1e5, 0) };
}

// 一份任意来源的对象 → 一份一定读得下去的存档（坏字段各自降级，不抛）
function normalize(p) {
  const src = isObj(p) ? p : {};
  return {
    settings: normSettings(src.settings),
    records: normRecords(src.records),
    daily: normDaily(src.daily),
    stats: normStats(src.stats),
    streak: normStreak(src.streak),
  };
}

let cache = null;

function blank() {
  return normalize({});
}

function read() {
  if (cache) return cache;
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { raw = null; }
  if (raw) {
    try {
      cache = normalize(JSON.parse(raw));
      return cache;
    } catch { /* 整串不是 JSON：只丢这一份，回到空档继续玩 */ }
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
    const p = JSON.parse(text);            // 调用方 catch：这里抛是"这不是存档"，不是崩
    if (!isObj(p) || !isObj(p.records)) throw new Error('not a nikoli save');
    cache = normalize(p);                  // 逐段 normalize：能救回来的字段一个都不丢
    write();
  },
  reset() { cache = blank(); write(); },
};

// 系统级"减弱动效"：null（玩家没显式表过态）时以操作系统设置为准。
// 没有 matchMedia 的环境（无头复验、老内核）一律按"不减弱"处理，不猜。
const REDUCE_MQ = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

export function prefersReducedMotion() {
  const v = read().settings.reduceMotion;
  if (v === true || v === false) return v;
  return !!(REDUCE_MQ && REDUCE_MQ.matches);
}

export function onReducedMotionChange(fn) {
  if (!REDUCE_MQ || typeof REDUCE_MQ.addEventListener !== 'function') return () => {};
  const h = () => fn(prefersReducedMotion());
  REDUCE_MQ.addEventListener('change', h);
  return () => REDUCE_MQ.removeEventListener('change', h);
}
