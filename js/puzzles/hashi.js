// 数桥 / Hashi —— 圆盘是岛，盘上的数字是证词："落在我身上的桥头正好这么多个"。
//
// 【坐标约定】本引擎是**格心玩法**：岛与桥的端点一律落在格心，半坐标必是 (奇, 奇)，
// 换算只用 js/core/lattice.js 的 isCell / cellOf / cellAt / cellCenter，`step: 2`。
// `spec.islands` 存的就是半坐标三元组 [hx, hy, clue]（cell 坐标 i=(hx-1)/2），
// clue 为 null 表示这个数字被藏起来了（生成器删线索删掉的，玩家得靠连通性推回来）。
// `spec.n` / `spec.m` 是格数，所以半坐标范围 1..2n-1 × 1..2m-1。validate() 认的就是这套。
//
// 【走法】按住岛 A → 拖过沿途的格子 → 抬手在岛 B 上 = 搭一根桥（一次 moves）。
// 途中的 move 只更新预览，绝不定桥；抬手才结算。副笔（btn 1）打记号，不计 moves：
// 点在空水上 = "这条道一定不搭桥"，点在岛上 = "这座岛已经凑齐"。
//
// 三件套与圈环同立场，缺一不可：
//   · propagate() —— 人用的那几条：数字满了就封其余、缺口正好等于剩下的道数就全搭
//     （缺口正好是两倍就全搭双桥）、数字 1 的岛挂不起双桥、定成双桥的道把两端其余道全封、
//     十字相交的两条道只能有一个走水。从空盘推到不动点，推完整盘就"唯一解"被推理链证明了。
//   · countSolutions() —— 传播之上做有界回溯，每条道试 {0,1,2} 三态，数到 cap 早停；
//     没数完一律 capped=true。生成器只认 count===1 && !capped，求解器不许说谎。
//   · validate() —— 独立于上面两者，直接从规则写：每对端点是不是合法道（同排同列、
//     中间不隔岛、最多两根、不许十字相交）、每座岛的桥头数对不对、图是不是**一张**。
//     最后一条是数桥最经典的坑：数字全对却分成两堆，只有连通性能把它拦下来。
//
// 出题：撒岛（3×3 排除格，隔得开才看得清）→ 造候选道 → 长一棵不交叉的随机生成树打底
// （保证连通）→ 再挑几条道加单桥/双桥 → 数出每座岛的桥头数当题面 → 贪心删线索，
// 每删一条都要求 countSolutions 仍然证明唯一解。随机全部来自 rngFrom(seed)，同种子同尺寸
// 在任何设备上是同一道题；候选全用光也交得出题（沿上边与右边排一条岛链，唯一性是白给的）。

import { rngFrom } from '../core/rng.js';
import { T } from '../core/theme.js';
import { paper, label, rgba, pulse, easeOut, clamp } from '../core/paper.js';
import { isCell, cellOf, cellAt, cellCenter, halfPoint } from '../core/lattice.js';

// 一条道的三态：UNKNOWN 是"还没定"，CLOSED 是"确定不搭"，SINGLE/DOUBLE 是搭了几根
export const UNKNOWN = -1;
export const CLOSED = 0;
export const SINGLE = 1;
export const DOUBLE = 2;

export const MAX_CLUE = 8;                             // 四向 × 双桥
const HALF = 1024;                                     // 坐标/索引打包用的底数
const key = (hx, hy) => hy * HALF + hx;
const pairKey = (a, b) => (a < b ? a * HALF + b : b * HALF + a);

// ---------------------------------------------------------------------------
// 几何：候选道、道的中间格、道的两两交叉
// ---------------------------------------------------------------------------

// 候选道只由岛位决定，删线索的循环会反复拿到同一套岛位，所以按岛位签名缓存一份几何。
// 缓存是纯函数的 memo，不影响确定性。
const GEO_CACHE = new Map();

const signatureOf = (spec) => (spec.islands || []).map(([x, y]) => x + ':' + y).join('|');

export function geomOf(spec) {
  const sig = signatureOf(spec);
  const hit = GEO_CACHE.get(sig);
  if (hit && hit.n === spec.n && (hit.m === (spec.m == null ? spec.n : spec.m))) return hit;
  const built = buildGeom(spec);
  if (!built) return null;
  if (GEO_CACHE.size > 24) GEO_CACHE.clear();
  GEO_CACHE.set(sig, built);
  return built;
}

function buildGeom(spec) {
  const n = spec.n;
  const m = spec.m == null ? spec.n : spec.m;
  const isl = spec.islands || [];
  const K = isl.length;
  if (!K || !n || !m) return null;
  const byPos = new Map();                             // 半坐标 key → 岛序号
  const rows = new Map();                              // hy → [岛序号]（按 hx 排）
  const cols = new Map();                              // hx → [岛序号]（按 hy 排）
  for (let p = 0; p < K; p++) {
    const [hx, hy] = isl[p];
    if (!isCell(hx, hy)) return null;                  // 岛必须在格心，本引擎不认别的落点
    if (hx < 1 || hy < 1 || hx > 2 * n - 1 || hy > 2 * m - 1) return null;
    const kk = key(hx, hy);
    if (byPos.has(kk)) return null;
    byPos.set(kk, p);
    (rows.get(hy) || setMap(rows, hy, [])).push(p);
    (cols.get(hx) || setMap(cols, hx, [])).push(p);
  }
  for (const list of rows.values()) list.sort((a, b) => isl[a][0] - isl[b][0]);
  for (const list of cols.values()) list.sort((a, b) => isl[a][1] - isl[b][1]);

  const lanes = [];
  const laneOfPair = new Map();
  const cellLanes = new Map();                         // 中间格 key → [道序号]（交叉格会有两条）
  const addLane = (a, b, horiz) => {
    const [ax, ay] = isl[a];
    const [bx, by] = isl[b];
    const fixed = horiz ? ay : ax;
    const lo = horiz ? Math.min(ax, bx) : Math.min(ay, by);
    const hi = horiz ? Math.max(ax, bx) : Math.max(ay, by);
    if (hi - lo < 2) return;
    // 同排同列但中间隔着岛 —— 那不是道，谁也看不见谁
    for (let t = lo + 2; t < hi; t += 2) {
      const c = horiz ? key(t, fixed) : key(fixed, t);
      if (byPos.has(c)) return;
    }
    const cells = [];
    for (let t = lo + 2; t < hi; t += 2) {
      const c = horiz ? key(t, fixed) : key(fixed, t);
      cells.push(horiz ? [t, fixed] : [fixed, t]);
      (cellLanes.get(c) || setMap(cellLanes, c, [])).push(lanes.length);
    }
    const idx = lanes.length;
    lanes.push({
      a, b, horiz, fixed, lo, hi, cells, idx,
      mid: cells.length ? cells[(cells.length - 1) >> 1] : [isl[b][0], isl[b][1]],
    });
    laneOfPair.set(pairKey(a, b), idx);
  };
  for (const list of rows.values()) for (let t = 0; t + 1 < list.length; t++) addLane(list[t], list[t + 1], true);
  for (const list of cols.values()) for (let t = 0; t + 1 < list.length; t++) addLane(list[t], list[t + 1], false);
  if (!lanes.length) return null;

  const islandLanes = [];
  for (let p = 0; p < K; p++) islandLanes.push([]);
  for (const lane of lanes) { islandLanes[lane.a].push(lane.idx); islandLanes[lane.b].push(lane.idx); }

  // 方向索引：按住一座岛往某个方向拖，唯一可能的道就是"这个方向上第一座岛"那条
  const dirs = [];
  for (let p = 0; p < K; p++) dirs.push({ h1: -1, hm1: -1, v1: -1, vm1: -1 });
  for (const lane of lanes) {
    const [ax, ay] = isl[lane.a];
    const [bx, by] = isl[lane.b];
    const put = (p, q) => {
      const [px, py] = isl[p];
      const [qx, qy] = isl[q];
      // 竖道要按 y 比方向：只看 x 的话两端恒等，s 永远是 -1，一半的桥从这头拖不出去
      const s = lane.horiz ? (qx > px ? 1 : -1) : (qy > py ? 1 : -1);
      dirs[p][lane.horiz ? (s > 0 ? 'h1' : 'hm1') : (s > 0 ? 'v1' : 'vm1')] = lane.idx;
    };
    put(lane.a, lane.b);
    put(lane.b, lane.a);
  }

  // 十字相交：一横一竖两条道，各自的内部区段在某个空格心上撞上
  const cross = lanes.map(() => []);
  for (let u = 0; u < lanes.length; u++) {
    for (let w = u + 1; w < lanes.length; w++) {
      const A = lanes[u];
      const B = lanes[w];
      if (A.horiz === B.horiz) continue;
      const H = A.horiz ? A : B;
      const V = A.horiz ? B : A;
      if (H.fixed > V.lo && H.fixed < V.hi && V.fixed > H.lo && V.fixed < H.hi) {
        cross[u].push(w);
        cross[w].push(u);
      }
    }
  }

  return {
    n, m, K, lanes, islandLanes, cross, dirs, byPos, laneOfPair, cellLanes,
    pos: isl.map(([x, y]) => [x, y]),
  };
}

