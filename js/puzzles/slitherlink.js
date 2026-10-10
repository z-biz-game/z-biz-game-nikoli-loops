// 圈环 / Slitherlink —— 格子里的数字是证词："恰好这么多条边在我四条边上"。
//
// 三样东西缺一不可：
//   · propagate() —— 人用的那几条规则：数字满了就封其余、缺的正好等于剩下的未知就全画、
//     一个点最多挂两条环边。从空盘推到不动点，若整条环都定下来了，那"唯一解"就是被这条
//     推理链证明的，不是猜出来的（与数织的 logicSolve 同一立场）。
//   · countSolutions() —— 传播之上做有界回溯，数到 cap 早停。它是保险丝：没数完就是
//     capped，绝不说"唯一"。
//   · validate() —— 独立于上面两者：给一串边，判它是不是"一条闭环 + 数字全对"。
//     求解器负责找得到解，校验器负责那确实是解，两边对拍才敢说生成器没说谎。
//
// 出题：随机长一块无洞多联骨牌，取它的边界 —— 边界天然就是一条不自交的闭环
// （前提：没有洞、且没有一个点挂四条边，两条都在候选筛掉时检查）。然后算每格的边界条数
// 当题面，再贪心删线索，每删一条都用 propagate() 复核还能不能纯逻辑推完。

import { rngFrom } from '../core/rng.js';
import { T } from '../core/theme.js';
import { paper, label, rgba, pulse, easeOut, clamp } from '../core/paper.js';
import { isHEdge, isEdge, edgeEnds, halfPoint, cellCenter } from '../core/lattice.js';

export const UNKNOWN = -1;
export const NO = 0;
export const YES = 1;

// 索引：横边 h(i,j) 覆盖 i∈[0,n) 、j∈[0,n]；竖边 v(i,j) 覆盖 i∈[0,n] 、j∈[0,n)
const H_COUNT = (n) => n * (n + 1);
const hIdx = (n, i, j) => j * n + i;
const vIdx = (n, i, j) => H_COUNT(n) + j * (n + 1) + i;
export const nEdges = (n) => 2 * n * (n + 1);

const hAt = (i, j) => [2 * i + 1, 2 * j];
const vAt = (i, j) => [2 * i, 2 * j + 1];
export function edgeOfIndex(n, k) {
  if (k < H_COUNT(n)) return hAt(k % n, Math.floor(k / n));
  const t = k - H_COUNT(n);
  return vAt(t % (n + 1), Math.floor(t / (n + 1)));
}
export const indexOfHalf = (n, hx, hy) => (isHEdge(hx, hy)
  ? hIdx(n, (hx - 1) / 2, hy / 2)
  : vIdx(n, hx / 2, (hy - 1) / 2));

export function cellEdges(n, i, j) {
  return [hIdx(n, i, j), hIdx(n, i, j + 1), vIdx(n, i, j), vIdx(n, i + 1, j)];
}
export function vertexEdges(n, i, j) {
  const out = [];
  if (i > 0) out.push(hIdx(n, i - 1, j));
  if (i < n) out.push(hIdx(n, i, j));
  if (j > 0) out.push(vIdx(n, i, j - 1));
  if (j < n) out.push(vIdx(n, i, j));
  return out;
}

export const clueGrid = (n, clues) => {
  const g = new Int8Array(n * n).fill(-1);
  for (const [i, j, k] of clues) g[j * n + i] = k;
  return g;
};

