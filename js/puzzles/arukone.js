// 箭头 / Arukone —— 格子里的数字是证词："从我这格往前走 k 步，正好撞上一个转弯；往后也是 k 步"。
// 数字格本身必须"直进直出"，中间那 k-1 格也全是直进，第 k 格才是拐弯。
//
// 状态模型（与珍珠同族，这里独立设计并把取舍写清楚）：
//   · 环 = 一条**有序**的格索引数组 `loop`（玩家落子的顺序），外加一格"打叉"数组 `mark`。
//     分支在这种表示里根本画不出来，所以"不分叉 / 同一格不走两遍"是结构保证，不必另查。
//   · 闭合是**派生**的：只要 loop 里的格互不重复、首尾相邻、长度 ≥4，它就是一条闭环。
//     也就是说"拖回头部那一格"不需要额外手势 —— 首尾一挨上就成环；这也让无头复验能按
//     spec.solution 的顺序一路拖到底。点已在环上的格 = 往回擦到那一格（玩家擦错分支的动作）。
//   · 每格"在不在环上 / 直还是拐"一律从 loop 现场派生，不另存一份，省掉两处状态互相打嘴。
//   · 一格一次落子（moves +1），擦除、改画、撤销都不退款；副笔的叉不计步。
//
// 三样东西缺一不可（与圈环同一立场）：
//   · propagate() —— 人用的那几条：数字格必在环上且直进；能走的直轴只剩一条就定轴；沿轴把
//     1..k-1 格压成"直"、第 k 格压成"拐"并封掉再往前的连法；一格最多两条环边、连不满两条就
//     整格出局；先闭成一圈就把其余未知一律封掉。推得完的题，唯一性是被这条推理链证明的。
//   · countSolutions() —— 传播之上做有界回溯，数到 cap 早停；没数完（含超出节点预算）一律
//     capped，绝不说"唯一"。
//   · validate() —— 独立于上面两者：直接从规则出发，拿一串有序格心判"单一简单闭环 +
//     每个数字双向距离都对"。求解器负责找得到解，校验器负责那确实是解，两边对拍才算数。
//
// 出题：随机长一条简单环（矩形环 + 保简单的"外扩/翻折"移动，两步都改变 2 格所以奇偶不破），
// 算出每格的直/拐模式，只挑"双向距离相等"的直进格当线索（这就是合法线索的定义），
// 再贪心删线索：优先用 logicSolve 复核（删完还能纯逻辑推完 = 推理链亲自证明唯一），
// 推不动的盘退回用 countSolutions 复核。都不达标就换下一块盘，最后还有 fallbackSpec 兜底，
// 所以 generate() 永远交得出题、也永远只交被数出唯一解的题。

import { rngFrom } from '../core/rng.js';
import { T } from '../core/theme.js';
import { paper, rules, label, crossMark, rgba, pulse, easeOut, clamp } from '../core/paper.js';
import { isCell, cellOf, cellAt, cellCenter } from '../core/lattice.js';

export const UNKNOWN = -1;
export const NO = 0;            // 这条连接一定不画（于是这格也就不在环上）
export const YES = 1;           // 这条连接一定画
export const STRAIGHT = 0;      // 环上这格：直进直出
export const TURN = 1;          // 环上这格：拐弯
export const ON = 2;            // 这格必在环上，但直/拐还没定（"桥格"推出来的中间态）
export const MARK_NONE = 0;
export const MARK_OFF = 1;      // 副笔：这格一定不在环上

// 方向：0=+x（右）1=-x（左）2=+y（下）3=-y（上）。对边 d^1，两条垂直边 d^2 / d^3。
const AXIS_BASE = [0, 2];       // 轴 0 = 左右，轴 1 = 上下

// ---- 拓扑：格 ↔ 相邻格之间的那段连接（环走的"边"） -------------------------------
// 环走格心，所以一条边 = 两个相邻格心之间那段。横边 (n-1)×m 条，竖边 n×(m-1) 条。
const hEdgeIdx = (n, m, i, j) => j * (n - 1) + i;
const vEdgeIdx = (n, m, i, j) => (n - 1) * m + j * n + i;
export const nEdges = (n, m) => (n - 1) * m + n * (m - 1);

const topoCache = new Map();
export function topo(n, m) {
  const key = n + 'x' + m;
  const hit = topoCache.get(key);
  if (hit) return hit;
  const N = n * m;
  const E = nEdges(n, m);
  const ein = new Int32Array(N * 4).fill(-1);       // 格 c 朝方向 d 的边（盘外为 -1）
  const ncell = new Int32Array(N * 4).fill(-1);     // 格 c 朝方向 d 的邻格
  const eu = new Int32Array(E);
  const ev = new Int32Array(E);
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    const c = j * n + i;
    if (i < n - 1) {
      const e = hEdgeIdx(n, m, i, j);
      ein[c * 4 + 0] = e; ncell[c * 4 + 0] = c + 1;
      ein[(c + 1) * 4 + 1] = e; ncell[(c + 1) * 4 + 1] = c;
      eu[e] = c; ev[e] = c + 1;
    }
    if (j < m - 1) {
      const e = vEdgeIdx(n, m, i, j);
      ein[c * 4 + 2] = e; ncell[c * 4 + 2] = c + n;
      ein[(c + n) * 4 + 3] = e; ncell[(c + n) * 4 + 3] = c;
      eu[e] = c; ev[e] = c + n;
    }
  }
  const t = { n, m, N, E, ein, ncell, eu, ev };
  topoCache.set(key, t);
  return t;
}

export const cellIndex = (n, m, i, j) => j * n + i;
export const cellI = (t, c) => c % t.n;
export const cellJ = (t, c) => (c - (c % t.n)) / t.n;
export const cellHalf = (t, c) => cellAt(c % t.n, (c - (c % t.n)) / t.n);
export const halvesOf = (t, cells) => cells.map((c) => cellHalf(t, c));
const stepTo = (t, c, d) => t.ncell[c * 4 + d];

export function dirBetween(t, a, b) {
  for (let d = 0; d < 4; d++) if (t.ncell[a * 4 + d] === b) return d;
  return -1;
}
export const edgeBetween = (t, a, b) => {
  const d = dirBetween(t, a, b);
  return d < 0 ? -1 : t.ein[a * 4 + d];
};

export const clueGrid = (n, m, clues) => {
  const g = new Int8Array(n * m).fill(-1);
  for (const [i, j, k] of clues) {
    if (i < 0 || j < 0 || i >= n || j >= m) continue;
    g[j * n + i] = k;
  }
  return g;
};

// 一份状态 = 前 E 项"这条连接画不画" + 后 N 项"这格直还是拐"。回溯整份拷贝，简单可靠。
export const newState = (n, m) => new Int8Array(nEdges(n, m) + n * m).fill(UNKNOWN);
const kindAt = (t, state, c) => state[t.E + c];

// 环上"前 - 这 - 后"三格的几何：行进方向不变即直，改了即拐。相邻关系不成立返回 UNKNOWN。
export function kindOfTriple(t, a, b, c) {
  const din = dirBetween(t, a, b);
  const dout = dirBetween(t, b, c);
  if (din < 0 || dout < 0) return UNKNOWN;
  return din === dout ? STRAIGHT : TURN;
}

