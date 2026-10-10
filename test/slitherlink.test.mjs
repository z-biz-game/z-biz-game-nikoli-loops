// 圈环的三道保险：
//   1) 生成器不许说谎 —— countSolutions 数到 2 必须只数出 1，且 capped 为假。
//   2) 校验器与求解器互不引用 —— validateIndices 独立判"一条闭环 + 数字全对"，
//      拿它复核求解器的产物，两边对得上才承认那是解。
//   3) 引擎是个纯状态机 —— 只用公开 API 走子；moves 单调；赢了锁盘。

import test from 'node:test';
import assert from 'node:assert/strict';
import slitherlink, {
  UNKNOWN, NO, YES, nEdges, edgeOfIndex, indexOfHalf, cellEdges, vertexEdges,
  clueGrid, propagate, logicSolve, countSolutions, solveOne, validateIndices,
  validate, generate, create, rescue,
} from '../js/puzzles/slitherlink.js';
import { edgeEnds } from '../js/core/lattice.js';

const SEEDS = (tag, k = 10) => Array.from({ length: k }, (_, i) => `${tag}:${i}`);
const setOf = (ks) => ks.slice().sort((a, b) => a - b).join(',');
const halfSet = (halves) => halves.map((h) => h.join(',')).sort().join('|');

// 一整圈外框 + 全盘线索：最小的人工可验证题面
function borderSpec(n) {
  const halves = [];
  for (let i = 0; i < n; i++) halves.push([2 * i + 1, 0], [2 * i + 1, 2 * n]);
  for (let j = 0; j < n; j++) halves.push([0, 2 * j + 1], [2 * n, 2 * j + 1]);
  const idx = halves.map(([x, y]) => indexOfHalf(n, x, y));
  const on = new Set(idx);
  const clues = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let c = 0;
    for (const k of cellEdges(n, i, j)) if (on.has(k)) c++;
    clues.push([i, j, c]);
  }
  return { n, clues, solution: idx.map((k) => edgeOfIndex(n, k)), par: idx.length };
}

// 一条边一次落子：按下再抬手
function drawEdges(e, halves) {
  for (const [x, y] of halves) { e.down(x, y, 0); e.up(); }
}

// ---- 半格索引 ↔ 边 ---------------------------------------------------------------

test('edgeOfIndex / indexOfHalf 互为反函数，且每条边都落在正确的半格带上', () => {
  for (const n of [5, 6, 7]) {
    const seen = new Set();
    for (let k = 0; k < nEdges(n); k++) {
      const [hx, hy] = edgeOfIndex(n, k);
      assert.equal(indexOfHalf(n, hx, hy), k, `n=${n} k=${k}`);
      assert.equal((hx % 2 === 1) !== (hy % 2 === 1), true, '一条边必须只跨一个方向');
      assert.equal(hx >= 0 && hx <= 2 * n && hy >= 0 && hy <= 2 * n, true, `越界 ${hx},${hy}`);
      seen.add(hx + ',' + hy);
    }
    assert.equal(seen.size, nEdges(n), '边不能重复也不能漏');
  }
});

