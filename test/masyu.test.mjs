// 珍珠的三道保险（与圈环同立场，只是落子目标从"边"换成了"格心"）：
//   1) 生成器不许说谎 —— countSolutions 数到 2 必须只数出 1，且 capped 为假；
//      预算烧穿时也要如实 capped，绝不把"没数完"写成"唯一"。
//   2) 校验器、传播器、求解器互不引用 —— validate 只按题面规则判一串有序格心，
//      spread 只做人推得出的那几条（珍珠必在环上、黑珠直伸两格、白珠直穿加一头拐），
//      logicSolve / solveOne 负责"找得到"；几边对得上才敢说那是解。
//   3) 引擎是个纯状态机 —— 只用公开 API 走子；一格一次落子，擦除、改画、撤销一律不退款；
//      判胜即锁盘。
//
// TODO(engine-bug) 集中记在最后两条：唯一性与拖拽轨迹都是好的，缺的是"纯逻辑推得完"的比例。

import test from 'node:test';
import assert from 'node:assert/strict';
import masyu, {
  UNKNOWN, NO, YES, nSegs, cellOfIndex, halfOfCell, geom, segBetween, pearlIndex,
  propagate, spread, cycleOf, logicSolve, countSolutions, solveOne, validate,
  randomLoop, pearlCandidates, isCycle, tiers, tierOf, generate, create,
} from '../js/puzzles/masyu.js';
import { cellAt, cellOf, isCell } from '../js/core/lattice.js';
import { rngFrom } from '../js/core/rng.js';

const SEEDS = (tag, k = 10) => Array.from({ length: k }, (_, i) => `${tag}:${i}`);
const halfSet = (halves) => halves.map((h) => h.join(',')).sort().join('|');

// 方向：0 右 1 左 2 下 3 上（与引擎内的编号一致）；出界的段记 -1，一律当"封死"
const at = (g, i, j) => j * g.n + i;
const portAt = (g, i, j, d) => g.ports[at(g, i, j) * 4 + d];

// spec.solution 是格心半格，引擎内部的格号是 c = j*n + i：来回换算
const pathOf = (spec) => spec.solution.map(([hx, hy]) => {
  const [i, j] = cellOf(hx, hy);
  return j * spec.n + i;
});
const halvesOf = (n, path) => path.map((c) => cellAt(c % n, Math.floor(c / n)));

// 人工题面：一条 w×h 的矩形回字环（环号 = 格号）。4×3 全是白珠位，5×4 才有黑珠位
function rectPath(n, x, y, w, h) {
  const p = [];
  for (let i = 0; i < w; i++) p.push(at(geom(n, n), x + i, y));
  for (let j = 1; j < h; j++) p.push(at(geom(n, n), x + w - 1, y + j));
  for (let i = w - 2; i >= 0; i--) p.push(at(geom(n, n), x + i, y + h - 1));
  for (let j = h - 2; j >= 1; j--) p.push(at(geom(n, n), x, y + j));
  return p;
}
const handSpec = (n, path, pearls) => ({
  n, m: n, pearls, solution: halvesOf(n, path), stroke: halvesOf(n, path), par: path.length,
});

// 往传播盘上照着一段格序落墨：走不通就是 fixture 自己搭错了，不许悄悄放过
function paint(g, state, path, val = YES) {
  const loop = path.length > 1 && segBetween(g, path[path.length - 1], path[0]) >= 0;
  const upto = loop ? path.length : path.length - 1;
  for (let t = 0; t < upto; t++) {
    const s = segBetween(g, path[t], path[(t + 1) % path.length]);
    assert.ok(s >= 0, `fixture 搭错了：${path[t]} → ${path[(t + 1) % path.length]} 不相邻`);
    state[s] = val;
  }
}
const piOf = (g, pearls) => pearlIndex(g, pearls);
const yesOf = (state, g, path) => path.map((c) => {
  const out = [];
  for (let d = 0; d < 4; d++) { const s = portAt(g, c % g.n, Math.floor(c / g.n), d); if (s >= 0 && state[s] === YES) out.push(d); }
  return out.sort();
});

// 无头复验的走法：按 spec.stroke 的顺序按住主笔一路拖（step=2，相邻两格共一条段）
function dragStroke(e, stroke) {
  e.down(stroke[0][0], stroke[0][1], 0);
  for (let t = 1; t < stroke.length; t++) e.move(stroke[t][0], stroke[t][1]);
  e.up();
}

// ---- 半格坐标 ↔ 格号 ---------------------------------------------------------------

test('halfOfCell / cellOfIndex 互为反函数：格心只落在奇奇坐标上', () => {
  for (const [n, m] of [[6, 6], [7, 7], [8, 5]]) {
    const seen = new Set();
    for (let c = 0; c < n * m; c++) {
      const half = halfOfCell(n, c);
      assert.deepEqual(cellOfIndex(n, c), cellOf(...half), `c=${c}`);
      assert.equal(isCell(...half), true, `格心必须是奇奇坐标，拿到 ${half}`);
      assert.deepEqual(half, cellAt(...cellOfIndex(n, c)), 'cellAt 与 halfOfCell 得说同一件事');
      seen.add(half.join(','));
    }
    assert.equal(seen.size, n * m, '格心不能重复也不能漏');
    assert.equal(Math.max(...[...seen].map((k) => +k.split(',')[0])), 2 * n - 1);
    assert.equal(Math.max(...[...seen].map((k) => +k.split(',')[1])), 2 * m - 1);
  }
});

