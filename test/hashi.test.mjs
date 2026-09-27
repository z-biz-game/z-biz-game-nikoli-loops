// 数桥的三道保险（与 slitherlink.test.mjs 同立场）：
//   1) 生成器不许说谎 —— 发出去的题必须 count===1 && !capped，而且要用独立的 validate
//      复核一遍求解器的产物：每座岛桥头数吻合、图是一张、一对岛 ≤2 根、桥不相交。
//   2) moves 的口径是"一根桥 = 一次落子"（双桥是两次），par 就是解里桥的总根数；
//      擦除、改画、撤销一律不退款 —— snap() 里不许出现 moves。
//   3) 引擎是个纯状态机 —— 只用公开 API 走子；赢了锁盘；副笔的记号不计步。
//
// 另有两条"已知缺陷"测试（hint 只放半根双桥就再问不出东西、竖桥方向索引把 v1 全丢掉）
// 钉的是眼下的真实行为：修好引擎的那一刻，这两条必须红，逼着改的人回来把断言换正。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import hashi, {
  UNKNOWN, CLOSED, SINGLE, DOUBLE, MAX_CLUE,
  geomOf, candidatePairs, islandAt, bridgeListOf, validate, propagate, logicSolve,
  countSolutions, solveOne, generate, create, islandHalfOf, islandCellOf,
} from '../js/puzzles/hashi.js';
import { isCell, isVertex, isHEdge, isVEdge, edgeSides, cellOf, cellAt } from '../js/core/lattice.js';

const SEEDS = (tag, k = 10) => Array.from({ length: k }, (_, i) => `${tag}:${i}`);
const keyOf = ([x, y]) => x + ',' + y;
// 桥的多重集（岛号对）——顺序无关，双桥出现两次
const bag = (pairs) => pairs.map(([a, b]) => (a < b ? a + '-' + b : b + '-' + a)).sort().join('|');
const cellSet = (cells) => cells.map(keyOf).sort().join('|');
const handSpec = (islands, n = 5) => ({ n, m: n, islands });
const laneOfPair = (g, a, b) => g.lanes.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
const stOf = (g, init = {}) => {
  const s = new Int8Array(g.lanes.length).fill(UNKNOWN);
  for (const k of Object.keys(init)) s[+k] = init[k];
  return s;
};
// 出题不便宜（11×11 一颗种子约 60ms），同一条种子在整个文件里只发一次
const memo = new Map();
const gen = (seed, n) => {
  const k = n + '@' + seed;
  if (!memo.has(k)) memo.set(k, generate(seed, n));
  return memo.get(k);
};
// 唯一解 → 道状态（SINGLE/DOUBLE/CLOSED）
function solutionState(spec) {
  const g = geomOf(spec);
  const s = new Int8Array(g.lanes.length).fill(CLOSED);
  for (const [a, b] of spec.bridges) s[laneOfPair(g, a, b).idx] += 1;
  return { g, s };
}
// 点两下同一对岛 = 一根桥（与键盘空格同一条路：down 起笔、up 结算）
const tap = (e, p) => { e.down(p[0], p[1], 0); return e.up(); };
// 按住岛 A 沿直线拖到岛 B：途中每格水面都得递一次 move，抬手才结算
function dragTo(e, A, B, stopAt = Infinity) {
  e.down(A[0], A[1], 0);
  const dx = Math.sign(B[0] - A[0]) * 2;
  const dy = Math.sign(B[1] - A[1]) * 2;
  let x = A[0];
  let y = A[1];
  let n = 0;
  while ((x !== B[0] || y !== B[1]) && n < stopAt) { x += dx; y += dy; n++; e.move(x, y); }
  return e.up();
}
const spanCells = (spec, a, b) => {
  const [ax, ay] = spec.islands[a];
  const [bx, by] = spec.islands[b];
  return (Math.abs(bx - ax) + Math.abs(by - ay)) / 2;
};

let internalsPromise = null;
// fallbackSpec / borderChainSpec 是模块私有的（契约第 2 条那条"永不该走到"的路），
// 测试不许改 js/，只能把同一份源码换个 import 前缀再吃一遍，好把保底路径摊开逐项验。
function internals() {
  if (!internalsPromise) {
    const url = new URL('../js/puzzles/hashi.js', import.meta.url);
    const src = fs.readFileSync(url, 'utf8')
      .replace(/from '\.\.\/core\/(\w+)\.js'/g, (_, f) => `from '${new URL('../core/' + f + '.js', url)}'`)
      + '\nexport { fallbackSpec, borderChainSpec };\n';
    internalsPromise = import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  }
  return internalsPromise;
}

// ---- 几何：岛号 ↔ 格心 ↔ 道 ------------------------------------------------------

test('岛号 ↔ 格心半坐标 ↔ 编号 三套口径互相咬合，岛不落在格心上就不算题面', () => {
  const spec = gen('geo:0', 9);
  const g = geomOf(spec);
  assert.equal(g.K, spec.islands.length);
  assert.equal(g.n, spec.n);
  assert.equal(g.m, spec.m);
  for (let p = 0; p < g.K; p++) {
    const [hx, hy] = spec.islands[p];
    assert.equal(isCell(hx, hy), true, `岛 ${p} 不在格心：${hx},${hy}`);
    assert.equal(hx >= 1 && hx <= 2 * spec.n - 1 && hy >= 1 && hy <= 2 * spec.m - 1, true, '岛出了盘');
    assert.deepEqual(g.pos[p], [hx, hy], 'geom.pos 必须与题面同序同值');
    assert.equal(islandAt(spec, hx, hy), p, '按坐标查岛号');
    const [i, j] = cellOf(hx, hy);
    assert.deepEqual(cellAt(i, j), [hx, hy], 'cell ↔ 半坐标必须互逆');
    assert.deepEqual(islandHalfOf(i, j), [hx, hy]);
    assert.deepEqual(islandCellOf(hx, hy), [i, j]);
  }
  assert.equal(new Set(spec.islands.map(keyOf)).size, spec.islands.length, '两座岛不许叠在同一格');
  assert.equal(islandAt(spec, 0, 0), -1, '点不是岛');
  assert.equal(islandCellOf(2, 3), null, '非格心坐标给不出岛');
  assert.equal(islandHalfOf(0, 0)[0] % 2, 1, '换坐标工具交出去的必是 (奇, 奇)');
  // 岛压到点/边上、或者根本围不出道：geomOf 一律 null，引擎也不许开局
  assert.equal(geomOf(handSpec([[2, 2, 1], [5, 1, 1]], 5)), null, '岛落在点上');
  assert.equal(geomOf(handSpec([[1, 2, 1], [5, 2, 1]], 5)), null, '岛落在横边上');
  assert.equal(geomOf(handSpec([[1, 1, 1], [1, 1, 1]], 5)), null, '两座岛叠格');
  assert.equal(geomOf(handSpec([[1, 1, 1], [3, 3, 1]], 5)), null, '斜着对望，一道也搭不出来');
  assert.throws(() => create(handSpec([[1, 1, 1], [3, 3, 1]], 5)), /题面不合法/);
});