test('cellEdges / vertexEdges 与 edgeEnds 说的是同一份邻接', () => {
  const n = 5;
  // 每条格边的两端必须是这个格的角点
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const corners = new Set([[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]].map(([x, y]) => x + ',' + y));
    assert.equal(cellEdges(n, i, j).length, 4);
    for (const k of cellEdges(n, i, j)) {
      for (const [x, y] of edgeEnds(...edgeOfIndex(n, k))) assert.equal(corners.has(x + ',' + y), true);
    }
  }
  // 点挂几条边：角 2、边 3、心 4
  assert.equal(vertexEdges(n, 0, 0).length, 2);
  assert.equal(vertexEdges(n, 2, 0).length, 3);
  assert.equal(vertexEdges(n, 2, 2).length, 4);
  // 反向也成立：一条边恰好被它的两个端点各列出一次，不多不少
  const listed = new Map();
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    for (const k of vertexEdges(n, i, j)) {
      const key = k + '@' + i + ',' + j;
      assert.equal(listed.has(key), false, `点 ${i},${j} 重复列出边 ${k}`);
      listed.set(key, true);
      assert.equal(edgeEnds(...edgeOfIndex(n, k)).some(([x, y]) => x === i && y === j), true,
        `点 ${i},${j} 不该挂着边 ${k}`);
    }
  }
  for (let k = 0; k < nEdges(n); k++) {
    const [[ax, ay], [bx, by]] = edgeEnds(...edgeOfIndex(n, k));
    assert.equal(listed.has(k + '@' + ax + ',' + ay), true, `边 ${k} 没被端点 ${ax},${ay} 列出`);
    assert.equal(listed.has(k + '@' + bx + ',' + by), true, `边 ${k} 没被端点 ${bx},${by} 列出`);
  }
});

// ---- 独立校验器 ------------------------------------------------------------------

test('validateIndices: 外框是合法环，少一条边就不是', () => {
  const spec = borderSpec(4);
  const edges = spec.solution.map(([x, y]) => indexOfHalf(spec.n, x, y));
  assert.equal(validateIndices(edges, spec.n, spec.clues), true);
  assert.equal(validateIndices(edges.slice(1), spec.n, spec.clues), false);
  assert.equal(validateIndices(edges.slice().reverse(), spec.n, spec.clues), true, '顺序无关');
  const stray = edges.map((k) => (k === edges[0] ? nEdges(spec.n) - 1 : k));
  assert.equal(validateIndices(stray, spec.n, spec.clues), false, '换一条不相干的边必须判死');
});

test('validateIndices 拒绝"两个小环"，即使每个点度数都是 2', () => {
  const n = 4;
  const ring = (ci, cj) => {
    const out = [];
    for (let i = 0; i < 2; i++) out.push(indexOfHalf(n, 2 * (ci + i) + 1, 2 * cj), indexOfHalf(n, 2 * (ci + i) + 1, 2 * (cj + 2)));
    for (let j = 0; j < 2; j++) out.push(indexOfHalf(n, 2 * ci, 2 * (cj + j) + 1), indexOfHalf(n, 2 * (ci + 2), 2 * (cj + j) + 1));
    return out;
  };
  const edges = ring(0, 0).concat(ring(2, 2));
  const on = new Set(edges);
  const clues = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let c = 0;
    for (const k of cellEdges(n, i, j)) if (on.has(k)) c++;
    clues.push([i, j, c]);
  }
  assert.equal(validateIndices(edges, n, clues), false, '分成了两个环');
  assert.equal(validateIndices(ring(0, 0), n, clues), false, '单环对不上数字');
});

test('validate(spec, 半格坐标) 与 validateIndices 同口径', () => {
  const spec = generate('roundtrip:0', 5);
  assert.equal(validate(spec, spec.solution), true);
  assert.equal(validate(spec, spec.solution.slice(0, -1)), false);
});

// ---- 传播规则 --------------------------------------------------------------------