test('geom 的格数/段数与 nSegs 一致，segBetween 认得每一对邻居且两端正好夹着这两格', () => {
  for (const [n, m] of [[6, 6], [7, 7], [8, 8]]) {
    const g = geom(n, m);
    assert.equal(g.cells, n * m);
    assert.equal(g.segs, nSegs(n, m));
    assert.equal(g.segs, (n - 1) * m + n * (m - 1), '横段 + 竖段');
    assert.deepEqual(Array.from(g.fresh()), new Array(g.segs).fill(UNKNOWN), 'fresh 是全未知盘');
    const used = new Set();
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
      for (let d = 0; d < 4; d++) {
        const s = portAt(g, i, j, d);
        if (s < 0) continue;
        used.add(s);
        const nb = g.nb[at(g, i, j) * 4 + d];
        assert.equal(segBetween(g, at(g, i, j), nb), s, `格 (${i},${j}) 方向 ${d}`);
        assert.equal(segBetween(g, nb, at(g, i, j)), s, '邻居反着查也得是同一条段');
        assert.equal(new Set([g.segA[s], g.segB[s]]).has(at(g, i, j)), true, 'segA/segB 得含这一格');
        assert.equal(new Set([g.segA[s], g.segB[s]]).has(nb), true, 'segA/segB 得含邻格');
      }
      const out = [portAt(g, 0, j, 1), portAt(g, n - 1, j, 0), portAt(g, i, 0, 3), portAt(g, i, m - 1, 2)];
      assert.deepEqual(out, [-1, -1, -1, -1], '出界的段一律记 -1');
      assert.equal(segBetween(g, at(g, i, j), at(g, i, j)), -1, '自己不算邻居');
      assert.equal(segBetween(g, at(g, i, j), -1), -1, '越界的格号直接不算');
    }
    assert.equal(used.size, g.segs, '每一段都得被两端各列出一次');
    assert.deepEqual(geom(n, m), g, '几何表按尺寸缓存，两次拿到的得是同一份');
  }
});

// ---- 独立校验器 ------------------------------------------------------------------

test('validate：一圈合法闭环通过，少一格 / 多一格 / 重访一格都不通过', () => {
  const spec = handSpec(6, rectPath(6, 0, 0, 4, 3), pearlCandidates(rectPath(6, 0, 0, 4, 3), 6, 6));
  assert.ok(spec.pearls.length >= 2);
  assert.equal(validate(spec, spec.solution), true);
  assert.equal(validate(spec, spec.solution.slice(0, -1)), false, '少一格：环收不拢');
  assert.equal(validate(spec, spec.solution.slice().reverse()), true, '顺序反着走同一条环，照样通过');
  assert.equal(validate(spec, spec.solution.concat([cellAt(5, 5)])), false, '多一格：盘上凭空多出一步');
  const repeat = spec.solution.slice(0, -1).concat([spec.solution[0], spec.solution[1]]);
  assert.equal(validate(spec, repeat), false, '重访同一个格');
  assert.equal(validate(spec, spec.solution.slice(0, 4)), false, '四格以下的环不算');
});

test('validate 只吃格心：点与边的半格坐标一律拒收', () => {
  const spec = handSpec(6, rectPath(6, 0, 0, 4, 3), pearlCandidates(rectPath(6, 0, 0, 4, 3), 6, 6));
  const asVerts = spec.solution.map(([hx, hy]) => [hx - 1, hy - 1]);        // 偶偶 = 点
  const asEdges = spec.solution.map(([hx, hy]) => [hx - 1, hy]);            // 偶奇 = 竖边
  assert.equal(validate(spec, asVerts), false, '点不是落子目标');
  assert.equal(validate(spec, asEdges), false, '边不是落子目标');
  assert.equal(validate(spec, spec.solution.map(([hx, hy]) => [hx + 2 * 6, hy])), false, '越界格子');
});

test('validate 认珍珠规则：白珠管拐弯、黑珠管前后各两格直穿', () => {
  const ring = rectPath(6, 0, 0, 5, 4);                 // 5×4 回字：四条直段 + 四个够格的拐角
  const spec = handSpec(6, ring, pearlCandidates(ring, 6, 6));
  assert.equal(spec.pearls.length, 12, '八颗白珠（长直段正中放不下）+ 四个拐角各一颗黑珠');
  assert.equal(spec.pearls.filter((p) => p[2] === 'black').length, 4);
  assert.equal(validate(spec, spec.solution), true, '按规则摆的珠全通过');
  // 换色即违规：黑珠摆到直段上、白珠摆到拐角上、白珠摆到直段正中间（两头都直）
  assert.equal(validate({ ...spec, pearls: [[1, 0, 'black']] }, spec.solution), false, '黑珠处线没拐弯');
  assert.equal(validate({ ...spec, pearls: [[0, 0, 'white']] }, spec.solution), false, '白珠处线拐了');
  assert.equal(validate({ ...spec, pearls: [[2, 0, 'white']] }, spec.solution), false, '白珠两头都直穿 = 白放');
  assert.equal(validate({ ...spec, pearls: [[0, 0, 'grey']] }, spec.solution), false, '题面里有不认识的珠子');
  // 3×3 回字全拐无直段：一颗珠也摆不下，这形状的题面根本不该出现
  assert.deepEqual(pearlCandidates(rectPath(6, 0, 0, 3, 3), 6, 6), [], '小环上没有可放珠的位置');
});

test('validate(spec, 格心) 与生成器自带的答案同口径，每档各验一道', () => {
  for (const key of [6, 7, 8]) {
    const spec = generate(`val:${key}`, key);
    assert.equal(validate(spec, spec.solution), true, `${key}×${key} 题面与答案不自洽`);
    assert.equal(validate(spec, spec.solution.slice(0, -1)), false, `${key}×${key} 少一格竟算通过`);
    assert.equal(validate(spec, spec.stroke), true, 'stroke 也是同一条环，只是换了起手');
    const [i, j] = cellOf(...spec.solution[0]);
    assert.equal(validate({ ...spec, pearls: [[i, j, 'white']] }, spec.solution)
      || validate({ ...spec, pearls: [[i, j, 'black']] }, spec.solution), true,
    `${key}×${key} 起手那格既放不了白也放不了黑？`);
  }
});

// ---- 传播规则 --------------------------------------------------------------------

test('spread：白珠只能直穿，唯一那一条轴当场被钉死', () => {
  const g = geom(6, 6);
  const state = g.fresh();
  assert.equal(spread(state, g, piOf(g, [[2, 0, 'white']])), true);
  // 上出界 ⇒ 竖轴不成形，只剩横轴：左右必须画、下必须封
  assert.deepEqual(yesOf(state, g, [at(g, 2, 0)])[0].slice(), [0, 1], '白珠被钉成横穿');
  assert.equal(state[portAt(g, 2, 0, 2)], NO, '走不通的那头当场封掉');
  assert.equal(state.filter((k) => k === UNKNOWN).length, g.segs - 3, '只动这一格的三条段，别的一律不猜');
});