// 邻接关系只跟 n 有关，生成器一次要调用上万次 propagate，每次都现算下标纯属白烧。
// 顶点一律编号成 j*(n+1)+i，这样闭环检查可以用 Int32Array 并查集，不必拿字符串当键。
const TOPO = new Map();
function topology(n) {
  let t = TOPO.get(n);
  if (t) return t;
  const total = nEdges(n);
  const cells = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cells.push(cellEdges(n, i, j));
  const verts = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(vertexEdges(n, i, j));
  const vOf = (i, j) => j * (n + 1) + i;
  const endA = new Int32Array(total);
  const endB = new Int32Array(total);
  const edgeCells = Array.from({ length: total }, () => []);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const ci = j * n + i;
    for (const k of cells[ci]) edgeCells[k].push(ci);
  }
  for (let k = 0; k < total; k++) {
    const [a, b] = edgeEnds(...edgeOfIndex(n, k));
    endA[k] = vOf(a[0], a[1]);
    endB[k] = vOf(b[0], b[1]);
  }
  const cellOfVert = verts.map((es) => {
    const set = new Set();
    for (const k of es) for (const ci of edgeCells[k]) set.add(ci);
    return [...set];
  });
  t = { cells, verts, endA, endB, edgeCells, cellOfVert, nv: (n + 1) * (n + 1) };
  TOPO.set(n, t);
  return t;
}

// ---- 规则传播 -------------------------------------------------------------------
// log 是可选的记账本：把这一轮新钉死的边记进去，回溯时按它撤销，省掉整盘拷贝。
export function propagate(state, n, clues, log = null) {
  const g = clueGrid(n, clues);
  const T = topology(n);
  const put = (k, val) => {
    if (state[k] === UNKNOWN) { state[k] = val; if (log) log.push(k); return true; }
    return state[k] === val;
  };
  let changed = true;
  let yesDirty = true;         // 只有"新画了边"才可能冒出子环，别每轮都全盘查环
  while (changed) {
    changed = false;
    for (let ci = 0; ci < T.cells.length; ci++) {
      const need = g[ci];
      if (need < 0) continue;
      const es = T.cells[ci];
      if (need > es.length) return false;            // 数字大过这个格能给的边数：题面本身就有病
      let yes = 0; const unk = [];
      for (const k of es) { if (state[k] === YES) yes++; else if (state[k] === UNKNOWN) unk.push(k); }
      if (yes > need) return false;
      const left = need - yes;
      if (left === 0 && unk.length) {
        for (const k of unk) if (!put(k, NO)) return false;
        changed = true;
      } else if (unk.length === left && unk.length) {
        for (const k of unk) if (!put(k, YES)) return false;
        changed = true; yesDirty = true;
      }
    }
    for (const es of T.verts) {
      let yes = 0; const unk = [];
      for (const k of es) { if (state[k] === YES) yes++; else if (state[k] === UNKNOWN) unk.push(k); }
      if (yes > 2) return false;
      if (yes === 2 && unk.length) {
        for (const k of unk) if (!put(k, NO)) return false;
        changed = true;
      } else if (yes === 1 && unk.length === 1) {
        if (!put(unk[0], YES)) return false;
        changed = true; yesDirty = true;
      }
    }
    if (yesDirty && closedTooEarly(state, n, T)) return false;
    yesDirty = false;
  }
  return true;
}

// 已经闭合出一圈、却还有别的已画边挂在圈外 —— 那是子环，非法。
// 判据是"每个连通块自己数点与边"：度 ≤2 时 V==E 的块就是一个闭环。
// 拿整盘 yes.length 去比会漏 —— 圈外的零散边把总数抬上去，那块明明已经成环了。
// 并查集配 Int32Array：这一步在生成器里每毫秒要跑几十次，字符串键撑不住。
function closedTooEarly(state, n, T = topology(n)) {
  const total = nEdges(n);
  const { endA, endB, nv } = T;
  const parent = new Int32Array(nv).fill(-1);   // -1 = 这个点上还没有已画的边
  const rank = new Int32Array(nv);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let yesCount = 0;
  for (let k = 0; k < total; k++) {
    if (state[k] !== YES) continue;
    yesCount++;
    const a = endA[k]; const b = endB[k];
    if (parent[a] < 0) parent[a] = a;
    if (parent[b] < 0) parent[b] = b;
    const ra = find(a); const rb = find(b);
    if (ra !== rb) {
      if (rank[ra] < rank[rb]) parent[ra] = rb;
      else if (rank[ra] > rank[rb]) parent[rb] = ra;
      else { parent[rb] = ra; rank[ra]++; }
    }
  }
  if (yesCount < 4) return false;
  // 边按 find(endA) 归账一次，别让两个端点各数一遍
  const verts = new Int32Array(nv);
  const edges = new Int32Array(nv);
  for (let v = 0; v < nv; v++) if (parent[v] >= 0) verts[find(v)]++;
  for (let k = 0; k < total; k++) if (state[k] === YES) edges[find(endA[k])]++;
  for (let v = 0; v < nv; v++) {
    if (parent[v] < 0 || find(v) !== v) continue;
    if (edges[v] === verts[v] && edges[v] < yesCount) return true;
  }
  return false;
}

