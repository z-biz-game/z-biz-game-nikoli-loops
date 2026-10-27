# 纸上逻辑 Nikoli · 环线 · 交付卡

> 本文件由 `003_辅助能力/audit/script/gen_deliverable.py` 从本仓 README、package.json 与 `git ls-files` 生成，**不要手改**；改源后重跑，`--check` 必须逐字节一致。
> 读数取自本仓 `git ls-files` 与 package.json，均不含本文件自身；这里不写提交号，所以 `--check` 比的是内容，不是时间。

## 一句话

浏览器原生的点阵推理谜题合集：圈环 / 珍珠 / 箭头 / 数桥。四款玩法画的是**点与点

- 仓名：`z-biz-game-nikoli-loops`　组别：A · 益智消除与棋类
- 技术栈：Electron + Canvas

## 怎么跑

```sh
npm start    # node tools/serve.mjs
```

## 怎么验

| 层 | 命令 |
| --- | --- |
| 整仓门禁 | `bash tools/verify.sh` |
| 单元/规则测试 | `npm test` |
| npm verify | `npm run verify` |

## 规模

| 指标 | 读数 |
| --- | ---: |
| 跟踪文件 | 52 |
| 应用代码 | 6,959 行（JS 6,460 / CSS 317 / HTML 182） |
| 测试/工具文件 | 9 个 |
| 依赖 | `dependencies` 0 / `devDependencies` 0 |
| 位图资产（不含 shots） | 15 个 / 347 KB |

## 目录

```
.github .gitignore LICENSE README.md assets css docs icons index.html js manifest.webmanifest package.json sw.js test tools
```

## 已知边界

`npm test` 里那 **2 项 `todo`** 是这个仓故意亮着的两盏红灯：它们各自断言一件引擎现在
做不到的事，标成 `todo` 是为了"看得见、但不拦上线"——**不许**为了让读数好看把它们改成
`skip` 或删掉，也不许把期望值改成引擎当前给得出的那个（那等于把天花板写进断言）：
- **箭头 Arukone**（`test/arukone.test.mjs` 那条「不同种子的题面各不相同：线索、环长、环都得
  动起来（6×6 八颗种子）」）：`propagate` 只推得完"四线索方框族"，
  所以不同种子的题面在环长与环的形状上动的幅度有限（题面多样性天花板十几张）。本轮这一盏灯
  报出来的原话是「8 颗种子只出 **7** 张不同题面，其中 **1** 次落到兜底 `fallbackSpec(6,6)`」——
  `todo` 项的断言消息会照样打印，不静默。
  唯一解与可推完这两条仍然逐颗种子成立 —— 这条 todo 说的是**多样性**，不是正确性。
- **珍珠 Masyu**（`test/masyu.test.mjs` 那条「黑珠颗数也该跟着种子动」）：能纯逻辑推完的环≈矩形回字环，
  四角就是黑珠，于是 7×7 的黑珠颗数只有 4/3 这几种 —— 黑珠颗数是**固有常数**，不随种子动。
  这条要等 wiggle 环能出题才该转绿。
另外三件任何闸都没说它能做到的事，按实写在这里：
- **不承诺大盘面**。四款的档位就停在表里那三档（最贵 8×8 / 11×11 数桥）；比菜单更大的尺寸
  没有闸守住"人能点得中"——半格坐标的命中框只有半个格，无头复验只在 390×720 视口验过那三款。
- **不承诺"数得出"等于"推得完"**。唯一性由 `propagate` 推到不动点**证明**，
  `countSolutions` 只当保险丝；数不完就如实标 `capped`，绝不说"唯一"。珍珠那一档写的是
  "能纯逻辑推完的盘优先发"，不是"只发纯逻辑盘"——这一字之差正是上面那条 Masyu todo 的位置。
- **不承诺 `file://` 能打开**。裸 ES Module 在 `file://` 下被 CORS 挡掉，必须有 `http://`。

## 证据

- 重跑：在 lead 仓根执行 `python3 003_辅助能力/audit/script/gen_deliverable.py ../z-biz-game-nikoli-loops --check`，应与本文件逐字节一致。
- 漂了就重跑并复核读数变化：新增文件、改 README 的边界小节、加/删闸都会让它变，这些变化本身就是要看的内容。
