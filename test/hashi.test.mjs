// 数桥的三道保险（与 slitherlink.test.mjs 同立场）：
//   1) 生成器不许说谎 —— 发出去的题必须 count===1 && !capped，而且要用独立的 validate
//      复核一遍求解器的产物：每座岛桥头数吻合、图是一张、一对岛 ≤2 根、桥不相交。
//   2) moves 的口径是"一根桥 = 一次落子"（双桥是两次落子），par 就是解里桥的总根数；
//      擦除、改画、撤销一律不退款 —— snap() 里不许出现 moves。
//   3) 引擎是个纯状态机 —— 只用公开 API 走子；赢了锁盘；副笔的记号不计步。
//
// 另有两条回归测试钉的是曾经真坏过的地方：buildGeom 的 dirs 方向表（竖道拿 x 比方向 ⇒ 一半的
// 桥从这头静默拖不出去），以及 propagate 的余量（单桥不是终局，把"双桥画到一半"当填不满的缺口，
// solveOne 带着合法墨迹摊手、提示跟着失效）。

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
const key = (hx, hy) => hy * 1024 + hx;
const bag = (pairs) => pairs.map(([a, b]) => (a < b ? a + '-' + b : b + '-' + a)).sort().join('|');
const handSpec = (islands, n = 5) => ({ n, m: n, islands });
const laneOfPair = (g, a, b) => g.lanes.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
const stOf = (g, init = {}) => {
  const s = new Int8Array(g.lanes.length).fill(UNKNOWN);
  for (const k of Object.keys(init)) s[+k] = init[k];
  return s;
};
// 出题是全文件最贵的一步（11×11 一颗种子约 60ms），同一颗种子只发一次，后面的测试共用
const memo = new Map();
const gen = (seed, n) => {
  const k = n + '@' + seed;
  if (!memo.has(k)) memo.set(k, generate(seed, n));
  return memo.get(k);
};
function solutionState(spec) {
  const g = geomOf(spec);
  const s = new Int8Array(g.lanes.length).fill(CLOSED);
  for (const [a, b] of spec.bridges) s[laneOfPair(g, a, b).idx] += 1;
  return { g, s };
}
const tap = (e, p) => { e.down(p[0], p[1], 0); return e.up(); };
function dragTo(e, A, B, stopAt = Infinity) {
  e.down(A[0], A[1], 0);
  const dx = Math.sign(B[0] - A[0]) * 2;
  const dy = Math.sign(B[1] - A[1]) * 2;
  let x = A[0]; let y = A[1]; let n = 0;
  while ((x !== B[0] || y !== B[1]) && n < stopAt) { x += dx; y += dy; n++; e.move(x, y); }
  return e.up();
}

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

test('岛号 ↔ 格心半坐标 ↔ 编号 三套口径互相咬合，岛不落在格心上就不算题面', () => {
  const spec = gen('u7:0', 7);
  const g = geomOf(spec);
  assert.equal(g.K, spec.islands.length);
  assert.deepEqual([g.n, g.m], [spec.n, spec.m]);
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
  assert.equal(islandAt(spec, 2 * spec.n - 1, 2 * spec.m - 1) >= -1, true);
  assert.equal(islandCellOf(2, 3), null, '非格心坐标给不出岛');
  assert.deepEqual(islandHalfOf(0, 0), cellAt(0, 0), '换坐标工具交出去的必是 (奇, 奇)');
  assert.equal(geomOf(handSpec([[2, 2, 1], [5, 1, 1]], 5)), null, '岛落在点上');
  assert.equal(geomOf(handSpec([[1, 2, 1], [5, 2, 1]], 5)), null, '岛落在横边上');
  assert.equal(geomOf(handSpec([[1, 1, 1], [1, 1, 1]], 5)), null, '两座岛叠格');
  assert.equal(geomOf(handSpec([[1, 1, 1], [3, 3, 1]], 5)), null, '斜着对望，一道也搭不出来');
  assert.throws(() => create(handSpec([[1, 1, 1], [3, 3, 1]], 5)), /题面不合法/);
});

test('候选道只在同排同列的相邻两岛之间：中间每一格都是空水面', () => {
  for (const n of [7, 9]) {
    const spec = gen('u' + n + ':1', n);
    const g = geomOf(spec);
    assert.deepEqual(candidatePairs(spec), spec.candidates, 'candidatePairs 与题面 candidates 必须同一份');
    assert.equal(new Set(spec.candidates.map(keyOf)).size, spec.candidates.length, '同一对岛不许出现两条道');
    const at = new Map(spec.islands.map(([x, y], p) => [keyOf([x, y]), p]));
    for (const lane of g.lanes) {
      const [ax, ay] = g.pos[lane.a];
      const [bx, by] = g.pos[lane.b];
      assert.notEqual(lane.a, lane.b);
      if (lane.horiz) {
        assert.equal(ay, by, '横道两端同排');
        assert.deepEqual([lane.lo, lane.hi], [Math.min(ax, bx), Math.max(ax, bx)]);
      } else {
        assert.equal(ax, bx, '竖道两端同列');
        assert.deepEqual([lane.lo, lane.hi], [Math.min(ay, by), Math.max(ay, by)]);
      }
      assert.ok(lane.hi - lane.lo >= 2, '两岛之间至少留一格水面');
      assert.ok(lane.cells.length >= 1, '生成盘的每道桥都有桥身可点');
      assert.equal(lane.cells.length, (lane.hi - lane.lo) / 2 - 1, '中间格得摊满两端之间');
      assert.ok(lane.cells.some((c) => c[0] === lane.mid[0] && c[1] === lane.mid[1]), 'mid 必须在这条道的水面上');
      for (const c of lane.cells) {
        assert.equal(isCell(c[0], c[1]), true);
        assert.equal(at.has(keyOf(c)), false, `桥中间撞到了第三座岛 ${keyOf(c)}`);
        const inRange = lane.horiz
          ? (c[1] === ay && c[0] > Math.min(ax, bx) && c[0] < Math.max(ax, bx))
          : (c[0] === ax && c[1] > Math.min(ay, by) && c[1] < Math.max(ay, by));
        assert.equal(inRange, true, '中间格必须落在两端之间');
        assert.ok(g.cellLanes.get(key(c[0], c[1])).includes(lane.idx), '交叉索引得认得这条道');
      }
      for (let p = 0; p < g.K; p++) {
        const has = g.islandLanes[p].includes(lane.idx);
        assert.equal(has, p === lane.a || p === lane.b, '一条道只挂自己两端两座岛');
      }
    }
    for (const ks of g.cellLanes.values()) assert.ok(ks.length >= 1 && ks.length <= 2, '一格水面最多压两条道');
  }
});

