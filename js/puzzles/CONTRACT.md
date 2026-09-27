# 环线玩法引擎契约

这个仓是 `z-biz-game-nikoli-cos` 的姊妹仓：外壳、存档、星级口径、无头复验套路完全一样，
**只有坐标系不一样**。数织那类玩法往"格"里落子，这里的四款（圈环 / 珍珠 / 箭头 / 数桥）
画的是**点与点之间的边**，输入命中框只有半个格，所以独立一套视图（`js/ui/lattice_view.js`）
和一份契约，而不是去改那边已经跑通的格坐标约定。

## 坐标系：半格索引

相邻两个点之间的距离是一个步进，称为"半格"。落子坐标 `(hx, hy)` 的奇偶决定它是什么目标：

| 奇偶 | 含义 | 备注 |
|---|---|---|
| 偶, 偶 | 点 (i=hx/2, j=hy/2) | 圈环的落子目标在点与点之间，点是线的接头 |
| 奇, 偶 | 横边 | 连接点 (i,j)→(i+1,j)，`i=(hx-1)/2, j=hy/2` |
| 偶, 奇 | 竖边 | 连接点 (i,j)→(i,j+1)，`i=hx/2, j=(hy-1)/2` |
| 奇, 奇 | 格心 (i=(hx-1)/2, j=(hy-1)/2) | 珍珠 / 箭头 / 数桥的落子目标 |

**两种玩法族共用这一块画布**，靠引擎声明自己吃哪一类目标：

| 玩法 | 落子目标 | `engine.step` | 一条 `moves` |
|---|---|---|---|
| 圈环 Slitherlink | 横边 / 竖边 | 1 | 画一条边 |
| 珍珠 Masyu、箭头 Arukone | 格心 | 2 | 线穿过一个格 |
| 数桥 Hashi | 格心（岛） | 2 | 搭一根桥（拖过多少格都算一次） |

`engine.step` 告诉键盘光标一次走多少个半格：环边玩法线是逐边长的，走 1；格心玩法的
目标是隔一个半格一个，走 2。视图 `nudge()` 按这个数步进，其余输入路径完全一致 ——
这也是无头复验能用同一套指针事件把四款都画完的原因。不认识的奇偶（比如格心玩法收到
一条边）必须返回 `false` 并原样忽略，绝不静默改状态。

点阵是 `(cols+1) × (rows+1)` 个点、`cols × rows` 个格。几何换算全在 `js/core/lattice.js`
（`isHEdge / isVEdge / hEdge / vEdge / edgeSides / edgesAt / edgeEnds / halfPoint / cellCenter`
以及格心用的 `isCell / cellOf / cellAt`），**引擎只准 import `js/core/*`，绝不 import `js/ui/*`**
—— 否则 `node --test` 跑不动。

## kind 描述符（模块 default export）

```js
{
  id: 'slitherlink', title: '圈环', latin: 'SLITHERLINK',
  tagline: '…', rules: ['…'], unit: '条',
  sizes: [{ key: 5, label: '5×5', tier: '入门' }, …],
  generate(seed, sizeKey) -> spec,   // 纯函数；spec 必须能 JSON.stringify
  create(spec) -> engine,
}
```

## engine

```js
{
  spec,
  step: 1 | 2,                                   // 键盘光标一次走几个半格：边玩法 1，格心玩法 2
  board: { cols, rows, margin: { l, t, r, b } },  // cols/rows 是格数；余量以格为单位
  down(hx, hy, btn) -> changed     // btn=0 主笔画边，btn=1 副笔（打叉等记号）
  move(hx, hy)   -> changed        // 拖拽经过的每个半格都会递一次（含中间那个点）
  up()           -> changed
  undo()/redo()/canUndo()/canRedo()
  hint() -> null | { cells: [[hx, hy], …], note: '' }   // 必须真的落子
  solved() -> bool
  stats() -> { moves, par, done, total }
  draw(ctx, v, now)                // 每帧自己画整个盘面
  celebrate(ctx, v, now, t)        // 可选
  badCells() -> [[hx, hy], …]      // 可选：与题面矛盾的"边"，外壳在抬手时算一次（只为音效）
}
```

`v`（view）每帧由 UI 构造：

```js
{ cell, sub, ox, oy, cols, rows, w, h, dpr, hover: {x, y} | null, reduce }
```

`cell` 是**点距**，`sub = cell/2` 是半格步进；点 `(i,j)` 在 `(ox + i*cell, oy + j*cell)`，
半格 `(hx,hy)` 的中心在 `(ox + hx*sub, oy + hy*sub)`。报错的边/格由引擎自己算并缓存
（`badCells()` 在状态变化时置脏，绘制时按需重算）—— 求解器级的检查不能跟着
`pointermove` 每帧跑，外壳只在抬手时调一次来决定要不要响错误音。

## moves / par 的口径（评星就靠这两个数）

**一条边 = 一次落子。** 按住拖过 3 条新边就是 3 次 `moves`；拖回已画过的边不另收；
擦除、改画**一律不退款**（撤销也不退，所以 `moves - par` 就是浪费掉的笔数）。
副笔画的记号（打叉表示"这条边一定不画"）不计入 `moves`，与数织的画叉同口径。

`par` 必须是**可证明的下界**，不能是常数：环类玩法一律取**唯一解的边数**
（依据：解里每条边至少要画一次，谁也不能一笔画出两条）。数桥取桥的根数（一根桥一次拖拽）。

星级：★ 解出 · ★★ 零提示 · ★★★ 零提示且 `moves ≤ ceil(par × 1.2)`。
判胜之后棋盘锁输入（`down()` 返回 false），改笔必须走撤销。

## 生成器的质量底线

1. **唯一解**：带计数的求解器 `countSolutions(spec, cap)` 数到 2 就早停；没数完要置
   `capped: true` 并拒绝端这道题。`capped` ≠ 无解 —— 求解器不许说谎。
2. **不许返回 null**：候选不达标就换下一个候选；兜底路径必须保证交得出题。
3. **可复现**：同 `seed` 同 `sizeKey` 在任何设备上同一道题（每日挑战靠这个"全球同题"），
   所以随机只能来自 `rngFrom(seed)`，不许碰 `Date` / `Math.random` / `performance.now`。
4. **胜负判定要有一条独立于求解器的规则校验**（`validate(spec, edges)`）：
   边集是否构成单一闭环（不分叉、不交点、不错题面数字）、是否满足全部题面约束。
   求解器负责"找得到解"，校验器负责"这个解真的是解"，两者对拍才算数。
5. 每档三阶，最贵一档 `generate()` 平均耗时 < 120ms；单个测试文件 `node --test` < 30s。
6. 约束全部写进 `test/<id>.test.mjs`，每档 fuzz 40 个 seed 守住，不靠人工抽查。
7. 无头复验要能用真指针事件一路画到通关：`spec` 里必须留得出一份"获胜笔画序列"
   （唯一解的边集 + 一个能按顺序拖出来的走法），见 `tools/playtest.mjs` 的 `steps()`。