function setMap(map, k, v) { map.set(k, v); return v; }

// 题面数字单独放一份：删线索时只改它，几何不动
function modelOf(spec, geom = null) {
  const g = geom || geomOf(spec);
  if (!g) return null;
  const clue = new Int16Array(g.K).fill(-1);
  for (let p = 0; p < g.K; p++) {
    const c = spec.islands[p][2];
    if (c != null) clue[p] = c;
  }
  return { geom: g, clue };
}

const isModel = (x) => !!x && !!x.geom && Array.isArray(x.geom.lanes);

export const candidatePairs = (spec) => {
  const g = geomOf(spec);
  return g ? g.lanes.map((lane) => [lane.a, lane.b]) : [];
};

export const islandAt = (spec, hx, hy) => {
  const g = geomOf(spec);
  if (!g) return -1;
  const p = g.byPos.get(key(hx, hy));
  return p === undefined ? -1 : p;
};

// 状态 → 桥的多重集（岛序号对；双桥出现两次）
export function bridgeListOf(geom, state) {
  const out = [];
  for (const lane of geom.lanes) {
    const v = state[lane.idx];
    for (let t = 0; t < v; t++) out.push([lane.a, lane.b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 独立校验：直接从规则写，不看求解器一眼
// ---------------------------------------------------------------------------

export function validate(spec, bridges) {
  const isl = spec && spec.islands;
  if (!isl || !isl.length || !Array.isArray(bridges)) return false;
  const K = isl.length;
  const n = spec.n;
  const m = spec.m == null ? spec.n : spec.m;
  const at = new Map();
  for (let p = 0; p < K; p++) {
    const hx = isl[p][0];
    const hy = isl[p][1];
    if (!isCell(hx, hy)) return false;                 // 格心玩法：岛只可能在 (奇, 奇)
    if (hx < 1 || hy < 1 || hx > 2 * n - 1 || hy > 2 * m - 1) return false;
    if (at.has(key(hx, hy))) return false;
    at.set(key(hx, hy), p);
  }
  const mult = new Map();
  const used = [];
  for (const br of bridges) {
    const a = br[0];
    const b = br[1];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 0 || b < 0 || a >= K || b >= K) return false;
    const [ax, ay] = isl[a];
    const [bx, by] = isl[b];
    let horiz;
    let fixed;
    let lo;
    let hi;
    if (ay === by) { horiz = true; fixed = ay; lo = Math.min(ax, bx); hi = Math.max(ax, bx); }
    else if (ax === bx) { horiz = false; fixed = ax; lo = Math.min(ay, by); hi = Math.max(ay, by); }
    else return false;                                 // 斜着不叫桥
    if (hi - lo < 2) return false;
    for (let t = lo + 2; t < hi; t += 2) if (at.has(horiz ? key(t, fixed) : key(fixed, t))) return false;
    const pk = pairKey(a, b);
    const c = (mult.get(pk) || 0) + 1;
    if (c > 2) return false;                           // 一对岛最多两根平行桥
    if (c === 1) used.push({ horiz, fixed, lo, hi });
    mult.set(pk, c);
  }
  for (let u = 0; u < used.length; u++) {
    for (let w = u + 1; w < used.length; w++) {
      const A = used[u];
      const B = used[w];
      if (A.horiz === B.horiz) continue;
      const H = A.horiz ? A : B;
      const V = A.horiz ? B : A;
      if (H.fixed > V.lo && H.fixed < V.hi && V.fixed > H.lo && V.fixed < H.hi) return false;
    }
  }
  const ends = new Int16Array(K);
  for (const [pk, c] of mult) {
    ends[Math.floor(pk / HALF)] += c;
    ends[pk % HALF] += c;                              // 双桥对两端各算两个桥头
  }
  for (let p = 0; p < K; p++) {
    const clue = isl[p][2];
    if (clue != null && ends[p] !== clue) return false;
  }
  const adj = new Map();
  for (const pk of mult.keys()) {
    const a = Math.floor(pk / HALF);
    const b = pk % HALF;
    (adj.get(a) || setMap(adj, a, [])).push(b);
    (adj.get(b) || setMap(adj, b, [])).push(a);
  }
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const v = stack.pop();
    for (const w of adj.get(v) || []) if (!seen.has(w)) { seen.add(w); stack.push(w); }
  }
  return seen.size === K;                              // 全部岛必须连成一张
}

// ---------------------------------------------------------------------------
// 规则传播
// ---------------------------------------------------------------------------

function assign(state, model, k, val) {
  const cur = state[k];
  if (cur === val) return true;
  if (cur !== UNKNOWN) return false;
  if (val === DOUBLE) {                                // 数字 1 的岛挂不起双桥
    const lane = model.geom.lanes[k];
    if (model.clue[lane.a] === 1 || model.clue[lane.b] === 1) return false;
  }
  state[k] = val;
  return true;
}

// 推到不动点；返回 false 表示这盘墨迹与题面矛盾。
// 用的每一条都必须"砍不掉任何真解"，否则唯一性证明就是假的：
//   · 缺口为 0 → 其余道全封。
//   · 每条道有个余量 cap：未定的道最多 2；已经搭了一根的道还能再吃一根（→双桥）；
//     哪座端点岛只剩一个桥头，它名下未定的道就搭不起第二根（"数字 1 的岛挂不起双桥"是推论）。
//   · 缺口正好等于各道余量之和 → 每道都顶到余量：未定的顶到 cap，单桥的长成双桥。
//     注意：缺口等于剩下的道数**不**能定案 —— 3 个缺口摊在 3 条道上还可以是 2+1+0。
//   · 缺口超过余量之和 → 矛盾。
//   · 一条道搭上桥，与它十字相交的道全封；两边都搭上 → 矛盾。
//     道定成双桥把两端其余道全封，就是"缺口归零 → 全封"这条规则的下一轮产物。
//   · 数字被藏起来的岛也归连通性管：它所有道都封死 = 孤岛，矛盾。
export function propagate(state, specOrModel) {
  const model = isModel(specOrModel) ? specOrModel : modelOf(specOrModel);
  if (!model) return false;
  const g = model.geom;
  const clue = model.clue;
  const L = g.lanes.length;
  // 这座岛此刻还欠几个桥头。必须现算：这一轮的赋值会改到邻岛共用的那条道，
  // 拿轮首缓存的缺口去判下一条规则，会把可满足的盘面说成矛盾（countSolutions 交出 0 个解）。
  const needAt = (p) => {
    const want = clue[p];
    if (want < 0) return -1;                            // 藏了数字的岛没有缺口这回事
    const ls = g.islandLanes[p];
    let sum = 0;
    for (let t = 0; t < ls.length; t++) {
      const v = state[ls[t]];
      if (v !== UNKNOWN) sum += v;
    }
    return want - sum;
  };
  // 这根单桥还长得出第二根：两端此刻都还欠着桥头。有一端已经凑齐数字，这根就封顶了。
  const mayGrow = (k) => {
    const lane = g.lanes[k];
    return needAt(lane.a) !== 0 && needAt(lane.b) !== 0;
  };
  // 一条未定的道最多还能扛几根桥头（同样现算，端点凑齐了就是 0）
  const capOf = (k) => {
    const lane = g.lanes[k];
    let c = 2;
    for (const p of [lane.a, lane.b]) {
      const nd = needAt(p);
      if (nd === 0) return 0;
      if (nd === 1) c = 1;                              // 只剩一个桥头：谁也别想搭双
    }
    return c;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let p = 0; p < g.K; p++) {
      const ls = g.islandLanes[p];
      if (clue[p] < 0) {
        if (g.K > 1 && ls.every((k) => state[k] === CLOSED)) return false;
        continue;
      }
      if (needAt(p) < 0) return false;                  // 桥头数已经超了证词
    }
    for (let p = 0; p < g.K; p++) {
      if (clue[p] < 0) continue;                        // 藏了数字的岛不归这里管
      const need = needAt(p);
      const ls = g.islandLanes[p];
      let room = 0;
      let unk = 0;
      for (let t = 0; t < ls.length; t++) {
        const k = ls[t];
        const v = state[k];
        // 单桥不是终局：把"还能再加一根"漏掉，等于把画到一半的双桥当成填不满缺口的矛盾，
        // solveOne 带着这种合法墨迹直接返回 null，提示跟着哑火。
        if (v === UNKNOWN) { unk++; room += capOf(k); }
        else if (v === SINGLE && mayGrow(k)) room += 1;
      }
      if (need < 0) return false;
      if (need === 0) {
        if (!unk) continue;
        for (let t = 0; t < ls.length; t++) {
          const k = ls[t];
          if (state[k] === UNKNOWN) { if (!assign(state, model, k, CLOSED)) return false; changed = true; }
        }
        continue;
      }
      if (need > room) return false;                     // 剩下的道填不满缺口
      if (need === room) {                               // 每道余量都得顶满，一颗不剩
        for (let t = 0; t < ls.length; t++) {
          const k = ls[t];
          if (state[k] === UNKNOWN) {
            const c = capOf(k);
            if (c === 0) { if (!assign(state, model, k, CLOSED)) return false; changed = true; }
            else if (!assign(state, model, k, c === 1 ? SINGLE : DOUBLE)) return false;
            else changed = true;
          } else if (state[k] === SINGLE && mayGrow(k)) {
            state[k] = DOUBLE;
            changed = true;
          }
        }
      }
    }
    for (let k = 0; k < L; k++) {
      if (state[k] <= 0) continue;                       // 搭了桥才占用水面
      const cs = g.cross[k];
      for (let t = 0; t < cs.length; t++) {
        const o = cs[t];
        if (state[o] === UNKNOWN) { state[o] = CLOSED; changed = true; }
        else if (state[o] > 0) return false;             // 十字相交的两根桥
      }
    }
  }
  return true;
}

// 纯逻辑一遍推到底；推不完返回 null（说明这题不是纯推理能做出来的，与唯一性无关）
export function logicSolve(spec, given = null) {
  const model = modelOf(spec);
  if (!model) return null;
  const L = model.geom.lanes.length;
  const state = given ? Int8Array.from(given) : new Int8Array(L).fill(UNKNOWN);
  if (!propagate(state, model)) return null;
  for (let k = 0; k < L; k++) if (state[k] === UNKNOWN) return null;
  const bridges = bridgeListOf(model.geom, state);
  return validate(spec, bridges) ? { state, bridges } : null;
}

// ---------------------------------------------------------------------------
// 有界回溯：数解、找一条解
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET = 4000;

function pickLane(state, model) {
  const g = model.geom;
  let best = -1;
  let bestScore = Infinity;
  for (let k = 0; k < g.lanes.length; k++) {
    if (state[k] !== UNKNOWN) continue;
    const lane = g.lanes[k];
    let score = 0;
    for (const p of [lane.a, lane.b]) {
      const ls = g.islandLanes[p];
      for (let t = 0; t < ls.length; t++) if (state[ls[t]] === UNKNOWN) score++;
    }
    if (score < bestScore) { bestScore = score; best = k; }
  }
  return best;
}

// 已经定下来的桥不许把岛封成孤岛：一座岛（或几座岛连成的小块）所有出水的道都被封死，
// 而全盘还没连成一张 —— 这条分支不可能再通了
function sealedOff(state, model) {
  const g = model.geom;
  const parent = new Int16Array(g.K);
  for (let p = 0; p < g.K; p++) parent[p] = p;
  const root = (p) => { while (parent[p] !== p) { parent[p] = parent[parent[p]]; p = parent[p]; } return p; };
  for (const lane of g.lanes) {
    if (state[lane.idx] > 0) {
      const ra = root(lane.a);
      const rb = root(lane.b);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const size = new Int16Array(g.K);
  const escape = new Uint8Array(g.K);
  for (let p = 0; p < g.K; p++) size[root(p)]++;
  for (const lane of g.lanes) {
    if (state[lane.idx] !== UNKNOWN) continue;
    escape[root(lane.a)] = 1;
    escape[root(lane.b)] = 1;
  }
  for (let p = 0; p < g.K; p++) if (parent[p] === p && size[p] && size[p] < g.K && !escape[p]) return true;
  return false;
}

function expandSearch(model, spec, cap, budget, seedState) {
  const g = model.geom;
  const L = g.lanes.length;
  // 这根桥还长得出第二根：两端数字不是 1（1 的岛挂不起双桥）。
  // 剩下的账（超数、十字相交、孤岛）交给 propagate 在下一层去算，这里只挡明显白跑的分支。
  const canGrow = (k) => {
    const lane = g.lanes[k];
    return model.clue[lane.a] !== 1 && model.clue[lane.b] !== 1;
  };
  let found = 0;
  let nodes = 0;
  let truncated = false;
  // 只有"玩家亲手拖上去的那一根"还留着长双桥的余地。搜索自己定下的 SINGLE 已经是
  // 这一支的结论，再替它开生长分支会把同一个解从两条路径上数两遍 —— 唯一解题立刻被误判成多解。
  const inked = new Uint8Array(L);
  if (seedState) for (let k = 0; k < L; k++) if (seedState[k] === SINGLE) inked[k] = 1;
  const states = [];
  // 两条搜索路径可能收敛到同一个终局（把一根道定成单桥，传播再替它长成双桥，
  // 与直接定成双桥是同一个盘面）。数解数的是"解的种类"，不是走到叶子的路径条数 ——
  // 不去重的话唯一解会被数成多解，出题闸门就把好题面全拒了。
  const seen = new Set();
  const keyOf = (st) => {
    let s = '';
    for (let k = 0; k < L; k++) s += String.fromCharCode(st[k] + 5);
    return s;
  };
  const walk = (st, from) => {
    if (found >= cap) return;
    if (++nodes > budget) { truncated = true; return; }
    if (!propagate(st, model)) return;
    const pick = pickLane(st, model);
    if (pick < 0) {
      const list = bridgeListOf(g, st);
      if (list.length && validate(spec, list)) {
        const key = keyOf(st);
        if (!seen.has(key)) {
          seen.add(key);
          found++;
          if (states.length < cap) states.push(Int8Array.from(st));
        }
      }
      // 墨迹里的单桥是"至少一根"而不是"只许一根"：答案要双桥时，玩家先拖了一根
      // 是合法局面。把它当封顶，solveOne 带着这种墨迹返回 null，提示就地哑火。
      // 从 from 往后开分支，保证同一堆生长组合只被走一遍。
      for (let k = from; k < L; k++) {
        if (!inked[k] || st[k] !== SINGLE || !canGrow(k)) continue;
        if (found >= cap) return;
        const next = Int8Array.from(st);
        next[k] = DOUBLE;
        walk(next, k + 1);
      }
      return;
    }
    const lane = g.lanes[pick];
    const canDouble = model.clue[lane.a] !== 1 && model.clue[lane.b] !== 1;
    for (const val of canDouble ? [SINGLE, CLOSED, DOUBLE] : [SINGLE, CLOSED]) {
      if (found >= cap) return;
      const next = Int8Array.from(st);
      next[pick] = val;
      if (sealedOff(next, model)) continue;
      walk(next, 0);
    }
  };
  walk(seedState ? Int8Array.from(seedState) : new Int8Array(L).fill(UNKNOWN), 0);
  return { count: found, capped: truncated || found >= cap, states, nodes };
}

// 数到 cap 就停。capped 只说真话：没数完一律 true（哪怕只数出一个解）
export function countSolutions(spec, cap = 2, seedState = null, budget = DEFAULT_BUDGET) {
  const model = modelOf(spec);
  if (!model) return { count: 0, capped: true, states: [], nodes: 0 };
  return expandSearch(model, spec, cap, budget, seedState);
}

// 找一条与现有墨迹相容的解（提示用，不管唯一性）
export function solveOne(spec, seedState = null, budget = DEFAULT_BUDGET) {
  const model = modelOf(spec);
  if (!model) return null;
  const r = expandSearch(model, spec, 1, budget, seedState);
  return r.count ? r.states[0] : null;
}

// ---------------------------------------------------------------------------
// 出题
// ---------------------------------------------------------------------------

const TIERS = [
  { key: 7, label: '7×7', tier: '入门', islands: [11, 13], extra: 0.5 },
  { key: 9, label: '9×9', tier: '熟手', islands: [16, 19], extra: 0.6 },
  { key: 11, label: '11×11', tier: '挑战', islands: [21, 25], extra: 0.7 },
];

const tierOf = (n) => TIERS.find((t) => t.key === n) || {
  key: n, label: n + '×' + n, tier: '自定义',
  islands: [Math.max(6, Math.round(n * n * 0.2)), Math.max(7, Math.round(n * n * 0.24))],
  extra: 0.6,
};

// 撒岛：长一张"岛网格"。先落一座岛，然后要么在已有的行/列交点上空位补岛，
// 要么把行线/列线往外推一条（推 2~4 格，隔开才画得下双桥，中间那格自然空着）。
// 为什么要成网格而不是散点：候选道数 = 2×岛数 − 用掉的行数 − 用掉的列数，
// 散点的行列各用掉一大把，道数刚刚够长一棵树，桥上无处落子（盘面上全是 1、2）；
// 网格把岛挤进少数几条行列，交点彼此看得见，环和双桥才长不出来才怪。
// 每条新线都立刻与旧线交个点，每座新岛都同排同列连着已有岛 —— 候选图天生连通。
function scatterIslands(rng, n, m, lo, hi) {
  const target = rng.range(lo, hi);
  const taken = new Set();
  const placed = [];
  const rows = [];
  const cols = [];
  const add = (i, j) => { taken.add(i * HALF + j); placed.push([i, j]); };
  // 这个空位能从几个方向看见已有岛（0 = 孤岛，1 = 一条藤，2 = 十字路口）。
  // 顺手记一下它是不是"四面被夹"：这种位子一旦填上，横竖两条长桥就再也撞不到一起，
  // 盘面上不会有十字冲突，"桥不能相交"这条规则等于白写 —— 洞要故意留在网眼里。
  const seenFrom = (i, j) => {
    let mask = 0;
    for (const [pi, pj] of placed) {
      if (pj === j) { if (pi < i) mask |= 1; else if (pi > i) mask |= 2; }
      else if (pi === i) { if (pj < j) mask |= 4; else if (pj > j) mask |= 8; }
    }
    const cnt = (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 1 : 0) + (mask & 8 ? 1 : 0);
    const pinned = (mask & 3) === 3 && (mask & 12) === 12;
    return { cnt, rank: pinned ? 0 : cnt >= 2 ? 2 : 1 };
  };
  // 新线：离所有已有线至少 2 格，不然两岛之间没有一格水面，桥架不下去
  const newLines = (list, span) => {
    const out = [];
    for (const anchor of list) {
      for (const d of [-4, -3, -2, 2, 3, 4]) {
        const v = anchor + d;
        if (v < 0 || v >= span || list.indexOf(v) >= 0) continue;
        if (list.some((q) => Math.abs(q - v) < 2)) continue;
        out.push(v);
      }
    }
    return out;
  };
  add(rng.int(n), rng.int(m));
  rows.push(placed[0][1]);
  cols.push(placed[0][0]);
  while (placed.length < target) {
    const fills = [];
    const rank = [];
    for (const r of rows) {
      for (const c of cols) {
        if (taken.has(c * HALF + r)) continue;
        const seen = seenFrom(c, r);
        if (!seen.cnt) continue;
        fills.push([c, r]);
        rank.push(seen.rank);
      }
    }
    // 网格填得太满 = 没有空格心 = 横桥竖桥永远撞不上，"不能十字相交"这条规则
    // 就成了一句空话。岛数一超过格子的七成，就先往外推线，把洞留在网眼里。
    const capacity = rows.length * cols.length;
    const crowded = placed.length + 1 > capacity * 0.7;
    const nr = crowded ? newLines(rows, m) : [];
    const nc = crowded ? newLines(cols, n) : [];
    if (nr.length || nc.length) {
      const horizontal = nr.length ? (nc.length ? rng() < 0.5 : true) : false;
      const list = horizontal ? rows : cols;
      const span = horizontal ? nr : nc;
      const v = rng.pick(span);
      list.push(v);
      // 新线立刻与旧线交一座岛，否则它就是条白画的辅助线
      const at = rng.pick(horizontal ? cols : rows);
      if (horizontal) add(at, v); else add(v, at);
      continue;
    }
    if (!fills.length) break;
    let best = 0;
    for (const s of rank) if (s > best) best = s;
    const pool = [];
    for (let t = 0; t < fills.length; t++) if (rank[t] >= Math.min(2, best)) pool.push(fills[t]);
    const [i, j] = rng.pick(pool);
    add(i, j);
  }
  return placed.length >= 6 ? placed : null;
}

function connectedOver(geom, laneOk) {
  const g = geom;
  const adj = [];
  for (let p = 0; p < g.K; p++) adj.push([]);
  for (const lane of g.lanes) if (laneOk(lane.idx)) { adj[lane.a].push(lane.b); adj[lane.b].push(lane.a); }
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const v = stack.pop();
    for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); stack.push(w); }
  }
  return seen.size === g.K;
}