// ---- 求解：给定墨迹往下推 -------------------------------------------------------
const emptyState = (n) => new Int8Array(nEdges(n)).fill(UNKNOWN);
const completeOf = (state) => {
  const out = [];
  for (let k = 0; k < state.length; k++) if (state[k] === YES) out.push(k);
  return out;
};

// 纯逻辑一遍推到底；推不完返回 null（这就是"人做得出来"的保证）
export function logicSolve(spec, given = null) {
  const { n, clues } = spec;
  const state = given ? Int8Array.from(given) : emptyState(n);
  if (!propagate(state, n, clues)) return null;
  for (let k = 0; k < state.length; k++) if (state[k] === UNKNOWN) return null;
  const edges = completeOf(state);
  return validateIndices(edges, n, clues) ? { edges, state } : null;
}

// 回溯的骨架，countSolutions 与 solveOne 共用。两件小事决定它能不能在手机上跑：
//   · 回滚用记账（trail），不拷整盘 —— 一次拷贝上百字节，节点一多全烧在分配上；
//   · 猜哪条边按"所在数字格还剩多少未知"挑，先挑一猜就见分晓的，树立刻变浅。
//     老版本从头扫第一个未知边，撞上约束稀疏的盘能展开上万个节点（7×7 实测几十秒）。
function search(spec, { cap = 2, budget = 1e9, seedState = null }) {
  const { n, clues } = spec;
  const T = topology(n);
  const g = clueGrid(n, clues);
  const state = seedState ? Int8Array.from(seedState) : emptyState(n);
  let found = 0;
  let spent = 0;
  let over = false;
  let hit = null;
  const undo = (log) => { for (let i = log.length - 1; i >= 0; i--) state[log[i]] = UNKNOWN; };
  const done = () => found >= cap || !!hit;
  const pick = () => {
    let best = -1;
    let bestScore = -1;
    for (let k = 0; k < state.length; k++) {
      if (state[k] !== UNKNOWN) continue;
      let score = 0;
      for (const ci of T.edgeCells[k]) {
        const need = g[ci];
        if (need < 0) continue;
        let yes = 0;
        let unk = 0;
        for (const e of T.cells[ci]) {
          if (state[e] === YES) yes++; else if (state[e] === UNKNOWN) unk++;
        }
        const tight = unk - (need - yes);          // 还能多填几条：越小越一猜就准
        score += tight <= 1 ? 20 : 1 / tight;
      }
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return best;
  };
  const walk = () => {
    if (done()) return;
    if (++spent > budget) { over = true; return; }
    const log = [];
    if (!propagate(state, n, clues, log)) { undo(log); return; }
    const k = pick();
    if (k < 0) {
      const edges = completeOf(state);
      if (edges.length && validateIndices(edges, n, clues)) { found++; if (!hit) hit = edges; }
      undo(log);
      return;
    }
    for (const val of [YES, NO]) {
      state[k] = val;
      walk();
      state[k] = UNKNOWN;
      if (done()) break;
    }
    undo(log);
  };
  walk();
  return { found, over, hit };
}

// 带计数的求解器：数到 cap 就停，没数完如实 capped。
// budget 是给生成器用的刹车 —— 一个 DFS 节点算一格，超了就 capped 退出。
// 说谎的代价比慢的代价大：capped 的题一律不能上线，但绝不能因为慢就判"唯一"。
export function countSolutions(spec, cap = 2, seedState = null, budget = 1e9) {
  const { found, over } = search(spec, { cap, budget, seedState });
  return { count: found, capped: over || found >= cap };
}

// 找一条与给定墨迹相容的解（提示用；不看唯一性）
export function solveOne(spec, seedState = null) {
  return search(spec, { cap: Infinity, budget: 1e9, seedState }).hit;
}

// ---- 独立校验：一串边索引是不是"一条闭环 + 数字全对" -----------------------------
export function validateIndices(edges, n, clues) {
  if (edges.length < 4) return false;
  const deg = new Map();
  const adj = new Map();
  for (const k of edges) {
    const [a, b] = edgeEnds(...edgeOfIndex(n, k));
    const ka = `${a[0]},${a[1]}`, kb = `${b[0]},${b[1]}`;
    deg.set(ka, (deg.get(ka) || 0) + 1);
    deg.set(kb, (deg.get(kb) || 0) + 1);
    (adj.get(ka) || adj.set(ka, []).get(ka)).push(kb);
    (adj.get(kb) || adj.set(kb, []).get(kb)).push(ka);
  }
  for (const d of deg.values()) if (d !== 2) return false;
  const seen = new Set();
  const stack = [deg.keys().next().value];
  while (stack.length) {
    const v = stack.pop();
    if (seen.has(v)) continue;
    seen.add(v);
    for (const w of adj.get(v) || []) if (!seen.has(w)) stack.push(w);
  }
  if (seen.size !== edges.length) return false;         // 不连通或分了几个环
  const onEdge = new Set(edges);
  const g = clueGrid(n, clues);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const need = g[j * n + i];
    if (need < 0) continue;
    let c = 0;
    for (const k of cellEdges(n, i, j)) if (onEdge.has(k)) c++;
    if (c !== need) return false;
  }
  return true;
}