test('propagate: 数字满了就封其余，缺口正好等于未知数就全画', () => {
  const n = 5;
  const full = new Int8Array(nEdges(n)).fill(UNKNOWN);
  assert.equal(propagate(full, n, [[0, 0, 4]]), true);
  assert.equal(cellEdges(n, 0, 0).every((k) => full[k] === YES), true, '格边一共 4 条，说 4 就是全画');
  const empty = new Int8Array(nEdges(n)).fill(UNKNOWN);
  assert.equal(propagate(empty, n, [[2, 2, 0]]), true);
  assert.equal(cellEdges(n, 2, 2).every((k) => empty[k] === NO), true);
  // 一个点已经挂了两条：第三条只能是封掉
  const v = new Int8Array(nEdges(n)).fill(UNKNOWN);
  const es = vertexEdges(n, 2, 2);
  v[es[0]] = YES; v[es[1]] = YES;
  assert.equal(propagate(v, n, []), true);
  assert.equal(es.slice(2).every((k) => v[k] === NO), true);
  // 一个点只剩一条未知边、已经画了一条：那一条也必须画（环过这个点就得成对）
  const corner = vertexEdges(n, 0, 0);                 // 角点只有两条出边
  assert.equal(corner.length, 2);
  const w = new Int8Array(nEdges(n)).fill(UNKNOWN);
  w[corner[0]] = YES;
  assert.equal(propagate(w, n, []), true);
  assert.equal(w[corner[1]], YES, '角点进来一条就得再出去一条');
});

test('propagate 把矛盾如实吞掉：数字大过格边数就是死局', () => {
  const n = 5;
  assert.equal(propagate(new Int8Array(nEdges(n)).fill(UNKNOWN), n, [[0, 0, 5]]), false);
  const s = new Int8Array(nEdges(n)).fill(UNKNOWN);
  for (const k of cellEdges(n, 1, 1)) s[k] = YES;
  assert.equal(propagate(s, n, [[1, 1, 3]]), false, '画了 4 条却只许 3 条');
});

test('closedTooEarly：先闭成一圈、外头还挂着散边 → 传播判死', () => {
  const n = 5;
  const sub = cellEdges(n, 1, 1);                     // 一个 1×1 的小环
  const on = new Set(sub);
  const clues = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let c = 0;
    for (const k of cellEdges(n, i, j)) if (on.has(k)) c++;
    if (c > 0) clues.push([i, j, c]);
  }
  const lone = new Int8Array(nEdges(n)).fill(UNKNOWN);
  for (const k of sub) lone[k] = YES;
  assert.equal(propagate(lone, n, clues), true, '一个小环 + 数字吻合，不该被误杀');
  const stray = indexOfHalf(n, 2 * n - 1, 0);         // 盘顶最右那条边，离小环很远
  assert.equal(sub.includes(stray), false);
  lone[stray] = YES;
  assert.equal(propagate(lone, n, clues), false, '圈外还挂着边 = 子环，非法');
});

test('logicSolve 从空盘推完的题，解与题面自带的答案逐条相同', () => {
  for (const n of [5, 6, 7]) {
    const spec = generate(`logic:${n}`, n);
    const sol = logicSolve(spec);
    assert.ok(sol, `${n} 纯逻辑推不完`);
    assert.equal(halfSet(sol.edges.map((k) => edgeOfIndex(n, k))), halfSet(spec.solution));
  }
});

// ---- 生成器：唯一性是真数出来的 ---------------------------------------------------

for (const tier of [5, 6, 7]) {
  test(`生成的每道题都只有唯一解，而且纯逻辑推得完（${tier}×${tier}）`, () => {
    for (const seed of SEEDS(`u${tier}`, 40)) {
      const spec = generate(seed, tier);
      assert.ok(spec.clues.length, seed);
      assert.ok(spec.par > 0, seed);
      const { count, capped } = countSolutions(spec, 2);
      assert.equal(capped, false, `${seed} 没数完就别说唯一`);
      assert.equal(count, 1, `${seed} 数出 ${count} 个解`);
      assert.ok(logicSolve(spec), `${seed} 推理链断了`);
      assert.equal(validate(spec, spec.solution), true, `${seed} 题面与答案不自洽`);
      assert.equal(spec.par, spec.solution.length, 'par 必须是唯一解的边数');
    }
  });
}

test('题面不许印 4：那等于把四条边直接涂给玩家看', () => {
  for (const n of [5, 6, 7]) {
    for (const seed of SEEDS(`c${n}`, 6)) {
      for (const [, , c] of generate(seed, n).clues) assert.ok(c < 4, `${seed} 印了个 ${c}`);
    }
  }
});