// 环上每格的直/拐：进来的方向与出去的方向相同即直，否则拐。
export function loopKinds(t, cells) {
  const L = cells.length;
  if (L < 4) return null;
  const kind = new Int8Array(L);
  for (let p = 0; p < L; p++) {
    const k = kindOfTriple(t, cells[(p + L - 1) % L], cells[p], cells[(p + 1) % L]);
    if (k === UNKNOWN) return null;
    kind[p] = k;
  }
  return kind;
}

// 一格的"双向距离"：沿环往前 / 往后走到第一个拐弯格各要几步。两个数相等才配当线索。
export function clueListForLoop(t, cells) {
  const kind = loopKinds(t, cells);
  if (!kind) return [];
  const L = kind.length;
  const out = [];
  for (let p = 0; p < L; p++) {
    if (kind[p] !== STRAIGHT) continue;
    let f = 0;
    while (f < L && kind[(p + f + 1) % L] !== TURN) f++;
    if (f >= L) continue;
    let b = 0;
    while (b < L && kind[(p - b - 1 + L) % L] !== TURN) b++;
    if (b >= L || f !== b) continue;
    out.push([cellI(t, cells[p]), cellJ(t, cells[p]), f + 1]);
  }
  return out.sort((x, y) => (x[1] - y[1]) || (x[0] - y[0]));
}

// 数字 c=k 沿某条轴（0=左右，1=上下）到底摆不摆得下：两个方向各走 k 步，沿线连接不许已被判死、
// 中间格不许已被判拐、第 k 格不许已被判直且不许带数字、还必须留有一条拐弯的出路。
// 这是人拿铅笔在盘上"顺着数一遍"就会做的事，也是这里最强的一条剪枝。
export function axisAlive(state, t, g, c, k, base) {
  const { ein, E } = t;
  if (state[E + c] === TURN) return false;
  const d0 = AXIS_BASE[base];                       // base 是"轴号"（0=左右，1=上下）
  const d1 = d0 + 1;                                // 同轴的对边方向
  const e0 = ein[c * 4 + d0];
  const e1 = ein[c * 4 + d1];
  if (e0 < 0 || e1 < 0) return false;               // 贴盘的格撑不起这条直轴
  if (state[e0] === NO || state[e1] === NO) return false;
  for (const dir of [d0, d1]) {
    let cur = c;
    for (let s = 1; s <= k; s++) {
      const nx = stepTo(t, cur, dir);
      if (nx < 0) return false;                     // 走到盘外，这么长的箭头放不下
      if (state[ein[cur * 4 + dir]] === NO) return false;
      const kk = state[E + nx];
      if (s < k) {
        if (kk === TURN) return false;              // 中间那几格只能直进
      } else {
        if (kk === STRAIGHT || g[nx] >= 0) return false;   // 第 k 格要拐弯，拐弯格不配有数字
        const p0 = ein[nx * 4 + (dir ^ 2)];
        const p1 = ein[nx * 4 + (dir ^ 3)];
        if (!(p0 >= 0 && state[p0] !== NO) && !(p1 >= 0 && state[p1] !== NO)) return false;
      }
      cur = nx;
    }
  }
  return true;
}