test('候选道只在同排同列的相邻两岛之间：中间每一格都是空水面', () => {
  for (const n of [7, 9]) {
    const spec = gen('lane', n);
    const g = geomOf(spec);
    assert.deepEqual(candidatePairs(spec), spec.candidates, 'candidatePairs 与题面 candidates 必须同一份');
    assert.equal(new Set(spec.candidates.map(keyOf)).size, spec.candidates.length, '同一对岛不许出现两条道');
    const at = new Map(spec.islands.map(([x, y], p) => [keyOf([x, y]), p]));
    for (const lane of g.lanes) {
      const [ax, ay] = g.pos[lane.a];
      const [bx, by] = g.pos[lane.b];
      assert.notEqual(ax + ',' + ay, bx + ',' + by);
      assert.ok(lane.a !== lane.b);
      if (lane.horiz) { assert.equal(ay, by, '横道两端同排'); assert.equal(ax, lane.lo); assert.equal(bx, lane.hi); }
      else { assert.equal(ax, bx, '竖道两端同列'); assert.equal(ay, lane.lo); assert.equal(by, lane.hi); }
      assert.equal(lane.hi - lane.lo >= 2, true, '两岛之间至少留一格水面');
      assert.ok(lane.cells.length >= 1, '生成盘的每道桥都有桥身可点');
      assert.ok(lane.cells.some((c) => c[0] === lane.mid[0] && c[1] === lane.mid[1]), 'mid 必须在这条道的水面上');
      for (const c of lane.cells) {
        assert.equal(isCell(c[0], c[1]), true);
        assert.equal(at.has(keyOf(c)), false, `桥中间撞到了第三座岛 ${keyOf(c)}`);
        const inRange = lane.horiz
          ? (c[1] === ay && c[0] > Math.min(ax, bx) && c[0] < Math.max(ax, bx))
          : (c[0] === ax && c[1] > Math.min(ay, by) && c[1] < Math.max(ay, by));
        assert.equal(inRange, true, '中间格必须落在两端之间');
        assert.deepEqual(g.cellLanes.get(c[1] * 1024 + c[0]).filter((k) => k === lane.idx).length >= 1, true);
      }
      // 逐格摊开：把整条道覆盖的格心数出来，正好是 hi-lo 之间那一串
      assert.equal(lane.cells.length, (lane.hi - lane.lo) / 2 - 1);
      for (let p = 0; p < g.K; p++) {
        const has = g.islandLanes[p].includes(lane.idx);
        assert.equal(has, p === lane.a || p === lane.b, '一条道只挂自己两端两座岛');
      }
    }
    // 桥身格心恰好被一条道用水面（交叉格才会有两条）——副笔的"此道不搭"只能点在单条道上
    for (const [k, ks] of g.cellLanes) assert.ok(ks.length <= 2 && ks.length >= 1, `格心 ${k} 压了 ${ks.length} 条道`);
  }
});

test('中间隔着岛就不是道：跨岛长桥 validate 判死；相邻两岛之间照样算道', () => {
  const blocked = handSpec([[1, 1, 1], [9, 1, 1], [5, 1, null]]);      // 三座岛同排，中间那座挡道
  const g = geomOf(blocked);
  assert.deepEqual(candidatePairs(blocked), [[0, 2], [2, 1]], '只许看得见邻居：0-1 中间压着岛 2');
  assert.equal(laneOfPair(g, 0, 1), undefined, '0-1 不许成道');
  assert.equal(validate(blocked, [[0, 1], [2, 1]]), false, '桥穿过别人的岛 = 错题');
  assert.equal(validate(blocked, [[0, 2], [2, 1], [0, 2], [2, 1]]), true, '两条都搭双桥才是解');
  // 紧邻的两座岛之间没有水面，仍然是一条合法道
  const snug = handSpec([[1, 1, 1], [3, 1, 1]]);
  assert.deepEqual(candidatePairs(snug), [[0, 1]]);
  assert.equal(validate(snug, [[0, 1]]), true);
  assert.equal(validate(snug, []), false, '没桥 = 岛没连成一张');
});

test('cross 相交表与 validate 的"桥不许十字相交"说的是同一件事', () => {
  const pin = handSpec([[1, 5, null], [9, 5, null], [5, 1, null], [5, 9, null]]);   // 一横一竖正交
  const g = geomOf(pin);
  assert.equal(g.lanes.length, 2);
  assert.deepEqual(g.cross.map((c) => c.slice().sort()), [[1], [0]]);
  const H = g.lanes.find((l) => l.horiz);
  const V = g.lanes.find((l) => !l.horiz);
  assert.deepEqual([V.fixed, H.fixed], [5, 5], '交叉点是个空格心');
  assert.equal(validate(pin, [[H.a, H.b], [V.a, V.b]]), false, 'validate 也得拒绝这一对');
  assert.equal(validate(pin, [[H.a, H.b]]), false, '只搭一根：另两座岛成了孤岛');
  // 生成的题里，每对相交的道 validate 都拒绝同搭；每条道都与解里其余道不相交
  for (const seed of SEEDS('xover', 4)) {
    const spec = gen(seed, 9);
    const gg = geomOf(spec);
    const on = new Set(spec.bridges.map(keyOf));
    for (const lane of gg.lanes) {
      for (const o of gg.cross[lane.idx]) {
        const other = gg.lanes[o];
        if (lane.idx < o) {
          const probe = spec.islands.map(([x, y], p) => [x, y, p === lane.a || p === lane.b || p === other.a || p === other.b ? 1 : null]);
          assert.equal(validate(handSpec(probe, spec.n), [[lane.a, lane.b], [other.a, other.b]]), false,
            `${seed}: 相交的两根桥 validate 必须判死`);
        }
      }
      assert.equal(on.has(keyOf([lane.a, lane.b])), true || on.size >= 0, '只为读解');
    }
    const horiz = gg.lanes.filter((l) => l.horiz && on.has(keyOf([l.a, l.b])));
    const vert = gg.lanes.filter((l) => !l.horiz && on.has(keyOf([l.a, l.b])));
    for (const A of horiz) for (const B of vert) {
      assert.ok(!(A.fixed > B.lo && A.fixed < B.hi && B.fixed > A.lo && B.fixed < A.hi), '解里的桥不许相交');
    }
  }
});

test('不认识的奇偶一律原样退回：点、横边、竖边都不许改状态', () => {
  const spec = gen('parity:0', 7);
  const e = create(spec);
  const before = e.stats();
  const targets = [];
  for (let hy = 0; hy <= 2 * spec.m; hy++) for (let hx = 0; hx <= 2 * spec.n; hx++) {
    if (isVertex(hx, hy) || isHEdge(hx, hy) || isVEdge(hx, hy)) targets.push([hx, hy]);
  }
  assert.ok(targets.length > 100);
  for (const [hx, hy] of targets) {
    assert.equal(isCell(hx, hy), false);
    assert.equal(e.down(hx, hy, 0), false, `主笔吃下了 ${hx},${hy}`);
    assert.equal(e.down(hx, hy, 1), false, `副笔吃下了 ${hx},${hy}`);
    assert.equal(e.move(hx, hy), false);
  }
  assert.deepEqual(e.stats(), before, '收到非格心目标之后状态得一模一样');
  assert.equal(e.up(), false, '没有起笔就没有结算');
  assert.equal(e.canUndo(), false, '什么都没落，撤销得是空');
  // 边与点确实各有归属（用 core 的换算复核一遍，别拿数桥自己的口径自证）
  const edge = targets.find(([x, y]) => isHEdge(x, y));
  assert.ok(edgeSides(edge[0], edge[1], spec.n, spec.m).some((s) => s));
  assert.equal(e.step, 2, '格心玩法：键盘一次挪两个半格');
  assert.deepEqual(e.board, { cols: spec.n, rows: spec.m, margin: { l: 0, t: 0, r: 0, b: 0 } });
});

// ---- 规则传播 --------------------------------------------------------------------

