# 纸上逻辑 Nikoli · 环线

浏览器原生的点阵推理谜题合集：**圈环 / 珍珠 / 箭头 / 数桥**。四款玩法画的是**点与点
之间的边**，不是格子里的墨块 —— 这是 [纸上逻辑 Nikoli](https://github.com/z-biz-game/z-biz-game-nikoli-cos)
（数织 / 数链 / 点灯 / 孔明棋）的姊妹辑：外壳、存档、星级口径一模一样，坐标系不一样。

每道玩法都自带一个唯一解生成器和一个真求解器：提示不是写死的剧本，而是当场从题面
推出来的那一步。

零构建、零运行时依赖、零美术与音频文件：打开 `index.html` 需要的那点东西全在 `js/`
里，Canvas 2D 画棋盘，WebAudio 合成音效，localStorage 存进度。

```bash
node tools/serve.mjs         # → http://127.0.0.1:5189/，然后点开任一档位
npm test                   # 引擎单测（不开浏览器）= `node --test test/*.test.mjs`
bash tools/verify.sh         # 单测 + 无头 Chrome 真指针通关，一把梭
```

> 直接双击 `index.html` 不行：裸 ES Module 在 `file://` 下会被 CORS 挡掉，必须有 http://。

## 四种玩法

| 玩法 | 档位 | 一句话规则 | 生成器保证 |
| --- | --- | --- | --- |
| 圈环 Slitherlink | 5×5 / 6×6 / 7×7 | 数字说"恰好这么多条边贴着我" | 只发纯逻辑推得完的盘；题面可以含 0（那是正经证词），4 永不印上盘 |
| 珍珠 Masyu | 6×6 / 7×7 / 8×8 | 白珠直穿、两头各要一次拐弯；黑珠拐弯、前后各伸出两格 | 唯一解由数解器复核；能纯逻辑推完的盘优先发 |
| 箭头 Arukone | 6×6 / 7×7 / 8×8 | 数字说：沿环往两头各数这么多格才第一次拐弯 | 只发 `logicSolve` 推得完的盘（这是 8×8 从 12 秒回到 6 毫秒的原因） |
| 数桥 Hashi | 7×7 / 9×9 / 11×11 | 岛上的数字 = 落在它身上的桥头数，一对岛最多两根 | 全数字面推得完的优先，允许带环的盘必须"数"得出唯一解，且所有岛连成一张 |

每道的完整规则文案就在 `js/puzzles/<玩法>.js` 的 `rules` 里，首页 `?` 按钮弹的就是它。

## 半格坐标：一整套玩法共用一块画布

相邻两个点之间是一次步进，称"半格"。落子坐标的奇偶决定它是什么：`(奇,奇)` 格心、
`(奇,偶)` 横边、`(偶,奇)` 竖边、`(偶,偶)` 点。圈环吃边（`engine.step = 1`），珍珠 /
箭头 / 数桥吃格心（`engine.step = 2`），两者共用 `js/core/lattice.js` 与
`js/ui/lattice_view.js`。代价是命中框只有半个格 —— 所以像素换算只准有一处定义，
无头复验里那句 `(h + 0.5) * sub` 是照着 `halfAt()` 的取带反推的。

## 引擎契约

外壳只管路由、计时、记分和输入设备无关性；棋盘内部的一切属于引擎。四套引擎实现同
一个契约（[`js/puzzles/CONTRACT.md`](js/puzzles/CONTRACT.md)）：

- `generate(seed, sizeKey) → spec` 是纯函数，`spec` 必须能 `JSON.stringify`；
- `create(spec) → engine` 不碰 DOM、不读时钟、不采样未播种的随机数；
- 同一个 seed 在任何设备上是同一道题 —— 每日挑战靠这个才"全球同题"；
- `moves` 单调累加：擦除、改画、撤销都不退款。评星因此测得出"人在试错"，洗不掉；
- `par` 是唯一解的量（环的边数 / 环上的格数 / 桥的根数），可证的下界，不是拍脑袋的目标；
- `hint()` 真的落子，不是弹一句话；
- 唯一性由 `propagate` 推到不动点**证明**，`countSolutions` 只当保险丝，数不完就如实
  标 `capped`，绝不说"唯一"。

加一道新玩法 = 一个引擎文件 + `registry.js` 里一行。

## 已验证

下面这一组数字是**本轮复跑**的读数（本机 2026-10-07，`node v26.8.1`，跑在本次改动后的树上），
每条都点名打印它的那道命令；命令换到别的机器上重跑，条数会变，而下面这些是这一次的账：

```bash
npm run check          # → OK（对 git ls-files 里每个 .js/.mjs 做 node --check，本轮 23 个文件）
npm test               # → tests 135 / pass 133 / fail 0 / todo 2 / duration_ms 8690
bash tools/verify.sh   # → rows: 55  fail: []  errors: []，末尾 === ALL GREEN ===，rc=0
```

- **135 项引擎单测**（`node --test test/*.test.mjs`，其中 2 项是故意标出来的 `todo`，见下面「已知边界」）。
  本轮逐文件计数：arukone 34 / hashi 34 / masyu 32 / slitherlink 32 / precache 3，两盏 todo 一盏在 arukone、
  一盏在 masyu。最重的一条是每档 fuzz 40 颗种子：逐道断言 `validate` 自洽、
  `countSolutions` 数到 2 早停仍得 `count = 1` 且 `capped = false`、`par` 等于唯一解的量、
  笔画序列真能一笔画完。保底题面（`rescue()` / `fallbackSpec()`）不靠"应该不会走到"——
  在 4..10 每一档上逐项验死。
- **闸的接线**（本轮改的就是这个）：CI 的「语法自检」原先把 `package.json` 的 `check` leg 逐字
  抄在 workflow 里（同一条 `git ls-files '*.js' '*.mjs'`，两边都是 23 个文件，所以对账无损），
  现在那一步是 `run: npm run check`；`tools/verify.sh` 的单测那一步同理从抄本改成调
  `npm test --silent`，输出落盘后再打印 `tests / pass / fail / todo` 四行计数。抄本的坏处不是
  啰嗦，是 leg 改了名单 CI 不会跟着红。
  更要紧的一处：这个脚本原先只有 `set -u`、没有 `pipefail`，而 `… | tail -14 || FAILED=1` 里
  `||` 判的是 `tail` 的退出码（tail 读到 EOF 就退 0）。CI 只有 `bash tools/verify.sh` 这一步会跑
  引擎单测，所以补 flag 之前，「引擎单测过了」这句话在 CI 里结构上不可能变红。
  本机两个方向的对照（同一份块文本，从定稿的 `verify.sh` 里原样摘出来跑）：干净树
  → `ℹ tests 135 / pass 133 / fail 0 / todo 2`、`FAILED=0`；一份带 planted 失败条目的副本
  （`_scratch/nl-red/`，132+1 条）→ `fail 1` 外加 `RED 单测 rc=1`、`FAILED=1`。
  计数行两种 reporter 都认（本机 spec 的 `ℹ tests N`、CI 非 TTY 走 tap 的 `# tests N`）。
- **接上退出码之后，这一步立刻红了一次**（`79b5fe6` 的 CI run `37529949939`）：
  `# tests 1 / pass 0 / fail 1 / duration_ms 39.7`，然后才是新加的 `RED 单测 rc=1`。
  把这仓的 CI 历史倒回去读，同一个形状出现在 `36421441160`、`37120631557`、`37342081161`、
  `37446970607` —— 四个不同的 commit、40 毫秒、`1..1`，所以它不是某条断言红了，而是
  **这条腿在 runner 上一个套件都没跑**：`npm test` 当时写的是目录写法 `node --test test/`。
  本机（`node v26.8.1`）同一条目录写法跑得出 135 项，姊妹仓 `z-biz-game-nikoli-cos` 在同一批
  runner 上用 `node --test test/*.test.mjs` 跑出 269 项，所以改成了显式 glob —— 五个文件由 shell
  展开，新增套件不用改这里，展开不到文件时会当场红而不是静默少跑。
  再加一道下限：计数行里的 `tests` 必须 ≥ 同一条 glob 数出来的套件文件数，且计数行必须存在。
  只看 rc 不够——CI 那一次报的 `1` 项本身就是红的，rc 已经接上了；但"什么都没发现 yet 退 0"
  这种跑法照样要红。三个方向的对照（块文本从定稿的 `verify.sh` 原样摘出来跑）：
  干净树 → `ℹ tests 135`、`FILES=5`、`FAILED=0`；把 runner 那次 `# tests 1 / fail 1` 的形状
  原样喂进去 → 两行红（`只报了 1 项，比 … 的 5 个套件还少` 与 `RED 单测 rc=1`）并打出
  `not ok` 那一行；rc=0 但不打印计数行 → `RED 单测没打印出 tests 计数行`、`FAILED=1`。
  本机没有 node 22（这个网络到不了 nodejs.org 与 docker hub），所以"目录写法在 runner 上具体
  怎么被发现"没有本地复现，只有上面那四次同形状的 CI 读数。换写法之后那一跑已经读回来了：
  `b2624d4` 的 CI run `37558874356` = `completed/success`，第 5 步打的是
  `# tests 135 / pass 133 / fail 0 / todo 2` 加 `rows: 55 fail: []`，与本机的 spec 读数同一组数
  ——这一步在本仓 CI 里第一次真的把 135 项跑了。下限为什么取"≥ 套件文件数"而不是"= 135"：
  同组织另两仓的 tap 顶格形状不一样（`z-biz-game-hitori-cos` 的 runner 日志里顶格 6 项是
  **六个文件**、`z-biz-game-zebra-cos` 的 29 项是 29 条用例名），所以条数会被 reporter 形状带着走，
  而"至少每个套件都得进来一次"这一步两边都判得准。
- **55 项无头复验**（`tools/playtest.mjs`，CDP `Input` 域）。真 `mousePressed/Moved/Released`
  打到画布上，四款各从最贵一档一路画到结算屏：判胜、星级、存档、HUD 全走 live 路径；
  两款坐标族各自验键盘光标（`step` 1 与 2 的夹取上界不同）、副笔不计步、撤销不退款；
  390×720 手机视口下圈环 / 珍珠 / 数桥各自重画一遍到底；全程零控制台错误。
  截图与 `result.json` 落在 `.playtest/`（已 gitignore，是复验产物不是源码）。
- **远端那一跑**（不是本机跑的，别把两者混成一件事）：`77f8c5e` 上 CI run
  `36421441160` 与 Pages run `36421441126` 都是 `completed/success`，CI 里跑的就是
  `bash tools/verify.sh`（`.github/workflows/ci.yml` 那一步叫「引擎单测 + 无头真指针通关」，
  看门狗 `WD_TIMEOUT=900`）。这一句先前写得太整：那次 run 的 success 里，**浏览器那 55 行是真跑了**
  （日志里逐条 `ok` 数得出来），而它名字里的"引擎单测"那一步当时打的是 `# tests 1 / # fail 1`，
  被 `tail` 的退出码吞成一个绿——见上面两条。线上页 <https://z-biz-game.github.io/z-biz-game-nikoli-loops/> 回 200。

## 已知边界（两处红着的诚实，不是待办清单）

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

## 端口

`tools/serve.mjs` 默认 **5189**，无头复验的 CDP 口默认 **9336**（两者都可以用 `SPORT` /
`CDP_PORT` 覆盖）。这两个数是刻意与姊妹辑 `z-biz-game-nikoli-cos` 的 5188 / 9335 错开的：
两个仓常常同时复验，撞了端口会**静默连到对面的页面**上去——那边全绿、这边一无所有。

光错开端口只是愿望，所以 `tools/verify.sh` 的预检**按字节比对**：起服后先取 `/` 的响应体，
与磁盘上的 `index.html` 逐字比，再取 `js/main.js` 同样逐字比；任一处不一致就
`预检失败：:5189 回的字节不是本仓的 index.html` 并 `exit 3`。这一条是这一轮补的——
补之前它只问"有没有 200"，而 5189 若被别的项目占着，本仓的 serve 会因 EADDRINUSE 死掉、
对面那个服务照样回 200，于是整趟复验打在别人的页面上还能全绿。
补完当场做过自证：在 5189 上摆一个只回 `<html><body>not the loops game</body></html>` 的
假服务再跑，预检报出上面那一句、`rc=3`；撤掉假服务后同一脚本 `rows: 55 fail: [] errors: []`
且 `=== ALL GREEN ===`、`rc=0`。

## 存档

进度、最佳用时、连续天数都在 localStorage（`js/core/storage.js`）。每日完成的键前缀
是 `loops-daily|`，与姊妹辑的 `nikoli-daily|` 隔开 —— 两仓同前缀会出现"在对面打过卡，
这边首页却已经划掉"。设置里可以导出成一串文本再导回来。

## 设计与坑

[`docs/DESIGN.md`](docs/DESIGN.md) 写的是看文件看不出来的那部分：为什么"推得完"比
"数得出"便宜三个数量级、0 为什么必须能印上盘、以及那个跑完全部单测也发现不了的输入
缺陷。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