// ---- 规则传播 -------------------------------------------------------------------
// 只用"任何解都必须成立"的蕴含，所以从空盘推到不动点若已无未知，得到的那一条就是唯一解
// （唯一性被推理链证明，不是数出来的）。返回 false = 当前墨迹与题面矛盾。
export function propagate(state, n, m, clues) {
  const t = topo(n, m);
  const { N, E, ein, ncell } = t;
  const g = clueGrid(n, m, clues);
  let dirt = false;
  const setE = (k, v) => {
    if (k < 0) return v === NO;                       // 盘外没有连接：天生"不画"
    if (state[k] === UNKNOWN) { state[k] = v; dirt = true; return true; }
    return state[k] === v;
  };
  const setK = (c, v) => {
    const k = E + c;
    const cur = state[k];
    if (cur === UNKNOWN) { state[k] = v; dirt = true; return true; }
    if (cur === v) return true;
    if (cur === ON && (v === STRAIGHT || v === TURN)) { state[k] = v; return true; }  // 中间态细化
    return false;
  };
  let changed = true;
  while (changed) {
    dirt = false;

    // (1) 度数：环上每格恰好两条连接；数字格还得是"一条直线上的对边"
    for (let c = 0; c < N; c++) {
      const yes = [];
      const unk = [];
      for (let d = 0; d < 4; d++) {
        const e = ein[c * 4 + d];
        if (e < 0) continue;
        if (state[e] === YES) yes.push(d); else if (state[e] === UNKNOWN) unk.push(d);
      }
      if (yes.length > 2) return false;
      if (g[c] >= 0) {
        const k = g[c];
        if (yes.length === 2) {
          if ((yes[0] ^ 1) !== yes[1]) return false;   // 数字格拐弯 = 与规则正面冲突
          setK(c, STRAIGHT);
          for (const d of unk) if (!setE(ein[c * 4 + d], NO)) return false;
        } else if (yes.length === 1) {
          const d = yes[0];
          if (!setE(ein[c * 4 + (d ^ 1)], YES)) return false;
          for (const p of [d ^ 2, d ^ 3]) if (!setE(ein[c * 4 + p], NO)) return false;
          setK(c, STRAIGHT);
        } else {
          // 这条轴到底放不放得下这个箭头：沿线的连接、中间格的"直"、第 k 格的"拐"都得活着
          const okH = axisAlive(state, t, g, c, k, 0);
          const okV = axisAlive(state, t, g, c, k, 1);
          if (okH && !okV) {
            if (!setE(ein[c * 4], YES) || !setE(ein[c * 4 + 1], YES)) return false;
            for (const d of [2, 3]) if (!setE(ein[c * 4 + d], NO)) return false;
            setK(c, STRAIGHT);
          } else if (okV && !okH) {
            if (!setE(ein[c * 4 + 2], YES) || !setE(ein[c * 4 + 3], YES)) return false;
            for (const d of [0, 1]) if (!setE(ein[c * 4 + d], NO)) return false;
            setK(c, STRAIGHT);
          } else if (!okH && !okV) return false;
        }
        continue;
      }
      if (yes.length === 2) {
        for (const d of unk) if (!setE(ein[c * 4 + d], NO)) return false;
        if (!setK(c, (yes[0] ^ 1) === yes[1] ? STRAIGHT : TURN)) return false;
      } else if (yes.length + unk.length < 2) {
        if (yes.length) return false;                   // 已经连上一条却又凑不满第二条
        if (kindAt(t, state, c) !== UNKNOWN) return false;   // 已判定在环上的格，走不满了
        for (const d of unk) if (!setE(ein[c * 4 + d], NO)) return false;
      } else if (yes.length === 1 && unk.length === 1) {
        // 有边连着 = 这格在环上 = 必须凑满两条，只剩一条活路就得画
        if (!setE(ein[c * 4 + unk[0]], YES)) return false;
      } else if (kindAt(t, state, c) !== UNKNOWN && yes.length + unk.length === 2 && unk.length) {
        // 已判定在环上、又只剩两条可能 → 都画（直/拐的方向交给 (2) 去拧）
        for (const d of unk) if (!setE(ein[c * 4 + d], YES)) return false;
      }
    }

    // (2) 已知的直/拐反过来约束连接
    for (let c = 0; c < N; c++) {
      const k = kindAt(t, state, c);
      if (k === UNKNOWN) continue;
      const yes = [];
      const unk = [];
      for (let d = 0; d < 4; d++) {
        const e = ein[c * 4 + d];
        if (e < 0) continue;
        if (state[e] === YES) yes.push(d); else if (state[e] === UNKNOWN) unk.push(d);
      }
      const alive = (d) => {
        const e = ein[c * 4 + d];
        return e >= 0 && state[e] !== NO;
      };
      if (!yes.length) {
        // 还没有任何一条边定下来：把"还能走的形状"数一遍，只剩一种就直接钉死
        const opts = [];
        if (k === STRAIGHT) {
          for (const a of AXIS_BASE) if (alive(a) && alive(a + 1)) opts.push([a, a + 1]);
        } else {
          for (let d = 0; d < 4; d++) if (alive(d)) for (const p of [d ^ 2, d ^ 3]) if (p > d && alive(p)) opts.push([d, p]);
        }
        if (!opts.length) return false;                 // 直也直不成、拐也拐不动
        if (opts.length === 1) {
          const [a, b] = opts[0];
          if (!setE(ein[c * 4 + a], YES) || !setE(ein[c * 4 + b], YES)) return false;
          for (let d = 0; d < 4; d++) {
            if (d === a || d === b) continue;
            if (!setE(ein[c * 4 + d], NO)) return false;
          }
        }
        continue;
      }
      if (k === STRAIGHT) {
        if (yes.length > 1 && ((yes[0] ^ 1) !== yes[1])) return false;
        const d = yes[0];
        if (!setE(ein[c * 4 + (d ^ 1)], YES)) return false;
        for (const p of [d ^ 2, d ^ 3]) if (!setE(ein[c * 4 + p], NO)) return false;
      } else {
        if (yes.length === 2) { if ((yes[0] ^ 1) === yes[1]) return false; continue; }
        const d = yes[0];
        if (!setE(ein[c * 4 + (d ^ 1)], NO)) return false;
        const p0 = ein[c * 4 + (d ^ 2)];
        const p1 = ein[c * 4 + (d ^ 3)];
        const s0 = p0 < 0 ? NO : state[p0];
        const s1 = p1 < 0 ? NO : state[p1];
        if (s0 === NO && s1 === NO) return false;
        if (s0 === YES && s1 === YES) return false;
        if (s0 === NO && s1 === UNKNOWN && !setE(p1, YES)) return false;
        if (s1 === NO && s0 === UNKNOWN && !setE(p0, YES)) return false;
      }
    }

    // (3) 数字的"距离"：轴一定下来就沿轴压直 / 压拐
    for (let c = 0; c < N; c++) {
      const k = g[c];
      if (k < 0) continue;
      let axis = -1;
      if (state[ein[c * 4]] === YES && state[ein[c * 4 + 1]] === YES) axis = 0;
      else if (ein[c * 4 + 2] >= 0 && ein[c * 4 + 3] >= 0 &&
        state[ein[c * 4 + 2]] === YES && state[ein[c * 4 + 3]] === YES) axis = 1;
      if (axis < 0) continue;
      if (!setK(c, STRAIGHT)) return false;
      for (const d of [AXIS_BASE[axis], AXIS_BASE[axis] + 1]) {
        if (!setE(ein[c * 4 + (d ^ 2)], NO) || !setE(ein[c * 4 + (d ^ 3)], NO)) return false;
        let cur = c;
        for (let s = 1; s <= k; s++) {
          const nx = stepTo(t, cur, d);
          if (nx < 0) return false;                     // 盘上放不下这么长的箭头
          if (!setE(ein[cur * 4 + d], YES)) return false;
          if (s < k) {
            // 中间那几格必须直进：它的两条侧翼不能进环
            if (!setK(nx, STRAIGHT)) return false;
            for (const p of [d ^ 2, d ^ 3]) if (!setE(ein[nx * 4 + p], NO)) return false;
          } else {
            // 第 k 格：拐弯格，而且不能带数字；沿轴再往前那一条必然不画
            if (g[nx] >= 0) return false;
            if (!setK(nx, TURN)) return false;
            if (!setE(ein[nx * 4 + d], NO)) return false;
          }
          cur = nx;
        }
      }
    }

    // (4) 提前闭成一圈 = 环已经定死，其余未知一律封掉；冒出两个圈就是矛盾
    if (cycleCheck(t, state) === true) {
      for (let e = 0; e < E; e++) if (state[e] === UNKNOWN) { state[e] = NO; dirt = true; }
    }
    changed = dirt;
  }
  return true;
}

// YES 图的形状检查：度数 >2 / 有尾巴 / 有独立小圈 → false；已闭成一整圈 → true；否则 null
function cycleCheck(t, state) {
  const { N, ein } = t;
  const deg = new Int8Array(N);
  for (let c = 0; c < N; c++) {
    for (let d = 0; d < 4; d++) { const e = ein[c * 4 + d]; if (e >= 0 && state[e] === YES) deg[c]++; }
    if (deg[c] > 2) return false;
  }
  const seen = new Uint8Array(N);
  let cycles = 0;
  let anyEdge = false;
  for (let c = 0; c < N; c++) {
    if (!deg[c]) continue;
    anyEdge = true;
    if (seen[c]) continue;
    const stack = [c];
    seen[c] = 1;
    let verts = 0;
    let closed = true;
    while (stack.length) {
      const v = stack.pop();
      verts++;
      if (deg[v] !== 2) closed = false;
      for (let d = 0; d < 4; d++) {
        const e = ein[v * 4 + d];
        if (e < 0 || state[e] !== YES) continue;
        const w = ncellOf(t, v, d);
        if (!seen[w]) { seen[w] = 1; stack.push(w); }
      }
    }
    if (closed) cycles++;
  }
  if (!anyEdge) return null;
  if (cycles > 1) return false;
  if (cycles === 1) {
    for (let c = 0; c < N; c++) if (deg[c] === 1) return false;   // 圈外还挂着尾巴
    return true;
  }
  return null;
}
const ncellOf = (t, c, d) => t.ncell[c * 4 + d];

// 状态里所有 YES 边 → 有序格环（要求单一闭环），不是就返回 null
export function loopOfState(t, state) {
  const { N, ein } = t;
  const on = new Set();
  for (let c = 0; c < N; c++) {
    let deg = 0;
    for (let d = 0; d < 4; d++) { const e = ein[c * 4 + d]; if (e >= 0 && state[e] === YES) deg++; }
    if (deg === 2) on.add(c);
    else if (deg !== 0) return null;
  }
  if (on.size < 4) return null;
  const start = on.values().next().value;
  const order = [start];
  let prev = -1;
  let cur = start;
  for (;;) {
    let nxt = -1;
    for (let d = 0; d < 4; d++) {
      const w = stepTo(t, cur, d);
      if (w >= 0 && w !== prev && on.has(w) && state[ein[cur * 4 + d]] === YES) { nxt = w; break; }
    }
    if (nxt < 0) return null;
    if (nxt === start) break;
    if (order.length > on.size) return null;
    order.push(nxt);
    prev = cur;
    cur = nxt;
  }
  return order.length === on.size ? order : null;
}