test('propagate: 数字凑齐了，这座岛其余的道一律封死', () => {
  // 中心岛数字 2，四向各一条道；左右两条各搭一根之后，上下两条只剩封
  const plus = handSpec([[5, 5, 2], [1, 5, 1], [9, 5, 1], [5, 1, 0], [5, 9, 0]]);
  const g = geomOf(plus);
  assert.deepEqual(g.islandLanes[0].length, 4);
  const s = stOf(g);
  s[laneOfPair(g, 0, 1).idx] = SINGLE;
  s[laneOfPair(g, 0, 2).idx] = SINGLE;
  assert.equal(propagate(s, plus), true);
  assert.equal(s[laneOfPair(g, 0, 3).idx], CLOSED, '数字满了还想搭 = 矛盾');
  assert.equal(s[laneOfPair(g, 0, 4).idx], CLOSED);
  assert.equal(s[laneOfPair(g, 0, 1).idx], SINGLE, '已经落子的不许被改');
  // 缺口归零的另一侧：中心岛自己数字 2 摊在两条道上，其中一条封了，另一条就得顶到双桥
  const s2 = stOf(g, { [laneOfPair(g, 0, 3).idx]: CLOSED, [laneOfPair(g, 0, 4).idx]: CLOSED });
  assert.equal(propagate(s2, plus), true);
  assert.equal(s2[laneOfPair(g, 0, 1).idx], SINGLE);
  assert.equal(s2[laneOfPair(g, 0, 2).idx], SINGLE);
});

test('propagate: 缺口正好等于各道上限就顶格搭，只剩一个桥头就不许双', () => {
  // 一座岛只有一条道可走：说 2 就是双桥，说 1 就是单桥
  const d = handSpec([[1, 1, 2], [9, 1, 2]]);
  const dg = geomOf(d);
  const ds = stOf(dg);
  assert.equal(propagate(ds, d), true);
  assert.equal(ds[0], DOUBLE, '一条道扛满两个桥头 = 只能是双桥');
  const one = handSpec([[1, 1, 1], [9, 1, 1]]);
  const og = geomOf(one);
  const os = stOf(og);
  assert.equal(propagate(os, one), true);
  assert.equal(os[0], SINGLE, '数字 1 的岛挂不起双桥');
  // 需要 3 个桥头摊在两条道上：一条已搭 1 根，另一条的缺口正好顶格 → 双桥
  const t = handSpec([[1, 1, 3], [9, 1, 1], [5, 9, 2]]);
  const tg = geomOf(t);
  assert.deepEqual(tg.lanes.map((l) => [l.a, l.b]), [[0, 1]] , '先确认 0 只有 0-1 一条道');
  const ts = stOf(tg);
  assert.equal(propagate(ts, t), false, '一条道填不上 3 个缺口 = 死局（题面本身不成立）');
  const u = handSpec([[1, 1, 3], [9, 1, 2], [1, 9, 1], [9, 9, 1]]);
  const ug = geomOf(u);
  const us = stOf(ug, { [laneOfPair(ug, 0, 2).idx]: SINGLE });
  assert.equal(propagate(us, u), true);
  assert.equal(us[laneOfPair(ug, 0, 1).idx], DOUBLE, '缺口 2 摊在唯一一条道上');
  // 缺口比剩下的道数大时不许硬拍：3 个缺口摊在 3 条道上还可以是 2+1+0
  const w = handSpec([[1, 1, 3], [9, 1, 3], [5, 5, 1], [1, 9, 1], [9, 9, 1]]);
  const wg = geomOf(w);
  const ws = stOf(wg);
  assert.equal(propagate(ws, w), true);
  assert.ok(ws.slice(0, 2).every((v) => v === UNKNOWN), '没到顶格就不许定案，否则唯一性证明是假的');
});

test('propagate: 搭一条就封掉与它十字相交的道，两条都搭即判死', () => {
  const pin = handSpec([[1, 5, null], [9, 5, null], [5, 1, null], [5, 9, null], [1, 1, null], [9, 9, null]]);
  const g = geomOf(pin);
  const H = laneOfPair(g, 0, 1).idx;
  const V = laneOfPair(g, 2, 3).idx;
  assert.ok(g.cross[H].includes(V) && g.cross[V].includes(H));
  const s = stOf(g, { [H]: SINGLE });
  assert.equal(propagate(s, pin), true);
  assert.equal(s[V], CLOSED, '水面只够一根桥');
  // 有数字的版本：横道两端各要 1，于是竖道连同其余两条全封
  const numbered = handSpec([[1, 5, 1], [9, 5, 1], [5, 1, null], [5, 9, null], [1, 1, null], [9, 9, null]]);
  const ng = geomOf(numbered);
  const ns = stOf(ng, { [laneOfPair(ng, 0, 1).idx]: SINGLE });
  assert.equal(propagate(ns, numbered), true);
  assert.equal(ns[laneOfPair(ng, 2, 3).idx], CLOSED);
  // 已经搭了两根相交的桥：propagate 必须诚实说死
  const dead = stOf(ng, { [laneOfPair(ng, 0, 1).idx]: SINGLE, [laneOfPair(ng, 2, 3).idx]: SINGLE });
  const dg = geomOf(handSpec([[1, 5, null], [9, 5, null], [5, 1, null], [5, 9, null]]));
  const both = stOf(dg, { 0: SINGLE, 1: SINGLE });
  assert.equal(propagate(both, handSpec([[1, 5, null], [9, 5, null], [5, 1, null], [5, 9, null]])), false);
  assert.ok(dead.length === ns.length);
});

test('propagate 把矛盾如实吞掉：超数、填不满、把藏数字的岛封成孤岛', () => {
  const sp = handSpec([[1, 1, 1], [9, 1, 2], [1, 9, 2]]);
  const g = geomOf(sp);
  const over = stOf(g, { [laneOfPair(g, 0, 1).idx]: DOUBLE });
  assert.equal(propagate(over, sp), false, '数字 1 的岛搭了双桥 = 桥头超了证词');
  const greedy = stOf(g);
  assert.equal(propagate(greedy, handSpec([[1, 1, 9], [9, 1, 9], [1, 9, 9]])), false, '一条道最多 2 根，9 填不满');
  const hidden = handSpec([[1, 1, null], [9, 1, 1]]);
  const hg = geomOf(hidden);
  assert.equal(propagate(stOf(hg, { 0: CLOSED }), hidden), false, '藏了数字的岛所有道封死 = 孤岛，照样矛盾');
  assert.equal(propagate(stOf(hg), hidden), true, '同一份题面没动墨迹就不该被判死');
  // 返回 false 时不许留下"看起来推完了"的状态
  const s = stOf(g, { [laneOfPair(g, 0, 1).idx]: SINGLE, [laneOfPair(g, 0, 2).idx]: SINGLE });
  assert.equal(propagate(s, handSpec([[1, 1, 1], [9, 1, 2], [1, 9, 2]])), false);
});

// ---- 独立校验器 ------------------------------------------------------------------

test('validate 认解：数字全对、一张图、每对 ≤2 根、桥不相交', () => {
  const spec = gen('val:0', 9);
  assert.equal(validate(spec, spec.bridges), true);
  assert.equal(validate(spec, spec.bridges.slice(0, -1)), false, '少一根桥：数字与连通性都得拦');
  const g = geomOf(spec);
  const dup = spec.bridges.slice().reverse();
  assert.equal(validate(spec, dup), true, '顺序无关');
  // 把某座岛的一根桥挪到它与另一座岛之间：只许在"确实是道"的位子上才可能过关
  const lane = g.lanes.find((l) => spec.islands[l.b][2] != null && !spec.bridges.some(([a, b]) => (a === l.a && b === l.b)));
  assert.equal(validate(spec, spec.bridges.concat([[lane.a, lane.b]])), false, '多搭一根必然顶破某座岛的证词');
  // 藏起来的数字不参与校验，其余座岛全得对得上
  const hidden = spec.islands.filter(([, , c]) => c == null).length;
  assert.ok(hidden >= 1);
  assert.equal(validate(handSpec(spec.islands.map(([x, y]) => [x, y, 1]), spec.n), spec.bridges),
    spec.bridges.every(([a, b]) => spec.islands[a][2] === 1 && spec.islands[b][2] === 1) || false,
    '把题面全改成 1 就不可能还是解');
});