test('中间隔着岛就不是道：跨岛长桥 validate 判死；相邻两岛之间照样算道', () => {
  const blocked = handSpec([[1, 1, 2], [9, 1, 2], [5, 1, null]]);   // 三岛同排，中间那座挡道
  const g = geomOf(blocked);
  assert.deepEqual(candidatePairs(blocked), [[0, 2], [2, 1]], '只许看得见邻居：0-1 中间压着岛 2');
  assert.equal(laneOfPair(g, 0, 1), undefined, '0-1 不许成道');
  assert.equal(validate(blocked, [[0, 1], [2, 1], [2, 1]]), false, '桥穿过别人的岛 = 错题');
  assert.equal(validate(blocked, [[0, 2], [2, 1], [0, 2], [2, 1]]), true, '两条都搭双桥才是解');
  const { count, capped } = countSolutions(blocked, 2);
  assert.deepEqual([count, capped], [1, false], '这种料唯一性是白给的：每座岛只剩一条道');
  const snug = handSpec([[1, 1, 1], [3, 1, 1]]);
  assert.deepEqual(candidatePairs(snug), [[0, 1]]);
  assert.equal(laneOfPair(geomOf(snug), 0, 1).cells.length, 0, '邻岛之道没有桥身');
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
  assert.deepEqual([V.fixed, H.fixed], [5, 5], '交叉点必是个空格心');
  assert.equal(validate(pin, [[H.a, H.b], [V.a, V.b]]), false, 'validate 也得拒绝这一对');
  assert.equal(validate(pin, [[H.a, H.b]]), false, '只搭一根：另两座岛成了孤岛');
  for (const spec of [gen('u7:2', 7), gen('u9:2', 9), gen('u11:2', 11)]) {
    const gg = geomOf(spec);
    const on = new Set(spec.bridges.map(keyOf));
    for (const lane of gg.lanes) {
      for (const o of gg.cross[lane.idx]) {
        if (lane.idx >= o) continue;
        const other = gg.lanes[o];
        const probe = handSpec(spec.islands.map(([x, y], p) =>
          [x, y, p === lane.a || p === lane.b || p === other.a || p === other.b ? 1 : null]), spec.n);
        assert.equal(validate(probe, [[lane.a, lane.b], [other.a, other.b]]), false,
          `${spec.n}: 相交的两根桥 validate 必须判死`);
      }
    }
    const used = gg.lanes.filter((l) => on.has(keyOf([l.a, l.b])));
    for (const A of used.filter((l) => l.horiz)) {
      for (const B of used.filter((l) => !l.horiz)) {
        assert.ok(!(A.fixed > B.lo && A.fixed < B.hi && B.fixed > A.lo && B.fixed < A.hi), '解里的桥不许相交');
      }
    }
  }
});

test('不认识的奇偶一律原样退回：点、横边、竖边都不许改状态', () => {
  const spec = gen('u7:3', 7);
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
  assert.ok(edgeSides(...(targets.find(([x, y]) => isHEdge(x, y))), spec.n, spec.m).some((s) => s));
  assert.equal(e.step, 2, '格心玩法：键盘一次挪两个半格');
  assert.deepEqual(e.board, { cols: spec.n, rows: spec.m, margin: { l: 0, t: 0, r: 0, b: 0 } });
});

test('propagate: 数字凑齐了，这座岛其余的道一律封死', () => {
  const plus = handSpec([[5, 5, 2], [1, 5, 1], [9, 5, 1], [5, 1, 0], [5, 9, 0]]);
  const g = geomOf(plus);
  assert.equal(g.islandLanes[0].length, 4);
  const s = stOf(g);
  s[laneOfPair(g, 0, 1).idx] = SINGLE;
  s[laneOfPair(g, 0, 2).idx] = SINGLE;
  assert.equal(propagate(s, plus), true);
  assert.equal(s[laneOfPair(g, 0, 3).idx], CLOSED, '数字满了还想搭 = 矛盾');
  assert.equal(s[laneOfPair(g, 0, 4).idx], CLOSED);
  assert.equal(s[laneOfPair(g, 0, 1).idx], SINGLE, '已经落子的不许被改');
  const s2 = stOf(g, { [laneOfPair(g, 0, 3).idx]: CLOSED, [laneOfPair(g, 0, 4).idx]: CLOSED });
  assert.equal(propagate(s2, plus), true);
  assert.equal(s2[laneOfPair(g, 0, 1).idx], SINGLE);
  assert.equal(s2[laneOfPair(g, 0, 2).idx], SINGLE);
});

test('propagate: 缺口正好等于各道上限就顶格搭，只剩一个桥头就不许双', () => {
  const d = handSpec([[1, 1, 2], [9, 1, 2]]);
  const dg = geomOf(d);
  const ds = stOf(dg);
  assert.equal(propagate(ds, d), true);
  assert.equal(ds[0], DOUBLE, '一条道扛满两个桥头 = 只能是双桥');
  const one = handSpec([[1, 1, 1], [9, 1, 1]]);
  const os = stOf(geomOf(one));
  assert.equal(propagate(os, one), true);
  assert.equal(os[0], SINGLE, '数字 1 的岛挂不起双桥');
  const t = handSpec([[1, 1, 2], [9, 1, 2], [1, 9, 1], [5, 9, 1]]);
  const tg = geomOf(t);
  assert.deepEqual(tg.lanes.map((l) => [l.a, l.b]), [[0, 1], [2, 3], [0, 2]]);
  const ts = stOf(tg, { [laneOfPair(tg, 0, 2).idx]: CLOSED });
  assert.equal(propagate(ts, t), true);
  assert.equal(ts[laneOfPair(tg, 0, 1).idx], DOUBLE, '缺口 2 摊在唯一一条道上');
  assert.equal(ts[laneOfPair(tg, 2, 3).idx], SINGLE, '数字 1 的那头不许被顶成双桥');
  assert.equal(propagate(stOf(geomOf(d)), handSpec([[1, 1, 3], [9, 1, 3]])), false);
  for (const n of [7, 9, 11]) {
    for (const seed of SEEDS('u' + n, 4)) {
      const spec = gen(seed, n);
      const { g, s } = solutionState(spec);
      const st = stOf(g);
      assert.equal(propagate(st, spec), true, `${seed}/${n} 空盘就被判死？`);
      for (const lane of g.lanes) {
        if (st[lane.idx] !== UNKNOWN) {
          assert.equal(st[lane.idx], s[lane.idx], `${seed}/${n}: 第 ${lane.idx} 条道被推成了 ${st[lane.idx]}，解里是 ${s[lane.idx]}`);
        }
      }
    }
  }
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
  const numbered = handSpec([[1, 5, 1], [9, 5, 1], [5, 1, null], [5, 9, null], [1, 1, null], [9, 9, null]]);
  const ng = geomOf(numbered);
  const ns = stOf(ng, { [laneOfPair(ng, 0, 1).idx]: SINGLE });
  assert.equal(propagate(ns, numbered), true);
  assert.equal(ns[laneOfPair(ng, 2, 3).idx], CLOSED);
  const tiny = handSpec([[1, 5, null], [9, 5, null], [5, 1, null], [5, 9, null]]);
  const both = stOf(geomOf(tiny), { 0: SINGLE, 1: SINGLE });
  assert.equal(propagate(both, tiny), false);
});

