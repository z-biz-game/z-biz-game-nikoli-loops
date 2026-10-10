// 珍珠 / Masyu —— 线穿过格心，珍珠格非走不可，白珠"直穿且两头至少一头拐"，黑珠"在珠上拐、
// 拐前后各直着走两格"。
//
// 与圈环的差别全在落子目标上：圈环画的是点与点之间的边（step 1），这里画的是"线穿过哪个格"
// （step 2，目标只有奇奇坐标 = 格心）。一格 = 一次落子；擦掉重画不退款，撤销也不退款 ——
// 快照里只有棋盘，绝没有 moves（姊妹仓的无头复验专门盯这一条）。
//
// 三样东西缺一不可（与圈环同立场）：
//   · propagate() —— 人用的那几条：珍珠格必在环上、黑珠的"两格直伸"、白珠的"直穿 + 一头拐"、
//     一格最多两条出头、提前闭成一圈而圈外还有线或珍珠 = 子环。从空盘推到不动点。
//     传播的每一步都是"任何解都得成立"的结论，所以推满全盘 = 唯一性的证明（不是猜的）。
//   · countSolutions() —— 传播之上做有界回溯，数到 cap 早停；没数完就是 capped，绝不说"唯一"。
//   · validate() —— 独立于上面两者：按题面规则直接判"一串有序格心是不是一条闭环 + 珍珠全对"。
//     求解器负责找得到解，校验器负责那确实是解，两边对拍才敢说生成器没说谎。
//
// 出题：先在格图上滚出一条"无弦单环"（矩形回字环 + 随机鼓包/收包，每步都用 isCycle 复验：
// 环上每格在格图里的邻格恰好两个 —— 这既保证是一条不自交不分叉的闭环，也保证玩家按顺序拖
// 过这些格时，接口只有一种接法）。然后按环上的拐/直分类，能放珠的位置先全放，再贪心删，
// 每删一颗都用 countSolutions 复核还是唯一解。

import { rngFrom } from '../core/rng.js';
import { T } from '../core/theme.js';
import { paper, rules, crossMark, rgba, pulse, easeOut, clamp } from '../core/paper.js';
import { isCell, cellOf, cellAt, halfPoint } from '../core/lattice.js';

export const UNKNOWN = -1;
export const NO = 0;
export const YES = 1;

// 珍珠种类：spec 里是字符串（要过 JSON），内部算的是 1/2
export const WHITE = 1;
export const BLACK = 2;

// 方向：0 右 1 左 2 下 3 上 —— d^1 正好是反向，AXES 是两条"直穿"轴，CORNERS 是四种拐法
const AXES = [[0, 1], [2, 3]];
const CORNERS = [[0, 2], [0, 3], [1, 2], [1, 3]];
const ALL_PAIRS = AXES.concat(CORNERS);

// 段的索引：横段 h(i,j) 连格心 (i,j)→(i+1,j)，i∈[0,n-1) j∈[0,m)；竖段接在其后
const hIdx = (n, i, j) => j * (n - 1) + i;
const vIdx = (n, m, i, j) => (n - 1) * m + j * n + i;
export const nSegs = (n, m) => (n - 1) * m + n * (m - 1);
export const cellOfIndex = (n, c) => [c % n, Math.floor(c / n)];
export const halfOfCell = (n, c) => cellAt(c % n, Math.floor(c / n));

// ---- 格图：每格四个方向的段号与邻格号（出界的记 -1，一律当"封死"） --------------------
const geomCache = new Map();

export function geom(n, m) {
  const key = n + 'x' + m;
  const hit = geomCache.get(key);
  if (hit) return hit;
  const cells = n * m;
  const segs = nSegs(n, m);
  const ports = new Int32Array(cells * 4).fill(-1);
  const nb = new Int32Array(cells * 4).fill(-1);
  const segA = new Int32Array(segs);
  const segB = new Int32Array(segs);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i;
      if (i < n - 1) { ports[c * 4] = hIdx(n, i, j); nb[c * 4] = c + 1; }
      if (i > 0) { ports[c * 4 + 1] = hIdx(n, i - 1, j); nb[c * 4 + 1] = c - 1; }
      if (j < m - 1) { ports[c * 4 + 2] = vIdx(n, m, i, j); nb[c * 4 + 2] = c + n; }
      if (j > 0) { ports[c * 4 + 3] = vIdx(n, m, i, j - 1); nb[c * 4 + 3] = c - n; }
    }
  }
  for (let j = 0; j < m; j++) for (let i = 0; i < n - 1; i++) {
    const s = hIdx(n, i, j); segA[s] = j * n + i; segB[s] = j * n + i + 1;
  }
  for (let j = 0; j < m - 1; j++) for (let i = 0; i < n; i++) {
    const s = vIdx(n, m, i, j); segA[s] = j * n + i; segB[s] = (j + 1) * n + i;
  }
  const g = { n, m, cells, segs, ports, nb, segA, segB, fresh: () => new Int8Array(segs).fill(UNKNOWN) };
  geomCache.set(key, g);
  return g;
}

// 连接两格的段号（不相邻返回 -1）
export function segBetween(g, a, b) {
  if (a < 0 || b < 0) return -1;
  for (let d = 0; d < 4; d++) if (g.nb[a * 4 + d] === b) return g.ports[a * 4 + d];
  return -1;
}

// 珍珠索引：role[c] = 0/WHITE/BLACK，list 是带珠的格（传播按格扫，不每次翻 spec 数组）
export function pearlIndex(g, pearls) {
  const role = new Int8Array(g.cells);
  const list = [];
  for (const [i, j, kind] of pearls) {
    if (i < 0 || j < 0 || i >= g.n || j >= g.m) continue;
    const c = j * g.n + i;
    const r = kind === 'black' ? BLACK : WHITE;
    if (role[c] === r) continue;
    role[c] = r;
    list.push([c, r]);
  }
  return { role, list };
}

// 黑珠的"直伸两格"：从珠 c 沿 d 方向必须连着三段（c→q1→q2→q3），
// 因为 q1、q2 都得直穿 —— 任何一段出界或已被封掉，这个方向就不是黑珠的走法。
function blackRun(g, c, d) {
  const s1 = g.ports[c * 4 + d];
  const q1 = g.nb[c * 4 + d];
  if (s1 < 0 || q1 < 0) return null;
  const s2 = g.ports[q1 * 4 + d];
  const q2 = g.nb[q1 * 4 + d];
  if (s2 < 0 || q2 < 0) return null;
  const s3 = g.ports[q2 * 4 + d];
  if (s3 < 0) return null;
  return [s1, s2, s3];
}

// PERP[d] = 与 d 不同轴的两个方向（"拐弯"就是从这两个里再挑一个）
const PERP = [[2, 3], [2, 3], [0, 1], [0, 1]];

// 格子 x 从珠子那侧进来（入向 dIn，即 x 指着珠子的段号方向），它还有没有可能拐弯？
// 两条垂直出头都被封 = 这格已被钉成直穿。白珠要求"进出两格至少一格拐"，全靠这个判断淘汰走法。
function canTurn(g, x, dIn, state) {
  if (x < 0) return false;
  for (const d of PERP[dIn]) {
    const k = g.ports[x * 4 + d];
    if (k >= 0 && state[k] !== NO) return true;
  }
  return false;
}