test('validate 拒绝"每座岛数字都对却不连成一张"——数桥最经典的那个坑', () => {
  // 四座岛排成方块，每座要 2 个桥头：绕一圈是解；两对各自双桥数字也全对，却是两堆
  const sq = handSpec([[1, 1, 2], [5, 1, 2], [1, 5, 2], [5, 5, 2]]);
  assert.deepEqual(candidatePairs(sq), [[0, 1], [2, 3], [0, 2], [1, 3]]);
  assert.equal(validate(sq, [[0, 1], [1, 3], [3, 2], [2, 0]]), true, '一圈单桥是解');
  assert.equal(validate(sq, [[0, 1], [0, 1], [2, 3], [2, 3]]), false, '数字全对但分成两堆');
  assert.equal(validate(sq, [[0, 2], [0, 2], [1, 3], [1, 3]]), false, '换个方向也一样');
  // 三座岛的"一堆双桥 + 一座孤岛"：数字对得上，图不是一张
  const tri = handSpec([[1, 1, 2], [9, 1, 2], [5, 9, 0]]);
  assert.equal(validate(tri, [[0, 1], [0, 1]]), false, '0 号岛数字 0 也得连进来');
  const { count, capped } = countSolutions(sq, 3);
  assert.equal(count, 1, '两堆的摆法在求解器里也必须不成立');
  assert.equal(capped, false);
});

test('validate 的反例清单：斜桥、第三根桥、越界的岛、非法岛号', () => {
  const spec = gen('val:1', 7);
  const K = spec.islands.length;
  assert.equal(validate(spec, [[0, 1], [1, 0]].concat([[0, 1], [0, 1]])), false, '一对岛最多两根平行桥');
  const diag = spec.islands[0];
  const far = spec.islands.find(([x, y]) => x !== diag[0] && y !== diag[1]);
  assert.equal(validate(spec, [[0, spec.islands.indexOf(far)]]), false, '斜着不叫桥');
  assert.equal(validate(spec, [[0, 0]]), false, '自己搭到自己身上');
  assert.equal(validate(spec, [[0, K], [1, -1], [K + 5, 2]]), false, '岛号出界');
  assert.equal(validate(spec, 'nope'), false, '不是数组直接否');
  assert.equal(validate(null, []), false);
  assert.equal(validate({ n: 5, islands: [] }, []), false, '没有岛就不叫题');
  // 岛的坐标不在格心 / 出了盘面：validate 与 geomOf 同口径
  assert.equal(validate(handSpec([[2, 2, 1], [5, 1, 1]]), [[0, 1]]), false, '岛压在点上');
  assert.equal(validate(handSpec([[1, 1, 1], [11, 1, 1]], 5), [[0, 1]]), false, '岛出了盘（2n-1=9）');
});

// ---- 求解器与校验器对拍 ----------------------------------------------------------

test('logicSolve 推得完的题，推出来的桥集与题面答案一字不差；spec.logical 不许说谎', () => {
  let proven = 0;
  for (const n of [7, 9, 11]) {
    for (const seed of SEEDS('log', 40)) {
      const spec = gen(seed, n);
      const sol = logicSolve(spec);
      assert.equal(!!spec.logical, !!sol, `${seed}/${n}: logical 与 logicSolve 结果必须一致`);
      if (sol) {
        proven++;
        assert.equal(bag(sol.bridges), bag(spec.bridges), `${seed}/${n} 推理链推出的不是那个解`);
        assert.equal(validate(spec, sol.bridges), true);
        assert.deepEqual(Array.from(sol.state), Array.from(solutionState(spec).s), '道状态也得与解同值');
      }
    }
  }
  assert.ok(proven > 0, '40×3 颗种子里一道纯逻辑推得完的都没有，说明闸门哑了');
  // 保底题面是纯推理的教科书：全盘数字、每座岛只剩一条道可走
  return internals().then((H) => {
    for (const spec of [H.fallbackSpec(7), H.borderChainSpec(9, 9)]) {
      const sol = H.logicSolve(spec);
      assert.ok(sol, '保底题面必须纯逻辑推得完');
      assert.equal(bag(sol.bridges), bag(spec.bridges));
    }
  });
});

test('countSolutions 不许说谎：两解如实报 2，没数完一律 capped，capped 不等于无解', () => {
  // 四座岛排成方块、每座要 3：双桥摆在哪一组边上都说得通 —— 两个解
  const two = handSpec([[1, 1, 3], [5, 1, 3], [1, 5, 3], [5, 5, 3]]);
  assert.equal(validate(two, [[0, 1], [0, 1], [0, 2], [1, 3], [2, 3], [2, 3]]), true);
  assert.equal(validate(two, [[0, 2], [0, 2], [1, 3], [1, 3], [0, 1], [2, 3]]), true);
  const all = countSolutions(two, 3);
  assert.equal(all.count, 2, '两个解就数出两个');
  assert.equal(all.capped, false, '数完了就不许喊累');
  const early = countSolutions(two, 2);
  assert.equal(early.count, 2);
  assert.equal(early.capped, true, '数到 cap 早停 = 没数完，必须 capped');
  // 无解：风车四座岛各要 1 个桥头，横竖两两相交，永远连不成一张
  const pin = handSpec([[1, 3, 1], [5, 3, 1], [3, 1, 1], [3, 5, 1]]);
  const none = countSolutions(pin, 2);
  assert.equal(none.count, 0);
  assert.equal(none.capped, false, '走到尽头没找到 = 真无解，不是没数完');
  // 预算不够就是没数完
  const spec = gen('bud:0', 11);
  const tight = countSolutions(spec, 2, null, 1);
  assert.equal(tight.capped, true, '一步就被掐断，谁也不能宣布唯一');
  const loose = countSolutions(spec, 2);
  assert.equal(loose.count, 1);
  assert.equal(loose.capped, false);
  assert.equal(countSolutions({ n: 5, islands: [[2, 2, 1]] }).capped, true, '不合法题面别装作数出来了');
});

test('带墨迹数解：解的一部分仍指向同一个唯一解，改错一根立刻没解', () => {
  for (const n of [7, 9, 11]) {
    for (const seed of SEEDS('seed', 6)) {
      const spec = gen(seed, n);
      const { g, s } = solutionState(spec);
      assert.equal(propagate(Int8Array.from(s), spec), true, '真解自己推不动就是传播规则撒了谎');
      const full = countSolutions(spec, 3, s);
      assert.deepEqual([full.count, full.capped], [1, false], `${seed}/${n} 拿解当墨迹再数一遍`);
      const partly = Int8Array.from(s);
      for (const lane of g.lanes) if (lane.idx % 4 === 0) partly[lane.idx] = UNKNOWN;
      const r = countSolutions(spec, 2, partly);
      assert.deepEqual([r.count, r.capped], [1, false], '留白也该数得出唯一解');
      const wrong = Int8Array.from(s);
      const dbl = g.lanes.find((l) => s[l.idx] === DOUBLE);
      if (dbl) {
        wrong[dbl.idx] = CLOSED;
        const w = countSolutions(spec, 2, wrong);
        assert.equal(w.count, 0, `${seed}/${n}：把双桥拆成 0 根，唯一解就没了`);
        assert.equal(w.capped, false, '无解要说"没解"，不许拿没数完当挡箭牌');
      }
      // solveOne 交出来的必须是 validate 认账的解，而且与现有墨迹相容
      const one = solveOne(spec, partly);
      assert.ok(one);
      assert.equal(validate(spec, bridgeListOf(g, one)), true);
      assert.equal(bag(bridgeListOf(g, one)), bag(spec.bridges), '唯一解题里 solveOne 不许找出另一张图');
      for (const lane of g.lanes) if (partly[lane.idx] !== UNKNOWN) assert.equal(one[lane.idx], partly[lane.idx]);
    }
  }
});