test('保底题面交得出题：4..10 每一档都数得出唯一解', () => {
  // generate() 里那条"永不该走到"的路径一旦哑火，玩家看到的就是空白盘。
  // 所以它得逐项验，而不是靠"生成器很少兜底"。保底允许人蒙一步（全盘线索推不完），
  // 但不许发多解题 —— 唯一性照样得是数出来的。
  for (let n = 4; n <= 10; n++) {
    const spec = rescue(n);
    assert.ok(spec && spec.clues.length, `n=${n} 交白卷`);
    const t0 = Date.now();
    const { count, capped } = countSolutions(spec, 2, null, 200000);
    assert.ok(Date.now() - t0 < 400, `n=${n} 保底题面数解花了 ${Date.now() - t0}ms`);
    assert.equal(count, 1, `n=${n} 保底题面数出 ${count} 个解`);
    assert.equal(capped, false, `n=${n} 保底题面没数完`);
    assert.equal(validate(spec, spec.solution), true, `n=${n} 保底题面与答案不自洽`);
    assert.equal(spec.par, spec.solution.length, `n=${n} 保底 par 不是解的边数`);
    assert.ok(spec.stroke, `n=${n} 保交出不了拖拽轨迹`);
  }
});

test('正常种子用不到保底：全盘印满线索的那几道才是异常', () => {
  for (const n of [5, 6, 7]) {
    const full = SEEDS(`r${n}`, 12)
      .map((s) => generate(s, n))
      .filter((spec) => spec.clues.length === n * n).length;
    assert.equal(full, 0, `${n}×${n} 有 ${full}/12 道走了保底`);
  }
});

test('同一颗种子在任何设备上得到同一道题，spec 过一遍 JSON 也不变味', () => {
  const a = generate('daily:2026-09-27|slitherlink', 6);
  const b = generate('daily:2026-09-27|slitherlink', 6);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
  const e = create(JSON.parse(JSON.stringify(a)));
  assert.equal(validate(e.spec, e.spec.solution), true);
});

test('不同种子的题面不会全一样：线索与环长都在动', () => {
  const specs = SEEDS('var', 8).map((s) => generate(s, 6));
  assert.ok(new Set(specs.map((s) => JSON.stringify(s.clues))).size >= 6);
  assert.ok(new Set(specs.map((s) => s.par)).size >= 3);
});

test('出题在手机上不卡：每档十道题各有预算', () => {
  for (const n of [5, 6, 7]) {
    const t0 = Date.now();
    for (const seed of SEEDS(`t${n}`)) generate(seed, n);
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `${n}×${n} 十道题花了 ${ms}ms`);
  }
});

// ---- 引擎状态机 ------------------------------------------------------------------

test('主笔：一条边一次落子，来回点不退款', () => {
  const e = create(generate('pen:0', 5));
  const [hx, hy] = e.spec.solution[0];
  assert.equal(e.down(hx, hy, 0), true);
  assert.equal(e.stats().moves, 1);
  assert.equal(e.stats().done, 1);
  e.up();
  assert.equal(e.down(hx, hy, 0), true, '再点同一条是擦除，也算一次输入');
  assert.equal(e.stats().done, 0);
  e.down(hx, hy, 0);
  assert.equal(e.stats().moves, 2, '重画不退款');
  assert.equal(e.stats().done, 1);
});

test('副笔的封边不计步，也不算环的一部分', () => {
  const e = create(generate('pen:1', 5));
  const [hx, hy] = e.spec.solution[0];
  assert.equal(e.down(hx, hy, 1), true);
  assert.equal(e.stats().moves, 0);
  assert.equal(e.stats().done, 0);
  assert.equal(validate(e.spec, [[hx, hy]]), false);
});