// 随机 Prim 长一棵互不交叉的生成树：天生连通，数字与桥都从它身上长出来。
// 每次优先挑"交叉最少"的道 —— 占道越少，剩下没连进来的岛越有机会找到出口，
// 否则树会长到一半被自己的桥封死（这在 11×11 上是常态）。
function growTree(geom, rng) {
  const count = new Int8Array(geom.lanes.length);
  const taken = new Uint8Array(geom.lanes.length);
  const ends = new Int16Array(geom.K);
  const group = new Uint8Array(geom.K);
  group[rng.int(geom.K)] = 1;
  let have = 1;
  const open = [];
  while (have < geom.K) {
    open.length = 0;
    for (const lane of geom.lanes) {
      if (count[lane.idx] || taken[lane.idx]) continue;
      if (group[lane.a] + group[lane.b] === 1) open.push(lane);
    }
    if (!open.length) return null;
    open.sort((A, B) => (geom.cross[A.idx].length - geom.cross[B.idx].length) || (A.idx - B.idx));
    const pick = open[rng.int(Math.min(open.length, 1 + rng.int(3)))];
    count[pick.idx] = 1;
    taken[pick.idx] = 1;
    for (const o of geom.cross[pick.idx]) taken[o] = 1;
    ends[pick.a] += 1;
    ends[pick.b] += 1;
    group[pick.a] = 1;
    group[pick.b] = 1;
    have++;
  }
  return { count, taken, ends };
}