// ---- 生成器：每档 40 颗种子 ------------------------------------------------------

function auditTier(n, tag, { minIslands, minPar, maxPar, minDoubles }) {
  const pars = [];
  const isl = [];
  for (const seed of SEEDS(tag, 40)) {
    const spec = generate(seed, n);                 // 这里必须现生成，不能走 memo：fuzz 要的是 40 颗不同种子
    assert.ok(spec && Array.isArray(spec.islands), seed + ' 交白卷');
    assert.equal(spec.n, n);
    assert.equal(spec.m, n);
    assert.ok(spec.islands.length >= minIslands, `${seed} 一桌只有 ${spec.islands.length} 座岛`);
    assert.ok(spec.islands.length >= 8, `${seed} 岛太少`);
    isl.push(spec.islands.length);
    const { g, s } = solutionState(spec);
    pars.push(spec.par);
    assert.ok(spec.par >= minPar && spec.par <= maxPar, `${seed} 桥数 ${spec.par} 出了合理区间`);
    assert.ok(spec.par >= spec.islands.length, `${seed} 桥比岛还少，盘上全是 1`);
    assert.ok(spec.par <= g.lanes.length, 'par 不许超过可搭桥的道数');
    assert.equal(spec.bridges.length, spec.par, 'par 就是解里桥的总根数');
    assert.equal(spec.par > 0, true);
    const doubles = spec.bridges.length - new Set(spec.bridges.map(keyOf)).size;
    assert.ok(doubles >= minDoubles, `${seed} 只有 ${doubles} 处双桥，不像数桥`);
    for (const [x, y, c] of spec.islands) {
      assert.equal(isCell(x, y), true);
      assert.ok(c == null || (c >= 1 && c <= MAX_CLUE), `题面印了个 ${c}`);
    }
    assert.ok(spec.islands.some(([, , c]) => c == null), `${seed} 一个数字都没藏`);
    const { count, capped } = countSolutions(spec, 2);
    assert.equal(capped, false, `${seed} 没数完就别说唯一`);
    assert.equal(count, 1, `${seed} 数出 ${count} 个解`);
    assert.equal(validate(spec, spec.bridges), true, `${seed} 校验器不认自己交出去的解`);
    assert.equal(propagate(Int8Array.from(s), spec), true, `${seed} 真解过不了传播`);
    assert.deepEqual(candidatePairs(spec), spec.candidates, `${seed} 候选道与几何不一致`);
    assert.equal(JSON.parse(JSON.stringify(spec)) === undefined, false);
  }
  const spread = Math.max(...pars) - Math.min(...pars);
  assert.ok(spread >= 4, `${n}×${n} 四十道题的桥数挤在 ${Math.min(...pars)}..${Math.max(...pars)}，太单调`);
  assert.ok(new Set(isl).size >= 2, '岛数得在动');
}

test('入门 7×7：四十颗种子道道唯一解、自洽、岛够多、桥够密', () => {
  auditTier(7, 'u7', { minIslands: 8, minPar: 11, maxPar: 20, minDoubles: 1 });
});

test('熟手 9×9：四十颗种子道道唯一解、自洽、岛够多、桥够密', () => {
  auditTier(9, 'u9', { minIslands: 15, minPar: 20, maxPar: 32, minDoubles: 3 });
});

test('挑战 11×11：四十颗种子道道唯一解、自洽、岛够多、桥够密', () => {
  auditTier(11, 'u11', { minIslands: 19, minPar: 28, maxPar: 44, minDoubles: 5 });
});

test('题面不许出现 0 号岛与 9 以上：数字范围 1..8，每档都藏了数字', () => {
  for (const n of [7, 9, 11]) {
    let hiddenTotal = 0;
    let zeroClue = 0;
    let over = 0;
    for (const seed of SEEDS('clue', 12)) {
      const spec = gen(seed, n);
      for (const [, , c] of spec.islands) {
        if (c == null) hiddenTotal++;
        else { if (c === 0) zeroClue++; if (c > MAX_CLUE) over++; }
      }
    }
    assert.equal(zeroClue, 0, `${n}×${n} 印了 0：那座岛等于告诉玩家全部封死`);
    assert.equal(over, 0, `${n}×${n} 印了超过 ${MAX_CLUE} 的数字`);
    assert.ok(hiddenTotal >= 12, `${n}×${n} 十二道题一共只藏了 ${hiddenTotal} 个数字，删线索没干活`);
  }
});

test('保底路径永远交得出真题：5..12 每一档都自洽、唯一、还能一路搭完', async () => {
  const H = await internals();
  for (let n = 5; n <= 12; n++) {
    for (const [label, spec] of [['fallbackSpec', H.fallbackSpec(n)], ['borderChain', H.borderChainSpec(n, n)]]) {
      assert.ok(spec && spec.islands.length >= 4, `n=${n} ${label} 交白卷`);
      assert.equal(spec.n, n);
      assert.ok(spec.par > 0, `n=${n} ${label} par 是 0`);
      assert.equal(spec.bridges.length, spec.par);
      const { count, capped } = H.countSolutions(spec, 2);
      assert.equal(count, 1, `n=${n} ${label} 数出 ${count} 个解`);
      assert.equal(capped, false, `n=${n} ${label} 没数完`);
      assert.equal(H.validate(spec, spec.bridges), true, `n=${n} ${label} 题面与答案不自洽`);
      assert.ok(H.logicSolve(spec), `n=${n} ${label} 应当纯逻辑就推得完`);
      assert.ok(spec.islands.every(([, , c]) => c != null), `n=${n} ${label} 保底题面不许藏数字`);
      const e = H.create(JSON.parse(JSON.stringify(spec)));
      for (const [a, b] of spec.bridges) { tap(e, spec.islands[a]); tap(e, spec.islands[b]); }
      assert.equal(e.solved(), true, `n=${n} ${label} 照解搭完居然没赢`);
      assert.equal(e.stats().moves, spec.par, `n=${n} ${label} 落子次数不等于桥的根数`);
    }
  }
  // 兜底的兜底也得活着：四座岛的保底题面在任意档位都是那道 ⌐ 形
  const f5 = H.fallbackSpec(5);
  assert.equal(bag(f5.bridges), bag([[0, 1], [2, 3], [1, 3], [1, 3]]), '保底题面的形状是写死的，改坏了要在这里报警');
});

test('同一颗种子在任何设备上得到同一道题，spec 过一遍 JSON 也照样能通关', () => {
  for (const n of [7, 9, 11]) {
    const seed = 'daily:2026-09-27|hashi|' + n;
    const a = generate(seed, n);
    const b = generate(seed, n);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), b, `${n}×${n} 同种子不同题`);
    assert.equal(bag(a.bridges), bag(b.bridges));
    const e = create(JSON.parse(JSON.stringify(a)));
    assert.equal(validate(e.spec, e.spec.bridges), true, 'JSON 往返之后题面仍自洽');
    for (const [x, y] of a.islands) tap(e, [x, y]);                        // 副笔之类都不许在往返中丢
    const f = create(JSON.parse(JSON.stringify(a)));
    for (const [p, q] of a.bridges) { tap(f, a.islands[p]); tap(f, a.islands[q]); }
    assert.equal(f.solved(), true, '往返之后照解搭不完');
    assert.equal(f.stats().moves, a.par);
  }
});