export const validate = (spec, halfCoords) =>
  validateIndices(halfCoords.map(([hx, hy]) => indexOfHalf(spec.n, hx, hy)), spec.n, spec.clues);

// 把唯一解摊成"一笔能拖过去"的顺序：环上每条边的两个端点里，总有一个接着下一条边。
// 无头复验拿这个顺序当真手指的拖拽轨迹，所以顺序错了不会让题变简单，只会让题画不出来。
export function orderLoop(n, edges) {
  const byVertex = new Map();
  for (const k of edges) {
    for (const [x, y] of edgeEnds(...edgeOfIndex(n, k))) {
      const key = x + ',' + y;
      (byVertex.get(key) || byVertex.set(key, []).get(key)).push(k);
    }
  }
  const left = new Set(edges);
  const start = edges[0];
  const out = [start];
  left.delete(start);
  let cur = start;
  while (left.size) {
    let next = -1;
    for (const v of edgeEnds(...edgeOfIndex(n, cur))) {
      for (const k of byVertex.get(v[0] + ',' + v[1]) || []) if (left.has(k)) { next = k; break; }
      if (next >= 0) break;
    }
    if (next < 0) return null;                        // 解不连通（上游 validate 已排除，这里只兜底）
    left.delete(next); out.push(next); cur = next;
  }
  return out.map((k) => edgeOfIndex(n, k));
}

// ---- 出题 -----------------------------------------------------------------------
// 无洞连通多联骨牌的边界 = 一条不自交的闭环。洞与"一个点挂四条边"都要筛掉。
// 格一律编号成 j*n+i、邻接直接算下标：一次出题要投几十上百个候选，
// 拿 "i,j" 字符串当键的话，光拼串和 split 就能把预算烧光。
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

function cellNeighbours(k, n, out) {
  const i = k % n;
  const j = (k - i) / n;
  out.length = 0;
  if (i > 0) out.push(k - 1);
  if (i < n - 1) out.push(k + 1);
  if (j > 0) out.push(k - n);
  if (j < n - 1) out.push(k + n);
  return out;
}