test('propagate 把矛盾如实吞掉：超数、填不满、把藏数字的岛封成孤岛', () => {
  // 第四座岛是必需的：岛 1、2 若只有一条道可走，题面本身就无解，那是夹具的错不是引擎的错
  const sp = handSpec([[1, 1, 1], [9, 1, 2], [1, 9, 2], [9, 9, 3]]);
  const g = geomOf(sp);
  assert.equal(propagate(stOf(g, { [laneOfPair(g, 0, 1).idx]: DOUBLE }), sp), false,
    '数字 1 的岛搭了双桥 = 桥头超了证词');
  assert.equal(propagate(stOf(g), handSpec([[1, 1, 9], [9, 1, 9], [1, 9, 9]])), false,
    '一条道最多两根，9 个缺口填不满');
  const hidden = handSpec([[1, 1, null], [9, 1, 1]]);
  const hg = geomOf(hidden);
  assert.equal(propagate(stOf(hg, { 0: CLOSED }), hidden), false, '藏了数字的岛所有道封死 = 孤岛，照样矛盾');
  assert.equal(propagate(stOf(hg), hidden), true, '同一份题面没动墨迹就不该被判死');
  assert.equal(propagate(stOf(g), sp), true, '没写字的盘永远不是死局');
  // 双桥搭到一半不是矛盾：单桥还能再吃一根，谁也不该因此摊手（solveOne 与 hint 都靠这条）。
  // 夹具本身得有解：岛 1 只有 (0,1) 一条道且数字 1，岛 2 只有 (0,2) 一条道且数字 2 ⇒ 后者必是双桥
  const half = handSpec([[1, 1, 3], [9, 1, 1], [1, 9, 2]]);
  const hg2 = geomOf(half);
  const hs = stOf(hg2, { [laneOfPair(hg2, 0, 2).idx]: SINGLE });
  assert.equal(propagate(hs, half), true, '半根双桥被当成填不满的缺口 = 求解器带着合法墨迹罢工');
  assert.equal(hs[laneOfPair(hg2, 0, 2).idx], DOUBLE, '岛 2 的唯一一条道还差一个桥头，就该长成双桥');
  assert.equal(hs[laneOfPair(hg2, 0, 1).idx], SINGLE);
});

test('validate 认解：每座岛桥头数吻合、图是一张、每对 ≤2 根、桥不相交', () => {
  const spec = gen('u9:4', 9);
  assert.equal(validate(spec, spec.bridges), true);
  assert.equal(validate(spec, spec.bridges.slice(0, -1)), false, '少一根桥：数字与连通性都得拦');
  assert.equal(validate(spec, spec.bridges.slice().reverse()), true, '顺序无关');
  const g = geomOf(spec);
  const free = g.lanes.find((l) => !spec.bridges.some(([a, b]) => a === l.a && b === l.b));
  assert.equal(validate(spec, spec.bridges.concat([[free.a, free.b]])), false,
    '多搭一根必然顶破某座岛的证词');
  assert.ok(spec.islands.some(([, , c]) => c == null), '这道题藏了数字才好验下一句');
  const blind = handSpec(spec.islands.map(([x, y]) => [x, y, null]), spec.n);
  assert.equal(validate(blind, spec.bridges), true, '没印数字时只剩连通与几何两道关卡');
  assert.equal(validate(blind, spec.bridges.filter((_, i) => i % 2)), false, '抹掉数字也不许把半张图当成解');
});

test('validate 拒绝"每座岛数字都对却不连成一张"——数桥最经典的那个坑', () => {
  const sq = handSpec([[1, 1, 2], [5, 1, 2], [1, 5, 2], [5, 5, 2]]);
  assert.deepEqual(candidatePairs(sq), [[0, 1], [2, 3], [0, 2], [1, 3]]);
  assert.equal(validate(sq, [[0, 1], [1, 3], [3, 2], [2, 0]]), true, '一圈单桥是解');
  assert.equal(validate(sq, [[0, 1], [0, 1], [2, 3], [2, 3]]), false, '数字全对但分成两堆');
  assert.equal(validate(sq, [[0, 2], [0, 2], [1, 3], [1, 3]]), false, '换个方向也一样');
  assert.equal(validate(sq, [[0, 1], [0, 1], [2, 3]]), false, '缺一条边 = 一座岛数字也不对');
  const { count, capped } = countSolutions(sq, 3);
  assert.deepEqual([count, capped], [1, false], '两堆的摆法在求解器里也必须不成立');
});

test('validate 的反例清单：斜桥、第三根桥、越界的岛、非法岛号', () => {
  const spec = gen('u7:5', 7);
  const K = spec.islands.length;
  assert.equal(validate(spec, [[0, 1], [1, 0], [0, 1], [0, 1]]), false, '一对岛最多两根平行桥');
  const first = spec.islands[0];
  const far = spec.islands.findIndex(([x, y]) => x !== first[0] && y !== first[1]);
  assert.ok(far > 0);
  assert.equal(validate(spec, [[0, far]]), false, '斜着不叫桥');
  assert.equal(validate(spec, [[0, 0]]), false, '自己搭到自己身上');
  assert.equal(validate(spec, [[0, K], [1, -1], [K + 5, 2]]), false, '岛号出界');
  assert.equal(validate(spec, 'nope'), false, '不是数组直接否');
  assert.equal(validate(null, []), false);
  assert.equal(validate({ n: 5, islands: [] }, []), false, '没有岛就不叫题');
  assert.equal(validate(handSpec([[2, 2, 1], [5, 1, 1]]), [[0, 1]]), false, '岛压在点上');
  assert.equal(validate(handSpec([[1, 1, 1], [11, 1, 1]], 5), [[0, 1]]), false, '岛出了盘（2n-1=9）');
});