// ---- 独立校验：有序格索引是不是"一条简单闭环 + 每个数字双向距离都对" --------------
// 这里不看任何求解器的中间量：只照规则走一遍环、数一遍距离。
export function validateCells(cells, n, m, clues) {
  const t = topo(n, m);
  const L = cells.length;
  if (L < 4) return false;
  const seen = new Set();
  for (const c of cells) {
    if (!(c >= 0 && c < t.N) || seen.has(c)) return false;         // 越界，或同一格走了两遍
    seen.add(c);
  }
  for (let p = 0; p < L; p++) {
    if (dirBetween(t, cells[p], cells[(p + 1) % L]) < 0) return false;   // 首尾也得挨着
  }
  const kind = loopKinds(t, cells);
  if (!kind) return false;
  const pos = new Map();
  for (let p = 0; p < L; p++) pos.set(cells[p], p);
  for (const [i, j, k] of clues) {
    if (!(i >= 0 && j >= 0 && i < n && j < m)) return false;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) return false;
    const p = pos.get(j * n + i);
    if (p === undefined) return false;                             // 数字格不在环上
    if (kind[p] !== STRAIGHT) return false;                        // 数字格必须直进直出
    let f = 0;
    while (f < L && kind[(p + f + 1) % L] !== TURN) f++;
    if (f >= L || f + 1 !== k) return false;                       // 正向：第 k 步那一格才拐弯
    let b = 0;
    while (b < L && kind[(p - b - 1 + L) % L] !== TURN) b++;
    if (b >= L || b + 1 !== k) return false;                       // 反向：也是 k
  }
  return true;
}

// 吃题面里那种有序格心列表 —— 判胜与无头复验都走这一条，不经过求解器
export function validate(spec, cellHalves) {
  const { n, m = n, clues } = spec;
  if (!Array.isArray(cellHalves)) return false;
  const cells = [];
  for (const h of cellHalves) {
    if (!Array.isArray(h) || h.length !== 2) return false;
    const [hx, hy] = h;
    if (!isCell(hx, hy)) return false;                             // 格心玩法只认 (奇,奇)
    const [i, j] = cellOf(hx, hy);
    if (i < 0 || j < 0 || i >= n || j >= m) return false;
    cells.push(j * n + i);
  }
  return validateCells(cells, n, m, clues);
}

// ---- 求解：给定墨迹往下推 -------------------------------------------------------
const seedOf = (n, m, given) => (given ? Int8Array.from(given) : newState(n, m));

// 纯逻辑一遍推到底；推不完返回 null（这就是"人做得出来"的保证）
export function logicSolve(spec, given = null) {
  const { n, m = n, clues } = spec;
  const t = topo(n, m);
  const state = seedOf(n, m, given);
  if (!propagate(state, n, m, clues)) return null;
  for (let e = 0; e < t.E; e++) if (state[e] === UNKNOWN) return null;
  const cells = loopOfState(t, state);
  if (!cells || !validateCells(cells, n, m, clues)) return null;
  return { cells, state, halves: halvesOf(t, cells) };
}

// 有界回溯：每层先传播，再挑一条"最受限"的未知连接分 YES/NO。数到 cap 早停，
// 超出节点预算同样记 capped —— 没数完就是没数完，不许说唯一。
function search(spec, cap, budget, given) {
  const { n, m = n, clues } = spec;
  const t = topo(n, m);
  let found = 0;
  let nodes = 0;
  let over = false;
  let first = null;
  const all = [];
  const walk = (state) => {
    if (over) return;
    if (++nodes > budget) { over = true; return; }
    if (!propagate(state, n, m, clues)) return;
    let pick = -1;
    let best = 1e9;
    for (let e = 0; e < t.E; e++) {
      if (state[e] !== UNKNOWN) continue;
      const a = t.eu[e];
      const b = t.ev[e];
      let s = 0;
      for (let d = 0; d < 4; d++) {
        const ea = t.ein[a * 4 + d]; if (ea >= 0 && state[ea] === UNKNOWN) s++;
        const eb = t.ein[b * 4 + d]; if (eb >= 0 && state[eb] === UNKNOWN) s++;
      }
      if (s < best) { best = s; pick = e; }
    }
    if (pick < 0) {
      const cells = loopOfState(t, state);
      if (cells && validateCells(cells, n, m, clues)) {
        found++;
        if (!first) first = cells;
        if (all.length < 8) all.push(cells);
      }
      return;
    }
    for (const val of [YES, NO]) {
      if (found >= cap) { over = true; return; }
      const next = Int8Array.from(state);
      next[pick] = val;
      walk(next);
    }
  };
  walk(seedOf(n, m, given));
  return { count: found, capped: over || found >= cap, first, all };
}

// 带计数的求解器：opts.all 时顺带把解（最多 8 个）交出来，测试拿它做交叉比对
export function countSolutions(spec, cap = 2, opts = {}) {
  const { n, m = n } = spec;
  const t = topo(n, m);
  const r = search(spec, opts.all ? Math.max(cap, 8) : cap, opts.budget || 20000, opts.given || null);
  const out = { count: r.count, capped: r.capped };
  if (opts.all) {
    out.cells = r.all;
    out.allHalves = r.all.map((cs) => halvesOf(t, cs));
  }
  return out;
}

// 找一条与给定墨迹相容的解（提示用；不看唯一性）
export function solveOne(spec, given = null, budget = 400000) {
  const r = search(spec, 1, budget, given);
  return r.count === 1 ? r.first : null;
}

// ---- 出题 -----------------------------------------------------------------------
export const rectLoop = (t, w, h, oi, oj) => {
  const cells = [];
  for (let i = 0; i < w; i++) cells.push(cellIndex(t.n, t.m, oi + i, oj));
  for (let j = 1; j < h; j++) cells.push(cellIndex(t.n, t.m, oi + w - 1, oj + j));
  for (let i = w - 2; i >= 0; i--) cells.push(cellIndex(t.n, t.m, oi + i, oj + h - 1));
  for (let j = h - 2; j >= 1; j--) cells.push(cellIndex(t.n, t.m, oi, oj + j));
  return cells;
};