// 一格在环上恰好两条出头：方向对六种（两轴直穿 + 四角拐弯）；珍珠把它们收窄，
// 已有的 NO 再淘汰一轮。返回可行的方向对列表（空 = 这颗珠子摆不下，矛盾）。
function feasiblePairs(g, c, kind, state) {
  const pairs = kind === WHITE ? AXES : kind === BLACK ? CORNERS : ALL_PAIRS;
  const out = [];
  for (const [d1, d2] of pairs) {
    const k1 = g.ports[c * 4 + d1], k2 = g.ports[c * 4 + d2];
    if (k1 < 0 || k2 < 0 || state[k1] === NO || state[k2] === NO) continue;
    if (kind === WHITE) {
      const a = g.nb[c * 4 + d1], b = g.nb[c * 4 + d2];
      if (!canTurn(g, a, d2, state) && !canTurn(g, b, d1, state)) continue;   // 两头都只能直穿 = 白珠作废
    } else if (kind === BLACK) {
      const r1 = blackRun(g, c, d1), r2 = blackRun(g, c, d2);
      if (!r1 || !r2) continue;
      if (r1.some((k) => state[k] === NO) || r2.some((k) => state[k] === NO)) continue;
    }
    out.push([d1, d2]);
  }
  return out;
}

// 一格的全部可能"构型"：珍珠只有它那一族方向对；空格还多一种"根本不在环上"（pair = null）。
// 这是完备的划分 —— 任何解在这一格的状态都必落在其中一条，所以回溯按它分叉不会漏解。
function configsOf(g, c, role, state) {
  if (role[c] !== 0) return feasiblePairs(g, c, role[c], state).map((pair) => ({ pair }));
  const out = [];
  for (const [d1, d2] of ALL_PAIRS) {
    const k1 = g.ports[c * 4 + d1], k2 = g.ports[c * 4 + d2];
    if (k1 < 0 || k2 < 0 || state[k1] === NO || state[k2] === NO) continue;
    out.push({ pair: [d1, d2] });
  }
  let yes = false;
  for (let d = 0; d < 4; d++) { const k = g.ports[c * 4 + d]; if (k >= 0 && state[k] === YES) yes = true; }
  if (!yes) out.push({ pair: null });                            // 整格不走（只在环上没沾到时才允许）
  return out;
}

// ---- 规则传播 -------------------------------------------------------------------
// 出界的段当作 NO，于是"封掉一个不可能的方向"和"封掉一条边"用同一条 put 就够了。
// 既可以直接 propagate(state, spec)，也照姊妹仓的样子 propagate(state, n, m, pearls)。
export function propagate(state, n, m, pearls) {
  if (n && typeof n === 'object') { const spec = n; n = spec.n; m = spec.m; pearls = spec.pearls; }
  const g = geom(n, m);
  return spread(state, g, pearlIndex(g, pearls || []));
}

export function spread(state, g, pi) {
  const { role } = pi;
  let changed = true;
  const put = (k, val) => {
    if (k < 0) return val === NO ? 0 : -1;
    if (state[k] === UNKNOWN) { state[k] = val; return 1; }
    return state[k] === val ? 0 : -1;
  };
  const force = (k, val) => { const r = put(k, val); if (r < 0) return false; changed = changed || r === 1; return true; };

  while (changed) {
    changed = false;

    // 1) 每格的出头数只能是 0 或 2；有珠的格必须是 2
    for (let c = 0; c < g.cells; c++) {
      let yes = 0; const unk = [];
      for (let d = 0; d < 4; d++) {
        const k = g.ports[c * 4 + d]; if (k < 0) continue;
        if (state[k] === YES) yes++; else if (state[k] === UNKNOWN) unk.push(k);
      }
      if (yes > 2) return false;
      if (yes === 2) { for (const k of unk) if (!force(k, NO)) return false; continue; }
      if (yes === 1) {
        if (1 + unk.length < 2) return false;                 // 进来一条却再也没第二条
        if (1 + unk.length === 2) { for (const k of unk) if (!force(k, YES)) return false; }
        continue;
      }
      if (role[c] !== 0) {                                    // 空手的珍珠格
        if (unk.length < 2) return false;
        if (unk.length === 2) { for (const k of unk) if (!force(k, YES)) return false; }
      }
    }

    // 2) 构型淘汰：一格剩下的可能走法只有一种，当场钉死。珍珠的走法由珠色收窄（白珠只剩两轴、
    //    黑珠只剩四角且两侧各三段没被封），空格则还多一种"整格不在环上"。
    for (let c = 0; c < g.cells; c++) {
      let hasUnk = false;
      for (let d = 0; d < 4; d++) { const k = g.ports[c * 4 + d]; if (k >= 0 && state[k] === UNKNOWN) { hasUnk = true; break; } }
      if (!hasUnk) continue;
      const cfgs = configsOf(g, c, role, state);
      if (!cfgs.length) return false;                            // 这颗珠子已经摆不下 / 这格无路可走
      if (cfgs.length > 1) continue;
      const pair = cfgs[0].pair;
      for (let d = 0; d < 4; d++) {
        const val = pair && (d === pair[0] || d === pair[1]) ? YES : NO;
        if (!force(g.ports[c * 4 + d], val)) return false;
      }
    }

    // 3) 珍珠已定的那一条轴/那一个拐，把它的后续也一并压出来
    for (const [c, kind] of pi.list) {
      if (kind === BLACK) {
        for (let d = 0; d < 4; d++) {
          const s1 = g.ports[c * 4 + d];
          if (s1 < 0 || state[s1] !== YES) continue;
          const run = blackRun(g, c, d);
          if (!run) return false;                                // 拐了却伸不足两格 = 这颗黑珠不成立
          for (const k of run) if (!force(k, YES)) return false;
        }
      } else {
        // 直穿过白珠、进出两格至少一格要拐弯：一头已被钉成直穿，另一头就必须拐
        for (const [d1, d2] of AXES) {
          const k1 = g.ports[c * 4 + d1], k2 = g.ports[c * 4 + d2];
          if (k1 < 0 || k2 < 0 || state[k1] !== YES || state[k2] !== YES) continue;
          const a = g.nb[c * 4 + d1], b = g.nb[c * 4 + d2];
          const aTurn = canTurn(g, a, d2, state), bTurn = canTurn(g, b, d1, state);
          if (!aTurn && !bTurn) return false;
          if (!aTurn && !force(g.ports[b * 4 + d2], NO)) return false;
          if (!bTurn && !force(g.ports[a * 4 + d1], NO)) return false;
        }
      }
    }

    // 4) 提前闭成一圈 = 子环
    if (closedTooEarly(state, g, role)) return false;

    // 5) 反过来说：圈已经闭合且珠子全在圈上，剩下的未知段一律封掉 —— 再多一笔就是第二个圈
    if (!changed) {
      const cyc = cycleOf(state, g);
      if (cyc) {
        const on = new Set(cyc);
        if (pi.list.every(([c]) => on.has(c))) {
          let any = false;
          for (let k = 0; k < g.segs; k++) if (state[k] === UNKNOWN) { state[k] = NO; any = true; }
          if (any) changed = true;
        }
      }
    }
  }
  return true;
}