test('logicSolve 推得完的题，推出来的桥集与题面答案一字不差；spec.logical 不许说谎', async () => {
  let proven = 0;
  for (const n of [7, 9, 11]) {
    for (const seed of SEEDS('u' + n, 40)) {
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
  assert.ok(proven > 0, '120 颗种子里一道纯逻辑推得完的都没有，说明第一道闸门哑了');
  const H = await internals();
  for (const spec of [H.fallbackSpec(7), H.borderChainSpec(9, 9)]) {
    const sol = H.logicSolve(spec);
    assert.ok(sol, '保底题面必须纯逻辑推得完');
    assert.equal(bag(sol.bridges), bag(spec.bridges));
    assert.equal(spec.logical, true);
  }
});

test('countSolutions 不许说谎：两解如实报 2，没数完一律 capped，capped 不等于无解', () => {
  const two = handSpec([[1, 1, 3], [5, 1, 3], [1, 5, 3], [5, 5, 3]]);
  assert.equal(validate(two, [[0, 1], [0, 1], [0, 2], [1, 3], [2, 3], [2, 3]]), true);
  assert.equal(validate(two, [[0, 2], [0, 2], [1, 3], [1, 3], [0, 1], [2, 3]]), true);
  const all = countSolutions(two, 3);
  assert.equal(all.count, 2, '两个解就数出两个');
  assert.equal(all.capped, false, '数完了就不许喊累');
  const early = countSolutions(two, 2);
  assert.equal(early.count, 2);
  assert.equal(early.capped, true, '数到 cap 早停 = 没数完，必须 capped');
  const pin = handSpec([[1, 3, 1], [5, 3, 1], [3, 1, 1], [3, 5, 1]]);
  const none = countSolutions(pin, 2);
  assert.deepEqual([none.count, none.capped], [0, false], '走到尽头没找到 = 真无解，不是没数完');
  const spec = gen('u11:5', 11);
  assert.equal(countSolutions(spec, 2, null, 1).capped, true, '一步就被掐断，谁也不能宣布唯一');
  assert.deepEqual((({ count, capped }) => [count, capped])(countSolutions(spec, 2)), [1, false]);
  assert.equal(countSolutions({ n: 5, islands: [[2, 2, 1]] }, 2).capped, true, '不合法题面别装作数出来了');
});

test('带墨迹数解：解的一部分仍指向同一个唯一解，改错一根立刻没解', () => {
  for (const n of [7, 9, 11]) {
    for (const seed of SEEDS('u' + n, 6)) {
      const spec = gen(seed, n);
      const { g, s } = solutionState(spec);
      assert.equal(propagate(Int8Array.from(s), spec), true, '真解自己推不动就是传播规则撒了谎');
      assert.deepEqual((({ count, capped }) => [count, capped])(countSolutions(spec, 3, s)), [1, false],
        `${seed}/${n} 拿解当墨迹再数一遍`);
      const partly = Int8Array.from(s);
      for (const lane of g.lanes) if (lane.idx % 4 === 0) partly[lane.idx] = UNKNOWN;
      assert.deepEqual((({ count, capped }) => [count, capped])(countSolutions(spec, 2, partly)), [1, false],
        '留白也该数得出唯一解');
      const dbl = g.lanes.find((l) => s[l.idx] === DOUBLE);
      if (dbl) {
        const wrong = Int8Array.from(s);
        wrong[dbl.idx] = CLOSED;
        const r = countSolutions(spec, 2, wrong);
        assert.deepEqual([r.count, r.capped], [0, false], `${seed}/${n}：把双桥拆成 0 根就没了唯一解`);
      }
      const half = Int8Array.from(s);
      for (const lane of g.lanes) if (half[lane.idx] === DOUBLE) half[lane.idx] = SINGLE;
      const hr = countSolutions(spec, 2, half);
      assert.deepEqual([hr.count, hr.capped], [1, false], `${seed}/${n}：双桥画到一半是合法局面，求解器别罢工`);
      const one = solveOne(spec, partly);
      assert.ok(one);
      assert.equal(validate(spec, bridgeListOf(g, one)), true);
      assert.equal(bag(bridgeListOf(g, one)), bag(spec.bridges), '唯一解题里 solveOne 不许找出另一张图');
      for (const lane of g.lanes) if (partly[lane.idx] !== UNKNOWN) assert.equal(one[lane.idx], partly[lane.idx]);
    }
  }
});

function auditTier(n, { minIslands, minPar, maxPar, minDoubles }) {
  const pars = []; const isl = [];
  for (const seed of SEEDS('u' + n, 40)) {
    const spec = gen(seed, n);
    assert.ok(spec && Array.isArray(spec.islands), seed + ' 交白卷');
    assert.deepEqual([spec.n, spec.m], [n, n]);
    assert.ok(spec.islands.length >= minIslands, `${seed} 一桌只有 ${spec.islands.length} 座岛`);
    const { g, s } = solutionState(spec);
    pars.push(spec.par); isl.push(spec.islands.length);
    assert.ok(spec.par >= minPar && spec.par <= maxPar, `${seed} 桥数 ${spec.par} 出了合理区间`);
    assert.ok(spec.par >= spec.islands.length, `${seed} 桥比岛还少，盘上全是 1`);
    assert.ok(spec.par <= g.lanes.length, 'par 不许超过可搭桥的道数');
    assert.equal(spec.bridges.length, spec.par, 'par 就是解里桥的总根数');
    const doubles = spec.bridges.length - new Set(spec.bridges.map(keyOf)).size;
    assert.ok(doubles >= minDoubles, `${seed} 只有 ${doubles} 处双桥，不像数桥`);
    assert.ok(new Set(spec.islands.map(keyOf)).size === spec.islands.length);
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
    assert.ok(JSON.stringify(spec).length > 40, 'spec 得能 JSON.stringify（存档靠它）');
  }
  const spread = Math.max(...pars) - Math.min(...pars);
  assert.ok(spread >= 4, `${n}×${n} 四十道题的桥数挤在 ${Math.min(...pars)}..${Math.max(...pars)}，太单调`);
  assert.ok(new Set(isl).size >= 2, '岛数得在动');
}

test('入门 7×7：四十颗种子道道唯一解、自洽、岛够多、桥够密', () => {
  auditTier(7, { minIslands: 8, minPar: 11, maxPar: 20, minDoubles: 1 });
});
test('熟手 9×9：四十颗种子道道唯一解、自洽、岛够多、桥够密', () => {
  auditTier(9, { minIslands: 15, minPar: 20, maxPar: 32, minDoubles: 3 });
});
test('挑战 11×11：四十颗种子道道唯一解、自洽、岛够多、桥够密', () => {
  auditTier(11, { minIslands: 19, minPar: 28, maxPar: 44, minDoubles: 5 });
});

test('题面不许出现 0 号数字与 8 以上：每档都藏了一把手数字', () => {
  for (const n of [7, 9, 11]) {
    let hidden = 0; let visible = 0; let max = 0;
    for (const seed of SEEDS('u' + n, 24)) {
      for (const [, , c] of gen(seed, n).islands) {
        if (c == null) hidden++;
        else { visible++; assert.notEqual(c, 0, `${n}×${n} 印了 0：那座岛等于把全盘封死告诉玩家`); max = Math.max(max, c); }
      }
    }
    assert.ok(max <= MAX_CLUE);
    assert.ok(hidden >= 24, `${n}×${n} 二十四道题一共只藏了 ${hidden} 个数字，删线索没干活`);
    assert.ok(hidden < visible, `${n}×${n} 藏的数字比印出来的还多，玩家没抓手`);
  }
});

test('保底路径永远交得出真题：5..12 每一档都自洽、唯一、还能一路搭完', async () => {
  const H = await internals();
  for (let n = 5; n <= 12; n++) {
    for (const [label, spec] of [['fallbackSpec', H.fallbackSpec(n)], ['borderChain', H.borderChainSpec(n, n)]]) {
      assert.ok(spec && spec.islands.length >= 4, `n=${n} ${label} 交白卷`);
      assert.deepEqual([spec.n, spec.m], [n, n]);
      assert.ok(spec.par > 0, `n=${n} ${label} par 是 0`);
      assert.equal(spec.bridges.length, spec.par);
      const { count, capped } = H.countSolutions(spec, 2);
      assert.equal(count, 1, `n=${n} ${label} 数出 ${count} 个解`);
      assert.equal(capped, false, `n=${n} ${label} 没数完`);
      assert.equal(H.validate(spec, spec.bridges), true, `n=${n} ${label} 题面与答案不自洽`);
      assert.ok(H.logicSolve(spec), `n=${n} ${label} 保底题面应当纯逻辑就推得完`);
      assert.ok(spec.islands.every(([, , c]) => c != null), `n=${n} ${label} 保底题面不许藏数字`);
      const e = H.create(JSON.parse(JSON.stringify(spec)));
      for (const [a, b] of spec.bridges) { tap(e, spec.islands[a]); tap(e, spec.islands[b]); }
      assert.equal(e.solved(), true, `n=${n} ${label} 照解搭完居然没赢`);
      assert.equal(e.stats().moves, spec.par, `n=${n} ${label} 落子次数不等于桥的根数`);
    }
  }
  assert.equal(bag(H.fallbackSpec(7).bridges), bag([[0, 1], [2, 3], [1, 3], [1, 3]]));
});

test('同一颗种子在任何设备上得到同一道题，spec 过一遍 JSON 也照样能通关', () => {
  for (const n of [7, 9, 11]) {
    const seed = 'daily:2026-09-27|hashi|' + n;
    const a = generate(seed, n);
    const b = generate(seed, n);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), b, `${n}×${n} 同种子不同题`);
    assert.equal(bag(a.bridges), bag(b.bridges));
    assert.deepEqual(candidatePairs(a), candidatePairs(b));
    const spec = JSON.parse(JSON.stringify(a));
    const e = create(spec);
    assert.equal(validate(e.spec, e.spec.bridges), true, 'JSON 往返之后题面仍自洽');
    for (const [p, q] of spec.bridges) { tap(e, spec.islands[p]); tap(e, spec.islands[q]); }
    assert.equal(e.solved(), true, '往返之后照解搭不完');
    assert.equal(e.stats().moves, spec.par);
  }
});