// 保简单的两步手术：外扩（一条边顶出去两格）与翻折（收回这样一个小包）。
// 都是 ±2 格，所以环长永远是偶数（横竖各自进出平衡，本来也只能是偶数）。
export function expandAt(t, cells, used, p, v) {
  const a = cells[p];
  const b = cells[(p + 1) % cells.length];
  const a2 = stepTo(t, a, v);
  const b2 = stepTo(t, b, v);
  if (a2 < 0 || b2 < 0 || used.has(a2) || used.has(b2)) return null;
  return cells.slice(0, p + 1).concat([a2, b2], cells.slice(p + 1));
}
export function shrinkAt(t, cells, p) {
  const L = cells.length;
  if (L < 8) return null;
  const at = (k) => cells[((k % L) + L) % L];
  const a = at(p);
  const a2 = at(p + 1);
  const b2 = at(p + 2);
  const b = at(p + 3);
  const d1 = dirBetween(t, a, a2);
  const d2 = dirBetween(t, a2, b2);
  const d3 = dirBetween(t, b2, b);
  if (d1 < 0 || d2 < 0 || d3 < 0) return null;
  if (d3 !== (d1 ^ 1)) return null;                                   // 两侧不反向 = 不是小包
  if (d2 !== (d1 ^ 2) && d2 !== (d1 ^ 3)) return null;                // 中段不垂直 = 不是小包
  // 从 a 起沿着环走一圈，把小包那两格跳过（p 靠近尾部时小包会跨过头尾，不能再用 slice）
  const out = [];
  for (let k = 0; k < L; k++) {
    const idx = (p + k) % L;
    if (idx === (p + 1) % L || idx === (p + 2) % L) continue;
    out.push(cells[idx]);
  }
  return out;
}

export function randomLoop(rng, t, target) {
  const { n, m } = t;
  const w = rng.range(2, Math.max(2, n - 1));
  const h = rng.range(2, Math.max(2, m - 1));
  let cells = rectLoop(t, w, h, rng.int(n - w + 1), rng.int(m - h + 1));
  if (cells.length < 4) return null;
  for (let s = 0; s < 80; s++) {
    const L = cells.length;
    const p = rng.int(L);
    const grow = L < target ? rng() < 0.8 : rng() < 0.25;
    let next = null;
    if (grow) {
      const d = dirBetween(t, cells[p], cells[(p + 1) % L]);
      if (d >= 0) {
        const order = rng() < 0.5 ? [d ^ 2, d ^ 3] : [d ^ 3, d ^ 2];
        for (const v of order) {
          next = expandAt(t, cells, new Set(cells), p, v);
          if (next) break;
        }
      }
    } else {
      next = shrinkAt(t, cells, p);
    }
    if (!next) continue;
    if (next.length < 4 || next.length > n * m - 2) continue;
    if (!loopKinds(t, next)) continue;                     // 手术做坏了环：宁可不要这一步
    cells = next;
    if (cells.length >= target) {
      const kinds = loopKinds(t, cells);
      if (kinds) {
        let nt = 0;
        for (const k of kinds) if (k === TURN) nt++;
        if (nt >= 6) break;
      }
    }
  }
  return loopKinds(t, cells) ? cells : null;
}

export const makeSpec = (t, cells, clues) => ({
  n: t.n,
  m: t.m,
  clues: clues.map(([i, j, k]) => [i, j, k]),
  solution: halvesOf(t, cells),
  par: cells.length,
});

const MIN_CLUES = 2;

// 环上的直段（两个拐弯之间的连续直行格），按环序给出。拿一个拐弯格当锚点，段就不会跨过头尾。
export function straightRuns(t, cells) {
  const kind = loopKinds(t, cells);
  if (!kind) return null;
  const L = kind.length;
  let anchor = -1;
  for (let p = 0; p < L; p++) if (kind[p] === TURN) { anchor = p; break; }
  if (anchor < 0) return [];
  const out = [];
  let p = (anchor + 1) % L;
  while (p !== anchor) {
    if (kind[p] === TURN) { p = (p + 1) % L; continue; }
    const seg = [];
    while (kind[p] === STRAIGHT) { seg.push(p); p = (p + 1) % L; }
    out.push(seg);
  }
  return out;
}

// 齿轮环：一条方框往两边顶"包"，把长直段切碎。为什么发题靠它而不是 randomLoop 的自由手术：
// 线索只配落在"到前后拐弯等距"的直段中点，一条直段最多贡献一个线索。一个包会把落点的两格
// 连同新塞进去的两格全变成拐弯，等于从长度 R 的段里吃掉两格、切成 k 与 R-2-k 两段：
// R 是偶数时只有 k 取奇数才两段都是奇数 —— 一条本来 0 线索的段变成两条各 1 线索，净赚 2。
// 奇数段一律不碰：切它线索数不涨（两段一奇一偶），却把环撑长、拐弯变密，
// 实测切过奇数段的盘就推不完了 —— 白忙一场还赔掉整道选择题。
export function gearLoop(rng, t, target, maxBumps = 12) {
  const { n, m } = t;
  // 框最小取到 3：2 格宽没有环，3 格宽才有"直段中点"这种落点（一条 3×3 环给出四个 1 字线索）。
  // 下限写死成 4 的代价是 4×4 档整条齿轮只会顶出 0 线索的外框，保底直接交白卷。
  const w = rng.range(Math.min(3, n), n);
  const h = rng.range(Math.min(3, m), m);
  const first = rectLoop(t, w, h, rng.int(Math.max(1, n - w + 1)), rng.int(Math.max(1, m - h + 1)));
  if (!loopKinds(t, first)) return null;
  let cells = first;
  for (let b = 0; b < maxBumps; b++) {
    const runs = straightRuns(t, cells);
    if (!runs) return null;
    const cuts = [];
    for (const seg of runs) {
      if (seg.length % 2 !== 0 || seg.length < 4) continue;      // 只切偶数段，才有净赚
      for (let k = 1; k + 2 <= seg.length; k += 2) cuts.push([seg, k]);
    }
    if (!cuts.length) break;
    rng.shuffle(cuts);
    let moved = false;
    // 一把顶不下去不能收工：贴盘的直段只有朝内那一侧顶得动，试错顺序碰运气就会
    // 让整条齿轮停在方框上（实测 8×8 因此几乎全是没顶过的 24 格小框）。
    for (const [seg, k] of cuts) {
      const p = seg[k];
      const d = dirBetween(t, cells[p], cells[(p + 1) % cells.length]);
      if (d < 0) continue;
      for (const v of rng() < 0.5 ? [d ^ 2, d ^ 3] : [d ^ 3, d ^ 2]) {
        const next = expandAt(t, cells, new Set(cells), p, v);
        if (next) { cells = next; moved = true; break; }
      }
      if (moved) break;
    }
    if (!moved) break;
    if (cells.length >= target && clueListForLoop(t, cells).length >= 6) break;
  }
  return loopKinds(t, cells) ? cells : null;
}