test('spread：黑珠拐弯，两侧各两格的直段一并被压出来', () => {
  const g = geom(6, 6);
  const state = g.fresh();
  state[portAt(g, 2, 2, 0)] = YES;                    // 只说"往右出头"
  assert.equal(spread(state, g, piOf(g, [[2, 2, 'black']])), true);
  assert.deepEqual(yesOf(state, g, [at(g, 2, 2)])[0], [0, 2], '左和上都被封 ⇒ 只剩右+下这一个拐');
  for (const [i, j, d] of [[2, 2, 0], [3, 2, 0], [4, 2, 0], [2, 2, 2], [2, 3, 2], [2, 4, 2]]) {
    assert.equal(state[portAt(g, i, j, d)], YES, `直段该伸到 (${i},${j})`);   // 珠 + 两侧各两格
  }
  for (const [i, j, d] of [[2, 2, 1], [2, 2, 3], [3, 2, 2], [3, 2, 3], [4, 2, 2], [4, 2, 3], [2, 3, 0], [2, 3, 1], [2, 4, 0], [2, 4, 1]]) {
    assert.equal(state[portAt(g, i, j, d)], NO, `(${i},${j}) 的出头 ${d} 必须封掉`);
  }
  assert.equal(state.filter((k) => k !== UNKNOWN).length, 16, '一条黑珠 + 一个方向只钉得住这十六条段，别的一律不猜');
});

test('spread 拒绝违反珍珠规则的画法：黑珠画直、白珠两头都直、珠格被封死', () => {
  const g = geom(6, 6);
  // 黑珠被横穿：6×6 上谁都伸不出"两侧各两格"的直段 —— 任何解都不成立
  const a = g.fresh();
  paint(g, a, [at(g, 0, 2), at(g, 1, 2), at(g, 2, 2), at(g, 3, 2), at(g, 4, 2)]);
  assert.equal(spread(a, g, piOf(g, [[2, 2, 'black']])), false, '黑珠处画直竟还能活下去');
  // 白珠直穿、进出两格都被钉成直穿 ⇒ 这颗珠子白放
  const b = g.fresh();
  paint(g, b, [at(g, 0, 2), at(g, 1, 2), at(g, 2, 2), at(g, 3, 2), at(g, 4, 2)]);
  for (const i of [1, 3]) { b[portAt(g, i, 2, 2)] = NO; b[portAt(g, i, 2, 3)] = NO; }
  b[portAt(g, 2, 2, 2)] = NO; b[portAt(g, 2, 2, 3)] = NO;
  assert.equal(spread(b, g, piOf(g, [[2, 2, 'white']])), false, '白珠两头都直穿竟不判死');
  // 珍珠格非走不可：全盘封死立刻矛盾
  const c = g.fresh().fill(NO);
  assert.equal(propagate(c, 6, 6, [[2, 2, 'white']]), false, '一颗珠也没穿到');
  // 一格最多两条出头：三条段硬塞进同一个格
  const d = g.fresh();
  paint(g, d, [at(g, 1, 1), at(g, 2, 1)]);
  paint(g, d, [at(g, 2, 0), at(g, 2, 1)]);
  paint(g, d, [at(g, 2, 1), at(g, 2, 2)]);
  assert.equal(spread(d, g, piOf(g, [])), false, '一个格挂三条出头 = 环在这里分了叉');
}
);

test('propagate 接受 spec，也接受 (state, n, m, pearls)：两种写法同一个结果', () => {
  const spec = generate('prop:0', 6);
  const a = geom(spec.n, spec.m).fresh();
  assert.equal(propagate(a, spec), true);
  const b = geom(spec.n, spec.m).fresh();
  assert.equal(propagate(b, spec.n, spec.m, spec.pearls), true);
  assert.deepEqual(Array.from(b), Array.from(a));
  assert.ok(a.includes(YES) && a.includes(NO), '空盘也该被珍珠压出一批结论');
});

test('spread 把一条画好的环收满全盘：多余段全掐掉，最后仍是同一条环', () => {
  const g = geom(6, 6);
  const ring = rectPath(6, 0, 0, 4, 3);
  const spec = handSpec(6, ring, pearlCandidates(ring, 6, 6));
  const state = g.fresh();
  paint(g, state, ring);                              // 只画环，别处全未知
  assert.equal(spread(state, g, piOf(g, spec.pearls)), true);
  assert.equal(state.includes(UNKNOWN), false, '圈已闭合且珠子都在圈上 ⇒ 剩下的段必须封掉');
  assert.deepEqual(cycleOf(state, g), ring, '封完不该把环弄丢');
});

test('logicSolve 推出的环与题面自带的答案逐格相同，成品盘经得起复检', () => {
  for (const key of [6, 7, 8]) {
    const spec = generate(`logic:${key}`, key);
    const sol = logicSolve(spec);
    assert.ok(sol, `${key}×${key} 纯逻辑推不完`);
    assert.equal(halfSet(sol.solution), halfSet(spec.solution), `${key}×${key} 推出来的不是同一条环`);
    assert.equal(sol.cells.length, spec.par);
    const g = geom(spec.n, spec.m);
    const recheck = Int8Array.from(sol.state);
    assert.equal(spread(recheck, g, piOf(g, spec.pearls)), true, '成品盘自己经不起传播复检');
    assert.deepEqual(Array.from(recheck), Array.from(sol.state), '复检不许改动已定的盘');
  }
});

// ---- 环的结构 --------------------------------------------------------------------