// 已画的段里若有一块自己闭成了环，而圈外还有线或有珍珠没被穿进去 —— 那条环再也接不上别的
// 格子，非法。判据是"分量里每格都恰好两条出头"（度全为 2 的连通块就是圈）。
function closedTooEarly(state, g, role) {
  const deg = new Int8Array(g.cells);
  const on = [];
  for (let s = 0; s < g.segs; s++) {
    if (state[s] !== YES) continue;
    const a = g.segA[s], b = g.segB[s];
    if (deg[a]++ === 0) on.push(a);
    if (deg[b]++ === 0) on.push(b);
  }
  if (on.length < 4) return false;
  const comp = new Int32Array(g.cells).fill(-1);
  const blocks = [];
  for (const c0 of on) {
    if (comp[c0] >= 0) continue;
    const id = blocks.length;
    const list = [];
    const stack = [c0];
    comp[c0] = id;
    while (stack.length) {
      const c = stack.pop();
      list.push(c);
      for (let d = 0; d < 4; d++) {
        const k = g.ports[c * 4 + d];
        if (k < 0 || state[k] !== YES) continue;
        const nb = g.nb[c * 4 + d];
        if (comp[nb] < 0) { comp[nb] = id; stack.push(nb); }
      }
    }
    blocks.push(list);
  }
  for (let id = 0; id < blocks.length; id++) {
    const list = blocks[id];
    if (!list.every((c) => deg[c] === 2)) continue;           // 还有开口，圈没闭合
    if (on.length > list.length) return true;                  // 圈外还挂着线
    for (let c = 0; c < g.cells; c++) if (role[c] !== 0 && comp[c] !== id) return true;
  }
  return false;
}

// ---- 求解 -----------------------------------------------------------------------
// 从满盘已定的 state 里走出有序的一圈；结构不对（有格不是两条头、分了几个圈）返回 null
export function cycleOf(state, g) {
  const deg = new Int8Array(g.cells);
  const on = [];
  for (let s = 0; s < g.segs; s++) {
    if (state[s] !== YES) continue;
    const a = g.segA[s], b = g.segB[s];
    if (deg[a]++ === 0) on.push(a);
    if (deg[b]++ === 0) on.push(b);
  }
  if (on.length < 4) return null;
  for (const c of on) if (deg[c] !== 2) return null;
  const order = [];
  const used = new Set();
  let cur = on[0];
  for (;;) {
    order.push(cur);
    let nx = -1, pick = -1;
    for (let d = 0; d < 4; d++) {
      const k = g.ports[cur * 4 + d];
      if (k < 0 || state[k] !== YES || used.has(k)) continue;
      nx = g.nb[cur * 4 + d]; pick = k; break;
    }
    if (pick < 0) break;
    used.add(pick);
    cur = nx;
    if (cur === on[0]) break;
  }
  if (cur !== on[0]) return null;
  if (used.size !== order.length || order.length !== on.length) return null;
  return order;
}

const yesSegs = (state) => {
  const out = [];
  for (let k = 0; k < state.length; k++) if (state[k] === YES) out.push(k);
  return out;
};

// 纯逻辑一遍推到底；推不完返回 null。推得完 = 唯一性被这条推理链证明（传播每步都对任何解成立）
export function logicSolve(spec, given = null) {
  const g = geom(spec.n, spec.m);
  const pi = pearlIndex(g, spec.pearls);
  const state = given ? Int8Array.from(given) : g.fresh();
  if (!spread(state, g, pi)) return null;
  for (let k = 0; k < state.length; k++) if (state[k] === UNKNOWN) return null;
  const cells = cycleOf(state, g);
  if (!cells) return null;
  const solution = cells.map((c) => halfOfCell(g.n, c));
  return validate(spec, solution) ? { segs: yesSegs(state), cells, solution, state } : null;
}

// 回溯的分叉点：挑一个"还剩多种走法"的格，按它的全部构型分叉 —— 构型是完备划分（每格要么
// 0 条要么 2 条出头），所以一条解都不会漏；每个分支当场把这格四条边全钉死，传播立刻跟上。
// 分支越少越好（叶子浅），珍珠格优先（它本来就只剩两三种）。
function pickCell(state, g, pi) {
  let best = -1, bestN = Infinity, bestScore = -1;
  for (let c = 0; c < g.cells; c++) {
    let unk = 0;
    for (let d = 0; d < 4; d++) { const k = g.ports[c * 4 + d]; if (k >= 0 && state[k] === UNKNOWN) unk++; }
    if (!unk) continue;
    const n = configsOf(g, c, pi.role, state).length;
    if (n < 2) continue;
    let yes = 0;
    for (let d = 0; d < 4; d++) { const k = g.ports[c * 4 + d]; if (k >= 0 && state[k] === YES) yes++; }
    const score = pi.role[c] !== 0 ? 3 : yes ? 2 : unk === 2 ? 1 : 0;
    if (n < bestN || (n === bestN && score > bestScore)) { bestN = n; bestScore = score; best = c; }
  }
  if (best >= 0) return { cell: best, seg: -1 };
  for (let k = 0; k < g.segs; k++) if (state[k] === UNKNOWN) return { cell: -1, seg: k };   // 兜底：猜一条段
  return null;
}

// 把一格的构型写进盘（只写 UNKNOWN，撞车就返回 false）
function applyConfig(state, g, c, cfg) {
  const pair = cfg.pair;
  for (let d = 0; d < 4; d++) {
    const k = g.ports[c * 4 + d];
    if (k < 0) { if (pair && (d === pair[0] || d === pair[1])) return false; continue; }
    const val = pair && (d === pair[0] || d === pair[1]) ? YES : NO;
    if (state[k] === UNKNOWN) state[k] = val;
    else if (state[k] !== val) return false;
  }
  return true;
}

// 共享的回溯骨架：leaf(state) 在全盘定案时被调用一次（返回 true 记一个解）。
// nodes 超预算就停 —— 这不是"数完了"，caller 必须如实报 capped。
function search(spec, g, pi, seedState, budget, cap, leaf) {
  const ctx = { found: 0, nodes: 0, over: false };
  const walk = (state) => {
    if (ctx.found >= cap || ctx.over) return;
    if (++ctx.nodes > budget) { ctx.over = true; return; }
    if (!spread(state, g, pi)) return;
    const pick = pickCell(state, g, pi);
    if (!pick) {
      // 传播推满了全盘：它每一步都对任何解成立，剩下的候选只有这一个，无需再猜
      const cells = cycleOf(state, g);
      if (cells && validate(spec, cells.map((c) => halfOfCell(g.n, c))) && leaf(state, cells)) ctx.found++;
      return;
    }
    if (pick.cell >= 0) {
      for (const cfg of configsOf(g, pick.cell, pi.role, state)) {
        if (ctx.found >= cap || ctx.over) return;
        const next = Int8Array.from(state);
        if (applyConfig(next, g, pick.cell, cfg)) walk(next);
      }
      return;
    }
    for (const val of [YES, NO]) {
      if (ctx.found >= cap || ctx.over) return;
      const next = Int8Array.from(state);
      next[pick.seg] = val;
      walk(next);
    }
  };
  walk(seedState ? Int8Array.from(seedState) : g.fresh());
  return ctx;
}