// 一条环配上一副线索，两步都要当场证完才交出去：
//   1) 全线索盘必须纯逻辑推得完 —— 推得完本身就是唯一性证明，而且一路无分支，便宜；
//   2) 贪心删线索（同样只接受推得完的删法），最后再让 countSolutions 数一遍上保险。
// 走不到这一步的环一律弃掉：发"数得出唯一但推不完"的盘，每删一条线索都要展开一棵
// 回溯树，8×8 实测一道题 12 秒，手机上不可接受。
function boardFromLoop(rng, t, cells, budget) {
  const cands = clueListForLoop(t, cells);
  if (cands.length < MIN_CLUES) return null;
  const keep = cands.map(() => true);
  const setOf = () => cands.filter((_, i) => keep[i]);
  const full = makeSpec(t, cells, cands);
  if (!validate(full, full.solution)) return null;                  // 题面与答案不自洽，弃
  if (!logicSolve(full)) return null;
  for (const idx of rng.shuffle(cands.map((_, i) => i))) {
    if (setOf().length <= MIN_CLUES) break;
    keep[idx] = false;
    if (setOf().length < MIN_CLUES || !logicSolve(makeSpec(t, cells, setOf()))) keep[idx] = true;
  }
  // 删到推不动为止，等于每颗种子都交同一副最小题面（实测四十道只出四五种题面）。往回随手贴
  // 几颗：贴回去的是这根环本来就合法的线索位，而"推得完"对加线索是单调的（原来的推法一步
  // 都没被削弱），所以照旧是证明过的题 —— 只是题面的疏密终于跟着种子变了。
  const core = keep.slice();
  const gone = cands.map((_, i) => i).filter((i) => !keep[i]);
  for (const idx of rng.shuffle(gone).slice(0, rng.range(0, Math.min(3, gone.length)))) keep[idx] = true;
  let spec = makeSpec(t, cells, setOf());
  if (!logicSolve(spec)) {                 // 理论上不会走到（单调）；真走到就退回那道复核过的最小题面
    for (let i = 0; i < keep.length; i++) keep[i] = core[i];
    spec = makeSpec(t, cells, setOf());
  }
  // 推得完的盘，数解只需一个节点：这一步是给 propagate 的正确性上保险，不是重新搜一遍
  const proof = countSolutions(spec, 2, { budget });
  if (proof.count !== 1 || proof.capped) return null;               // 保险丝烧了：这道不发
  spec.count = 1;
  spec.capped = false;
  spec.propagates = true;
  return spec;
}

// 兜底：一条种子驱动的齿轮环，配全部合法线索。每一条都当场验一遍，
// 只交"被真数出来唯一"的那道；全部证不出唯一时退而交第一道自洽的（并把 count/capped
// 如实标出来）—— 到那一步题还是那道题，只是没人替它担保唯一性。
// minPar 是本档的地板：兜底要是连环长都不挑，8×8 会交出一条 3×3 小框（par 8），
// 玩家按"挑战"点开，收到的却是入门档都嫌短的题目。
export function fallbackSpec(n, m = n, seed = null, minPar = 0) {
  const t = topo(n, m);
  const rng = rngFrom(seed == null ? `fallback|${n}x${m}` : `fallback|${seed}|${n}x${m}`);
  const target = Math.max(minPar, Math.round(t.N * 0.55));
  // 地板要按档挑，但"没人担保唯一性"那条退路一步都不能走到：先守着本档地板找，找不到就把
  // 地板放低一格再找 —— 交出去的题目宁可是入门档的形状，也不是一张 0 线索的空盘。
  const sweep = (floorTry) => {
    let loose = null;
    const proven = [];
    for (let b = 0; b < 24 && proven.length < 4; b++) {
      const cells = gearLoop(rng, t, target);
      if (!cells || cells.length < floorTry) continue;
      const clues = clueListForLoop(t, cells);
      if (!clues.length) continue;
      const spec = makeSpec(t, cells, clues);
      if (!validate(spec, spec.solution)) continue;                 // 自洽是底线
      if (!logicSolve(spec)) continue;                              // 保底也不发推不完的盘
      if (!loose) loose = spec;
      const { count, capped } = countSolutions(spec, 2, { budget: 6000 });
      // 攒四道再按种子抽签，而不是第一道过关就交：兜底也是题面多样性的一条来源，
      // 交"第一道过关的"等于把所有掉进兜底的种子并成同一张盘。
      if (count === 1 && !capped) proven.push(Object.assign(spec, { count: 1, capped: false, propagates: true }));
    }
    if (proven.length) return { proven: rng.pick(proven) };
    if (!loose) return {};
    const r = countSolutions(loose, 2, { budget: 6000 });
    return { loose: Object.assign(loose, { count: r.count, capped: r.capped, propagates: true }) };
  };
  let gotLoose = null;
  for (const floorTry of [minPar, Math.max(0, minPar - 6), 0]) {
    const { proven, loose } = sweep(floorTry);
    if (proven) return proven;
    if (loose && !gotLoose) gotLoose = loose;
  }
  if (gotLoose) return gotLoose;
  // 一个候选都没自洽 —— 理论上到不了这里，但交白卷就是让玩家的首页开出一张空盘。
  // 所以最后再硬拼一次整盘外框：唯一性没人担保（capped 明写），题面本身一定是道真题。
  const cells = rectLoop(t, n, m, 0, 0);
  const bare = makeSpec(t, cells, clueListForLoop(t, cells));
  return Object.assign(bare, { count: 0, capped: true });
}

// 每档的质量地板：环长与线索数。没有地板，三档会一起塌回同一种小方框 ——
// 玩家换档等于没换题。地板值取自实测：这一族推得完的盘，par 上限就是 24-28（更大更密的
// 齿轮盘 propagate 推不完，改走计数闸门一道要 0.8-1s，手机上不可接受），所以挑战档
// 的地板定在 24 而不是理论上的 35，宁可如实窄一点。
const FLOOR = {
  6: { par: 12, clues: 3 },
  7: { par: 18, clues: 4 },
  8: { par: 24, clues: 4 },
};

export function generate(seed, sizeKey) {
  const n = sizeKey || 6;
  const m = n;
  const t = topo(n, m);
  const rng = rngFrom(seed);
  const target = Math.max(8, Math.round(t.N * 0.55));
  const floor = FLOOR[n] || { par: Math.round(t.N * 0.3), clues: 4 };
  // 收满几道就够挑一道：取"第一个过关的盘"会让所有种子撞进同一个形状族，
  // 每日挑战于是成批发出同一道题。这里攒一池合格的，再按种子自己那枚色子挑。
  const pool = [];
  // 前几把交给 randomLoop 的自由手术（偶尔滚出形状更好的盘），
  // 后面一律齿轮环：实测 8×8 上手术环过不了逻辑门（0/300），齿轮才是能出题的那一族。
  for (let attempt = 0; attempt < 64 && pool.length < 12; attempt++) {
    const cells = attempt < 8
      ? randomLoop(rng, t, target)
      : gearLoop(rng, t, target + (attempt % 5) * 2, 4 + (attempt % 9) * 2);
    if (!cells || cells.length < floor.par) continue;
    const spec = boardFromLoop(rng, t, cells, 6000);
    if (!spec || spec.clues.length < floor.clues) continue;
    pool.push(spec);
  }
  if (!pool.length) return fallbackSpec(n, m, seed, floor.par);
  return pool[rng.int(pool.length)];
}