// 一块候选布局：生成树打底（保证连通），再挑道加单桥/双桥。
// gate(probeSpec) 是生成器递进来的"加完这根桥，全数字题面还立得住吗"，不传就随便加。
// 这根闸门不能省：环一多，全数字本身就可能有两个解（同一个矩形，双桥摆哪条边都行），
// 那种料后面删什么线索都救不回来，趁早在这里就别加这根桥。
function makeLayout(rng, n, m, gate) {
  const tier = tierOf(n);
  const cells = scatterIslands(rng, n, m, tier.islands[0], tier.islands[1]);
  if (!cells) return null;
  const pos = cells.map(([i, j]) => cellAt(i, j));      // 从这里往下全是半坐标
  const spec = { n, m, islands: pos.map(([x, y]) => [x, y, null]) };
  const geom = geomOf(spec);
  if (!geom) return null;
  if (!connectedOver(geom, () => true)) return null;   // 候选图本身就不连通，直接重投

  let tree = null;
  for (let t = 0; t < 5 && !tree; t++) tree = growTree(geom, rng);
  if (!tree) return null;
  const { count, taken, ends } = tree;

  // 加料：补单桥与双桥，凑够桥数。双桥有配额（全是双桥的盘不好玩），
  // 而且每加一根都要过一遍 gate —— 加了就把纯逻辑推不通的料宁可不要，
  // 这样"题面全数字"本身仍是推理链推得完的，往上的删线索才有底子可删。
  const want = Math.min(geom.lanes.length, Math.round(geom.K * (1 + tier.extra)));
  const order = rng.shuffle(geom.lanes.map((lane) => lane.idx));
  let bridges = geom.K - 1;
  let doubles = 0;
  const probe = { n, m, islands: pos.map((q, p) => [q[0], q[1], ends[p]]), candidates: null };
  const keepable = () => {
    if (!gate) return true;
    for (let p = 0; p < ends.length; p++) probe.islands[p][2] = ends[p];
    return gate(probe);
  };
  for (const k of order) {
    if (bridges >= want) break;
    const lane = geom.lanes[k];
    if (count[k] === 2) continue;
    if (count[k] === 0 && taken[k]) continue;          // 与别的桥十字相交，水面已经不给用
    if (ends[lane.a] + 1 > MAX_CLUE || ends[lane.b] + 1 > MAX_CLUE) continue;
    if (count[k] === 1 && doubles + 1 > Math.max(1, Math.round(want * 0.3))) continue;
    const before = count[k];
    count[k] = before + 1;
    ends[lane.a] += 1;
    ends[lane.b] += 1;
    if (!keepable()) {
      count[k] = before;
      ends[lane.a] -= 1;
      ends[lane.b] -= 1;
      continue;
    }
    if (before === 0) { taken[k] = 1; for (const o of geom.cross[k]) taken[o] = 1; }
    else doubles++;
    bridges++;
  }

  const clues = [];
  for (let p = 0; p < geom.K; p++) {
    if (ends[p] < 1 || ends[p] > MAX_CLUE) return null;
    clues.push(ends[p]);
  }
  const bridges2 = [];
  for (const lane of geom.lanes) for (let t = 0; t < count[lane.idx]; t++) bridges2.push([lane.a, lane.b]);
  let singles = 0;
  for (const lane of geom.lanes) if (count[lane.idx] === 1) singles++;
  if (!singles) return null;
  return { geom, n, m, islands: pos.map(([x, y]) => [x, y]), clues, bridges: bridges2, singles };
}