test('拖着一笔画过整条环：中间的空档不吞边，也不重复计步', () => {
  const e = create(generate('drag:0', 5));
  const loop = e.spec.solution;
  e.down(loop[0][0], loop[0][1], 0);
  for (let i = 1; i < loop.length; i++) e.move(loop[i][0], loop[i][1]);
  e.up();
  assert.equal(e.stats().done, loop.length);
  assert.equal(e.stats().moves, loop.length);
  assert.equal(e.solved(), true);
});

test('画完一圈就赢，之后锁盘：任何落子都不吃', () => {
  const e = create(generate('win:0', 5));
  drawEdges(e, e.spec.solution);
  assert.equal(e.solved(), true);
  const before = e.stats();
  const stray = e.spec.solution[0].map((x, i) => x + (i ? 0 : 2));   // 环外一点
  assert.equal(e.down(stray[0], stray[1], 0), false);
  assert.equal(e.move(stray[0], stray[1]), false);
  assert.deepEqual(e.stats(), before);
});

test('只画对一半不算赢，缺口如实反映在 done/total', () => {
  const e = create(generate('half:0', 6));
  drawEdges(e, e.spec.solution.slice(0, e.spec.par - 1));
  assert.equal(e.solved(), false);
  const st = e.stats();
  assert.equal(st.done, st.total - 1);
});

test('badCells 点出违反数字的边，撤销后消失', () => {
  const e = create(generate('bad:0', 5));
  const n = e.spec.n;
  const g = clueGrid(n, e.spec.clues);
  let target = null;
  for (let j = 0; j < n && !target; j++) for (let i = 0; i < n && !target; i++) if (g[j * n + i] === 1) target = [i, j];
  assert.ok(target, '题面里得有一个 1');
  const es = cellEdges(n, target[0], target[1]);
  assert.equal(e.badCells().length, 0);
  drawEdges(e, es.slice(0, 3).map((k) => edgeOfIndex(n, k)));
  assert.equal(e.badCells().length, 3);
  e.undo(); e.undo();
  assert.equal(e.badCells().length, 0, '只剩一条边，数字 1 满足了');
});

test('badCells 也管点度数：一个点挂三条边就报错', () => {
  const e = create(generate('bad2:0', 6));
  const n = e.spec.n;
  const mid = vertexEdges(n, 2, 2).slice(0, 3);
  drawEdges(e, mid.map((k) => edgeOfIndex(n, k)));
  assert.ok(e.badCells().length >= 3);
});

test('undo / redo 把棋盘搬回原处，步数不退款', () => {
  const e = create(generate('undo:0', 5));
  const loop = e.spec.solution;
  drawEdges(e, loop.slice(0, 5));
  const mid = e.stats();
  assert.equal(e.canUndo(), true);
  for (let i = 0; i < 5; i++) assert.equal(e.undo(), true);
  assert.equal(e.stats().done, 0);
  assert.equal(e.stats().moves, mid.moves, '撤销退回盘面，绝不退回已经花掉的笔');
  assert.equal(e.undo(), false);
  assert.equal(e.canRedo(), true);
  for (let i = 0; i < 5; i++) assert.equal(e.redo(), true);
  assert.equal(e.stats().done, mid.done);
  assert.equal(e.stats().moves, mid.moves);
});

test('只用提示也能解完每一档，而提示必须真的改棋盘', () => {
  for (const n of [5, 6, 7]) {
    const e = create(generate(`hint:${n}`, n));
    let guard = 0;
    while (!e.solved()) {
      assert.ok(guard++ < 400, `${n} 提示解不完`);
      const before = e.stats();
      const h = e.hint();
      assert.ok(h, `${n} 提示返回空`);
      assert.equal(h.cells.length, 1);
      const [hx, hy] = h.cells[0];
      assert.equal((hx % 2 === 1) !== (hy % 2 === 1), true, '提示的坐标必须是条边');
      assert.ok(typeof h.note === 'string' && h.note.length);
      const after = e.stats();
      assert.notDeepEqual({ m: before.moves, d: before.done }, { m: after.moves, d: after.done });
    }
    assert.equal(e.solved(), true);
  }
});