// 返回占用格的编号集合（j*n+i），拿不到合法形状就返回 null
function randomLoopCells(rng, n) {
  const size = rng.range(Math.max(4, n), n * n - Math.max(2, n));
  const taken = new Uint8Array(n * n);
  const cells = new Set();
  const front = [];
  const nb = [];
  const grow = (k) => {
    taken[k] = 1;
    cells.add(k);
    for (const m of cellNeighbours(k, n, nb)) if (!taken[m]) front.push(m);
  };
  grow(rng.int(n * n));
  while (cells.size < size) {
    let next = -1;
    while (front.length) {
      const k = front.splice(rng.int(front.length), 1)[0];
      if (!taken[k]) { next = k; break; }
    }
    if (next < 0) break;
    grow(next);
  }
  if (cells.size < 4) return null;
  // 洞：从盘外沿"非格"洪水填充，还有填不到的非格就是有洞。多一圈当陆地的边界。
  const w = n + 2;
  const outer = new Uint8Array(w * w);
  const isCell = (x, y) => x >= 0 && y >= 0 && x < n && y < n && taken[y * n + x] === 1;
  const stack = [];
  for (let k = 0; k < w; k++) stack.push(k, (w - 1) * w + k, k * w, k * w + w - 1);
  while (stack.length) {
    const p = stack.pop();
    if (outer[p]) continue;
    const x = (p % w) - 1;
    const y = ((p - (p % w)) / w) - 1;
    if (isCell(x, y)) continue;
    outer[p] = 1;
    for (let d = 0; d < 4; d++) {
      const ax = x + DX[d];
      const ay = y + DY[d];
      if (ax < -1 || ay < -1 || ax > n || ay > n) continue;   // 再往外已经没有格可判
      const q = (ay + 1) * w + (ax + 1);
      if (!outer[q]) stack.push(q);
    }
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (!taken[j * n + i] && !outer[(j + 1) * w + (i + 1)]) return null;
  }
  return cells;
}

function boundaryEdges(cells, n) {
  const set = new Set();
  for (const c of cells) {
    const i = c % n;
    const j = (c - i) / n;
    const at = (x, y) => x >= 0 && y >= 0 && x < n && y < n && cells.has(y * n + x);
    if (!at(i, j - 1)) set.add(hIdx(n, i, j));
    if (!at(i, j + 1)) set.add(hIdx(n, i, j + 1));
    if (!at(i - 1, j)) set.add(vIdx(n, i, j));
    if (!at(i + 1, j)) set.add(vIdx(n, i + 1, j));
  }
  return [...set];
}

// 一道题值不值得发出去，看两件事，缺一不可：
//   · logicSolve 推得完。propagate 每条规则只钉"别无选择"的边，所以推得完 = 证明了唯一，
//     顺带保证人做得出来；而且它一路无分支，毫秒级。
//   · countSolutions 数得出 1。给上面那条推理链兜底：万一有条规则不 sound，数解会露馅。
//     纯逻辑推得完的盘，DFS 连一个分支都不展开，所以这一步几乎不要钱。
function publishable(spec, budget = 40000) {
  if (!logicSolve(spec)) return false;
  const { count, capped } = countSolutions(spec, 2, null, budget);
  return count === 1 && !capped;
}

// 题面 → 可发出去的 spec。解直接取 logicSolve 推出来的那条（它已经是唯一解），
// 顺手摊成 stroke（拖拽顺序），无头复验拿它当真手指轨迹。
function buildSpec(n, clues) {
  const sol = logicSolve({ n, clues });
  if (!sol) return null;
  const stroke = orderLoop(n, sol.edges);
  if (!stroke) return null;
  return {
    n,
    clues,
    solution: sol.edges.map((k) => edgeOfIndex(n, k)),
    stroke,
    par: sol.edges.length,
  };
}