test('cycleOf 与 isCycle 都拒绝分叉、自交（两个圈）与断环', () => {
  const g = geom(6, 6);
  const ring = rectPath(6, 0, 0, 4, 3);
  const closed = () => { const s = g.fresh(); paint(g, s, ring); return s; };
  assert.deepEqual(cycleOf(closed(), g), ring, '先看正例：一条完整的环认得出来');

  const fork = closed();
  fork[portAt(g, 1, 1, 2)] = YES;                     // (1,1)→(1,2)：往环里插出一条岔
  assert.equal(cycleOf(fork, g), null, '一个格挂三条出头');
  assert.equal(isCycle(ring.concat([at(g, 1, 1)]), 6, 6), false, 'isCycle 同样拒绝带岔的形状');

  const two = closed();
  paint(g, two, rectPath(6, 0, 3, 3, 3));             // 另起一个不相干的圈
  assert.equal(cycleOf(two, g), null, '两个圈不算一条环');
  assert.equal(cycleOf(two.map((k) => k), g) === null, true);
  assert.equal(isCycle(rectPath(6, 0, 3, 3, 3), 6, 6), true, '单独那个圈本身是合法环');

  const broken = closed();
  broken[segBetween(g, at(g, 0, 0), at(g, 1, 0))] = NO;
  assert.equal(cycleOf(broken, g), null, '断环：还留着两个笔头');
  assert.equal(isCycle(ring.slice(1), 6, 6), false, '断环同样过不了 isCycle');

  const fig8 = ring.concat([at(g, 5, 1), at(g, 5, 2), at(g, 4, 2), at(g, 4, 1)]);
  assert.equal(isCycle(fig8, 6, 6), false, '自交成 8 字：交点上挂了四条');
  assert.equal(isCycle(rectPath(6, 0, 0, 3, 3).concat(rectPath(6, 2, 2, 3, 3)), 6, 6), false, '两个圈拼在一起');
  assert.equal(isCycle(rectPath(6, 0, 0, 6, 6), 6, 6), true, '盘心留一格不走的空心环合法');
  assert.equal(isCycle(halvesOf(6, ring).length ? ring.concat(ring.slice(0, 1)) : [], 6, 6), false, '重访同一格');
});

test('生成器的答案永远是一条无弦单环，stroke 是能一路拖下去的顺序', () => {
  for (const key of [6, 7, 8]) {
    const spec = generate(`cyc:${key}`, key);
    const path = pathOf(spec);
    assert.equal(isCycle(path, spec.n, spec.m), true, `${key}×${key} 答案不是无弦单环`);
    assert.equal(spec.stroke.length, spec.par);
    assert.equal(halfSet(spec.stroke), halfSet(spec.solution), '顺序表不许增删格子');
    const g = geom(spec.n, spec.m);
    const sp = spec.stroke.map(([hx, hy]) => { const [i, j] = cellOf(hx, hy); return j * spec.n + i; });
    const onPearl = new Set(spec.pearls.map(([i, j]) => j * spec.n + i));
    assert.equal(onPearl.has(sp[0]), true, '起手格得是颗珠，方便复验时一眼看出从哪儿开始');
    for (let t = 0; t < sp.length; t++) {
      assert.equal(segBetween(g, sp[t], sp[(t + 1) % sp.length]) >= 0, true, `第 ${t} 格与下一格不相邻，手指拖不过去`);
      const [x1, y1] = spec.stroke[t]; const [x2, y2] = spec.stroke[(t + 1) % sp.length];
      assert.equal(Math.abs(x1 - x2) + Math.abs(y1 - y2), 2, '格心之间恰好一个格 = 半格索引差 2');
    }
  }
});

test('pearlCandidates 只报放得下的位置，题面里每颗珠都在其中', () => {
  for (const key of [6, 7, 8]) {
    const spec = generate(`cand:${key}`, key);
    const path = pathOf(spec);
    const cands = new Set(pearlCandidates(path, spec.n, spec.m).map(([i, j, k]) => `${i},${j},${k}`));
    assert.ok(cands.size >= 2, `${key}×${key} 这根环上一个可放珠的位置都没有`);
    for (const [i, j, kind] of spec.pearls) {
      assert.equal(cands.has(`${i},${j},${kind}`), true, `${key}×${key} 印了一颗放不下的 ${kind} 珠`);
    }
    // 位置与颜色必须对得上格上的拐/直：同一个格子换色就违规
    const g = geom(spec.n, spec.m);
    const sol = logicSolve(spec) || { state: null };
    if (!sol.state) continue;
    const ringSegs = new Set(spec.solution.map(([hx, hy]) => cellOf(hx, hy)).map(([i, j]) => at(g, i, j)));
    assert.equal([...ringSegs].length, spec.par, '答案里的格不许重复');
  }
});

// ---- 求解器不许说谎 ---------------------------------------------------------------

test('countSolutions 诚实：数不完就是 capped，绝不写"唯一"', () => {
  const loose = { n: 6, m: 6, pearls: [] };
  const many = countSolutions(loose, 2);
  assert.equal(many.count, 2, '没有珍珠的盘至少得数出两个解');
  assert.equal(many.capped, true);
  assert.equal(many.over, false, '数到 cap 早停，不是预算烧穿');
  const spec = generate('honest:0', 8);
  const squeezed = countSolutions(spec, 2, null, 0);           // 一个节点都不给
  assert.equal(squeezed.over, true, '预算为零还说数得完？');
  assert.equal(squeezed.count, 0);
  assert.equal(squeezed.capped, true, '没数完还敢说唯一？');
  const full = countSolutions(spec, 2);
  assert.equal(full.count, 1);
  assert.equal(full.capped, false);
  assert.equal(full.over, false);
});

test('countSolutions 的 seedState 只当线索用：相容的解照样被数出来', () => {
  const spec = generate('seed:0', 6);
  const clean = countSolutions(spec, 2);
  const g = geom(spec.n, spec.m);
  const forced = g.fresh();
  const path = pathOf(spec);
  paint(g, forced, path);                             // 把答案当线索压进去
  assert.equal(spread(forced, g, piOf(g, spec.pearls)), true);
  const withSeed = countSolutions(spec, 2, forced);
  assert.equal(withSeed.count, clean.count, '给了对的线索反而数不出解，回溯的起点被动了');
  const wrong = g.fresh();
  wrong[portAt(g, 0, 0, 0)] = YES; wrong[portAt(g, 1, 0, 0)] = NO;   // 左上角硬塞一条不可能的段
  const dead = countSolutions({ ...spec, pearls: [] }, 2, wrong);
  assert.ok(dead.count >= 1, '给了线索也该数得出题');
});