// 带计数的求解器：数到 cap 就停；没数完（预算耗尽）也如实 capped
export function countSolutions(spec, cap = 2, seedState = null, budget = 2600) {
  const g = geom(spec.n, spec.m);
  const pi = pearlIndex(g, spec.pearls);
  const ctx = search(spec, g, pi, seedState, budget, cap, () => true);
  return { count: ctx.found, capped: ctx.found >= cap || ctx.over, over: ctx.over, nodes: ctx.nodes };
}

// 找一条与给定墨迹相容的解（提示用；不看唯一性）
export function solveOne(spec, seedState = null, budget = 6000) {
  const g = geom(spec.n, spec.m);
  const pi = pearlIndex(g, spec.pearls);
  let hit = null;
  search(spec, g, pi, seedState, budget, 1, (state) => { hit = yesSegs(state); return true; });
  return hit;
}

// ---- 独立校验：有序格心列表是不是一条合法环 ------------------------------------------
// 这里故意不复用上面任何工具：只按题面规则、只认"相邻 = 沿一个轴差一个格"。
export function validate(spec, cellHalves) {
  const n = spec.n, m = spec.m;
  const L = cellHalves ? cellHalves.length : 0;
  if (L < 4) return false;
  const cells = [];
  const seen = new Set();
  for (const at of cellHalves) {
    const hx = at[0], hy = at[1];
    if (!isCell(hx, hy)) return false;                        // 只有格心能落子
    const [i, j] = cellOf(hx, hy);
    if (i < 0 || j < 0 || i >= n || j >= m) return false;
    const c = j * n + i;
    if (seen.has(c)) return false;                            // 不许重访
    seen.add(c);
    cells.push([i, j]);
  }
  for (let t = 0; t < L; t++) {
    const a = cells[t], b = cells[(t + 1) % L];
    if (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) !== 1) return false;   // 相邻且只沿一个轴
  }
  const where = new Map();
  cells.forEach(([i, j], t) => where.set(i + ',' + j, t));
  for (const [pi, pj] of spec.pearls) if (!where.has(pi + ',' + pj)) return false;   // 有珠没被穿到
  const bend = (t) => {                                        // 这一格拐不拐弯
    const k = (t + L) % L;
    const a = cells[(k - 1 + L) % L], b = cells[k], c = cells[(k + 1) % L];
    return (b[0] - a[0]) !== (c[0] - b[0]) || (b[1] - a[1]) !== (c[1] - b[1]);
  };
  for (const [pi, pj, kind] of spec.pearls) {
    const t = where.get(pi + ',' + pj);
    const turn = bend(t);
    if (kind === 'white') {
      if (turn) return false;                                  // 白珠必须直穿
      if (!bend((t - 1 + L) % L) && !bend((t + 1) % L)) return false;   // 前后至少一头要拐
    } else if (kind === 'black') {
      if (!turn) return false;                                 // 黑珠必须拐
      for (const s of [-2, -1, 1, 2]) if (bend((t + s + L * 2) % L)) return false;   // 前后各两格直穿
    } else return false;                                       // 题面里有不认识的珠子
  }
  return true;
}