function specWith(base, clues) {
  return {
    n: base.n,
    m: base.m,
    islands: base.islands.map(([x, y], p) => [x, y, clues[p] == null ? null : clues[p]]),
    candidates: base.candidates,
  };
}

function gateOK(spec, budget) {
  const r = countSolutions(spec, 2, null, budget);
  return r.count === 1 && !r.capped;
}

// 加桥闸门两档：
// logicGate —— 全数字题面必须一条推理链推到底（便宜，且推出来的唯一性是白送的）；
// uniqueGate —— 允许环，只要全数字题面"数"得出唯一解。第一档会把大部分环拒掉，
// 盘面于是长成一根藤（数字全是 1、2）；第二档才要得出双桥和环。
const logicGate = (probe) => !!logicSolve(probe);
const uniqueGate = (budget) => (probe) => logicSolve(probe) !== null || gateOK(probe, budget);

// 贪心删线索。两步走：先用纯逻辑当闸门（便宜，而且推理链本身就是唯一性的证明），
// 推不完的题面再用 countSolutions 数一遍 —— 数出来的唯一解照样是证明，只是玩家
// 得自己动点脑筋。两种口径都只接受"数完了且只有一个解"的题面。
function thinClues(rng, base, clues, budget) {
  let cur = clues.slice();
  let spec = specWith(base, cur);
  if (!logicSolve(spec)) {
    const r = countSolutions(spec, 2, null, budget);
    if (r.count !== 1 || r.capped) return null;
  }
  // 第一轮：能纯逻辑推完的删多少删多少
  for (const p of rng.shuffle(cur.map((_, i) => i))) {
    if (cur[p] == null) continue;
    const trial = cur.slice();
    trial[p] = null;
    const ts = specWith(base, trial);
    if (logicSolve(ts)) { cur = trial; spec = ts; }
  }
  if (budget <= 0) return { spec, clues: cur };
  // 第二轮：拿有界回溯当闸门再删一轮，删不动的一律留着
  for (const p of rng.shuffle(cur.map((_, i) => i))) {
    if (cur[p] == null) continue;
    const trial = cur.slice();
    trial[p] = null;
    const ts = specWith(base, trial);
    const r = countSolutions(ts, 2, null, budget);
    if (r.count === 1 && !r.capped) { cur = trial; spec = ts; }
  }
  return { spec, clues: cur };
}

function finishSpec(base, clues) {
  const bridges = base.bridges.map(([a, b]) => [a, b]);
  const spec = specWith(base, clues);
  spec.bridges = bridges;
  spec.par = bridges.length;
  spec.logical = !!logicSolve(spec);
  return spec;
}

function tryBoard(rng, n, m, gate, budget) {
  const layout = makeLayout(rng, n, m, gate);
  if (!layout) return null;
  const base = {
    n: layout.n, m: layout.m, islands: layout.islands,
    candidates: layout.geom.lanes.map((lane) => [lane.a, lane.b]),
    bridges: layout.bridges,
  };
  const thinned = thinClues(rng, base, layout.clues, budget);
  if (!thinned) return null;
  const spec = finishSpec(base, thinned.clues);
  const audit = countSolutions(spec, 2);               // 交卷前再数一次：唯一性必须是数完的
  // 把审计结果随题面交出去：下游（测试、UI 的"这题有人担保过"角标）不必再数一遍，
  // 也不必猜 —— capped 为真就意味着"没数完"，谁拿到都得自己决定信不信。
  spec.count = audit.count;
  spec.capped = audit.capped;
  if (audit.count !== 1 || audit.capped) return null;
  if (!validate(spec, spec.bridges)) return null;      // 求解器与校验器对不上，说明有人撒谎
  return spec;
}