// 保底题面：一整圈外边界，一格不留地把所有数字印上去（0 在圈环里是正经证词：
// "这四条边上都没有环"）。三层递降：
//   1) 纯逻辑推得完 —— 与正常出题同一标准，能成最好。
//   2) 数得出唯一 —— 全盘线索的 DFS 只有几个节点，实测 4..10 档都在 2ms 内交卷。
//      这种题人可能要蒙一步，但它是唯一解，不发多解题这条底线不破。
//   3) 直接交死题面 —— 走到的话 generate 末尾的审计会把它标成 capped，绝不装成唯一。
// 交不出题是契约违约，所以第 1、2 层由 test/slitherlink.test.mjs 在 4..10 每一档逐项验死。
export function rescue(n) {
  const edges = [];
  for (let i = 0; i < n; i++) edges.push(hIdx(n, i, 0), hIdx(n, i, n));
  for (let j = 0; j < n; j++) edges.push(vIdx(n, 0, j), vIdx(n, n, j));
  const onEdge = new Set(edges);
  const full = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let c = 0;
    for (const k of cellEdges(n, i, j)) if (onEdge.has(k)) c++;
    full.push([i, j, c < 4 ? c : 4]);
  }
  const bare = () => ({
    n,
    clues: full,
    solution: edges.map((k) => edgeOfIndex(n, k)),
    stroke: orderLoop(n, edges),
    par: edges.length,
  });
  const pretty = full.filter(([, , c]) => c > 0 && c < 4);
  const built = buildSpec(n, pretty) || buildSpec(n, full);
  if (built) return built;
  const { count, capped } = countSolutions({ n, clues: full }, 2, null, 200000);
  if (count === 1 && !capped) {
    const sol = solveOne({ n, clues: full }) || edges;
    return {
      n,
      clues: full,
      solution: sol.map((k) => edgeOfIndex(n, k)),
      stroke: orderLoop(n, sol),
      par: sol.length,
    };
  }
  return bare();
}

export function generate(seed, sizeKey) {
  const n = sizeKey || 5;
  const rng = rngFrom(seed);
  const minLoop = 2 * n + 2;                 // 环太短就是一眼看完的玩具
  const shapeOf = (cells) => {
    const edges = boundaryEdges(cells, n);
    if (edges.length < minLoop) return null;
    // 环上任何一点度数为 2 才叫"一条不自交的闭曲线"；四度点意味着两块只在角上相接，
    // 边界在那里会打结 —— 这种形状直接弃掉重投。
    const deg = new Int8Array((n + 1) * (n + 1));
    for (const k of edges) {
      const T = topology(n);
      if (++deg[T.endA[k]] > 2 || ++deg[T.endB[k]] > 2) return null;
    }
    const onEdge = new Set(edges);
    const full = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let c = 0;
      for (const k of cellEdges(n, i, j)) if (onEdge.has(k)) c++;
      full.push([i, j, c]);
    }
    return { edges, full };
  };
  const build = (clues) => buildSpec(n, clues);
  // 删线索：每删一条都重新证明一遍，删完仍然唯一才认。宁可多留几条，也不发一道多解题。
  const trim = (clues) => {
    let keep = clues.slice();
    const floor = Math.max(3, Math.ceil(clues.length * 0.25));
    for (const c of rng.shuffle(keep)) {
      if (keep.length <= floor) break;
      const at = keep.indexOf(c);                 // 线索对象出自 full，引用即身份
      if (at < 0) continue;
      const trial = keep.slice(0, at).concat(keep.slice(at + 1));
      if (publishable({ n, clues: trial })) keep = trial;
    }
    return keep;
  };
  let best = null;
  for (let attempt = 0; attempt < 400 && !best; attempt++) {
    const cells = randomLoopCells(rng, n);
    if (!cells) continue;
    const shape = shapeOf(cells);
    if (!shape) continue;
    // 候选线索从整盘数字起步，只把 4 剔掉：4 等于把答案印在题面上。0 留着 ——
    // 它是正经证词（"这四条边上都没有环"），而且纯逻辑推演往往就靠它起步。
    // 到底印哪几条，由下面的贪心删 decides：删了还能推完的就删掉。
    let clues = shape.full.filter(([, , c]) => c < 4);
    if (!publishable({ n, clues })) continue;
    best = build(trim(clues));
  }
  if (!best) best = rescue(n);                    // 投了几百次也没碰上人做得出来的题面：交保底
  // 发出去之前再数一遍解。走到的题都推得完，所以这一步只花一次 propagate；
  // budget 是给那条永不该走到的兜底路径上保险 —— 宁可报 capped，也不让出题卡死。
  const { count, capped } = countSolutions(best, 2, null, 3000);
  best.count = count;
  best.capped = capped;
  return best;
}