test('不同种子的题面不会全一样：岛位、岛数与桥数都在动', () => {
  for (const n of [7, 9, 11]) {
    const specs = SEEDS('var', 8).map((s) => gen(s, n));
    assert.ok(new Set(specs.map((s) => s.islands.map(keyOf).join(';'))).size >= 7, `${n}×${n} 八道题撞车`);
    assert.ok(new Set(specs.map((s) => s.par)).size >= 3, `${n}×${n} 桥数一个都不变`);
    assert.ok(new Set(specs.map((s) => s.islands.filter(([, , c]) => c == null).length)).size >= 2);
  }
});

test('出题在手机上不卡：每档十道题各有预算', () => {
  const budget = { 7: 500, 9: 1000, 11: 2600 };
  for (const n of [7, 9, 11]) {
    const t0 = Date.now();
    for (const seed of SEEDS('time', 10)) generate(seed, n);
    const ms = Date.now() - t0;
    assert.ok(ms < budget[n], `${n}×${n} 十道题花了 ${ms}ms（预算 ${budget[n]}ms）`);
  }
});

// ---- 引擎状态机 ------------------------------------------------------------------

test('主笔：按住岛拖到对岸算一根桥，半路松手什么都不落', () => {
  const spec = gen('pen:0', 7);
  const g = geomOf(spec);
  const lane = g.lanes.find((l) => l.horiz && l.cells.length >= 2);
  const A = spec.islands[lane.a];
  const B = spec.islands[lane.b];
  const e = create(spec);
  assert.equal(dragTo(e, A, B, 1), false, '只拖过一格水面就松手：预览而已');
  assert.deepEqual(e.stats(), { moves: 0, par: spec.par, done: 0, total: spec.par });
  assert.equal(dragTo(e, A, B, 2), false, '差一岛不算数');
  assert.equal(e.stats().moves, 0);
  assert.equal(dragTo(e, A, B), true, '拖到对岸才结算');
  assert.deepEqual(e.stats(), { moves: 1, par: spec.par, done: 1, total: spec.par });
  assert.equal(dragTo(e, A, B), true, '同一对岛再来一次 = 第二根');
  assert.equal(e.stats().done, 2);
  assert.equal(dragTo(e, A, B), true, '已经双桥还想拖：拆一根，步数照收');
  assert.equal(e.stats().done, 1);
  assert.equal(e.stats().moves, 3);
  // 拖过去又拖回起笔的岛 = 擦掉这一根（一样不退款）
  const before = e.stats().moves;
  e.down(A[0], A[1], 0);
  e.move(lane.cells[0][0], lane.cells[0][1]);
  e.move(A[0], A[1]);
  assert.equal(e.up(), true);
  assert.equal(e.stats().done, 0);
  assert.equal(e.stats().moves, before + 1, '擦除也是输入');
});

test('一根桥 = 一次落子：点两下同一对岛搭一根，双桥就是两下两下', () => {
  const spec = gen('tap', 7);
  const e = create(spec);
  const g = geomOf(spec);
  const lane = g.lanes.find((l) => spec.bridges.some(([a, b]) => (a === lane_0(l, l)) ) || true);
  const [a, b] = spec.bridges[0];
  const other = g.lanes.find((l) => !(l.a === a && l.b === b) && !(l.a === b && l.b === a));
  assert.equal(tap(e, spec.islands[a]), false, '第一下只是把岛记成"上一手"');
  assert.equal(e.stats().moves, 0);
  assert.equal(tap(e, spec.islands[b]), true, '第二下配对成一根桥');
  assert.equal(e.stats().moves, 1);
  assert.equal(e.stats().done, 1);
  assert.equal(tap(e, spec.islands[a]) || tap(e, spec.islands[b]), true, '再点一轮 = 双桥');
  assert.equal(e.stats().moves, 3, '双桥是两次落子，不是一次');
  assert.equal(e.stats().done, 2);
  assert.equal(spec.par, spec.bridges.length, 'par = 桥的总根数（双桥算两根）');
  // 点两座不成道的岛：什么都不落，但"上一手"改挂在新的岛上
  const [c, d] = other.a < other.b ? [other.a, other.b] : [other.a, other.b];
  const pair = spec.bridges.map(([x, y]) => [Math.min(x, y), Math.max(x, y)]);
  const nonLane = g.lanes.length ? (() => {
    for (let p = 0; p < g.K; p++) for (let q = p + 1; q < g.K; q++) {
      if (!laneOfPair(g, p, q)) return [p, q];
    }
    return null;
  })() : null;
  assert.ok(nonLane, '候选图不是完全图，总有一对搭不成道');
  const m0 = e.stats().moves;
  assert.equal(tap(e, spec.islands[nonLane[0]]), false);
  assert.equal(tap(e, spec.islands[nonLane[1]]), false, '不是一对道的两下不许收钱');
  assert.equal(e.stats().moves, m0);
  assert.ok(pair.length === spec.bridges.length);
});
const lane_0 = (l) => l.a;

test('照解一根一根搭到通关：moves 正好用完 par，done/total 如实', () => {
  for (const n of [7, 9, 11]) {
    for (const seed of SEEDS('win', 3)) {
      const spec = gen(seed, n);
      const e = create(spec);
      let half = 0;
      for (const [a, b] of spec.bridges) {
        tap(e, spec.islands[a]);
        tap(e, spec.islands[b]);
        const st = e.stats();
        half++;
        assert.equal(st.done, half, `${seed}/${n} 第 ${half} 根桥没进 done`);
        assert.equal(st.moves, half, `${seed}/${n} 落子数与桥数脱钩了`);
        assert.equal(st.total, spec.par);
        assert.equal(st.par, spec.par);
        assert.equal(e.solved(), half === spec.par, '差一根就不许宣布通关');
      }
      assert.equal(e.solved(), true);
      assert.equal(e.stats().moves, spec.par);
      assert.equal(e.stats().done, spec.par);
      assert.ok(spec.par >= 11);
    }
  }
});

test('判胜之后锁盘：改笔必须走撤销', () => {
  const spec = gen('lock', 7);
  const e = create(spec);
  for (const [a, b] of spec.bridges) { tap(e, spec.islands[a]); tap(e, spec.islands[b]); }
  assert.equal(e.solved(), true);
  const before = e.stats();
  const [a, b] = spec.bridges[0];
  assert.equal(e.down(spec.islands[a][0], spec.islands[a][1], 0), false, '锁盘之后主笔不吃');
  assert.equal(e.down(spec.islands[b][0], spec.islands[b][1], 1), false, '副笔也不吃');
  assert.equal(e.move(3, 3), false);
  assert.equal(e.up(), false);
  assert.deepEqual(e.stats(), before);
  assert.equal(e.hint(), null, '赢了没得提示');
  assert.equal(e.undo(), true, '想改笔只能撤销');
  assert.equal(e.solved(), false);
  assert.equal(e.stats().done, before.done - 1);
  tap(e, spec.islands[a]);
  tap(e, spec.islands[b]);
  assert.equal(e.solved(), true, '改回原样仍然通关');
});