test('不同种子的题面不会全一样：岛位、岛数与桥数都在动', () => {
  for (const n of [7, 9, 11]) {
    const specs = SEEDS('u' + n, 8).map((s) => gen(s, n));
    assert.ok(new Set(specs.map((s) => s.islands.map(keyOf).join(';'))).size >= 7, `${n}×${n} 八道题撞车`);
    assert.ok(new Set(specs.map((s) => s.par)).size >= 3, `${n}×${n} 桥数一个都不变`);
    assert.ok(new Set(specs.map((s) => s.islands.filter(([, , c]) => c == null).length)).size >= 2);
  }
});

test('出题在手机上不卡：每档十道题各有预算', () => {
  const budget = { 7: 900, 9: 1600, 11: 3600 };
  for (const n of [7, 9, 11]) {
    const t0 = Date.now();
    for (const seed of SEEDS('budget', 10)) generate(seed, n);
    const ms = Date.now() - t0;
    assert.ok(ms < budget[n], `${n}×${n} 十道题花了 ${ms}ms（预算 ${budget[n]}ms）`);
  }
});

test('主笔：按住岛拖到对岸算一根桥，半路松手什么都不落', () => {
  const spec = gen('u7:6', 7);
  const g = geomOf(spec);
  const lane = g.lanes.filter((l) => l.horiz && l.cells.length >= 1)
    .sort((p, q) => q.cells.length - p.cells.length)[0];
  assert.ok(lane, '这道 7×7 里连一条有桥身的横道都找不到');
  const A = spec.islands[lane.a]; const B = spec.islands[lane.b];
  const e = create(spec);
  assert.deepEqual(e.stats(), { moves: 0, par: spec.par, done: 0, total: spec.par });
  assert.equal(dragTo(e, A, B, 1), false, '只拖过一格水面就松手：预览而已');
  assert.deepEqual(e.stats(), { moves: 0, par: spec.par, done: 0, total: spec.par });
  assert.equal(dragTo(e, A, B, lane.cells.length), false, '差一岛不算数');
  assert.equal(e.stats().moves, 0);
  assert.equal(dragTo(e, A, B), true, '拖到对岸才结算');
  assert.deepEqual(e.stats(), { moves: 1, par: spec.par, done: 1, total: spec.par });
  assert.equal(dragTo(e, A, B), true, '同一对岛再来一次 = 第二根');
  assert.equal(e.stats().done, 2);
  assert.equal(dragTo(e, A, B), true, '已经双桥还想拖：拆一根，步数照收');
  assert.deepEqual([e.stats().done, e.stats().moves], [1, 3]);
  e.down(A[0], A[1], 0);
  e.move(lane.cells[0][0], lane.cells[0][1]);
  e.move(A[0], A[1]);
  assert.equal(e.up(), true);
  assert.deepEqual([e.stats().done, e.stats().moves], [0, 4], '擦除也是输入');
});