test('solveOne 与唯一解对拍：每一步提示都指向同一根环', () => {
  for (const key of [6, 7, 8]) {
    for (const seed of SEEDS(`one${key}`, 4)) {
      const spec = generate(seed, key);
      const segs = solveOne(spec);
      assert.ok(segs, `${seed} 求解器连唯一解都找不到`);
      const g = geom(spec.n, spec.m);
      const want = new Set();
      const path = pathOf(spec);
      for (let t = 0; t < path.length; t++) want.add(segBetween(g, path[t], path[(t + 1) % path.length]));
      assert.deepEqual(segs.slice().sort((a, b) => a - b), [...want].sort((a, b) => a - b),
        `${seed} 找到的解与数出来的唯一解不是同一条`);
    }
  }
});

// ---- 生成器：每档 40 颗种子 --------------------------------------------------------

const TIER_BOUNDS = { 6: [12, 20], 7: [15, 24], 8: [18, 26] };

for (const key of [6, 7, 8]) {
  const [minLen, maxLen] = TIER_BOUNDS[key];
  test(`生成的每道题都只有唯一解，而且拖得出来（${key}×${key}，40 颗种子）`, () => {
    const kinds = new Set(); const pars = new Set(); const starts = new Set();
    let noLogic = 0;
    for (const seed of SEEDS(`u${key}`, 40)) {
      const spec = generate(seed, key);
      assert.ok(spec, `${seed} 交了白卷`);
      assert.equal(spec.n, key); assert.equal(spec.m, key, `${seed} sizeKey 没照做`);
      assert.equal(spec.capped, false, `${seed} 没数完就别说唯一`);
      assert.equal(spec.count, 1, `${seed} 生成器自己数出 ${spec.count} 个解`);
      const { count, capped } = countSolutions(spec, 2);
      assert.equal(capped, false, `${seed} 复核时没数完`);
      assert.equal(count, 1, `${seed} 复核数出 ${count} 个解`);
      assert.equal(validate(spec, spec.solution), true, `${seed} 题面与答案不自洽`);
      assert.equal(spec.par, spec.solution.length, `${seed} par 必须是唯一解的格数`);
      assert.ok(spec.par >= minLen && spec.par <= maxLen,
        `${seed} ${key}×${key} 的环长 ${spec.par} 出了 [${minLen},${maxLen}]`);
      assert.ok(spec.pearls.length >= 2, `${seed} 只有 ${spec.pearls.length} 颗珠`);
      const sol = logicSolve(spec);
      if (sol) assert.equal(halfSet(sol.solution), halfSet(spec.solution), `${seed} 推出来的环与题面不同`);
      else noLogic++;
      assert.ok(isCycle(pathOf(spec), spec.n, spec.m), `${seed} 答案不是一条环`);
      const places = new Set(pearlCandidates(pathOf(spec), spec.n, spec.m).map(([a, b, k]) => `${a},${b},${k}`));
      for (const [i, j, kind] of spec.pearls) {
        kinds.add(kind);
        assert.equal(places.has(`${i},${j},${kind}`), true, `${seed} 印了一颗答案里放不下的 ${kind} 珠`);
        // 盘角只有两条出头，白珠在该处非拐不可 —— 题面这样印就自己把题印死了
        assert.ok(!(kind === 'white' && (i === 0 || i === spec.n - 1) && (j === 0 || j === spec.m - 1)),
          `${seed} 白珠落到了盘角 (${i},${j})`);
      }
      pars.add(spec.par);
      starts.add(spec.stroke[0].join(','));
    }
    assert.ok(kinds.has('white') && kinds.has('black'), `${key}×${key} 四十道题里没同时出现过两种珠`);
    assert.ok(pars.size >= 3, `${key}×${key} 四十道题只有 ${pars.size} 种环长，形状太单调`);
    assert.ok(starts.size >= 3, `${key}×${key} 起手格全挤在一处`);
    // TODO(engine-bug): ${key}×${key} 每 40 道里有 ${noLogic} 道纯逻辑推不完，得靠数试。见文件末条测试。
    assert.ok(noLogic <= [4, 5, 12][key - 6], `${key}×${key} 推不完的题涨到 ${noLogic} 道了`);
  });
}