test('撤销绝不退款：盘面回到零，moves 还是 1；redo 把盘面搬回来', () => {
  const spec = gen('undo', 7);
  const e = create(spec);
  const [a, b] = spec.bridges[0];
  tap(e, spec.islands[a]);
  tap(e, spec.islands[b]);
  assert.equal(e.stats().moves, 1);
  assert.equal(e.canUndo(), true);
  assert.equal(e.canRedo(), false);
  assert.equal(e.undo(), true);
  assert.deepEqual(e.stats(), { moves: 1, par: spec.par, done: 0, total: spec.par },
    '撤销只搬盘面，已经花掉的笔数收不回来');
  assert.equal(e.solved(), false);
  assert.equal(e.undo(), false, '空历史别硬编');
  assert.equal(e.canRedo(), true);
  assert.equal(e.redo(), true);
  assert.equal(e.stats().done, 1, '重做把桥放回去');
  assert.equal(e.stats().moves, 1, '重做也不额外收钱');
  assert.equal(e.redo(), false);
  // 连着搭五根再全撤：moves 一格不少
  const e2 = create(spec);
  for (const [x, y] of spec.bridges.slice(0, 5)) { tap(e2, spec.islands[x]); tap(e2, spec.islands[y]); }
  const spent = e2.stats().moves;
  assert.equal(spent, 5);
  for (let i = 0; i < 5; i++) assert.equal(e2.undo(), true);
  assert.equal(e2.stats().done, 0);
  assert.equal(e2.stats().moves, spent, '撤销绝不退款（契约里为这条翻过一次车）');
  for (let i = 0; i < 5; i++) assert.equal(e2.redo(), true);
  assert.equal(e2.stats().done, 5);
  assert.equal(e2.stats().moves, spent);
  // 新落子清空 redo 栈
  tap(e2, spec.islands[a]);
  tap(e2, spec.islands[b]);
  e2.undo();
  assert.equal(e2.canRedo(), true);
  tap(e2, spec.islands[a]);
  tap(e2, spec.islands[b]);
  assert.equal(e2.canRedo(), false, '落新子之后 redo 栈必须作废');
});

test('副笔：封道与"凑齐"记号不计步、也不算成桥', () => {
  const spec = gen('pen2', 7);
  const e = create(spec);
  const g = geomOf(spec);
  const lane = g.lanes.find((l) => l.cells.length && !spec.bridges.some(([x, y]) => (x === l.a && y === l.b)));
  const cell = lane.cells[0];
  assert.equal(e.down(cell[0], cell[1], 1), true, '副笔点空水道 = 记一笔"这条道不搭"');
  assert.deepEqual(e.stats(), { moves: 0, par: spec.par, done: 0, total: spec.par }, '记号不计步');
  assert.equal(validate(spec, [[lane.a, lane.b]]), false, '记号不算桥');
  assert.equal(e.down(cell[0], cell[1], 1), true, '再点一次擦记号');
  assert.equal(e.down(spec.islands[0][0], spec.islands[0][1], 1), true, '副笔点岛 = 标"这座岛凑齐了"');
  assert.equal(e.stats().moves, 0);
  assert.equal(e.canUndo(), true, '记号也进历史，撤销能擦');
  e.undo();
  // 已经搭了桥的道不许再记号（点记号不如直接改桥）；交叉格压着两条道也不许猜
  const busy = g.lanes.find((l) => spec.bridges.some(([x, y]) => (x === l.a && y === l.b)));
  const [ba, bb] = [busy.a, busy.b];
  tap(e, spec.islands[ba]);
  tap(e, spec.islands[bb]);
  assert.equal(e.stats().done, 1);
  assert.equal(e.down(busy.cells[0][0], busy.cells[0][1], 1), false, '这条道已经有桥，副笔不受理');
  const cross = g.lanes.find((l) => g.cross[l.idx].length && l.cells.length && g.cross[l.idx].some((o) => g.lanes[o].cells.length));
  if (cross) {
    const o = g.lanes[g.cross[cross.idx].find((q) => g.lanes[q].cells.length)];
    const H = cross.horiz ? cross : o;
    const V = cross.horiz ? o : cross;
    assert.equal(e.down(V.fixed, H.fixed, 1), false, '交叉格上压着两条道，点不准就不许猜');
  }
  assert.equal(e.stats().moves, 1, '副笔的三次尝试一次都不收钱');
});

test('hint 必须真的落下桥，而且落的正是解里那一根', () => {
  for (const n of [7, 9, 11]) {
    const spec = gen('hint', n);
    const { g, s } = solutionState(spec);
    const e = create(spec);
    let guard = 0;
    let placedByHint = 0;
    while (!e.solved()) {
      assert.ok(guard++ < 60, `${n}×${n} hint 循环没收住`);
      const before = e.stats();
      const h = e.hint();
      if (!h) break;                                    // 死锁是已知缺陷，另有测试钉住
      assert.equal(h.cells.length, 1, '提示得指一个格心');
      const [hx, hy] = h.cells[0];
      assert.equal(isCell(hx, hy), true, '提示的坐标必须是格心（本玩法唯一的落子目标）');
      assert.ok(h.cells[0].length === 2);
      assert.ok(typeof h.note === 'string' && h.note.length > 0, '提示得说人话');
      const after = e.stats();
      assert.notDeepEqual({ m: before.moves, d: before.done }, { m: after.moves, d: after.done },
        'hint 返回了却没改棋盘');
      assert.equal(after.moves, before.moves + 1, '提示也只收一根桥的钱');
      const hit = g.lanes.filter((l) => l.mid[0] === hx && l.mid[1] === hy);
      assert.ok(hit.length >= 1, '提示指的格心不在任何道上');
      assert.ok(hit.some((l) => s[l.idx] >= after.done - before.done + s[l.idx]), '提示指的格心得是解里的道');
      placedByHint++;
    }
    assert.ok(placedByHint >= 1, `${n}×${n} 一个提示都没发出去`);
    // 提示的墨迹始终与唯一解相容：把 done 根桥拿去 validate，最多就是"还差几根"
    assert.equal(e.badCells().every(([x, y]) => isCell(x, y)), true, '报错的位子得落在格心上');
  }
});

test('已知缺陷①：提示落在双桥上只放一根，再问 hint() 就空手（hashi.js:1064）', async () => {
  // 现象：hint 求出一条与墨迹相容的解，然后只 addBridge 一次。若那条道在解里是双桥，
  // 盘面就停在"半根双桥"上 —— 这一手与唯一解矛盾，下一次 hint 的 solveOne 直接空手，
  // 玩家按提示按钮什么也不会发生。契约要求 hint 必须真的落子，这里钉的是眼下的行为：
  // 修好之后（提示一次补满、或按"至少 count"求墨迹）这条测试就该红。
  let found = null;
  for (const seed of SEEDS('hintbug', 20)) {
    const spec = gen(seed, 7);
    const e = create(spec);
    const h1 = e.hint();
    assert.ok(h1, `${seed} 第一个提示就是空手`);
    const h2 = e.hint();
    if (h2 === null && !e.solved()) { found = { spec, e, h1 }; break; }
  }
  assert.ok(found, '二十颗种子都没撞上"提示只放半根双桥"，说明这条缺陷记录得改');
  const { spec, e, h1 } = found;
  const { g, s } = solutionState(spec);
  const hit = g.lanes.filter((l) => l.mid[0] === h1.cells[0][0] && l.mid[1] === h1.cells[0][1]);
  assert.ok(hit.every((l) => s[l.idx] === DOUBLE), '卡住的那一手，解里必须是双桥');
  assert.equal(e.stats().done, 1, '只落下了一根');
  assert.equal(e.solved(), false);
  assert.equal(validate(spec, spec.bridges), true, '题面没问题，是提示自己把玩家带进死胡同');
  // 玩家自己补上第二根，hint 立刻又活着 —— 证明卡住的原因是盘面，不是求解器坏了
  const [a, b] = [hit[0].a, hit[0].b];
  tap(e, spec.islands[a]);
  tap(e, spec.islands[b]);
  assert.equal(e.stats().done, 2);
  assert.notEqual(e.hint(), null, '补满双桥之后 hint 应该又能问出东西');
  e.undo();
  e.undo();
  assert.equal(e.stats().done, 0);
  assert.ok(e.hint(), '撤销掉半根双桥之后 hint 也当恢复');
});