test('四个方向都拖得动：方向索引与几何一一对应，竖桥不许再拖成哑炮', () => {
  for (const n of [7, 9, 11]) {
    const spec = gen('u' + n + ':7', n);
    const g = geomOf(spec);
    for (let p = 0; p < g.K; p++) {
      for (const k of g.islandLanes[p]) {
        const l = g.lanes[k];
        const [px, py] = g.pos[p];
        const [qx, qy] = g.pos[l.a === p ? l.b : l.a];
        const want = l.horiz ? (qx > px ? 'h1' : 'hm1') : (qy > py ? 'v1' : 'vm1');
        assert.equal(g.dirs[p][want], k, `${n}×${n} 岛 ${p} 往 ${want} 的方向指错了道`);
      }
      assert.ok(Object.values(g.dirs[p]).every((v) => v >= -1 && v < g.lanes.length));
    }
    const e = create(spec);
    let expect = 0;
    for (const l of g.lanes) {
      for (const [p, q] of [[l.a, l.b], [l.b, l.a]]) {
        expect++;
        assert.equal(dragTo(e, spec.islands[p], spec.islands[q]), true,
          `${n}×${n} 从岛 ${p} 拖到岛 ${q} 没落子（方向索引坏了？）`);
        assert.equal(e.stats().done, expect);
      }
    }
    assert.equal(e.stats().moves, expect, '一根桥一次落子，拖多少次收多少钱');
  }
  const plus = handSpec([[5, 5, null], [9, 5, null], [5, 9, null], [1, 5, null], [5, 1, null]]);
  const pg = geomOf(plus);
  assert.equal(pg.cross.every((c) => !c.length), true, '这个夹具里四条道互不相交');
  for (const lane of pg.lanes) {
    const e = create(plus);
    const from = lane.a === 0 ? lane.b : lane.a;
    assert.equal(dragTo(e, plus.islands[from], plus.islands[0]), true);
    assert.equal(e.stats().done, 1);
    for (const other of pg.lanes) {
      if (other.idx === lane.idx) continue;
      assert.equal(e.down(other.cells[0][0], other.cells[0][1], 0), false, `手指明明在 ${lane.idx}，桥却落到了 ${other.idx}`);
    }
    assert.equal(e.down(lane.cells[0][0], lane.cells[0][1], 0), true, '桥在自己那条道的桥身上');
    assert.equal(e.stats().done, 0);
  }
});

test('一根桥 = 一次落子：点两下同一对岛搭一根，双桥就是两轮点两下', () => {
  const spec = gen('u7:8', 7);
  const g = geomOf(spec);
  const e = create(spec);
  const [a, b] = spec.bridges[0];
  assert.equal(tap(e, spec.islands[a]), false, '第一下只是把岛记成"上一手"');
  assert.equal(e.stats().moves, 0);
  assert.equal(tap(e, spec.islands[b]), true, '第二下配对成一根桥');
  assert.deepEqual([e.stats().moves, e.stats().done], [1, 1], '一根桥收一次钱，两下点击也只算一次');
  tap(e, spec.islands[a]);
  assert.equal(tap(e, spec.islands[b]), true, '再一轮点两下 = 双桥');
  assert.deepEqual([e.stats().moves, e.stats().done], [2, 2]);
  tap(e, spec.islands[a]);
  assert.equal(tap(e, spec.islands[b]), true, '第三轮：已经双桥，只能拆一根，步数照收');
  assert.deepEqual([e.stats().moves, e.stats().done], [3, 1]);
  assert.equal(spec.par, spec.bridges.length, 'par = 桥的总根数（双桥计两根）');
  let non = null;
  for (let p = 0; p < g.K && !non; p++) {
    for (let q = p + 1; q < g.K && !non; q++) if (!laneOfPair(g, p, q)) non = [p, q];
  }
  assert.ok(non, '候选图不是完全图，总有一对搭不成道');
  const m0 = e.stats().moves;
  assert.equal(tap(e, spec.islands[non[0]]), false);
  assert.equal(tap(e, spec.islands[non[1]]), false, '不是一对道的两下不许收钱');
  assert.equal(e.stats().moves, m0);
  assert.equal(tap(e, spec.islands[0]), false);
  assert.equal(tap(e, spec.islands[0]), false);
  assert.equal(e.stats().moves, m0);
});

test('照解一根一根搭到通关：moves 正好用完 par，done/total 如实', () => {
  for (const n of [7, 9, 11]) {
    for (const seed of SEEDS('u' + n, 3)) {
      const spec = gen(seed, n);
      const e = create(spec);
      let done = 0;
      for (const [a, b] of spec.bridges) {
        tap(e, spec.islands[a]);
        tap(e, spec.islands[b]);
        done++;
        const st = e.stats();
        assert.deepEqual([st.done, st.moves], [done, done], `${seed}/${n} 第 ${done} 根桥没如实记`);
        assert.equal(st.total, spec.par);
        assert.equal(st.par, spec.par);
        assert.equal(e.solved(), done === spec.par, '差一根就不许宣布通关');
      }
      assert.equal(e.solved(), true);
      assert.equal(e.stats().moves, spec.par, '照解走恰好用完 par：par 是可证下界');
    }
  }
});

test('判胜之后锁盘：改笔必须走撤销', () => {
  const spec = gen('u7:9', 7);
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
  const [c, d] = spec.bridges[spec.bridges.length - 1];   // 撤销撤的是最后一笔，补也要补它
  tap(e, spec.islands[c]);
  tap(e, spec.islands[d]);
  assert.equal(e.solved(), true, '改回原样仍然通关');
});