// ---- 引擎 -----------------------------------------------------------------------
export function create(spec) {
  const n = spec.n;
  const m = spec.m || spec.n;
  const t = topo(n, m);
  const clues = spec.clues || [];
  const g = clueGrid(n, m, clues);
  const par = spec.par || 0;
  const loop = [];                 // 有序格索引：玩家落子的顺序就是环的顺序
  const onLoop = new Int8Array(t.N);
  const mark = new Uint8Array(t.N);   // 副笔：MARK_OFF = 这格一定不在环上
  const history = [];
  const future = [];
  let moves = 0;
  let locked = false;

  const refresh = () => {
    onLoop.fill(0);
    for (const c of loop) onLoop[c] = 1;
    badStale = true;
  };
  // 快照里绝不肯带 moves：撤销只搬盘面，已经花掉的笔数是收不回来的（评星靠 moves-par）
  const snap = () => ({ l: loop.slice(), k: Array.from(mark) });
  const back = (h) => {
    loop.length = 0;
    for (const c of h.l) loop.push(c);
    mark.set(h.k);
    refresh();
  };
  const remember = () => { history.push(snap()); if (history.length > 800) history.shift(); future.length = 0; };

  const cyclic = () => loop.length >= 4 && dirBetween(t, loop[loop.length - 1], loop[0]) >= 0;
  const wins = () => cyclic() && validateCells(loop, n, m, clues);

  let badStale = true;
  let badCache = [];
  const badCells = () => {
    if (!badStale) return badCache;
    const bad = [];
    const L = loop.length;
    const pos = new Map();
    loop.forEach((c, p) => pos.set(c, p));
    const closed = cyclic();
    // 沿墨迹走一格；走到没画的那头就返回 -1（判不了，不许冤枉玩家）
    const stepPos = (p, dir) => {
      if (dir > 0) {
        if (p + 1 < L) return p + 1;
        return closed && L >= 4 ? 0 : -1;
      }
      if (p - 1 >= 0) return p - 1;
      return closed && L >= 4 ? L - 1 : -1;
    };
    const kindAtPos = (p) => {
      const a = stepPos(p, -1);
      const b = stepPos(p, 1);
      if (a < 0 || b < 0) return UNKNOWN;
      return kindOfTriple(t, loop[a], loop[p], loop[b]);
    };
    for (const [i, j, k] of clues) {
      const c = cellIndex(n, m, i, j);
      let flag = mark[c] === MARK_OFF;                    // 给数字格打叉 = 跟题面顶牛
      const p = pos.get(c);
      if (!flag && p !== undefined) {
        if (kindAtPos(p) === TURN) flag = true;           // 数字格拐弯 = 明令禁止
        else {
          for (const dir of [1, -1]) {
            if (flag) break;
            let q = p;
            for (let s = 1; s <= k; s++) {
              const r = stepPos(q, dir);
              if (r < 0) break;                           // 墨迹到头，这一向还没法定案
              const kk = kindAtPos(r);
              if (kk === UNKNOWN) break;
              if (kk === TURN) { if (s !== k) flag = true; break; }
              if (s === k) { flag = true; break; }        // 数到 k 还没拐弯
              q = r;
            }
          }
        }
      }
      if (flag) bad.push(cellAt(i, j));
    }
    badCache = bad;
    badStale = false;
    return badCache;
  };

  // 主笔落在一个还没进环的格上：接得上就接，接不上就另起一笔（旧的一律作废，不退款）
  const joinCell = (c, fromDown) => {
    const attach = loop.length > 0 && dirBetween(t, loop[loop.length - 1], c) >= 0;
    if (!attach && !fromDown && loop.length) return false;   // 拖拽中途跳到不相邻的格：不动
    remember();
    if (attach) loop.push(c);
    else { loop.length = 0; loop.push(c); }
    moves += 1;                                    // 一格一次落子；擦除、改画、撤销都不退款
    mark[c] = MARK_NONE;
    refresh();
    if (wins()) locked = true;
    return true;
  };

  const mainAt = (hx, hy, fromDown) => {
    if (locked || !isCell(hx, hy)) return false;
    const [i, j] = cellOf(hx, hy);
    if (i < 0 || j < 0 || i >= n || j >= m) return false;
    const c = cellIndex(n, m, i, j);
    const at = loop.indexOf(c);
    if (at >= 0) {
      if (at === loop.length - 1) return false;          // 尾部再点一下：盘面没变
      remember();
      loop.length = at + 1;                              // 点环上已有的格 = 往回擦到那一格
      refresh();
      if (wins()) locked = true;
      return true;
    }
    return joinCell(c, fromDown);
  };

  const offAt = (hx, hy) => {
    if (locked || !isCell(hx, hy)) return false;
    const [i, j] = cellOf(hx, hy);
    if (i < 0 || j < 0 || i >= n || j >= m) return false;
    const c = cellIndex(n, m, i, j);
    if (onLoop[c]) return false;               // 已经在环上的格不许打叉：别静默改状态
    remember();
    mark[c] = mark[c] === MARK_OFF ? MARK_NONE : MARK_OFF;
    badStale = true;
    return true;
  };

  // 把墨迹翻成求解器的状态：走过的连接钉成 YES，中间格的直/拐钉死，打了叉的格四周全 NO
  const inkState = () => {
    const state = newState(n, m);
    const L = loop.length;
    for (let p = 0; p + 1 < L; p++) {
      const d = dirBetween(t, loop[p], loop[p + 1]);
      if (d < 0) return null;
      state[t.ein[loop[p] * 4 + d]] = YES;
    }
    if (cyclic()) {
      const d = dirBetween(t, loop[L - 1], loop[0]);
      state[t.ein[loop[L - 1] * 4 + d]] = YES;
    }
    for (let p = 1; p + 1 < L; p++) {
      state[t.E + loop[p]] = kindOfTriple(t, loop[p - 1], loop[p], loop[p + 1]);
    }
    for (let c = 0; c < t.N; c++) {
      if (mark[c] !== MARK_OFF) continue;
      for (let d = 0; d < 4; d++) { const e = t.ein[c * 4 + d]; if (e >= 0 && state[e] === UNKNOWN) state[e] = NO; }
    }
    return state;
  };

  return {
    spec,
    step: 2,                                     // 键盘光标一次挪一个格：目标是格心
    board: { cols: n, rows: m, margin: { l: 0, t: 0, r: 0, b: 0 } },

    down(hx, hy, btn) {
      if (btn === 1) return offAt(hx, hy);
      return mainAt(hx, hy, true);
    },
    move(hx, hy) {
      if (locked || !isCell(hx, hy)) return false;   // 点、边、盘外一律原样退回，不改状态
      return mainAt(hx, hy, false);
    },
    up() {
      if (!locked && wins()) { locked = true; return true; }
      return false;
    },

    undo() { if (!history.length) return false; future.push(snap()); back(history.pop()); locked = false; return true; },
    redo() { if (!future.length) return false; history.push(snap()); back(future.pop()); if (wins()) locked = true; return true; },
    canUndo() { return history.length > 0; },
    canRedo() { return future.length > 0; },

    hint() {
      if (locked) return null;
      const ink = inkState();
      if (!ink) return null;
      const sol = solveOne(spec, ink);
      if (!sol) return null;                       // 墨迹跟任何解都不相容：只能靠撤销
      const L = sol.length;
      const pos = new Map();
      sol.forEach((c, p) => pos.set(c, p));
      let next = -1;
      if (!loop.length) {
        const first = clues.length ? cellIndex(n, m, clues[0][0], clues[0][1]) : sol[0];
        next = pos.has(first) ? first : sol[0];
      } else {
        const tail = loop[loop.length - 1];
        const p = pos.get(tail);
        if (p === undefined) return null;
        let dir = 1;
        if (loop.length >= 2) dir = sol[(p + 1) % L] === loop[loop.length - 2] ? -1 : 1;
        next = sol[(p + dir + L) % L];
        if (loop.indexOf(next) >= 0) return null;
      }
      const [hx, hy] = cellHalf(t, next);
      const note = loop.length
        ? '环非从这一格穿过去不可 —— 顺着数字数出来的那一格'
        : '先从数字格起手：数字格一定在环上，而且必定直进直出';
      if (!mainAt(hx, hy, true)) return null;
      return { cells: [[hx, hy]], note };
    },

    solved() {
      if (locked) return true;
      if (wins()) { locked = true; return true; }
      return false;
    },
    stats() { return { moves, par, done: loop.length, total: par }; },
    cellState(i, j) {
      if (i < 0 || j < 0 || i >= n || j >= m) return 0;
      const c = cellIndex(n, m, i, j);
      return onLoop[c] ? 1 : (mark[c] === MARK_OFF ? 2 : 0);
    },

    badCells,

    draw(ctx, v, now) {
      const cell = v.cell;
      paper(ctx, 0, 0, v.w, v.h);
      rules(ctx, v, T.rule);
      for (let c = 0; c < t.N; c++) {
        if (mark[c] !== MARK_OFF) continue;
        crossMark(ctx, v, cellI(t, c), cellJ(t, c), T.inkFaint, 0.62);
      }
      const bad = new Set(badCells().map(([x, y]) => x + ',' + y));
      const L = loop.length;
      if (L) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2.6, cell * 0.15);
        const segs = [];
        for (let p = 0; p + 1 < L; p++) segs.push([p, p + 1]);
        const closed = cyclic();
        if (closed) segs.push([L - 1, 0]);
        for (const [a, b] of segs) {
          const pa = cellCenter(v, cellI(t, loop[a]), cellJ(t, loop[a]));
          const pb = cellCenter(v, cellI(t, loop[b]), cellJ(t, loop[b]));
          const hurt = bad.has(cellHalf(t, loop[a]).join(',')) || bad.has(cellHalf(t, loop[b]).join(','));
          ctx.strokeStyle = hurt ? T.warn : T.accent;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
        ctx.restore();
        if (!closed && !locked) {              // 笔尖：告诉玩家下一格该从这儿接
          const p = cellCenter(v, cellI(t, loop[L - 1]), cellJ(t, loop[L - 1]));
          ctx.fillStyle = rgba(T.accent, 0.22 + 0.16 * (v.reduce ? 0.5 : pulse(now)));
          ctx.beginPath();
          ctx.arc(p.x, p.y, cell * 0.13, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const [i, j, k] of clues) {
        const p = cellCenter(v, i, j);
        const hurt = bad.has(cellAt(i, j).join(','));
        ctx.fillStyle = T.card;                // 把墨让开，数字才读得清
        ctx.beginPath();
        ctx.arc(p.x, p.y, cell * 0.3, 0, Math.PI * 2);
        ctx.fill();
        const on = loop.indexOf(cellIndex(n, m, i, j)) >= 0;
        label(ctx, String(k), p.x, p.y, {
          size: cell * 0.42,
          color: hurt ? T.warn : (cyclic() && on && !bad.size ? T.good : T.ink),
          bold: true,
          mono: true,
        });
      }
      // 悬停：空格给个脉冲点；数字格把"数出去 k 步"的那两格圈出来 —— 距离这件事要看得见
      const hv = v.hover;
      if (hv && isCell(hv.x, hv.y) && !locked) {
        const [hi, hj] = cellOf(hv.x, hv.y);
        if (hi >= 0 && hj >= 0 && hi < n && hj < m) {
          const c = cellIndex(n, m, hi, hj);
          const need = g[c];
          const at = loop.indexOf(c);
          const p = cellCenter(v, hi, hj);
          if (need >= 0 && at >= 0 && L >= 4) {
            for (const dir of [1, -1]) {
              let q = at;
              let hit = q;
              let ok = true;
              for (let s = 1; s <= need; s++) {
                const nq = ((q + dir) % L + L) % L;
                const from = dir > 0 ? q : nq;
                const to = dir > 0 ? nq : q;
                if (dirBetween(t, loop[from], loop[to]) < 0) { ok = false; break; }
                q = nq;
                hit = q;
              }
              if (!ok) continue;
              const hp = cellCenter(v, cellI(t, loop[hit]), cellJ(t, loop[hit]));
              ctx.save();
              ctx.strokeStyle = rgba(T.gold, 0.8);
              ctx.lineWidth = Math.max(1.4, cell * 0.05);
              ctx.setLineDash([cell * 0.1, cell * 0.09]);
              ctx.beginPath();
              ctx.arc(hp.x, hp.y, cell * (0.26 + (v.reduce ? 0 : 0.03 * pulse(now))), 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
            }
          } else if (!onLoop[c]) {
            ctx.fillStyle = rgba(T.accent, v.reduce ? 0.2 : 0.14 + 0.12 * pulse(now));
            ctx.beginPath();
            ctx.arc(p.x, p.y, cell * 0.19, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    },

    celebrate(ctx, v, now, k0) {
      this.draw(ctx, v, now);
      const k = easeOut(clamp(k0 * 1.4, 0, 1));
      ctx.save();
      ctx.strokeStyle = rgba(T.gold, 0.45 * (1 - k));
      ctx.lineWidth = Math.max(2, v.cell * 0.14) * (1 + k * 0.7);
      ctx.beginPath();
      ctx.arc(v.ox + v.cols * v.cell / 2, v.oy + v.rows * v.cell / 2, v.cell * (0.5 + k * v.cols * 0.55), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    },
  };
}

const TIERS = [
  { key: 6, label: '6×6', tier: '入门' },
  { key: 7, label: '7×7', tier: '熟手' },
  { key: 8, label: '8×8', tier: '挑战' },
];

export default {
  id: 'arukone',
  title: '箭头',
  latin: 'ARUKONE',
  tagline: '数字说：往两头各数 k 格才拐弯',
  unit: '格',
  rules: [
    '线走的是格子中心：一条不断的闭环穿过若干格，不分叉、同一格不走两遍。',
    '环经过数字格时一定直进直出；数字 = 从这个格出发，沿环往两个方向各数几格才第一次碰到拐弯格。',
    '数字 3 就是"往前走 3 步那一格必须拐弯、中间两格直进"，往回数也一样；没数字的格可直可拐，也可以根本不进环。',
    '副笔在空格上点一下表示"这格一定不在环上"，记号不计入步数；一格一次落子，擦掉重画不退款。',
  ],
  sizes: TIERS.map(({ key, label: lb, tier }) => ({ key, label: lb, tier })),
  generate,
  create,
};