// ---- 出题 -----------------------------------------------------------------------
// 环上每格在格图里的邻格恰好两个 = 一条不分叉、不自交、无弦的单环（无弦这点让玩家的
// 拖拽只有一种接法：新格只可能跟已经在线上的两个邻格接头）
function isCycle(path, n, m) {
  const L = path.length;
  if (L < 4 || L > n * m - 1) return false;
  const set = new Set(path);
  if (set.size !== L) return false;
  const nbrsOf = (c) => {
    const i = c % n, j = Math.floor(c / n);
    const out = [];
    if (i > 0) out.push(c - 1);
    if (i < n - 1) out.push(c + 1);
    if (j > 0) out.push(c - n);
    if (j < m - 1) out.push(c + n);
    return out;
  };
  for (const c of path) {
    if (c < 0 || c >= n * m) return false;
    let k = 0;
    for (const nb of nbrsOf(c)) if (set.has(nb)) k++;
    if (k !== 2) return false;
  }
  const seen = new Set([path[0]]);
  const stack = [path[0]];
  while (stack.length) {
    const c = stack.pop();
    for (const nb of nbrsOf(c)) if (set.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  return seen.size === L;
}

// 矩形回字环（w,h ≥ 3：中间有洞才没有弦）；2×2 的四格环也合法
function ringPath(n, x, y, w, h) {
  const p = [];
  for (let i = 0; i < w; i++) p.push(y * n + x + i);
  for (let j = 1; j < h; j++) p.push((y + j) * n + x + w - 1);
  for (let i = w - 2; i >= 0; i--) p.push((y + h - 1) * n + x + i);
  for (let j = h - 2; j >= 1; j--) p.push(j * n + x);
  return p;
}

function rot(path, k) { const L = path.length; return path.slice(k).concat(path.slice(0, k)); }

// 把一格直的线段往 t 侧鼓出一节：a,c,b（c 直穿）→ a, a+t, c+t, b+t, b
function expand(path, n, m, k, ti, tj) {
  const r = rot(path, ((k - 1) % path.length + path.length) % path.length);
  const a = r[0], c = r[1], b = r[2];
  const ai = a % n, aj = Math.floor(a / n);
  const ci = c % n, cj = Math.floor(c / n);
  const bi = b % n, bj = Math.floor(b / n);
  if (ci - ai !== bi - ci || cj - aj !== bj - cj) return null;         // c 不是直穿
  const set = new Set(path);
  const add = (i, j) => {
    if (i < 0 || j < 0 || i >= n || j >= m) return -1;
    const t = j * n + i;
    return set.has(t) ? -1 : t;
  };
  const na = add(ai + ti, aj + tj), nc = add(ci + ti, cj + tj), nb = add(bi + ti, bj + tj);
  if (na < 0 || nc < 0 || nb < 0) return null;
  return [a, na, nc, nb, b].concat(r.slice(3));
}

// 鼓包的逆操作：把直着三格的一节收回去
function contract(path, n, m, k, ti, tj) {
  const r = rot(path, ((k - 1) % path.length + path.length) % path.length);
  const u = r[0], a = r[1], b = r[2], c = r[3], v = r[4];
  const set = new Set(path);
  const at = (cell) => [cell % n, Math.floor(cell / n)];
  const eq = (p, qi, qj) => p[0] === qi && p[1] === qj;
  const ua = at(u), aa = at(a), ba = at(b), ca = at(c), va = at(v);
  if (!eq(ua, aa[0] - ti, aa[1] - tj)) return null;
  if (!eq(va, ca[0] - ti, ca[1] - tj)) return null;
  if (ba[0] - aa[0] !== ca[0] - ba[0] || ba[1] - aa[1] !== ca[1] - ba[1]) return null;
  const mi = ba[0] - ti, mj = ba[1] - tj;
  if (mi < 0 || mj < 0 || mi >= n || mj >= m) return null;
  const mid = mj * n + mi;
  if (set.has(mid) || mid === u || mid === v) return null;
  return [u, mid, v].concat(r.slice(5));
}

// 随机滚一条环：矩形回字环起步，一路随机鼓包/收包，长度往 target 靠。每步都用 isCycle 复验
// （环上每格的邻格恰好两个 = 不分叉、不自交、无弦，玩家顺着 solution 拖只有一种接法）。
// 鼓包一次造出"拐-直-拐"三格：中间那格能放白珠，两侧那两格因为紧挨着别的拐，黑珠放不下去 ——
// 所以形状要靠"鼓到一半再收回来"来回抖，才有足够的可放珠位置；这也是下面按候选数挑形状的原因。
export function randomLoop(rng, n, m, maxLen, minLen = 12) {
  const target = rng.range(Math.max(minLen, Math.round(maxLen * 0.66)), maxLen);
  // 起步只看"放得下、不超上限"：以前还要求起步那条回字环本身就 ≥ minLen，于是 8×8 上想滚
  // 40 格的环压根找不到合法起步（回字环最长 28），整条随机走直接返回 null。偏偏高填充率的环
  // 才是唯一性最好求的那一批 —— 长环把盘面挤满，珠子的规则才没有余地让第二条环偷偷换轨。
  const perim = (w, h) => 2 * (w + h) - 4;
  let startW = 0;
  let startH = 0;
  for (let k = 0; k < 24 && !startW; k++) {
    const wCap = Math.min(n, Math.floor((maxLen + 4) / 2) - 3);
    if (wCap < 3) continue;
    const w = rng.range(3, wCap);
    const hCap = Math.min(m, Math.floor((maxLen + 4) / 2) - w);
    if (hCap < 3) continue;
    const h = rng.range(3, hCap);
    if (perim(w, h) > maxLen) continue;
    startW = w;
    startH = h;
  }
  if (!startW) return null;
  const x = rng.int(n - startW + 1);
  const y = rng.int(m - startH + 1);
  let path = ringPath(n, x, y, startW, startH);
  if (!isCycle(path, n, m)) return null;
  const steps = rng.range(target, target * 2);
  for (let s = 0; s < steps; s++) {
    const L = path.length;
    const grow = L < target || L <= minLen;
    const k = rng.int(L);
    const tries = [];
    for (const [ti, tj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) tries.push([ti, tj]);
    rng.shuffle(tries);
    let hit = null;
    for (const [ti, tj] of tries) {
      const cand = grow
        ? expand(path, n, m, k, ti, tj)
        : (L > minLen ? contract(path, n, m, k, ti, tj) : null);
      if (cand && cand.length <= maxLen && isCycle(cand, n, m)) { hit = cand; break; }
    }
    if (hit) path = hit;
  }
  if (path.length < Math.max(minLen, target * 0.8) || path.length > maxLen) return null;
  return path;
}

// 环上的拐/直：白珠放在"直穿且前后至少一头拐"，黑珠放在"拐弯且前后各两格直穿"
export function pearlCandidates(path, n, m) {
  const L = path.length;
  const dir = (t) => {
    const p = path[((t % L) + L) % L], q = path[((t + 1) % L + L) % L];
    return [Math.sign(q % n - p % n), Math.sign(Math.floor(q / n) - Math.floor(p / n))];
  };
  const straight = [];
  for (let t = 0; t < L; t++) {
    const din = dir(t - 1), dout = dir(t);
    straight.push(din[0] === dout[0] && din[1] === dout[1]);
  }
  const out = [];
  for (let t = 0; t < L; t++) {
    const i = path[t] % n, j = Math.floor(path[t] / n);
    if (straight[t]) {
      if (!straight[(t - 1 + L) % L] || !straight[(t + 1) % L]) out.push([i, j, 'white']);
    } else if (straight[(t - 1 + L) % L] && straight[(t - 2 + L) % L]
      && straight[(t + 1) % L] && straight[(t + 2) % L]) {
      out.push([i, j, 'black']);
    }
  }
  return out;
}
export { isCycle };
const eligiblePearls = pearlCandidates;

// rng 给了就随种子换起手：同一条环从哪颗珠开始数都合法，但"环上第一颗珠"对回字环永远是那个角，
// 十二道题挤在三个起手格上 —— 每日一题连着一周从同一个角下笔，是玩家看得出来的单调。
function makeSpec(n, m, path, pearls, rng = null) {
  const solution = path.map((c) => halfOfCell(n, c));
  const pearlCells = new Set(pearls.map(([i, j]) => i + j * n));
  const anchors = [];
  for (let k = 0; k < path.length; k++) if (pearlCells.has(path[k])) anchors.push(k);
  const s = anchors.length > 1 && rng ? anchors[rng.int(anchors.length)] : (anchors[0] ?? 0);
  const stroke = path.slice(s).concat(path.slice(0, s)).map((c) => halfOfCell(n, c));
  return { n, m, pearls, solution, stroke, par: solution.length };
}

// 贪心删珠：删掉之后题面仍然成立才删。"仍然成立"有两种证法，贵的那条留到不得已在用：
//   · 满珠盘一遍传播就推到底 —— 这条推理链本身就是唯一性证明，于是删珠的每一步复核也只跑一遍传播；
//   · 推不完才去数解（数到 2 早停；没数完一律算不唯一）。
// 顺序很要紧：先数解会把 8×8 上"推得完但数不完"的好盘全挡在门外 —— 实测满珠盘能一遍推完的环
// 6×6 占 34%、7×7 占 24%、8×8 占 8%，而这些盘在 7×7 以上跑 countSolutions 几乎必然撑爆预算。
function minePearls(rng, n, m, path, budget) {
  const all = eligiblePearls(path, n, m);
  if (all.length < 2) return null;
  const keep = all.map(() => true);
  const setOf = () => all.filter((_, t) => keep[t]);
  const specOf = (pearls, r = null) => makeSpec(n, m, path, pearls, r);
  const probe = (pearls) => {
    const spec = specOf(pearls);
    const { count, capped } = countSolutions(spec, 2);
    return { spec, unique: count === 1 && !capped, count, capped };
  };
  const full = specOf(all);
  const derivable = !!logicSolve(full);
  if (!derivable && !probe(all).unique) return null;             // 满珠盘都有第二种走法，这根环出题不了
  let calls = derivable ? 0 : 1;
  if (derivable) {
    for (const idx of rng.shuffle(all.map((_, i) => i))) {
      if (calls > budget) break;
      keep[idx] = false;
      if (!logicSolve(specOf(setOf()))) keep[idx] = true;
      else calls++;
    }
    // 删到推不动为止 = 每题都交"同一副最小题面"，四十道只交出十三种题面。
    // 往回随手贴几颗：贴回的是这根环自己的合法珠位，而"能推完"对加珠是单调的
    // （原来的推法一步都没被削弱），所以照旧是证明过的题 —— 只是每道的珠子疏密不同了。
    const core = keep.slice();
    const gone = all.map((_, i) => i).filter((i) => !keep[i]);
    for (const idx of rng.shuffle(gone).slice(0, rng.range(0, Math.min(3, gone.length)))) keep[idx] = true;
    let pearls = setOf();
    if (pearls.length < 2) return null;
    let spec = specOf(pearls);
    if (!logicSolve(spec)) {                 // 理论上不会发生（单调），发生就退回那道已复核过的最小题面
      for (let t = 0; t < keep.length; t++) keep[t] = core[t];
      pearls = setOf();
      if (pearls.length < 2) return null;
      spec = specOf(pearls);
    }
    return { spec: specOf(setOf(), rng), logic: true, count: 1, capped: false };
  }
  for (const idx of rng.shuffle(all.map((_, i) => i))) {
    if (calls > budget) break;
    const trial = keep.slice();
    trial[idx] = false;
    const pearls = all.filter((_, t) => trial[t]);
    if (pearls.length < 2) continue;
    calls++;
    if (probe(pearls).unique) for (let t = 0; t < keep.length; t++) keep[t] = trial[t];
  }
  const pearls = setOf();
  if (pearls.length < 2) return null;
  const res = probe(pearls);
  if (!res.unique) return null;
  return { spec: specOf(pearls, rng), logic: false, count: res.count, capped: res.capped };
}

// maxLen 之外还得压一个 minLen：随机走一步只挪 ±2 格，从小环爬不上去，
// 不压下界就会十道九道掉回 handBuilt 那道回字。
// 档位止步 8×8：10×10 上这条随机走只产得出"大方框"，实测满珠盘 9/10 是真有第二个解
// （中位 65 个节点就数出来了），换预算救不了 —— 与其发一道多解题，不如把盘子收小。
const TIERS = [
  { key: 6, n: 6, m: 6, label: '6×6', tier: '入门', minLen: 12, maxLen: 20, tries: 20, budget: 90 },
  { key: 7, n: 7, m: 7, label: '7×7', tier: '熟手', minLen: 15, maxLen: 22, tries: 20, budget: 80 },
  { key: 8, n: 8, m: 8, label: '8×8', tier: '挑战', minLen: 18, maxLen: 26, tries: 34, budget: 70 },
];

export const tiers = TIERS.map(({ key, label, tier }) => ({ key, label, tier }));
export const tierOf = (sizeKey) => TIERS.find((t) => t.key === sizeKey) || TIERS[0];

// 兜底：矩形回字环 + 贪心挖珠。两条纪律：
//   · 环长必须落在本档区间里 —— 兜底一旦跨档，"分档"就只是 TIERS 表上写着好看；
//   · 候选按 seed 洗牌后再逐条挖珠 —— 按固定顺序交第一道，随机走失败的那几颗种子
//     （实测 u8 有 22/40）会全撞在同一条环的同一副珠上，题面、黑珠数、起手格一起塌。
// 挖珠顺带把同一根环裂成多道不同的题；每条都过 countSolutions 才进候选池。绝不返回 null。
function handBuilt(t, rng) {
  const { n, m } = t;
  const ringsIn = (band) => {
    const out = [];
    for (let w = 4; w <= n; w++) {
      for (let h = 4; h <= m; h++) {
        const perim = 2 * (w + h) - 4;
        if (band && (perim < t.minLen || perim > t.maxLen)) continue;
        for (let x = 0; x + w <= n; x++) for (let y = 0; y + h <= m; y++) out.push([x, y, w, h]);
      }
    }
    return rng.shuffle(out);
  };
  // 一条环过不了"满珠唯一"只花一次 countSolutions，所以本档可以扫得宽。
  // 两种收成分开要：纯逻辑推得完的那道直接交出去（这才配叫"挑战"），推不完的只当备胎，
  // 整条本档都没有备胎才跨档 —— 跨档的短回字环虽然推得完，但档位表就白写了。
  const harvest = (band, tries) => {
    let spare = null;
    for (const [x, y, w, h] of ringsIn(band)) {
      if (tries-- <= 0) break;
      const path = ringPath(n, x, y, w, h);
      if (!isCycle(path, n, m)) continue;
      const mined = minePearls(rng, n, m, path, t.budget);
      if (!mined) continue;
      if (mined.logic) return mined.spec;
      if (!spare) spare = mined.spec;
    }
    return spare;
  };
  const inBand = harvest(true, 40);
  if (inBand) return inBand;
  const loose = harvest(false, 20);
  if (loose) return loose;
  // 盘小得连 4×4 环都放不下：给一颗最小的合法题（只求交得出题，唯一性另说）
  const path = ringPath(n, 0, 0, Math.min(n, 3), Math.min(m, 3));
  const spec = makeSpec(n, m, path, eligiblePearls(path, n, m));
  const { count, capped } = countSolutions(spec, 2);
  spec.count = count;
  spec.capped = capped;
  return spec;
}

// 主路的赌局：滚 rounds 轮随机环，每轮贪心挖珠，交得出题的那副按"推得完 > 环长 > 珠少"排序。
// 单独拆出来，是为了让兜底层能接着同一串随机数再赌一轮 —— 随机走出来的鼓包环才是"人做的题"
// 那个样子（黑珠颗数、起手格都在动），矩形回字环只是不让它交白卷的最后手段。
// 每一轮都赌到底，赌到能推完的题面全收进篮子，最后才随种子挑一道：一发现推得完就立刻收工，
// 等于把"二十次随机走里挑一次"压成"第一次成功的那一次"，实测题面重复率立刻翻两三倍。
// 篮子空了才认推不完的备胎（照样过数解担保）。
function mineLoops(rng, t, rounds) {
  const good = [];
  let spare = null;
  for (let attempt = 0; attempt < rounds; attempt++) {
    const path = randomLoop(rng, t.n, t.m, t.maxLen, t.minLen);
    if (!path) continue;
    const mined = minePearls(rng, t.n, t.m, path, t.budget);
    if (!mined) continue;
    if (mined.logic) { good.push(mined); continue; }
    if (!spare) spare = mined;
  }
  if (!good.length) return spare;
  // 篮子里挑环最长的那批（同分随种子决定）：档位分的是长度，挑短的就等于把档白分了
  // 抽签只看环最长的那一半：全挑最长等于每档只交一种环长，全随机又分不开档位
  good.sort((a, b) => b.spec.par - a.spec.par);
  return good[Math.min(good.length - 1, rng.int(Math.ceil(good.length / 2)))];
}

export function generate(seed, sizeKey) {
  const t = tierOf(sizeKey);
  const rng = rngFrom(seed);
  const best = mineLoops(rng, t, t.tries);
  const done = best ? best.spec : handBuilt(t, rng);
  // 数解只补没有证明的那批：推得完的盘由那条推理链担保，靠数解过关的盘刚数过一遍
  if (done.count !== 1 || done.capped) {
    const chk = countSolutions(done, 2);
    done.count = chk.count;
    done.capped = chk.capped;
  }
  return done;
}

// ---- 引擎：棋盘状态机 -------------------------------------------------------------
export function create(spec) {
  const n = spec.n, m = spec.m;
  const g = geom(n, m);
  const pi = pearlIndex(g, spec.pearls);
  const par = spec.par || 0;
  const cell = new Int8Array(g.cells).fill(UNKNOWN);   // YES = 线穿过这格；NO = 副笔"必不在环上"
  const seg = new Int8Array(g.segs).fill(UNKNOWN);     // 玩家画出的格心之间接头
  const history = [];
  const future = [];
  let moves = 0;
  let locked = false;
  let pen = null;                                      // 'draw' | 'erase'
  let prev = -1;

  const snap = () => ({ c: Array.from(cell), s: Array.from(seg) });   // 只快照棋盘：moves 绝不进来
  const back = (h) => { cell.set(h.c); seg.set(h.s); badStale = true; };
  const remember = () => { history.push(snap()); if (history.length > 800) history.shift(); future.length = 0; };

  const deg = (c) => {
    let k = 0;
    for (let d = 0; d < 4; d++) { const s = g.ports[c * 4 + d]; if (s >= 0 && seg[s] === YES) k++; }
    return k;
  };
  const onCount = () => { let k = 0; for (let c = 0; c < g.cells; c++) if (cell[c] === YES) k++; return k; };
  const join = (c) => {
    if (cell[c] === YES) return false;
    cell[c] = YES;
    moves += 1;                                        // 一格一次落子；擦除、改画、撤销都不退款
    badStale = true;
    return true;
  };
  const link = (a, b) => {
    const s = segBetween(g, a, b);
    if (s < 0 || seg[s] === YES) return false;
    if (deg(a) >= 2 || deg(b) >= 2) return false;      // 两头都接满了就接不上：得先擦
    seg[s] = YES;
    badStale = true;
    return true;
  };
  const attach = (c) => {
    let ch = false;
    for (let d = 0; d < 4; d++) {
      const nb = g.nb[c * 4 + d];
      if (nb >= 0 && cell[nb] === YES && link(c, nb)) ch = true;
    }
    return ch;
  };
  const clear = (c) => {
    let ch = false;
    for (let d = 0; d < 4; d++) { const s = g.ports[c * 4 + d]; if (s >= 0 && seg[s] === YES) { seg[s] = UNKNOWN; ch = true; } }
    if (cell[c] !== UNKNOWN) { cell[c] = UNKNOWN; ch = true; }
    badStale = true;
    return ch;
  };

  // 把棋盘上的墨迹与记号翻成求解器的初始盘：画出的段 = YES，标了"不在环上"的格四面全封
  const seedState = () => {
    const st = g.fresh();
    for (let s = 0; s < g.segs; s++) if (seg[s] === YES) st[s] = YES;
    for (let c = 0; c < g.cells; c++) {
      if (cell[c] !== NO) continue;
      for (let d = 0; d < 4; d++) { const s = g.ports[c * 4 + d]; if (s >= 0) st[s] = NO; }
    }
    return st;
  };

  // 从棋盘推出有序的一圈（结构不合法返回 null）：solved 与判错都走这条路
  const drawnCycle = () => {
    let cnt = 0;
    for (let c = 0; c < g.cells; c++) {
      if (cell[c] !== YES) continue;
      cnt++;
      if (deg(c) !== 2) return null;                    // 还留着悬着的笔头 = 没连成圈
    }
    if (cnt < 4) return null;
    const st = g.fresh();
    for (let s = 0; s < g.segs; s++) if (seg[s] === YES) st[s] = YES;
    const cells = cycleOf(st, g);
    if (!cells || cells.length !== cnt) return null;    // 分了几个圈 / 有格没被穿到
    return cells.map((c) => halfOfCell(n, c));
  };

  // 判胜即锁盘：棋盘走到的这一圈由独立校验器 validate 说了算
  const winNow = () => {
    const path = drawnCycle();
    const ok = !!path && validate(spec, path);
    if (ok) locked = true;
    return ok;
  };

  let badStale = true;
  let badCache = [];
  const badCells = () => {
    if (!badStale) return badCache;
    const bad = new Set();
    const push = (c) => bad.add(c);
    // 一个格接了三条以上出头 —— 环在这里分了叉
    for (let c = 0; c < g.cells; c++) if (cell[c] === YES && deg(c) > 2) push(c);
    // 珍珠被标成"不在环上"
    for (const [c] of pi.list) if (cell[c] === NO) push(c);
    // 局部结构已经能判死珍珠：白珠画成了拐弯、黑珠画成了直穿、黑珠两侧没直着伸出两格
    const nbs = (c) => {
      const out = [];
      for (let d = 0; d < 4; d++) { const s = g.ports[c * 4 + d]; if (s >= 0 && seg[s] === YES) out.push([g.nb[c * 4 + d], d]); }
      return out;
    };
    // q 在方向 d 上是否直着走出去（头接满了才判得了，没接满先不下结论）
    const goesStraight = (q, d) => {
      if (deg(q) < 2) return null;
      const s = g.ports[q * 4 + d];
      return s >= 0 && seg[s] === YES;
    };
    for (const [c, kind] of pi.list) {
      if (cell[c] !== YES) continue;
      const list = nbs(c);
      if (list.length !== 2) continue;                   // 还没画满，判不了
      const [a, da] = list[0], [b, db] = list[1];
      const straight = (da ^ 1) === db;
      if (kind === WHITE) {
        if (!straight) { push(c); push(a); push(b); continue; }
        const sa = goesStraight(a, da), sb = goesStraight(b, db);
        if (sa && sb) push(c);                           // 两头都直穿 = 这颗白珠白放了
      } else {
        if (straight) push(c);
        for (const [q, dq] of list) {
          const st = goesStraight(q, dq);
          if (st === false) { push(q); continue; }       // 紧邻的那格就拐了：直段不够两格
          if (st && q >= 0) {
            const r = g.nb[q * 4 + dq];
            if (r >= 0 && goesStraight(r, dq) === false) push(r);
          }
        }
      }
    }
    // 提前闭成一圈，圈外还有线或有珍珠没被穿进去
    const cells = new Set();
    for (let c = 0; c < g.cells; c++) if (cell[c] === YES && deg(c) > 0) cells.add(c);
    const seen = new Set();
    for (const start of cells) {
      if (seen.has(start)) continue;
      const block = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const c = stack.pop();
        block.push(c);
        for (const [nb] of nbs(c)) if (cells.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
      if (!block.every((c) => deg(c) === 2)) continue;
      if (block.length !== cells.size) for (const c of block) push(c);
      for (const [pc] of pi.list) if (!block.includes(pc)) for (const c of block) push(c);
    }
    badCache = [...bad].map((c) => halfOfCell(n, c));
    badStale = false;
    return badCache;
  };

  return {
    spec,
    step: 2,                                            // 键盘光标一次挪一个格：目标是格心
    board: { cols: n, rows: m, margin: { l: 0, t: 0, r: 0, b: 0 } },

    down(hx, hy, btn) {
      if (locked || !isCell(hx, hy)) return false;      // 偶偶的点、奇偶的边一律原样退回
      const [i, j] = cellOf(hx, hy);
      if (i < 0 || j < 0 || i >= n || j >= m) return false;
      const c = j * n + i;
      if (btn === 1) {                                  // 副笔：记"这格一定不在环上"，不计步
        if (cell[c] === YES) return false;
        remember();
        cell[c] = cell[c] === NO ? UNKNOWN : NO;
        badStale = true;
        return true;
      }
      if (cell[c] === YES) {                            // 压在已有的线上 = 从这里擦
        pen = 'erase';
        prev = c;
        remember();
        return clear(c);
      }
      pen = 'draw';
      prev = c;
      remember();
      let ch = false;
      if (cell[c] === NO) { cell[c] = UNKNOWN; ch = true; }
      if (join(c)) ch = true;
      // 落子之后照样接线：按下与拖动必须是同一种落子语义。写成 join(c) || attach(c)
      // 会被 join 短路，于是"点两下"永远连不上已画的邻居 —— 单测直接按 move 序列画环，
      // 只有真点才露馅。
      if (attach(c)) ch = true;
      return ch;
    },

    move(hx, hy) {
      if (locked || !isCell(hx, hy)) return false;
      const [i, j] = cellOf(hx, hy);
      if (i < 0 || j < 0 || i >= n || j >= m) return false;
      const c = j * n + i;
      if (pen === 'erase') {
        if (cell[c] !== YES) return false;
        remember();
        return clear(c);
      }
      if (c === prev) return false;
      const adj = prev >= 0 ? segBetween(g, prev, c) : -1;
      if (cell[c] === YES) {                            // 拖回线上：把两头接起来（收口/重连）
        if (adj < 0) return false;
        remember();
        const ch = link(prev, c);
        prev = c;
        return ch;
      }
      remember();
      let ch = join(c);
      if (adj >= 0) ch = link(prev, c) || ch;
      ch = attach(c) || ch;
      prev = c;
      return ch;
    },

    up() { pen = null; prev = -1; return false; },

    undo() { if (!history.length) return false; future.push(snap()); back(history.pop()); locked = false; return true; },
    redo() { if (!future.length) return false; history.push(snap()); back(future.pop()); return true; },
    canUndo() { return history.length > 0; },
    canRedo() { return future.length > 0; },

    hint() {
      const sol = solveOne(spec, seedState());
      if (!sol) return null;
      const on = new Set(sol);
      // 先给"该画却没画、而且能把线往前推一格"的接头：这一步必须真的动棋盘
      for (const freshOnly of [true, false]) {
        for (let s = 0; s < g.segs; s++) {
          if (!on.has(s) || seg[s] === YES) continue;
          const a = g.segA[s], b = g.segB[s];
          if (deg(a) >= 2 || deg(b) >= 2) continue;
          const fresh = cell[a] !== YES || cell[b] !== YES;
          if (freshOnly && !fresh) continue;
          remember();
          const ja = join(a); const jb = join(b);
          seg[s] = YES;
          badStale = true;
          const won = winNow();
          const c = ja ? a : b;
          return {
            cells: [halfOfCell(n, c)],
            note: fresh
              ? '这个接头非走不可 —— 线在这里只有一种穿法'
              : '把线头接上' + (won ? '：一整圈闭合了' : '：唯一的走法只剩这一条'),
          };
        }
      }
      // 线画满了还差结论：给一个"必不在环上"的格（副笔级的提示，不计步）
      for (let c = 0; c < g.cells; c++) {
        if (cell[c] !== UNKNOWN) continue;
        let inLoop = false;
        for (let d = 0; d < 4 && !inLoop; d++) {
          const s = g.ports[c * 4 + d];
          if (s >= 0 && on.has(s)) inLoop = true;
        }
        if (inLoop) continue;
        remember();
        cell[c] = NO;
        badStale = true;
        return { cells: [halfOfCell(n, c)], note: '这个格不在环上' };
      }
      return null;
    },

    solved() { return winNow(); },
    stats() { return { moves, par, done: onCount(), total: par }; },

    badCells,

    draw(ctx, v, now) {
      const cell0 = v.cell;
      paper(ctx, 0, 0, v.w, v.h);
      rules(ctx, v);
      const bad = new Set(badCells().map(([x, y]) => x + ',' + y));
      // 墨迹：格心到格心，圆头接头让拐弯处连成一条不断的线
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let s = 0; s < g.segs; s++) {
        if (seg[s] !== YES) continue;
        const pa = halfPoint(v, ...halfOfCell(n, g.segA[s]));
        const pb = halfPoint(v, ...halfOfCell(n, g.segB[s]));
        const wrong = badHas(bad, n, g.segA[s]) || badHas(bad, n, g.segB[s]);
        ctx.strokeStyle = wrong ? T.warn : T.accent;
        ctx.lineWidth = Math.max(2.4, cell0 * (wrong ? 0.12 : 0.15));
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      ctx.restore();
      // 只接了一头的悬笔：在格心点一下，提示这里还没连上
      for (let c = 0; c < g.cells; c++) {
        if (cell[c] !== YES) continue;
        const p = halfPoint(v, ...halfOfCell(n, c));
        ctx.fillStyle = badHas(bad, n, c) ? T.warn : T.accent;
        ctx.beginPath();
        ctx.arc(p.x, p.y, cell0 * (deg(c) < 2 ? 0.11 : 0.075), 0, Math.PI * 2);
        ctx.fill();
      }
      for (let c = 0; c < g.cells; c++) {
        if (cell[c] === NO) {
          const [i, j] = cellOfIndex(n, c);
          crossMark(ctx, v, i, j, T.inkFaint, 0.62);
        }
      }
      // 珍珠：白 = 空心环，黑 = 实心圆 —— 不靠颜色也分得清
      for (const [c, kind] of pi.list) {
        const p = halfPoint(v, ...halfOfCell(n, c));
        ctx.save();
        ctx.fillStyle = T.card;
        ctx.beginPath();
        ctx.arc(p.x, p.y, cell0 * 0.32, 0, Math.PI * 2);
        ctx.fill();
        if (kind === BLACK) {
          ctx.fillStyle = T.ink;
          ctx.beginPath();
          ctx.arc(p.x, p.y, cell0 * 0.225, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = T.ink;
          ctx.lineWidth = Math.max(1.6, cell0 * 0.075);
          ctx.beginPath();
          ctx.arc(p.x, p.y, cell0 * 0.19, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
      const hv = v.hover;
      if (hv && isCell(hv.x, hv.y) && !locked) {
        const [i, j] = cellOf(hv.x, hv.y);
        if (i >= 0 && j >= 0 && i < n && j < m) {
          const p = halfPoint(v, hv.x, hv.y);
          const k = 0.26 + 0.05 * pulse(now);
          ctx.save();
          ctx.strokeStyle = rgba(T.accent, 0.3 + 0.22 * pulse(now));
          ctx.lineWidth = Math.max(1.5, cell0 * 0.07);
          ctx.beginPath();
          ctx.arc(p.x, p.y, cell0 * k, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    },

    celebrate(ctx, v, now, t) {
      this.draw(ctx, v, now);
      const k = easeOut(clamp(t * 1.4, 0, 1));
      ctx.save();
      ctx.strokeStyle = rgba(T.gold, 0.45 * (1 - k));
      ctx.lineWidth = Math.max(2, v.cell * 0.15) * (1 + k * 0.7);
      ctx.beginPath();
      ctx.arc(v.ox + v.cols * v.cell / 2, v.oy + v.rows * v.cell / 2, v.cell * (0.5 + k * v.cols * 0.55), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    },
  };
}

// 报错格集合按半格坐标存，取像素坐标比太绕：统一按格号问一次
function badHas(bad, n, c) {
  const [hx, hy] = halfOfCell(n, c);
  return bad.has(hx + ',' + hy);
}

export default {
  id: 'masyu',
  title: '珍珠',
  latin: 'MASYU',
  tagline: '白珠直穿两头拐，黑珠拐弯前后直',
  unit: '格',
  rules: [
    '沿格心画一条不断的闭环：线不分叉、不重走同一个格，全盘只有这么一圈。',
    '每颗珍珠所在的格都必须被线穿过：白珠处线直着穿过，且穿进穿出两格里至少一格拐弯。',
    '黑珠处线必须拐弯，并且拐弯前后各连着两格直穿 —— 直段在珠子两侧都至少伸出两格。',
    '没有珍珠的格不限：线可以直穿、可以拐弯，也可以整个不走。副笔标"这格一定不在环上"，不计步数。',
  ],
  sizes: tiers,
  generate,
  create,
};