test('撤销绝不退款：盘面回到零，moves 还是 1；redo 把盘面搬回来', () => {
  const spec = gen('u9:0', 9);
  const e = create(spec);
  const [a, b] = spec.bridges[0];
  tap(e, spec.islands[a]);
  tap(e, spec.islands[b]);
  assert.equal(e.stats().moves, 1);
  assert.equal(e.canUndo(), true);
  assert.equal(e.canRedo(), false);
  assert.equal(e.undo(), true);
  assert.deepEqual(e.stats(), { moves: 1, par: spec.par, done: 0, total: spec.par },
    '撤销只搬盘面，已经花掉的笔数收不回来（评星就靠 moves-par）');
  assert.equal(e.solved(), false);
  assert.equal(e.undo(), false, '空历史别硬编');
  assert.equal(e.canRedo(), true);
  assert.equal(e.redo(), true);
  assert.equal(e.stats().done, 1, '重做把桥放回去');
  assert.equal(e.stats().moves, 1, '重做也不额外收钱');
  assert.equal(e.redo(), false);
  const e2 = create(spec);
  for (const [x, y] of spec.bridges.slice(0, 5)) { tap(e2, spec.islands[x]); tap(e2, spec.islands[y]); }
  assert.equal(e2.stats().moves, 5);
  for (let i = 0; i < 5; i++) assert.equal(e2.undo(), true);
  assert.equal(e2.stats().done, 0);
  assert.equal(e2.stats().moves, 5, '撤销绝不退款');
  for (let i = 0; i < 5; i++) assert.equal(e2.redo(), true);
  assert.equal(e2.stats().done, 5);
  assert.equal(e2.stats().moves, 5);
  e2.undo();
  assert.equal(e2.canRedo(), true);
  tap(e2, spec.islands[a]);
  tap(e2, spec.islands[b]);
  assert.equal(e2.canRedo(), false, '落新子之后 redo 栈必须作废');
});

test('副笔：封道与"凑齐"记号不计步、也不算成桥', () => {
  const spec = gen('u11:0', 11);
  const e = create(spec);
  const g = geomOf(spec);
  const free = g.lanes.find((l) => l.cells.length && !spec.bridges.some(([x, y]) => x === l.a && y === l.b));
  const cell = free.cells[0];
  assert.equal(e.down(cell[0], cell[1], 1), true, '副笔点空水道 = 记一笔"这条道一定不搭"');
  assert.deepEqual(e.stats(), { moves: 0, par: spec.par, done: 0, total: spec.par }, '记号不计步');
  assert.equal(validate(spec, [[free.a, free.b]]), false, '记号不算桥');
  assert.equal(e.down(cell[0], cell[1], 1), true, '再点一次擦记号');
  assert.equal(e.down(spec.islands[0][0], spec.islands[0][1], 1), true, '副笔点岛 = 标"这座岛凑齐了"');
  assert.equal(e.stats().moves, 0);
  assert.equal(e.canUndo(), true, '记号也进历史，撤销能擦');
  e.undo();
  const busy = g.lanes.find((l) => spec.bridges.some(([x, y]) => x === l.a && y === l.b) && l.cells.length);
  tap(e, spec.islands[busy.a]);
  tap(e, spec.islands[busy.b]);
  assert.equal(e.stats().done, 1);
  assert.equal(e.down(busy.cells[0][0], busy.cells[0][1], 1), false, '这条道已经有桥，副笔不受理');
  const crossPair = g.lanes.find((l) => l.cells.length && g.cross[l.idx].some((o) => g.lanes[o].cells.length));
  assert.ok(crossPair, '11×11 的盘上总有一对相交的道');
  const other = g.lanes[g.cross[crossPair.idx].find((q) => g.lanes[q].cells.length)];
  const H = crossPair.horiz ? crossPair : other;
  const V = crossPair.horiz ? other : crossPair;
  assert.equal(g.cellLanes.get(key(V.fixed, H.fixed)).length, 2);
  assert.equal(e.down(V.fixed, H.fixed, 1), false, '交叉格上压着两条道，点不准就不许猜');
  assert.equal(e.stats().moves, 1, '副笔的几次尝试一根都不收');
  assert.equal(e.down(busy.cells[0][0], busy.cells[0][1], 0), true);
  assert.deepEqual([e.stats().done, e.stats().moves], [0, 2]);
  tap(e, spec.islands[busy.a]);
  tap(e, spec.islands[busy.b]);
  const crossUsed = g.lanes.find((l) => g.cross[l.idx].some((o) => o === busy.idx));
  if (crossUsed) {
    const H2 = crossUsed.horiz ? crossUsed : busy;
    const V2 = crossUsed.horiz ? busy : crossUsed;
    assert.equal(e.down(V2.fixed, H2.fixed, 0), false, '交叉格主笔也不受理');
  }
  assert.equal(e.stats().done, 1);
});

test('hint 一次一根地搭到通关，双桥的第二根也不许卡住', () => {
  for (const n of [7, 9, 11]) {
    const spec = gen('u' + n + ':1', n);
    const { g, s } = solutionState(spec);
    const e = create(spec);
    let lastDone = 0;
    let asked = 0;
    for (let guard = 0; guard < 300; guard++) {
      const h = e.hint();
      if (!h) break;
      asked++;
      assert.equal(h.cells.length, 1, '提示得指一个格心');
      const [hx, hy] = h.cells[0];
      assert.equal(isCell(hx, hy), true, '提示的坐标必须是格心（本玩法唯一的落子目标）');
      assert.ok(hx >= 1 && hy >= 1 && hx <= 2 * spec.n - 1 && hy <= 2 * spec.m - 1, '提示别指到盘外');
      assert.ok(typeof h.note === 'string' && h.note.length > 0, '提示得说人话');
      const st = e.stats();
      assert.deepEqual([st.done, st.moves], [lastDone + 1, lastDone + 1], '提示返回了却没落子，或者多收了钱');
      const hit = g.lanes.filter((l) => l.mid[0] === hx && l.mid[1] === hy);
      assert.ok(hit.length >= 1, '提示指的格心不在任何道的桥身上');
      assert.ok(hit.some((l) => s[l.idx] >= 1), '提示指的格心得是解里用着的道');
      assert.equal(e.badCells().length, 0, '提示自己不许把盘面带进与题面矛盾的境地');
      assert.equal(e.solved(), st.done === spec.par);
      lastDone = st.done;
    }
    assert.ok(asked >= 1, `${n}×${n} 一个提示都没发出去`);
    assert.equal(e.solved(), true, `${n}×${n} 一路听提示只搭到第 ${lastDone} 根就没得提示了`);
    assert.equal(e.stats().moves, spec.par, '提示也是落子，钱照收');
    assert.equal(e.hint(), null, '通关之后没得提示');
  }
  // 走到无解可相容时，提示得摊手而不是硬塞一条
  const spec = gen('u9:8', 9);
  const g = geomOf(spec);
  const e = create(spec);
  const on = new Set(spec.bridges.map(keyOf));
  const bad = g.lanes.find((l) => l.cells.length && !on.has(keyOf([l.a, l.b])));
  tap(e, spec.islands[bad.a]);
  tap(e, spec.islands[bad.b]);
  assert.equal(e.stats().done, 1);
  assert.equal(e.hint(), null, '这根桥不在任何解里，提示不许装作还有救');
  assert.deepEqual(e.badCells(), [], '单搭一根不顶破任何证词，报错格得是空');
});