const TIERS = [
  { key: 5, label: '5×5', tier: '入门' },
  { key: 6, label: '6×6', tier: '熟手' },
  { key: 7, label: '7×7', tier: '挑战' },
];

export function create(spec) {
  const { n, clues } = spec;
  const total = nEdges(n);
  const par = spec.par || 0;
  const state = new Int8Array(total).fill(UNKNOWN);
  const history = [];
  const future = [];
  let moves = 0;
  let locked = false;

  // 快照只存盘面，不存步数：撤销把棋盘搬回去，但不退已经花掉的笔（契约里 moves 单调）。
  const snap = () => Array.from(state);
  const back = (s) => { state.set(s); badStale = true; };
  const remember = () => { history.push(snap()); if (history.length > 800) history.shift(); future.length = 0; };
  const put = (k, val) => {
    if (state[k] === val) return false;
    if (val === YES) moves += 1;                     // 一条边一次落子；擦除与改画都不退款
    state[k] = val;
    badStale = true;
    return true;
  };
  const drawn = () => completeOf(state);
  let badStale = true;
  let badCache = [];
  const badCells = () => {
    if (!badStale) return badCache;
    const bad = [];
    const g = clueGrid(n, clues);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const need = g[j * n + i];
      if (need < 0) continue;
      const yes = cellEdges(n, i, j).filter((k) => state[k] === YES);
      if (yes.length > need) for (const k of yes) bad.push(edgeOfIndex(n, k));
    }
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const yes = vertexEdges(n, i, j).filter((k) => state[k] === YES);
      if (yes.length > 2) for (const k of yes) bad.push(edgeOfIndex(n, k));
    }
    const seen = new Set();
    badCache = bad.filter(([x, y]) => { const t = x + ',' + y; if (seen.has(t)) return false; seen.add(t); return true; });
    badStale = false;
    return badCache;
  };

  return {
    spec,
    step: 1,                                        // 键盘光标一次挪半格：目标是一条边
    board: { cols: n, rows: n, margin: { l: 0, t: 0, r: 0, b: 0 } },

    down(hx, hy, btn) {
      if (locked || !isEdge(hx, hy)) return false;
      const k = indexOfHalf(n, hx, hy);
      remember();
      if (btn === 1) return put(k, state[k] === NO ? UNKNOWN : NO);
      return put(k, state[k] === YES ? UNKNOWN : YES);
    },
    move(hx, hy) {
      if (locked || !isEdge(hx, hy)) return false;
      const k = indexOfHalf(n, hx, hy);
      if (state[k] === YES) return false;            // 拖回已画的边不另收
      remember();
      return put(k, YES);
    },
    up() { return false; },

    undo() { if (!history.length) return false; future.push(snap()); back(history.pop()); locked = false; return true; },
    redo() { if (!future.length) return false; history.push(snap()); back(future.pop()); return true; },
    canUndo() { return history.length > 0; },
    canRedo() { return future.length > 0; },

    hint() {
      // 在当前墨迹下求一条相容的解，先给"该画却没画"的边；画满了就给"该封"的边
      const sol = solveOne(spec, state);
      if (!sol) return null;
      const on = new Set(sol);
      let k = -1;
      for (let i = 0; i < total; i++) if (on.has(i) && state[i] !== YES) { k = i; break; }
      if (k < 0) for (let i = 0; i < total; i++) if (!on.has(i) && state[i] !== NO) { k = i; break; }
      if (k < 0) return null;
      remember();
      const val = on.has(k) ? YES : NO;
      put(k, val);
      if (validateIndices(drawn(), n, clues)) locked = true;
      const [hx, hy] = edgeOfIndex(n, k);
      return { cells: [[hx, hy]], note: val === YES ? '这条边非画不可 —— 数字只剩这一种摆法' : '这条边不在环上' };
    },

    solved() { return drawn().length > 0 && validateIndices(drawn(), n, clues) && (locked = true); },
    stats() { return { moves, par, done: drawn().length, total: par }; },

    badCells,

    draw(ctx, v, now) {
      const cell = v.cell;
      paper(ctx, 0, 0, v.w, v.h);
      ctx.save();
      ctx.strokeStyle = rgba(T.rule, 0.45);
      ctx.lineWidth = 1 / v.dpr;
      for (let i = 0; i <= n; i++) {
        ctx.beginPath();
        ctx.moveTo(v.ox + i * cell, v.oy);
        ctx.lineTo(v.ox + i * cell, v.oy + n * cell);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(v.ox, v.oy + i * cell);
        ctx.lineTo(v.ox + n * cell, v.oy + i * cell);
        ctx.stroke();
      }
      ctx.restore();
      const bad = new Set(badCells().map(([x, y]) => x + ',' + y));
      for (let k = 0; k < total; k++) {
        if (state[k] === UNKNOWN) continue;
        const [hx, hy] = edgeOfIndex(n, k);
        const p = halfPoint(v, hx, hy);
        const horiz = isHEdge(hx, hy);
        const len = cell * 0.82;
        ctx.save();
        ctx.lineCap = 'round';
        if (state[k] === NO) {
          ctx.strokeStyle = T.inkFaint;
          ctx.lineWidth = Math.max(1, cell * 0.05);
        } else {
          ctx.strokeStyle = bad.has(hx + ',' + hy) ? T.warn : T.accent;
          ctx.lineWidth = Math.max(2.4, cell * 0.14);
        }
        ctx.beginPath();
        if (horiz) { ctx.moveTo(p.x - len / 2, p.y); ctx.lineTo(p.x + len / 2, p.y); }
        else { ctx.moveTo(p.x, p.y - len / 2); ctx.lineTo(p.x, p.y + len / 2); }
        ctx.stroke();
        ctx.restore();
      }
      const g = clueGrid(n, clues);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const need = g[j * n + i];
        if (need < 0) continue;
        const p = cellCenter(v, i, j);
        let yes = 0;
        for (const k of cellEdges(n, i, j)) if (state[k] === YES) yes++;
        label(ctx, String(need), p.x, p.y, {
          size: cell * 0.44,
          color: yes > need ? T.warn : yes === need ? T.good : T.ink,
          bold: true,
        });
      }
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const d = vertexEdges(n, i, j).reduce((a, k) => a + (state[k] === YES ? 1 : 0), 0);
        ctx.fillStyle = d === 2 ? T.accent : T.ink;
        ctx.beginPath();
        ctx.arc(v.ox + i * cell, v.oy + j * cell, cell * (d === 2 ? 0.075 : 0.048), 0, Math.PI * 2);
        ctx.fill();
      }
      const hv = v.hover;
      if (hv && isEdge(hv.x, hv.y) && state[indexOfHalf(n, hv.x, hv.y)] !== YES && !locked) {
        const p = halfPoint(v, hv.x, hv.y);
        ctx.save();
        ctx.strokeStyle = rgba(T.accent, 0.16 + 0.12 * pulse(now));
        ctx.lineWidth = Math.max(2, cell * 0.12);
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (isHEdge(hv.x, hv.y)) { ctx.moveTo(p.x - cell * 0.41, p.y); ctx.lineTo(p.x + cell * 0.41, p.y); }
        else { ctx.moveTo(p.x, p.y - cell * 0.41); ctx.lineTo(p.x, p.y + cell * 0.41); }
        ctx.stroke();
        ctx.restore();
      }
    },

    celebrate(ctx, v, now, t) {
      this.draw(ctx, v, now);
      const k = easeOut(clamp(t * 1.4, 0, 1));
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

export default {
  id: 'slitherlink',
  title: '圈环',
  latin: 'SLITHERLINK',
  tagline: '数字说：我四条边上有几条环',
  unit: '条',
  rules: [
    '沿点与点之间画线，最后连成一圈不断的环：不分叉、不自交，也不能出现两个小环。',
    '格子里的数字 = 这个格四条边上属于环的条数；没有数字的格不限。',
    '一个点最多挂两条环边：挂满就得把其余方向封掉，大部分推理从这里开始。',
    '副笔在边上点一下表示"这里一定不是环"，记号不计入步数。',
  ],
  sizes: TIERS.map(({ key, label: lb, tier }) => ({ key, label: lb, tier })),
  generate,
  create,
};