// 兜底：全盘候选只剩两条道 —— 一条单桥、一条双桥，且其中一座岛的数字是 1。
// 为什么它一定唯一：数字 1 的那座岛只有两条道可走，桥数 1 只能落在其中一条上；
// 那条道定成 1 之后，另一条道就凑不够这座岛要的量？不 —— 靠的是另一端的岛：
// 单桥道的两端都是 1，双桥道的两端都是 2，于是每座岛都只剩一条道可走，全推得完。
// 具体形状：四座岛排成"⌐"，两个拐角之间那条道走双桥。画出来正好把 0/1/2 三种
// 桥态都占上，比一整圈边框链更像道题。
function fallbackSpec(n) {
  const m = n;
  const a = cellAt(0, 0);
  const b = cellAt(n - 1, 0);
  const c = cellAt(0, m - 1);
  const d = cellAt(n - 1, m - 1);
  const islands = [a, b, c, d];
  const geom = geomOf({ n, m, islands: islands.map(([x, y]) => [x, y, null]) });
  const lanes = geom.lanes.map((lane) => [lane.a, lane.b]);
  const pick = (x, y) => lanes.find(([p, q]) => (p === x && q === y) || (p === y && q === x));
  const bridges = [pick(0, 1), pick(2, 3), pick(1, 3), pick(1, 3)];
  const ends = new Int16Array(4);
  for (const [p, q] of bridges) { ends[p]++; ends[q]++; }
  const spec = finishSpec({ n, m, islands, candidates: lanes, bridges }, Array.from(ends));
  if (!gateOK(spec, DEFAULT_BUDGET)) return borderChainSpec(n, m);
  return spec;
}

// 兜底的兜底：沿上边 + 右边排一条岛链。候选图本身就是一条路，唯一性是白给的
function borderChainSpec(n, m) {
  const cells = [];
  for (let i = 0; i < n; i += 2) cells.push([i, 0]);
  if (cells[cells.length - 1][0] !== n - 1) cells.push([n - 1, 0]);
  for (let j = 2; j < m; j += 2) cells.push([n - 1, j]);
  if (cells[cells.length - 1][1] !== m - 1) cells.push([n - 1, m - 1]);
  const islands = cells.map(([i, j]) => cellAt(i, j));
  const geom = geomOf({ n, m, islands: islands.map(([x, y]) => [x, y, null]) });
  const lanes = geom.lanes.map((lane) => [lane.a, lane.b]);
  const bridges = lanes.slice();
  const ends = new Int16Array(islands.length);
  for (const [p, q] of bridges) { ends[p]++; ends[q]++; }
  return finishSpec({ n, m, islands, candidates: lanes, bridges }, Array.from(ends));
}

export function generate(seed, sizeKey) {
  const n = sizeKey || 7;
  const m = n;
  const rng = rngFrom(String(seed) + '|hashi|' + n);
  // 一桌候选盘里挑最好看的：岛与岛之间要有环、要有双桥（数字全是 1、2 的盘不像数桥），
  // 在此之上再挑"整条推理链推得完"的 —— hint 就能只靠推，不用自己动回溯。
  let best = null;
  let bestScore = -1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const spec = tryBoard(rng, n, m, uniqueGate(900), 1500);
    if (!spec) continue;
    const score = (spec.logical ? 4 : 0) + spec.bridges.length / spec.islands.length;
    if (score > bestScore) { best = spec; bestScore = score; }
    if (bestScore >= 5) break;                         // 又满又推得完，没什么可挑了
  }
  // 上面那档全数不出唯一解？退一档：只收纯逻辑推得完的藤形盘，环少也认了
  for (let attempt = 0; attempt < 6 && !best; attempt++) best = tryBoard(rng, n, m, logicGate, 0);
  if (!best) best = fallbackSpec(n);
  return best;
}

// ---------------------------------------------------------------------------
// 引擎：格心玩法的指针状态机
// ---------------------------------------------------------------------------