test('提示与当前墨迹相容：画对一半再问，仍指向同一条环', () => {
  const spec = generate('hint2:0', 6);
  const part = spec.solution.slice(0, Math.floor(spec.par / 2)).map(([x, y]) => indexOfHalf(spec.n, x, y));
  const seed = new Int8Array(nEdges(spec.n)).fill(UNKNOWN);
  for (const k of part) seed[k] = YES;
  const sol = solveOne(spec, seed);
  assert.ok(sol);
  assert.equal(setOf(sol), setOf(spec.solution.map(([x, y]) => indexOfHalf(spec.n, x, y))));
});

test('par 是可证下界：照答案画正好用完 par 步', () => {
  for (const n of [5, 6, 7]) {
    const spec = generate(`par:${n}`, n);
    const e = create(spec);
    drawEdges(e, spec.solution);
    assert.equal(e.stats().moves, spec.par);
    assert.equal(e.stats().par, spec.par);
    assert.equal(e.solved(), true);
  }
});

test('引擎不碰 DOM、时钟与随机数：模块里不许出现这些东西', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/puzzles/slitherlink.js', import.meta.url), 'utf8');
  for (const bad of ['document.', 'window.', 'localStorage', 'Math.random', 'new Date']) {
    assert.equal(src.includes(bad), false, `引擎里出现了 ${bad}`);
  }
});

test('spec.stroke 是同一圈边的可拖顺序：相邻两条共点，集合与 solution 完全相同', () => {
  for (const n of [5, 6, 7]) {
    const spec = generate(`stroke:${n}`, n);
    assert.equal(spec.stroke.length, spec.par);
    const a = spec.stroke.map((h) => h.join(',')).sort().join('|');
    const b = spec.solution.map((h) => h.join(',')).sort().join('|');
    assert.equal(a, b, '顺序表不许增删边');
    const idx = spec.stroke.map(([x, y]) => indexOfHalf(n, x, y));
    for (let k = 0; k + 1 < idx.length; k++) {
      const s1 = new Set(edgeEnds(...edgeOfIndex(n, idx[k])).map(([x, y]) => x + ',' + y));
      const s2 = new Set(edgeEnds(...edgeOfIndex(n, idx[k + 1])).map(([x, y]) => x + ',' + y));
      assert.ok([...s1].some((v) => s2.has(v)), `第 ${k} 条与下一条不共点，手指拖不过去`);
      // 半格索引必须只差 2：视图靠这个判断"中间那个点是经过，不是落子"
      const [x1, y1] = edgeOfIndex(n, idx[k]);
      const [x2, y2] = edgeOfIndex(n, idx[k + 1]);
      assert.equal(Math.abs(x1 - x2) + Math.abs(y1 - y2), 2);
    }
    // 收尾那条得能接回头一条（环）
    const first = new Set(edgeEnds(...edgeOfIndex(n, idx[0])).map(([x, y]) => x + ',' + y));
    const last = new Set(edgeEnds(...edgeOfIndex(n, idx[idx.length - 1])).map(([x, y]) => x + ',' + y));
    assert.ok([...first].some((v) => last.has(v)), '环没收拢');
  }
});

test('玩法元数据齐全：外壳渲染首页要用到每个字段', () => {
  assert.equal(slitherlink.id, 'slitherlink');
  assert.ok(slitherlink.title && slitherlink.latin && slitherlink.tagline && slitherlink.unit);
  assert.ok(slitherlink.rules.length >= 3);
  assert.equal(slitherlink.sizes.length, 3);
  for (const s of slitherlink.sizes) assert.ok(s.key && s.label && s.tier);
  assert.equal(typeof slitherlink.generate, 'function');
  assert.equal(typeof slitherlink.create, 'function');
});