test('badCells：超数的岛与十字交叉点都点出来，撤销之后立刻重算', () => {
  const spec = gen('u9:6', 9);
  const g = geomOf(spec);
  const e = create(spec);
  assert.deepEqual(e.badCells(), [], '空盘不该有错');
  const p = g.islandLanes.findIndex((ls, q) => spec.islands[q][2] === 1 && ls.length >= 2);
  assert.ok(p >= 0, '题面里得有一座数字 1 的岛');
  const l0 = g.lanes[g.islandLanes[p][0]];
  const l1 = g.lanes[g.islandLanes[p][1]];
  tap(e, spec.islands[l0.a]);
  tap(e, spec.islands[l0.b]);
  assert.deepEqual(e.badCells(), [], '数字 1 正好满足，不该报错');
  tap(e, spec.islands[l1.a]);
  tap(e, spec.islands[l1.b]);
  const bad = e.badCells();
  assert.ok(bad.some(([x, y]) => x === g.pos[p][0] && y === g.pos[p][1]), '超数的岛必须被点出来');
  assert.ok(bad.every(([x, y]) => isCell(x, y)), '报错的位子必是格心');
  assert.equal(e.solved(), false);
  e.undo();
  assert.deepEqual(e.badCells(), [], '撤销之后还挂着旧红点：外壳抬手时调的那一次会说谎');
  tap(e, spec.islands[l1.a]);
  tap(e, spec.islands[l1.b]);
  assert.deepEqual(e.badCells(), bad, '重新犯错也得报得出来（缓存两头都要失效）');
  e.undo();
  assert.deepEqual(e.badCells(), []);
  const pin = handSpec([[1, 5, null], [9, 5, null], [5, 1, null], [5, 9, null]]);
  const e2 = create(pin);
  tap(e2, pin.islands[0]);
  tap(e2, pin.islands[1]);
  assert.deepEqual(e2.badCells(), [], '一根桥谈不上相交');
  tap(e2, pin.islands[2]);
  tap(e2, pin.islands[3]);
  assert.deepEqual(e2.badCells(), [[5, 5]], '交叉点是个空格心，得报出来');
  assert.equal(e2.solved(), false);
  const zero = handSpec([[1, 5, 0], [9, 5, 0], [5, 1, 0], [5, 9, 0]]);
  const e3 = create(zero);
  for (const i of [0, 1, 2, 3]) tap(e3, zero.islands[i]);
  assert.equal(e3.badCells().length, 5, `四座岛全超数 + 一个交叉点，只报了 ${JSON.stringify(e3.badCells())}`);
  assert.ok(e3.badCells().some(([x, y]) => x === 5 && y === 5));
  e3.undo();
  assert.deepEqual(e3.badCells().sort(), [[1, 5], [9, 5]], '拆掉竖桥：只剩横桥那两端两座岛超数，交叉点也没了');
});

test('玩法元数据齐全：外壳渲染首页要用到每个字段', () => {
  assert.equal(hashi.id, 'hashi');
  assert.equal(hashi.title, '数桥');
  assert.equal(hashi.latin, 'HASHI');
  assert.ok(hashi.tagline && hashi.tagline.length > 4);
  assert.equal(hashi.unit, '根', '一根桥一次落子：计量单位必须是"根"');
  assert.ok(hashi.rules.length >= 3);
  assert.ok(hashi.rules.some((r) => /连通|一张/.test(r)), '规则里得写清"数字全对不连通照样错"');
  assert.ok(hashi.rules.some((r) => /两|2/.test(r)), '规则里得交代一对岛最多两根');
  assert.ok(hashi.rules.some((r) => /\?|问号|藏/.test(r)), '规则里得交代空心盘是被藏起来的数字');
  assert.deepEqual(hashi.sizes.map((s) => s.key), [7, 9, 11]);
  assert.deepEqual(hashi.sizes.map((s) => s.tier), ['入门', '熟手', '挑战']);
  for (const s of hashi.sizes) {
    assert.ok(s.key && s.label && s.tier, JSON.stringify(s));
    assert.equal(s.label, s.key + '×' + s.key);
    assert.equal(hashi.sizes.filter((q) => q.key === s.key).length, 1, '档位不许重复');
  }
  assert.equal(typeof hashi.generate, 'function');
  assert.equal(typeof hashi.create, 'function');
  assert.ok(create(hashi.generate('meta', 7)).stats().par > 0);
});

test('引擎不碰 DOM、时钟与随机数：源码里不许出现这些东西', () => {
  const src = fs.readFileSync(new URL('../js/puzzles/hashi.js', import.meta.url), 'utf8');
  for (const bad of ['Date', 'Math.random', 'performance', 'document', 'window', 'localStorage', 'setTimeout']) {
    assert.equal(src.includes(bad), false, `引擎里出现了 ${bad}`);
  }
  assert.ok(src.includes("from '../core/rng.js'"), '随机只能来自 rngFrom(seed)');
  assert.equal(src.includes("from '../ui/"), false, '引擎只准 import js/core/*');
  const snap = src.slice(src.indexOf('const snap = () =>'), src.indexOf('const back ='));
  assert.ok(snap.length > 10 && !snap.includes('moves'), 'snap() 里出现了 moves');
  assert.ok(/future\.push\(snap\(\)\)/.test(src), 'redo 栈走同一份快照，同样退不了款');
});