test('档位是真的分开了：三档的环长下限与题面规模各不相同', () => {
  assert.deepEqual(tiers, masyu.sizes);
  assert.deepEqual(tiers.map((t) => t.key), [6, 7, 8]);
  assert.deepEqual(tiers.map((t) => t.tier), ['入门', '熟手', '挑战']);
  assert.equal(tierOf(7).key, 7);
  assert.equal(tierOf(99).key, 6, '认得的 sizeKey 才许换档，否则退回最便宜的一档');
  const pars = {};
  for (const key of [6, 7, 8]) {
    pars[key] = SEEDS(`tier${key}`, 8).map((s) => generate(s, key).par);
    for (const p of pars[key]) assert.ok(p >= TIER_BOUNDS[key][0] && p <= TIER_BOUNDS[key][1],
      `${key}×${key} 抽到 ${p} 格，出了本档区间`);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(avg(pars[8]) - avg(pars[6]) >= 1, `入门与挑战档平均环长没拉开：${avg(pars[6]).toFixed(1)} vs ${avg(pars[8]).toFixed(1)}`);
  assert.ok(Math.min(...pars[8]) > Math.min(...pars[6]), '最贵那档的最短环竟比入门还短');
});

test('randomLoop 每步都过 isCycle 复验，滚不出非法形状也不越档', () => {
  const FLOOR = { 6: 3, 7: 8, 8: 8 };
  for (const key of [6, 7, 8]) {
    const [minLen, maxLen] = TIER_BOUNDS[key];
    let loops = 0;
    for (let k = 0; k < 15; k++) {
      const path = randomLoop(rngFrom(`loop${key}:${k}`), key, key, maxLen, minLen);
      if (!path) continue;                            // 滚不出来就换种子：generate() 有 20 次机会
      loops++;
      assert.equal(new Set(path).size, path.length, '环上不许重访同一个格');
      assert.equal(isCycle(path, key, key), true, '滚出来的不是无弦单环');
      assert.ok(path.length >= minLen && path.length <= maxLen, `长度 ${path.length} 出了档`);
      assert.ok(pearlCandidates(path, key, key).length >= 2, '这根环摆不下两颗珠，出不了题');
    }
    assert.ok(loops >= FLOOR[key], `${key}×${key} 十五次只滚出 ${loops} 条环，生成器的起点太脆`);
  }
});

test('同一颗种子在任何设备上得到同一道题，spec 过一遍 JSON 也不变味', () => {
  const a = generate('daily:2026-09-27|masyu', 7);
  const b = generate('daily:2026-09-27|masyu', 7);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
  const e = create(JSON.parse(JSON.stringify(a)));
  assert.equal(validate(e.spec, e.spec.solution), true);
  dragStroke(e, e.spec.stroke);
  assert.equal(e.solved(), true, '过一遍 JSON 就通不了关');
  assert.equal(e.stats().moves, a.par);
});

test('不同种子的题面不会全一样：珍珠组合、环长与形状都在动', () => {
  const specs = SEEDS('var', 8).map((s) => generate(s, 6));
  assert.ok(new Set(specs.map((s) => JSON.stringify(s.pearls))).size >= 6, '八道题的珍珠组合大量重复');
  assert.ok(new Set(specs.map((s) => s.par)).size >= 3, '八道题的环长只有两种以内');
  assert.ok(new Set(specs.map((s) => halfSet(s.solution))).size >= 6, '八道题里环的形状几乎没换过');
  const blacks = specs.map((s) => s.pearls.filter((p) => p[2] === 'black').length);
  assert.ok(new Set(blacks).size >= 3, `黑珠颗数几乎恒定：${blacks.join('/')}`);
  assert.ok(new Set(specs.map((s) => s.pearls.length)).size >= 3, `总珠数几乎恒定：${specs.map((s) => s.pearls.length).join('/')}`);
});

test('出题在手机上不卡：每档十道题各有预算', () => {
  const BUDGET = { 6: 300, 7: 800, 8: 2500 };
  for (const key of [6, 7, 8]) {
    const t0 = Date.now();
    for (const seed of SEEDS(`t${key}`)) generate(seed, key);
    const ms = Date.now() - t0;
    assert.ok(ms < BUDGET[key], `${key}×${key} 十道题花了 ${ms}ms，超过 ${BUDGET[key]}ms`);
  }
});

// ---- 引擎状态机 ------------------------------------------------------------------

test('主笔：一格一次落子，擦除、改画、撤销一律不退款', () => {
  const spec = generate('pen:0', 6);
  const e = create(spec);
  const [hx, hy] = spec.solution[0];
  assert.equal(e.step, 2, '格心玩法：键盘光标一次挪一个格');
  assert.deepEqual(e.board, { cols: spec.n, rows: spec.m, margin: { l: 0, t: 0, r: 0, b: 0 } });
  assert.equal(e.down(hx, hy, 0), true);
  assert.deepEqual(e.stats(), { moves: 1, par: spec.par, done: 1, total: spec.par });
  e.up();
  assert.equal(e.down(hx, hy, 0), true, '再点是擦除，也算一次输入');
  assert.deepEqual(e.stats(), { moves: 1, par: spec.par, done: 0, total: spec.par }, '擦除不收笔，也不退笔');
  e.up();
  assert.equal(e.down(hx, hy, 0), true);
  e.up();
  assert.equal(e.stats().moves, 2, '重画不退款');
  assert.equal(e.undo(), true);
  assert.deepEqual(e.stats(), { moves: 2, par: spec.par, done: 0, total: spec.par }, '撤销退回盘面，绝不退回已经花掉的笔');
  assert.equal(e.redo(), true);
  assert.deepEqual(e.stats(), { moves: 2, par: spec.par, done: 1, total: spec.par }, '重做也只搬盘面');
});

test('按 stroke 顺序一路拖过去能通关，步数正好用完 par', () => {
  for (const key of [6, 7, 8]) {
    const spec = generate(`stroke:${key}`, key);
    const e = create(spec);
    dragStroke(e, spec.stroke);
    assert.equal(e.solved(), true, `${key}×${key} 顺着 stroke 拖不出解`);
    assert.deepEqual(e.stats(), { moves: spec.par, par: spec.par, done: spec.par, total: spec.par });
    assert.equal(e.badCells().length, 0, '通关盘上不该有报错格');
    // 反着拖也成：环是双向的
    const f = create(spec);
    dragStroke(f, spec.stroke.slice().reverse());
    assert.equal(f.solved(), true, '倒着拖是同一条环');
  }
});

test('判胜即锁盘：之后再落子一律返回 false，stats 冻住', () => {
  const spec = generate('win:0', 6);
  const e = create(spec);
  dragStroke(e, spec.stroke);
  assert.equal(e.solved(), true);
  const before = e.stats();
  const stray = cellAt(spec.n - 1, spec.m - 1);
  assert.equal(e.down(stray[0], stray[1], 0), false, '锁盘后主笔不吃');
  assert.equal(e.down(stray[0], stray[1], 1), false, '锁盘后副笔也不吃');
  assert.equal(e.move(spec.stroke[1][0], spec.stroke[1][1]), false);
  assert.equal(e.up(), false);
  assert.deepEqual(e.stats(), before, '锁盘后一个字节都不许动');
  assert.equal(e.undo(), true, '要改笔只能撤销');
  assert.equal(e.down(stray[0], stray[1], 0), true, '撤销之后盘又活了');
});

test('只画对一段不算赢，缺口如实反映在 done/total', () => {
  const spec = generate('half:0', 7);
  const e = create(spec);
  dragStroke(e, spec.stroke.slice(0, spec.par - 1));
  assert.equal(e.solved(), false, '差一格也判赢？');
  assert.deepEqual(e.stats(), { moves: spec.par - 1, par: spec.par, done: spec.par - 1, total: spec.par });
  assert.equal(e.badCells().length, 0, '只画了一半、还没跟珍珠打架，不该虚报错误格');
  dragStroke(e, [spec.stroke[spec.par - 1], spec.stroke[0]]);
  assert.equal(e.solved(), true, '把最后那一格补上就该赢');
  assert.equal(e.stats().moves, spec.par, '补口的那一手又走了一遍已画的格，不该多收笔');
});

test('不认识的坐标一律原样退回：点、边、越界格都不吃', () => {
  const spec = generate('parity:0', 6);
  const e = create(spec);
  const before = e.stats();
  const targets = [[2, 2], [4, 2], [2, 4], [1, 2], [2, 1], [-1, -1], [12, 3], [3, 13], [1, 1].map((x) => x)];
  for (const [hx, hy] of targets) {
    if (isCell(hx, hy) && hx < 2 * spec.n - 1 && hy < 2 * spec.m - 1 && hx >= 1 && hy >= 1) continue;
    assert.equal(e.down(hx, hy, 0), false, `(${hx},${hy}) 不是格心，竟被吃了`);
    assert.equal(e.move(hx, hy), false);
    assert.equal(e.down(hx, hy, 1), false);
  }
  assert.deepEqual(e.stats(), before, '拒收的输入不许改状态');
  assert.equal(e.canUndo(), false, '一次合法落子都没有，历史也该是空的');
});

test('副笔的记号不计步、不算环的一部分，标在珍珠上就报错', () => {
  const spec = generate('pen1:0', 6);
  const [pi, pj] = spec.pearls[0];
  const e = create(spec);
  assert.equal(e.down(...cellAt(pi, pj), 1), true);
  assert.deepEqual(e.stats(), { moves: 0, par: spec.par, done: 0, total: spec.par });
  assert.equal(validate(spec, [cellAt(pi, pj)]), false);
  assert.deepEqual(e.badCells(), [cellAt(pi, pj)], '把珍珠标成"不在环上"必须被点出来');
  assert.equal(e.down(...cellAt(pi, pj), 1), true, '再点一次是擦掉记号');
  assert.deepEqual(e.badCells(), []);
  assert.equal(e.stats().moves, 0, '副笔来回打点也不该收笔数');
  // 副笔不许盖在已画的线上，主笔也不该把记号当墨迹
  const c = spec.stroke[1];
  assert.equal(e.down(c[0], c[1], 0), true);
  assert.equal(e.down(c[0], c[1], 1), false, '已画出的格不许再打记号');
  assert.equal(e.stats().moves, 1);
});

test('badCells 能点出与珍珠矛盾的格：拐弯的白珠、断掉的黑珠直段', () => {
  const spec = generate('bad:0', 7);
  const white = spec.pearls.find((p) => p[2] === 'white');
  assert.ok(white, '这道题得有一颗白珠');
  const e = create(spec);
  assert.equal(e.badCells().length, 0, '空盘不该报错');
  // 在白珠上拐：把它两条相邻边的其中一条画成拐弯的走法
  const [wx, wy] = cellAt(white[0], white[1]);
  const solIdx = spec.solution.findIndex(([hx, hy]) => hx === wx && hy === wy);
  assert.ok(solIdx > 0);
  const prev = spec.solution[(solIdx - 1 + spec.par) % spec.par];
  const next = spec.solution[(solIdx + 1) % spec.par];
  assert.deepEqual(
    [Math.abs(prev[0] - wx) + Math.abs(prev[1] - wy), Math.abs(next[0] - wx) + Math.abs(next[1] - wy)], [2, 2],
    '白珠在环上前后各差一个格');
  // 找一条让白珠拐弯的走法：prev 的一个竖/横邻居与 next 的另一个方向配成直角
  const g = geom(spec.n, spec.m);
  const cAt = ([hx, hy]) => { const [i, j] = cellOf(hx, hy); return at(g, i, j); };
  const here = cAt([wx, wy]);
  const bends = [];
  for (let d = 0; d < 4; d++) for (let d2 = 0; d2 < 4; d2++) {
    if ((d ^ 1) === d2) continue;                                  // 直穿，不算拐
    const a = g.nb[here * 4 + d], b = g.nb[here * 4 + d2];
    if (a < 0 || b < 0) continue;
    bends.push([halfOfCell(spec.n, a), [wx, wy], halfOfCell(spec.n, b)]);
  }
  assert.ok(bends.length);
  for (const [a, mid, b] of bends.slice(0, 1)) {
    e.down(a[0], a[1], 0); e.up();
    e.down(mid[0], mid[1], 0); e.up();
    e.down(b[0], b[1], 0); e.up();
    e.down(a[0], a[1] + 2, 0); e.up();                             // 把 a 这一头继续直着引出去，好让度数够判
    const bad = halfSet(e.badCells());
    assert.ok(bad.includes(`${mid},${''}`.split(',')[0] + ',' + mid[1]) || e.badCells().length > 0,
      '白珠被画成拐弯，badCells 得说点什么');
    assert.equal(e.badCells().some(([x, y]) => x === mid[0] && y === mid[1]), true, '报错格得包含这颗白珠');
  }
});

test('badCells 也管结构：多接一格的岔路、以及"看着合法"的局部都如实标注', () => {
  const spec = generate('bad2:0', 6);
  const g = geom(spec.n, spec.m);
  const path = pathOf(spec);
  const e = create(spec);
  dragStroke(e, spec.stroke.slice(0, 6));
  assert.equal(e.solved(), false);
  // 找一格：环外一格，但和线上两格相邻 —— 硬接上去就成岔路
  let sub = null;
  for (let c = 0; c < g.cells && !sub; c++) {
    if (path.includes(c) || spec.pearls.some(([i, j]) => at(g, i, j) === c)) continue;
    const nbs = [];
    for (let d = 0; d < 4; d++) { const nb = g.nb[c * 4 + d]; if (nb >= 0 && path.includes(nb) && !spec.pearls.some(([i, j]) => at(g, i, j) === nb)) nbs.push(nb); }
    if (nbs.length === 2) sub = [c, nbs];
  }
  assert.ok(sub, '这道题找不到可用的岔路位置，换 seed');
  const [c, nbs] = sub;
  for (const nb of nbs) { const h = halfOfCell(spec.n, nb); e.down(h[0], h[1], 0); e.up(); }
  const h = halfOfCell(spec.n, c);
  e.down(h[0], h[1], 0); e.up();
  assert.ok(e.badCells().length >= 1, '接出三条出头竟不报错');
  assert.equal(e.badCells().some(([x, y]) => x === h[0] && y === h[1]), true, '报错的应该就是多接出来的那一格');
}
);

test('undo / redo 把棋盘搬回原处，步数不退款', () => {
  const spec = generate('undo:0', 6);
  const e = create(spec);
  dragStroke(e, spec.stroke);
  assert.equal(e.solved(), true);
  const mid = e.stats();
  assert.equal(e.canUndo(), true);
  for (let i = 0; i < 5; i++) assert.equal(e.undo(), true);
  assert.equal(e.stats().done, mid.done - 4, '一个手势里的五步会连带擦掉接头');
  assert.equal(e.stats().moves, mid.moves, '撤销退回盘面，绝不退回已经花掉的笔');
  assert.equal(e.solved(), false, '撤销之后锁盘得解除');
  for (let i = 0; i < 5; i++) assert.equal(e.redo(), true);
  assert.equal(e.stats().done, mid.done);
  assert.equal(e.stats().moves, mid.moves);
  dragStroke(e, spec.stroke);
  assert.equal(e.solved(), true);
  assert.equal(e.stats().moves, spec.par, 'undo/redo 来回搬盘也不该多收一笔');
});

test('只用提示也能解完每一档，而提示必须真的改棋盘', () => {
  for (const key of [6, 7, 8]) {
    const spec = generate(`hint${key}:0`, key);
    const e = create(spec);
    const onRing = new Set(spec.solution.map((h) => h.join(',')));
    const first = e.hint();
    assert.ok(first, `${key}×${key} 提示返回空`);
    assert.equal(first.cells.length, 1, '一次提示只点一个格');
    assert.equal(isCell(...first.cells[0]), true, '提示的坐标必须是格心');
    assert.ok(e.stats().done > 0 && e.stats().moves > 0, '提示不许只是嘴上说说');
    let guard = 0;
    let prev = e.stats();
    while (!e.solved()) {
      assert.ok(guard++ < 400, `${key}×${key} 提示解不完`);
      const h = e.hint();
      assert.ok(h, `${key}×${key} 第 ${guard} 步提示返回空`);
      assert.ok(typeof h.note === 'string' && h.note.length);
      const [hx, hy] = h.cells[0];
      assert.equal(onRing.has(`${hx},${hy}`) || /不在环上$/.test(h.note), true,
        `${key}×${key} 提示指向了唯一解之外的格：${h.note}`);
      const after = e.stats();
      assert.ok(after.moves >= prev.moves && after.done >= prev.done, '提示不该倒退');
      assert.ok(after.moves !== prev.moves || after.done !== prev.done || /接上/.test(h.note),
        '提示必须动盘面（接上两个已画的格只动段，不动笔数）');
      prev = after;
    }
    assert.equal(e.solved(), true);
    assert.equal(e.stats().moves, spec.par, '一路靠提示解完，笔数不该超出 par');
  }
});

// ---- 纯度与元数据 ----------------------------------------------------------------

test('引擎不碰 DOM、时钟与随机数：模块里不许出现这些东西', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/puzzles/masyu.js', import.meta.url), 'utf8');
  for (const bad of ['new Date', 'Date.now', 'Math.random', 'performance', 'document.', 'window.', 'localStorage']) {
    assert.equal(src.includes(bad), false, `引擎里出现了 ${bad}`);
  }
  assert.equal(/from '\.\.\//.test(src.split('\n').find((l) => l.startsWith('import { isCell'))), true);
  for (const line of src.split('\n')) {
    if (line.includes('import') && line.includes('ui/')) assert.fail(`引擎 import 了视图层：${line}`);
  }
});

test('玩法元数据齐全：外壳渲染首页要用到每个字段', () => {
  assert.equal(masyu.id, 'masyu');
  assert.equal(masyu.title, '珍珠');
  assert.equal(masyu.latin, 'MASYU');
  assert.equal(masyu.unit, '格', '格心玩法的计量单位是格');
  assert.ok(masyu.tagline && masyu.rules.length >= 3);
  assert.equal(masyu.sizes.length, 3);
  for (const s of masyu.sizes) assert.ok(s.key && s.label && s.tier, JSON.stringify(s));
  assert.equal(typeof masyu.generate, 'function');
  assert.equal(typeof masyu.create, 'function');
  const e = create(masyu.generate('meta:0', 6));
  assert.equal(e.step, 2);
  assert.equal(typeof e.draw, 'function');
  assert.equal(typeof e.badCells, 'function');
});

// TODO(engine-bug): 唯一性是数出来的、拖拽轨迹是齐的，但"纯逻辑推得完"并不覆盖全部题面：
//   每档 40 颗种子（u6:* / u7:* / u8:*）里，logicSolve 推不完的是
//     6×6：3 道（u6:6 / u6:35 / u6:38，不动点还剩 24~28 个未知段）
//     7×7：4 道（u7:12 / u7:13 / u7:17 / u7:39）
//     8×8：11 道（u8:6/7/14/18/19/21/26/30/31/33/34，u8:6 不动点后仍有 75/112 未知）
//   复现：generate('u8:6', 8) 后 logicSolve(spec) === null，而 countSolutions(spec, 2) 仍是
//   { count: 1, capped: false }。generate() 里 `score = (mined.logic ? 100 : 0) + …` 允许
//   20 次尝试全不推得完时交出猜解题；挑战档近三成题玩家必须靠试，与"人做的题"的定位有出入。
//   期望行为：挑战档也优先交纯逻辑推得完的题面（比如把 minLen 提高让珍珠约束更强，或失败时换形状）。
//   下面的断言按"当前如实行为"钉住上界；条数一涨就会响，不要把它改宽。
test('已知缺口：每档 40 道里纯逻辑推不完的道数（当前如实值）', () => {
  const AS_SHIPPED = { 6: 3, 7: 4, 8: 11 };
  for (const key of [6, 7, 8]) {
    const bad = SEEDS(`u${key}`, 40).filter((s) => !logicSolve(generate(s, key)));
    assert.ok(bad.length <= AS_SHIPPED[key], `${key}×${key} 推不完 ${bad.length} 道，比已知值 ${AS_SHIPPED[key]} 更差`);
    for (const s of bad) {
      const spec = generate(s, key);
      assert.equal(spec.count, 1, `${s} 推不完还自称唯一`);
      assert.ok(solveOne(spec), `${s} 连一条解都找不出来`);
    }
  }
});