test('已知缺陷②：竖桥的方向索引把"往下"整个丢了（hashi.js:132）', () => {
  // buildGeom 的 put() 用 qx > px 判方向，竖道两端 px === qx ⇒ 永远算成"往上"：
  // dirs[p].v1 全是 -1（向下拖永远作废），而 dirs[p].vm1 会被同列后处理的那条道顶掉
  // （往上拖，桥却搭到下面那座岛）。这里钉的是眼下行为，修好后本测试必须红。
  const spec = gen('dirs', 9);
  const g = geomOf(spec);
  for (let p = 0; p < g.K; p++) {
    assert.equal(g.dirs[p].v1, -1, `岛 ${p} 的"往下"方向本应为某条竖道，现在恒为 -1`);
    for (const k of g.islandLanes[p]) {
      const l = g.lanes[k];
      if (!l.horiz) continue;
      const [px] = g.pos[p];
      const [qx] = g.pos[l.a === p ? l.b : l.a];
      assert.equal(g.dirs[p][qx > px ? 'h1' : 'hm1'], k, '横桥的方向索引是对的，缺陷只在竖桥');
    }
  }
  // 用公开 API 复现：一座岛同时有上、下两条竖道，往上拖一根桥，落点却在下面那条道
  const sp = handSpec([[3, 7, null], [3, 3, null], [3, 11, null]]);
  const gg = geomOf(sp);
  const up = laneOfPair(gg, 0, 1);
  const down = laneOfPair(gg, 0, 2);
  const e = create(sp);
  assert.equal(dragTo(e, sp.islands[0], sp.islands[2]), false, '往下拖：这一笔直接作废，什么也不落');
  assert.equal(e.stats().done, 0);
  assert.equal(dragTo(e, sp.islands[0], sp.islands[1]), true, '往上拖：落子判定"成功"');
  assert.equal(e.stats().done, 1);
  assert.equal(e.down(up.cells[0][0], up.cells[0][1], 0), false, '上面那条道其实空的 —— 桥没搭在它身上');
  assert.equal(e.stats().done, 1);
  assert.equal(e.down(down.cells[0][0], down.cells[0][1], 0), true, '桥落在了下面的岛上：手指朝北，桥朝南');
  assert.equal(e.stats().done, 0);
});

test('badCells 点出超数的岛与相交的桥；已知缺陷：撤销之后缓存不刷新', () => {
  const spec = gen('bad', 7);
  const g = geomOf(spec);
  const e = create(spec);
  assert.equal(e.badCells().length, 0, '空盘不该有错');
  // 找一座数字为 1 且有两条道的岛：搭满就是 1，再多一根就得赭
  const p = g.islandLanes.findIndex((ls, q) => spec.islands[q][2] === 1 && ls.length >= 2);
  assert.ok(p >= 0, '题面里得有一座数字 1 的岛');
  const l0 = g.lanes[g.islandLanes[p][0]];
  tap(e, spec.islands[l0.a]);
  tap(e, spec.islands[l0.b]);
  assert.deepEqual(e.badCells(), [], '数字 1 正好满足');
  const l1 = g.lanes[g.islandLanes[p][1]];
  tap(e, spec.islands[l1.a]);
  tap(e, spec.islands[l1.b]);
  const bad = e.badCells();
  assert.ok(bad.some(([x, y]) => x === g.pos[p][0] && y === g.pos[p][1]), '超数的岛必须被点出来');
  assert.equal(bad.every(([x, y]) => isCell(x, y)), true);
  assert.equal(e.solved(), false);
  e.undo();
  // 已知缺陷：back() 只置 dirty，不置 badStale —— 撤销之后报错的岛还红着（hashi.js:862）
  assert.deepEqual(e.badCells(), bad, '撤销后 badCells 仍返回旧缓存（修好后这里应变成 []）');
  tap(e, spec.islands[l1.a]);
  tap(e, spec.islands[l1.b]);
  e.undo();
  e.undo();
  e.redo();
  e.undo();                                   // 再走一手新墨迹，缓存才失效
  assert.equal(e.badCells().length, 0, '下一次真落子之后 badCells 才重新算');
  // 十字相交：把两条相交的道各搭一根，交叉那个格心得被点出来
  const pin = handSpec([[1, 5, null], [9, 5, null], [5, 1, null], [5, 9, null]]);
  const e2 = create(pin);
  tap(e2, pin.islands[0]);
  tap(e2, pin.islands[1]);
  assert.deepEqual(e2.badCells(), [], '一根桥没有相交');
  tap(e2, pin.islands[2]);
  tap(e2, pin.islands[3]);
  assert.deepEqual(e2.badCells(), [[5, 5]], '交叉点是个空格心，得报出来');
  assert.equal(e2.solved(), false);
  // 超数与相交同时存在时两条都要报
  const both = handSpec([[1, 5, 1], [9, 5, 1], [5, 1, 1], [5, 9, 1]]);
  const e3 = create(both);
  for (const i of [0, 1, 2, 3]) tap(e3, both.islands[i]);
  assert.ok(e3.badCells().length >= 3, `两条相交桥 + 四座岛全部超数，badCells 只给了 ${JSON.stringify(e3.badCells())}`);
});

test('玩法元数据齐全：外壳渲染首页要用到每个字段', () => {
  assert.equal(hashi.id, 'hashi');
  assert.equal(hashi.title, '数桥');
  assert.equal(hashi.latin, 'HASHI');
  assert.ok(hashi.tagline && hashi.tagline.length > 4);
  assert.equal(hashi.unit, '根', '一根桥一次落子：计量单位必须是"根"');
  assert.ok(hashi.rules.length >= 3);
  assert.ok(hashi.rules.some((r) => /连通|一张/.test(r)), '规则里得写清"数字全对不连通照样错"');
  assert.ok(hashi.rules.some((r) => /\?|问号|藏/.test(r)), '规则里得交代空心盘是被藏起来的数字');
  assert.deepEqual(hashi.sizes.map((s) => s.key), [7, 9, 11]);
  for (const s of hashi.sizes) {
    assert.ok(s.key && s.label && s.tier, JSON.stringify(s));
    assert.equal(s.label, s.key + '×' + s.key);
    assert.equal(typeof generate('meta', s.key).par, 'number');
  }
  assert.equal(hashi.sizes.map((s) => s.tier).join('/'), '入门/熟手/挑战');
  assert.equal(typeof hashi.generate, 'function');
  assert.equal(typeof hashi.create, 'function');
  assert.equal(hashi.generate('meta', 7).par > 0, true);
});

test('引擎不碰 DOM、时钟与随机数：源码里不许出现这些东西', () => {
  const src = fs.readFileSync(new URL('../js/puzzles/hashi.js', import.meta.url), 'utf8');
  for (const bad of ['Date', 'Math.random', 'performance', 'document', 'window', 'localStorage', 'setTimeout']) {
    assert.equal(src.includes(bad), false, `引擎里出现了 ${bad}`);
  }
  assert.ok(src.includes("from '../core/rng.js'"), '随机只能来自 rngFrom(seed)');
  assert.ok(!src.includes("from '../ui/"), '引擎只准 import js/core/*');
  // 快照里不许带 moves：带了就等于撤销退款（契约事故复盘）
  const snap = src.slice(src.indexOf('const snap = () =>'), src.indexOf('const back ='));
  assert.ok(snap.length > 10 && !snap.includes('moves'), 'snap() 里出现了 moves');
  assert.ok(/future\.push\(snap\(\)\)/.test(src), 'redo 栈也走同一份快照，同样退不了款');
});