export function create(spec) {
  const model = modelOf(spec);
  if (!model) throw new Error('hashi: 题面不合法');
  const g = model.geom;
  const L = g.lanes.length;
  const par = spec.par || (spec.bridges ? spec.bridges.length : 0);

  const count = new Int8Array(L);                      // 每条道现在搭了几根
  const closed = new Uint8Array(L);                    // 副笔：这条道一定不搭
  const full = new Uint8Array(g.K);                    // 副笔：这座岛已经凑齐
  const history = [];
  const future = [];
  let moves = 0;
  let locked = false;
  let dirty = true;
  let winCache = false;
  let stroke = null;                                   // 正在拖的一笔
  let pending = -1;                                    // 上一次停在哪个岛上（点两下搭一根桥）

  // 快照里绝不肯带 moves：撤销只搬盘面，已经花掉的笔数是收不回来的（评星靠 moves-par）
  const snap = () => ({
    c: Array.from(count), k: Array.from(closed), f: Array.from(full),
  });
  const back = (h) => {
    count.set(h.c); closed.set(h.k); full.set(h.f); dirty = true; badStale = true;
  };
  const remember = () => { history.push(snap()); if (history.length > 800) history.shift(); future.length = 0; };

  const ends = () => {
    const e = new Int16Array(g.K);
    for (const lane of g.lanes) { e[lane.a] += count[lane.idx]; e[lane.b] += count[lane.idx]; }
    return e;
  };
  const placed = () => {
    const out = [];
    for (const lane of g.lanes) for (let t = 0; t < count[lane.idx]; t++) out.push([lane.a, lane.b]);
    return out;
  };
  const inkState = () => {
    const s = new Int8Array(L).fill(UNKNOWN);
    for (const lane of g.lanes) {
      const k = lane.idx;
      if (count[k] > 0) s[k] = count[k];
      else if (closed[k]) s[k] = CLOSED;
    }
    return s;
  };

  let badStale = true;
  let badCache = [];
  const badCells = () => {
    if (!badStale) return badCache;
    const out = [];
    const seen = new Set();
    const push = (hx, hy) => {
      const kk = key(hx, hy);
      if (!seen.has(kk)) { seen.add(kk); out.push([hx, hy]); }
    };
    const e = ends();
    for (let p = 0; p < g.K; p++) {
      const [hx, hy] = g.pos[p];
      const want = spec.islands[p][2];
      if (want != null && e[p] > want) push(hx, hy);   // 桥头数超了证词：这座岛就是错的
    }
    for (const lane of g.lanes) {
      if (count[lane.idx] <= 0) continue;
      for (const o of g.cross[lane.idx]) {
        if (count[o] <= 0) continue;
        const other = g.lanes[o];
        const H = lane.horiz ? lane : other;
        const V = lane.horiz ? other : lane;
        push(V.fixed, H.fixed);                        // 交叉点必是个空格心
      }
    }
    badCache = out;
    badStale = false;
    return badCache;
  };
  const invalidate = () => { dirty = true; badStale = true; };

  const addBridge = (k) => {
    remember();
    const lane = g.lanes[k];
    if (count[k] < 2) { count[k] += 1; closed[k] = 0; }
    else count[k] -= 1;                                // 已经双桥还想再拖：拆一根，步数照收
    moves += 1;
    invalidate();
    return lane;
  };
  const dropBridge = (k) => {
    if (count[k] === 0) return null;
    remember();
    count[k] -= 1;
    moves += 1;                                        // 擦除与改画一律不退款
    invalidate();
    return g.lanes[k];
  };

  // 一笔的走法：按住岛 A → 沿横/竖一条直线拖出去 → 抬手在岛 B 上。
  // s.reach 是"顺着手势最远拖出去几个半格"，s.lane 是那个方向上唯一可能的道，
  // s.off 表示这一笔已经走废（掉头越过起笔的岛、或那个方向根本没有道），抬手什么都不做。
  const dirLane = (p, axis, sign) => g.dirs[p][axis + (sign > 0 ? '1' : 'm1')];
  const spanOf = (lane, p) => {
    const [px, py] = g.pos[p];
    const [qx, qy] = g.pos[lane.a === p ? lane.b : lane.a];
    return lane.horiz ? Math.abs(qx - px) : Math.abs(qy - py);
  };
  const onIsland = (s, p) => s.last[0] === g.pos[p][0] && s.last[1] === g.pos[p][1];

  return {
    spec,
    step: 2,                                           // 键盘光标一次挪一个格：目标是格心
    board: { cols: g.n, rows: g.m, margin: { l: 0, t: 0, r: 0, b: 0 } },

    down(hx, hy, btn) {
      if (locked || !isCell(hx, hy)) return false;     // 点、边这类目标数桥不认，原样退回
      const at = g.byPos.get(key(hx, hy));
      const island = at === undefined ? -1 : at;
      if (btn === 1) {                                 // 副笔：只记号，一律不计 moves
        if (island >= 0) { remember(); full[island] ^= 1; return true; }
        const ks = g.cellLanes.get(key(hx, hy));
        if (!ks || ks.length !== 1 || count[ks[0]] > 0) return false;
        remember();
        closed[ks[0]] ^= 1;
        return true;
      }
      if (island >= 0) {                               // 主笔按住岛：起一笔，此刻还没定桥
        stroke = { a: island, axis: null, sign: 0, reach: 0, lane: -1, last: [hx, hy], moved: false, off: false };
        return false;
      }
      const ks = g.cellLanes.get(key(hx, hy));         // 主笔点在桥身上：拆掉这一根
      if (!ks || ks.length !== 1) return false;        // 交叉格上压着两根桥，点不准就不许猜
      return dropBridge(ks[0]) !== null;
    },

    move(hx, hy) {
      if (locked || !stroke || !isCell(hx, hy)) return false;
      const s = stroke;
      const [ax, ay] = g.pos[s.a];
      s.moved = true;
      if (hx === ax && hy === ay) {                    // 拖回起笔的岛：方向清干净，可以再挑一次
        s.last = [hx, hy];
        s.reach = 0;
        s.axis = null;
        s.sign = 0;
        s.off = false;
        return false;
      }
      let axis;
      let sign;
      let step;
      if (hy === ay && hx !== ax) { axis = 'h'; sign = hx > ax ? 1 : -1; step = Math.abs(hx - ax); }
      else if (hx === ax && hy !== ay) { axis = 'v'; sign = hy > ay ? 1 : -1; step = Math.abs(hy - ay); }
      else return false;                               // 歪出这条直线：忽略它，预览留在原处
      if (s.axis === null) { s.axis = axis; s.sign = sign; }
      else if (s.axis !== axis) return false;
      const d = sign === s.sign ? step : -step;        // 掉头往回拖，d 就是负的
      if (d < 0) {                                     // 越过起笔的岛往反方向去了：这一笔作废
        s.off = true;
        s.last = [ax, ay];
        s.reach = 0;
        s.axis = null;
        s.sign = 0;
        return false;
      }
      if (d > s.reach) {
        const k = dirLane(s.a, s.axis, s.sign);
        if (k < 0) { s.off = true; return false; }     // 这个方向上没有道（隔着岛或出了盘）
        s.reach = d;
        s.lane = k;
      }
      s.last = [hx, hy];
      return false;                                    // 途中只更新预览，绝不定桥
    },

    up() {
      const s = stroke;
      stroke = null;
      if (locked || !s) return false;
      if (!s.moved) {                                  // 点一下：与上一次停留的岛配成一根桥
        if (pending >= 0 && pending !== s.a) {
          const k = g.laneOfPair.get(pairKey(pending, s.a));
          pending = k === undefined ? s.a : -1;
          if (k === undefined) return false;
          addBridge(k);
          return true;
        }
        pending = s.a;
        return false;
      }
      pending = -1;
      if (s.off || s.lane < 0) return false;
      const lane = g.lanes[s.lane];
      if (onIsland(s, s.a)) {                          // 拖过去又拖回来 = 擦掉这一根（不退款）
        dropBridge(s.lane);
        return true;
      }
      if (s.reach >= spanOf(lane, s.a)) {              // 拖到（或拖过）对岸那座岛：搭一根
        addBridge(s.lane);
        return true;
      }
      return false;                                    // 半路松手：只算预览，什么也没落
    },

    undo() {
      if (!history.length) return false;
      future.push(snap());
      back(history.pop());
      locked = false;
      return true;
    },
    redo() {
      if (!future.length) return false;
      history.push(snap());
      back(future.pop());
      return true;
    },
    canUndo() { return history.length > 0; },
    canRedo() { return future.length > 0; },

    hint() {
      // 在当前墨迹下求一条相容的解：先补缺的桥，其次拆多余的（副笔记号不算落子，不退款）
      const sol = solveOne(spec, inkState());
      if (!sol) return null;
      let k = -1;
      for (const lane of g.lanes) if (sol[lane.idx] > count[lane.idx]) { k = lane.idx; break; }
      if (k < 0) for (const lane of g.lanes) if (sol[lane.idx] < count[lane.idx]) { k = lane.idx; break; }
      if (k < 0) return null;
      const lane = g.lanes[k];
      let note;
      if (sol[k] > count[k]) { addBridge(k); note = '这条道要搭桥 —— 唯一能同时满足两端数字的摆法'; }
      else { dropBridge(k); note = '这座岛的桥头数超了，这根桥得拆掉'; }
      return { cells: [lane.mid], note };
    },

    solved() {
      if (dirty) { winCache = validate(spec, placed()); dirty = false; }
      if (winCache) locked = true;
      return winCache;
    },
    stats() {
      let done = 0;
      for (let k = 0; k < L; k++) done += count[k];
      return { moves, par, done, total: par };
    },

    badCells,

    draw(ctx, v, now) {
      const cell = v.cell;
      const sub = v.sub;
      const r = cell * 0.3;
      paper(ctx, 0, 0, v.w, v.h);
      ctx.save();
      ctx.strokeStyle = rgba(T.rule, 0.5);
      ctx.lineWidth = 1 / v.dpr;
      for (let i = 0; i <= g.n; i++) {
        ctx.beginPath();
        ctx.moveTo(v.ox + i * cell, v.oy);
        ctx.lineTo(v.ox + i * cell, v.oy + g.m * cell);
        ctx.stroke();
      }
      for (let j = 0; j <= g.m; j++) {
        ctx.beginPath();
        ctx.moveTo(v.ox, v.oy + j * cell);
        ctx.lineTo(v.ox + g.n * cell, v.oy + j * cell);
        ctx.stroke();
      }
      ctx.restore();
      ctx.save();
      ctx.fillStyle = rgba(T.inkFaint, 0.35);
      for (let j = 0; j < g.m; j++) for (let i = 0; i < g.n; i++) {
        const c = cellCenter(v, i, j);
        if (g.byPos.has(key(2 * i + 1, 2 * j + 1))) continue;
        ctx.beginPath();
        ctx.arc(c.x, c.y, cell * 0.022, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      const px = (hx, hy) => halfPoint(v, hx, hy);
      const bad = new Set(badCells().map(([x, y]) => key(x, y)));

      // 副笔的封桥记号
      ctx.save();
      ctx.strokeStyle = rgba(T.inkFaint, 0.8);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.2, cell * 0.06);
      for (const lane of g.lanes) {
        if (!closed[lane.idx] || count[lane.idx] > 0) continue;
        const mid = px(lane.mid[0], lane.mid[1]);
        const d = cell * 0.14;
        ctx.beginPath();
        ctx.moveTo(mid.x - d, mid.y - d); ctx.lineTo(mid.x + d, mid.y + d);
        ctx.moveTo(mid.x + d, mid.y - d); ctx.lineTo(mid.x - d, mid.y + d);
        ctx.stroke();
      }
      ctx.restore();

      const e = ends();
      const laneBad = (lane) => {
        if (bad.has(key(g.pos[lane.a][0], g.pos[lane.a][1]))) return true;
        if (bad.has(key(g.pos[lane.b][0], g.pos[lane.b][1]))) return true;
        for (const o of g.cross[lane.idx]) if (count[o] > 0) return true;
        return false;
      };
      // 桥：单桥一根粗线走正中，双桥两根细线分列两侧 —— 一眼能分清
      for (const lane of g.lanes) {
        const c = count[lane.idx];
        if (c === 0) continue;
        const A = px(g.pos[lane.a][0], g.pos[lane.a][1]);
        const B = px(g.pos[lane.b][0], g.pos[lane.b][1]);
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;
        const inset = r + cell * 0.03;
        const x0 = A.x + ux * inset;
        const y0 = A.y + uy * inset;
        const x1 = B.x - ux * inset;
        const y1 = B.y - uy * inset;
        const warn = laneBad(lane);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = warn ? T.warn : T.accent;
        const offs = c === 2 ? [-cell * 0.115, cell * 0.115] : [0];
        ctx.lineWidth = Math.max(1.8, cell * (c === 2 ? 0.075 : 0.15));
        for (const off of offs) {
          ctx.beginPath();
          ctx.moveTo(x0 + nx * off, y0 + ny * off);
          ctx.lineTo(x1 + nx * off, y1 + ny * off);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 岛：圆盘 + 数字；凑齐了换绿，超了换赭，藏起来的画个空心盘
      for (let p = 0; p < g.K; p++) {
        const [hx, hy] = g.pos[p];
        const c = px(hx, hy);
        const want = spec.islands[p][2];
        const over = want != null && e[p] > want;
        const met = want != null && e[p] === want;
        ctx.save();
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        if (want == null) {
          ctx.fillStyle = T.card;
          ctx.fill();
          ctx.strokeStyle = rgba(T.inkSoft, 0.9);
          ctx.lineWidth = Math.max(1.2, cell * 0.055);
          ctx.stroke();
        } else {
          ctx.fillStyle = over ? T.warn : met ? T.good : T.accent;
          ctx.fill();
        }
        ctx.restore();
        if (full[p]) {
          ctx.save();
          ctx.strokeStyle = rgba(T.gold, 0.9);
          ctx.lineWidth = Math.max(1.4, cell * 0.06);
          ctx.beginPath();
          ctx.arc(c.x, c.y, r + cell * 0.09, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        label(ctx, want == null ? '?' : String(want), c.x, c.y, {
          size: cell * 0.42,
          color: want == null ? T.inkSoft : T.card,
          bold: true,
          mono: true,
        });
      }

      // 拖拽预览：从起笔的岛沿着那条道虚线跟手；够到对岸就整条道亮起，
      // 已经有一根的地方预告第二根，已经双桥的地方预告"再拖就拆一根"
      if (stroke && !locked) {
        const s = stroke;
        const A = px(g.pos[s.a][0], g.pos[s.a][1]);
        const k = s.lane;
        let line = null;
        if (s.moved && k >= 0 && !s.off) {
          const lane = g.lanes[k];
          const span = spanOf(lane, s.a);
          const [bx, by] = g.pos[lane.a === s.a ? lane.b : lane.a];
          const tgt = px(bx, by);
          const t = span ? Math.min(s.reach, span) / span : 0;
          line = {
            x: A.x + (tgt.x - A.x) * t,
            y: A.y + (tgt.y - A.y) * t,
            ok: s.reach >= span,
            lane,
          };
        } else {
          const last = px(s.last[0], s.last[1]);
          line = { x: last.x, y: last.y, ok: false, lane: null };
        }
        ctx.save();
        ctx.setLineDash([cell * 0.12, cell * 0.1]);
        ctx.lineCap = 'round';
        ctx.strokeStyle = line.ok ? rgba(T.accent, 0.6) : rgba(T.warn, 0.55);
        ctx.lineWidth = Math.max(1.6, cell * 0.11);
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(line.x, line.y);
        ctx.stroke();
        if (line.ok) {
          const lane = line.lane;
          const B = px(g.pos[lane.a === s.a ? lane.b : lane.a][0], g.pos[lane.a === s.a ? lane.b : lane.a][1]);
          ctx.setLineDash([]);
          ctx.strokeStyle = rgba(count[lane.idx] === 2 ? T.warn : T.good, 0.4);
          ctx.lineWidth = Math.max(1.2, cell * 0.06);
          const off = count[lane.idx] === 1 ? cell * 0.115 : 0;
          const ux = (B.x - A.x) / (Math.hypot(B.x - A.x, B.y - A.y) || 1);
          const uy = (B.y - A.y) / (Math.hypot(B.x - A.x, B.y - A.y) || 1);
          ctx.beginPath();
          ctx.moveTo(A.x - uy * off + ux * r, A.y + ux * off + uy * r);
          ctx.lineTo(B.x - uy * off - ux * r, B.y + ux * off - uy * r);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 悬停脉冲：岛给一圈呼吸的光环，空水道给整条道的淡影
      const hv = v.hover;
      if (hv && isCell(hv.x, hv.y) && !locked && !stroke) {
        const p = g.byPos.get(key(hv.x, hv.y));
        if (p !== undefined) {
          const c = px(hv.x, hv.y);
          ctx.save();
          ctx.strokeStyle = rgba(T.accent, 0.18 + 0.16 * pulse(now));
          ctx.lineWidth = Math.max(1.6, cell * 0.07);
          ctx.beginPath();
          ctx.arc(c.x, c.y, r + cell * (0.12 + 0.06 * pulse(now)), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        } else {
          const ks = g.cellLanes.get(key(hv.x, hv.y));
          if (ks && ks.length === 1) {
            const lane = g.lanes[ks[0]];
            if (count[lane.idx] === 0) {
              const A = px(g.pos[lane.a][0], g.pos[lane.a][1]);
              const B = px(g.pos[lane.b][0], g.pos[lane.b][1]);
              ctx.save();
              ctx.lineCap = 'round';
              ctx.strokeStyle = rgba(T.accent, 0.12 + 0.1 * pulse(now));
              ctx.lineWidth = Math.max(1.4, cell * 0.1);
              ctx.beginPath();
              ctx.moveTo(A.x, A.y);
              ctx.lineTo(B.x, B.y);
              ctx.stroke();
              ctx.restore();
            }
          }
        }
      }
    },

    celebrate(ctx, v, now, t) {
      this.draw(ctx, v, now);
      const k = easeOut(clamp(t * 1.3, 0, 1));
      ctx.save();
      ctx.strokeStyle = rgba(T.gold, 0.5 * (1 - k));
      ctx.lineWidth = Math.max(2, v.cell * 0.1) * (1 + k);
      for (let p = 0; p < g.K; p++) {
        const c = halfPoint(v, g.pos[p][0], g.pos[p][1]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, v.cell * (0.3 + k * 0.55), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

// 给外壳与测试用的换坐标小工具（cell ↔ 半坐标），引擎内部一律半坐标
export const islandHalfOf = (i, j) => cellAt(i, j);
export const islandCellOf = (hx, hy) => (isCell(hx, hy) ? cellOf(hx, hy) : null);

export default {
  id: 'hashi',
  title: '数桥',
  latin: 'HASHI',
  tagline: '数字说：落在我身上的桥头有这么多',
  unit: '根',
  rules: [
    '只在岛与岛之间搭桥：横竖成线，中间不得有第三座岛；斜着不叫桥。',
    '一对岛最多两根平行桥，桥与桥不许十字相交（只能在岛上相遇）。',
    '岛上的数字 = 落在它身上的桥头数，双桥对两端各算两个；带问号的空心盘数字被藏起来了，得自己推回来。',
    '每座岛都要凑够自己的数字，最后所有岛连成一张 —— 数字全对却分成两堆照样是错题。',
  ],
  sizes: TIERS.map(({ key: kk, label: lb, tier }) => ({ key: kk, label: lb, tier })),
  generate,
  create,
};
