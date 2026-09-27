// 无头复验：把真指针事件（CDP Input domain）打到画布上，走玩家那条路 —— 坐标换算、
// pointerdown/move/up、落子判定、HUD、结算、存档全都要 live。
//
// 与 nikoli-cos 那份唯一的区别：这里的落子目标是**半格**。像素 ↔ 半格索引的换算只有
// 一行差别（`ox + (h + 0.5) * sub`），但它必须与 lattice_view.js 的 `halfAt()` 完全一致，
// 否则"点到隔壁的边"会伪装成"引擎算错了"。
//
//   node tools/playtest.mjs                 # 四种玩法全跑
//   KINDS=slitherlink node tools/playtest.mjs
// 前置：Chrome 已带 --remote-debugging-port 起好（tools/verify.sh 负责这件事）。
//   CDP_PORT=9336 BASE_URL=http://127.0.0.1:5189/ node tools/playtest.mjs

const PORT = process.env.CDP_PORT || 9336;
// 附着到哪个页面就按 origin 认，别硬编码端口：写死会在别的端口上静默对一个
// about:blank 求值，测试结果假绿。
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5189/';
const ORIGIN = new URL(BASE).origin;
const SHOTS = process.env.SHOT_DIR || null;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

// 档位取每款的最大档：复验要复验的就是最贵那一档还画得动、点得完。
const ONLY = process.env.KINDS ? process.env.KINDS.split(',') : null;

// ---- 页面侧：状态读取与"该怎么点" ------------------------------------------------

const PAGE = `
window.__t = {
  rows: [],
  ok(test, pass, detail) { this.rows.push({ test, pass: !!pass, detail: detail === undefined ? null : detail }); },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  frames: (n = 2) => new Promise((r) => { let k = n; const t = () => (--k <= 0 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
  state: () => window.nikoli.debug.state,
  view: () => window.nikoli.debug.view(),
  text: (sel) => (document.querySelector(sel) ? document.querySelector(sel).textContent.trim() : null),
  visible: (sel) => { const n = document.querySelector(sel); return !!n && !n.hidden; },

  async goto(hash) {
    location.hash = hash;
    for (let i = 0; i < 200; i++) {
      await this.wait(20);
      if (this.state().engine && this.state().kind && !document.querySelector('#play').hidden) break;
    }
    await this.frames();
    return !!this.state().engine;
  },

  // 获胜笔画从题面里读出来，一律是"半格坐标序列"。像素换算留在 node 侧。
  // 这几个都得写成方法简写：对象字面量里的箭头函数抓的是 window，不是 __t。
  steps(kind, size) {
    const spec = this.state().engine.spec;
    // stroke：一条连续可拖的轨迹（圈环的环、珍珠/箭头的回路都按这个口径给出）
    if (spec.stroke && spec.stroke.length) return { mode: 'drag', halves: spec.stroke };
    // 数桥是"一根桥一次拖拽"：bridges 是岛序号对，岛条目本身就带半格坐标
    if (spec.bridges && spec.islands) {
      return { mode: 'lanes', lanes: spec.bridges.map(([p, q]) => [spec.islands[p], spec.islands[q]]) };
    }
    if (spec.solution && spec.solution.length) return { mode: 'drag', halves: spec.solution };
    throw new Error(kind + ' 的题面没带获胜笔画序列（契约第 7 条）');
  },

  geom() {
    const v = this.view();
    const r = v.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, ox: v.view.ox, oy: v.view.oy, cell: v.view.cell, sub: v.view.sub, cols: v.view.cols, rows: v.view.rows };
  },

  // 等几何稳定再落子：HUD 文案一变长，控制行换行 → board-wrap 改尺寸 → ResizeObserver
  // 在下一帧才重排画布。ResizeObserver 的回调排在 rAF 之后，所以只等一帧不够。
  async settle() {
    if (!this.trace) this.trace = [];
    let prev = null;
    for (let i = 0; i < 8; i++) {
      await this.frames(1);
      const g = this.geom();
      const k = [g.left, g.top, g.cell].map((n) => Math.round(n * 4)).join('/');
      if (k === prev) return g;
      if (this.trace[this.trace.length - 1] !== k) this.trace.push(k);
      prev = k;
    }
    return this.geom();
  },

  // 落子探针：在引擎门口记一笔，指针事件到底变成了哪个半格，一目了然。
  spy() {
    const e = this.state().engine;
    if (e.__spied) return;
    e.__spied = 1;
    this.log = [];
    this.trace = [];
    for (const m of ['down', 'move', 'up']) {
      const raw = e[m].bind(e);
      e[m] = (...a) => { const r = raw(...a); this.log.push([m, a[0], a[1], a[2] || 0, r ? 1 : 0]); return r; };
    }
  },

  probe() {
    const v = this.view();
    return {
      cw: v.wrap.clientWidth, ch: v.wrap.clientHeight,
      pw: v.canvas.width, ph: v.canvas.height,
      cell: v.view && v.view.cell, sub: v.view && v.view.sub, running: v.running,
      alpha: Array.from(v.ctx.getImageData(0, 0, v.canvas.width, v.canvas.height).data.slice(0, 400)),
    };
  },

  ink() {
    const v = this.view();
    const d = v.ctx.getImageData(0, 0, v.canvas.width, v.canvas.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) lit++;
    return lit;
  },

  report(kind, size, extra) {
    const S = this.state();
    const e = S.engine;
    const st = e.stats();
    const rec = window.nikoli.debug.store.record(kind.id + ':' + size);
    return Object.assign({
      kind: kind.id,
      sizeLabel: this.text('#play-size'),
      status: this.text('#status-text'),
      solved: e.solved(),
      moves: st.moves,
      par: st.par,
      done: st.done,
      total: st.total,
      screen: ['home', 'play', 'result'].find((s) => !document.querySelector('#' + s).hidden),
      title: this.text('#result-title'),
      stars: document.querySelectorAll('#result-stars i.on').length,
      stored: rec ? rec.solves : 0,
      noHintStored: rec ? rec.noHintSolves : 0,
      hints: S.hints,
    }, extra || {});
  },
};
'installed';
`;

// ---- CDP ----------------------------------------------------------------------

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const e = m.params.exceptionDetails;
        this.errors.push(`[EXCEPTION] ${e.exception?.description || e.text} @ ${e.url}:${e.lineNumber}`);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push(`[log] ${m.params.entry.text} ${m.params.entry.url || ''}`);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

// 两个岛之间的 lane 摊成半格序列：桥沿行/列走，中途每一格都要递给引擎。
// 岛条目是 [hx, hy] 或 [hx, hy, 数字]（数桥带证词），所以坐标取前两个 ——
// 末尾那个是岛上的数字，当坐标点过去就点到盘外了。
const laneOf = (a, b) => {
  const [ax, ay] = [a[0], a[1]];
  const [bx, by] = [b[0], b[1]];
  const dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
  const out = [[ax, ay]];
  let x = ax, y = ay;
  while (x !== bx || y !== by) { x += dx; y += dy; out.push([x, y]); }
  return out;
};

const mk = (cdp, sessionId) => async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, sessionId }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const existing = list.find((t) => t.type === 'page' && isOurs(t.url));
  const { targetId } = existing
    ? { targetId: existing.id || existing.targetId }
    : await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 640, deviceScaleFactor: 1, mobile: false }, sessionId);

  const js = mk(cdp, sessionId);
  const snap = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(`${SHOTS}/${name}`, Buffer.from(data, 'base64'));
  };
  // 指针事件的 x/y 必须是有限数：NaN 会被 JSON 变成 null，CDP 只回一句
  // "double value expected"，看不出是谁点空了。这里把参数抓住再报。
  const fire = (params) => {
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
      throw new Error('落子坐标算坏了：' + JSON.stringify(params) + ' 已发 ' + rows.length + ' 行');
    }
    return cdp.send('Input.dispatchMouseEvent', params, sessionId);
  };
  const rows = [];
  const ok = (test, pass, detail) => rows.push({ test, pass: !!pass, detail: detail ?? null });

  await cdp.send('Page.navigate', { url: BASE }, sessionId);
  // 等的是"模块图跑完"这个事实，不是某个拍脑袋的 sleep：本地静态服 200ms 就够，
  // 线上 Pages 首次加载要过 TLS + 十几个模块，固定等 1.5s 会误判成"页面没起来"。
  let booted = false;
  for (let i = 0; i < 80 && !booted; i++) {
    await new Promise((r) => setTimeout(r, 250));
    booted = await js('!!window.nikoli && !!window.nikoli.debug');
  }
  ok('页面加载：window.nikoli 挂上', booted);
  if (!booted) {
    // 起不来就别往下演了：后面的探针会对着 undefined 一路抛，把真正的原因（模块 404、
    // 语法错、MIME 不对）埋在一堆噪音底下。
    console.log(JSON.stringify({ rows, fail: ['页面没起来'], errors: cdp.errors.slice(0, 8) }, null, 2));
    ws.close();
    process.exit(1);
  }
  await js(PAGE);

  const kinds = await js(`window.nikoli.KINDS.map((k) => ({
    id: k.id, title: k.title, sizes: k.sizes.map((s) => s.key), rules: k.rules.length,
    glyph: k.shell && k.shell.glyph, dual: !!(k.shell && k.shell.dual),
  }))`);
  const plan = (ONLY ? kinds.filter((k) => ONLY.includes(k.id)) : kinds)
    .map((k) => ({ kind: k, size: k.sizes[k.sizes.length - 1] }));
  ok('注册表：每款都有 glyph 与至少三条规则',
    kinds.length > 0 && kinds.every((k) => k.glyph && k.rules >= 3), kinds);

  // ---- 首页：玩法卡 + 每日格，档位名必须来自玩法自己 ------------------
  const home = await js(`(() => {
    window.nikoli.debug.home();
    const cards = [...document.querySelectorAll('#kinds .kind')].map((n) => ({
      name: n.querySelector('.kind-name').textContent,
      sizes: [...n.querySelectorAll('.size-chip')].map((b) => b.textContent),
    }));
    const daily = [...document.querySelectorAll('#daily-row .daily-cell')].map((n) =>
      n.querySelector('.n').textContent + ' ' + n.querySelector('.s').textContent);
    return { cards, daily };
  })()`);
  ok('首页：玩法卡数与注册表一致', home.cards.length === kinds.length, home.cards.map((c) => c.name));
  ok('首页：每日挑战格子数与玩法数一致', home.daily.length === kinds.length, home.daily);
  ok('首页：档位标签由玩法自己给（都是"格"盘，不许出现空标签）',
    home.cards.every((c) => c.sizes.length >= 2 && c.sizes.every((s) => /×|孔/.test(s))),
    home.cards.map((c) => c.sizes));

  if (SHOTS) await snap('home.png');
  await js(`document.querySelector('#kinds .kind .kind-help').click()`);
  const howto = await js(`(() => ({ open: document.querySelector('#howto').open,
    li: document.querySelectorAll('#howto-body li').length,
    title: window.__t.text('#howto-title') }))()`);
  ok('怎么玩：弹窗列出规则', howto.open && howto.li >= 3, howto);
  await js(`document.querySelector('#howto').close()`);

  // ---- 每种玩法：真指针事件一路画到通关 ------------------------------------
  // 半格命中框只有半个格：像素 = ox + (h + 0.5) * sub，与 lattice_view.halfAt 的 floor
  // 取带一一对应。取格心那一侧，取到的是这条边的正中间。
  for (const p of plan) {
    const id = p.kind.id;
    const entered = await js(`window.__t.goto('#/p/${id}/${p.size}/${1234 + p.size}')`);
    ok(`${id}：路由进局`, entered);

    // 换局时 layout() 会重设 canvas.width —— 那一步就把画布清空了，必须等几何稳定后
    // 再给渲染循环留一两帧，否则采到的是一张刚擦干净的空白画布。
    await js(`window.__t.settle().then(() => window.__t.frames(2))`);
    const before = await js(`window.__t.ink()`);
    ok(`${id}：棋盘已画出像素`, before > 400, before > 400 ? { inkSamples: before } : await js(`window.__t.probe()`));
    if (SHOTS) await snap(`${id}-board.png`);
    await js(`window.__t.spy()`);

    const plan2 = await js(`window.__t.steps('${id}', ${p.size})`);
    const miss = [];
    // 每个落子点都重新量一次几何：HUD 文案一变长，控制行就换行，board-wrap 随之改尺寸，
    // LatticeView 的 ResizeObserver 会重排画布。缓存一份坐标，后半程就点到隔壁边去了。
    const pt = async (half) => {
      const g = await js(`window.__t.settle()`);
      if (![g.left, g.top, g.ox, g.oy, g.sub].every(Number.isFinite)) throw new Error('geom 缺字段：' + JSON.stringify(g));
      const x = Math.round(g.left + g.ox + (half[0] + 0.5) * g.sub);
      const y = Math.round(g.top + g.oy + (half[1] + 0.5) * g.sub);
      if (x < g.left || y < g.top) miss.push({ half, x, y, left: g.left, top: g.top });
      return { x, y };
    };
    const drag = async (halves) => {
      const a = await pt(halves[0]);
      await fire({ type: 'mousePressed', ...a, button: 'left', buttons: 1, clickCount: 1 });
      for (const h of halves.slice(1)) {
        await fire({ type: 'mouseMoved', ...(await pt(h)), button: 'left', buttons: 1 });
      }
      await fire({ type: 'mouseReleased', ...(await pt(halves[halves.length - 1])), button: 'left', buttons: 0 });
    };

    if (plan2.mode === 'drag') {
      await drag(plan2.halves);                        // 一整圈一笔拖完，与手指一致
    } else {
      // 数桥：一根桥一次拖拽。中途的半格也要点过去，引擎靠这些 move 画 preview
      for (const [a, b] of plan2.lanes) await drag(laneOf(a, b));
    }

    await new Promise((r) => setTimeout(r, 1200));   // 结算动画 950ms 后才换屏
    if (SHOTS) await snap(`${id}.png`);
    const rep = await js(`window.__t.report(window.nikoli.byId('${id}'), ${p.size})`);
    ok(`${id}：一路画到通关并进结算屏`, rep.solved && rep.screen === 'result', rep);
    // 布局漂移：一局之中画布只该在进局时定一次尺寸。落子过程中还变，就是
    // "内容撑容器 → 容器量内容"的反馈环又接上了（宽屏 flex 版踩过）。
    const trace = await js(`window.__t.trace || []`);
    ok(`${id}：全程画布尺寸不漂移`, trace.length <= 2, { geometrySteps: trace.length, trace: trace.slice(0, 6) });
    if (!rep.solved) {
      ok(`${id}：落子探针（该点的半格 vs 引擎收到的调用）`, false, {
        want: plan2.halves ? [['drag', ...plan2.halves.map((h) => h.join(','))]] : plan2.lanes,
        got: await js(`window.__t.log`),
        miss,
        trace: await js(`window.__t.trace || []`),
      });
    }
    ok(`${id}：HUD 与档位名如实`, rep.done === rep.total && !!rep.sizeLabel, { status: rep.status, sizeLabel: rep.sizeLabel });
    ok(`${id}：存档落了盘`, rep.stored >= 1, { solves: rep.stored, noHint: rep.noHintStored });
    // 星级要读自己这一局的结算屏：上一玩法留下的三星还挂在那儿，不看 screen 就会假绿。
    ok(`${id}：没用提示该给三星`, rep.screen === 'result' && rep.stars === 3, { stars: rep.stars, hints: rep.hints, title: rep.title });
  }

  // ---- 输入设备无关性：键盘光标落子、副笔不计步、真点击撤销 ------------------
  // 两款坐标族都得验：view.nudge()/home() 是共用的，但 step=1 与 step=2 用的是两条
  // 不同的夹取上界，只验一款等于没验另一款。数桥是第三种语义 —— 同一条 press() 走
  // down+up，它要连点两座岛才配得出一根桥，所以期望值按玩法给，不按公式算。
  const KB = [
    { id: 'slitherlink', moves: 2, done: 2 },            // 逐边：点两条边
    { id: 'masyu', moves: 2, done: 2 },                  // 格心：点两个格
    { id: 'hashi', moves: 1, done: 1 },                  // 点两下配一根桥
  ].filter((t) => plan.some((p) => p.kind.id === t.id));
  const tap = async (k) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, sessionId);
  };
  const KEY = {
    space: { key: ' ', code: 'Space', vk: 32 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  };
  for (const t of KB) {
    const size = plan.find((p) => p.kind.id === t.id).size;
    await js(`window.__t.goto('#/p/${t.id}/${size}/${9999}')`);
    await js(`window.__t.settle()`);
    await js(`window.__t.spy()`);
    const step = await js(`window.__t.state().engine.step || 1`);
    const rp = await js(`window.__t.steps('${t.id}', ${size})`);
    // 获胜笔画的前两个目标：拖拽玩法是前两段落点，数桥是第一根桥两端的岛
    const want = rp.mode === 'drag' ? rp.halves.slice(0, 2) : rp.lanes[0].map((h) => [h[0], h[1]]);
    const cur = () => js(`(() => { const v = window.__t.view(); const c = v.view.hover || v.home(); return [c.x, c.y]; })()`);
    const goTo = async (half) => {
      for (let i = 0; i < 200; i++) {
        const [cx, cy] = await cur();
        if (cx === half[0] && cy === half[1]) return true;
        const k = cx !== half[0] ? (cx < half[0] ? 'ArrowRight' : 'ArrowLeft')
          : cy !== half[1] ? (cy < half[1] ? 'ArrowDown' : 'ArrowUp') : null;
        if (!k) return false;                            // 两个轴同时对不上：step 走错了
        await tap(KEY[k]);
      }
      return false;
    };
    let reached = true;
    for (const half of want) { reached = (await goTo(half)) && reached; await tap(KEY.space); }
    await js(`window.__t.frames(1)`);
    const st = await js(`window.__t.state().engine.stats()`);
    const hov = await cur();
    // 光标必须停在自家那类目标上：格心玩法两点皆奇，边玩法一奇一偶
    const onTarget = step === 2 ? (hov[0] % 2 === 1 && hov[1] % 2 === 1) : (hov[0] + hov[1]) % 2 === 1;
    ok(`键盘 ${t.id}：光标按 step=${step} 挪到目标、空格即落子`,
      reached && onTarget && st.moves === t.moves && st.done === t.done, { step, want, hov, st });

    const undoBtn = await js(`(() => { const b = document.querySelector('[data-action=undo]');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: b.disabled }; })()`);
    ok(`落子之后 ${t.id} 的撤销按钮就该可用`, undoBtn.disabled === false, undoBtn);
    await fire({ type: 'mousePressed', x: undoBtn.x, y: undoBtn.y, button: 'left', buttons: 1, clickCount: 1 });
    await fire({ type: 'mouseReleased', x: undoBtn.x, y: undoBtn.y, button: 'left', buttons: 0 });
    await js(`window.__t.frames(1)`);
    const afterUndo = await js(`window.__t.state().engine.stats()`);
    ok(`撤销 ${t.id}：盘面退回一条，moves 不退款`,
      afterUndo.done === t.done - 1 && afterUndo.moves === t.moves, { before: st, afterUndo });

    // 副笔：重开一局（什么都不画），在自家目标上记号，步数必须一动不动
    await js(`document.querySelector('[data-action=restart]').click()`);
    await js(`window.__t.wait(60)`);
    const dual = await js(`(() => {
      const b = document.querySelector('#tool-toggle button[data-tool="1"]');
      if (!b || b.closest('#tool-toggle').hidden) return { skipped: '该玩法无副笔' };
      b.click();
      return { target: ${JSON.stringify(want[0])}, before: window.__t.state().engine.stats() };
    })()`);
    if (!dual.skipped) {
      const g = await js(`window.__t.settle()`);
      // DOMRect 的属性挂在原型上，直接返回给 CDP 会被序列化成 {} —— 必须自己摊成普通对象
      const r = await js(`(() => { const q = document.querySelector('#board').getBoundingClientRect();
        return { left: q.left, top: q.top }; })()`);
      const x = Math.round(r.left + g.ox + (dual.target[0] + 0.5) * g.sub);
      const y = Math.round(r.top + g.oy + (dual.target[1] + 0.5) * g.sub);
      await fire({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await fire({ type: 'mouseReleased', x, y, button: 'left', buttons: 0 });
      await js(`window.__t.frames(1)`);
      const after = await js(`window.__t.state().engine.stats()`);
      ok(`副笔 ${t.id}：记号不计入步数，也不算成盘面的一部分`,
        after.moves === dual.before.moves && after.done === dual.before.done, { target: dual.target, before: dual.before, after });
      await js(`document.querySelector('#tool-toggle button[data-tool="0"]').click()`);
    }
  }

  const soundBtn = await js(`(() => { const r = document.querySelector('#sound-btn').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await fire({ type: 'mousePressed', ...soundBtn, button: 'left', buttons: 1, clickCount: 1 });
  await fire({ type: 'mouseReleased', ...soundBtn, button: 'left', buttons: 0 });
  const sound = await js(`({ off: document.querySelector('#sound-btn').classList.contains('off'),
    stored: window.nikoli.debug.store.settings.sound })`);
  ok('顶栏声音按钮改的是存档不是局部变量', sound.off === true && sound.stored === false, sound);

  // 每日格点进去得带今日种子：两仓的 KEY 前缀不同，前缀写错就是串了别家的存档
  const daily = await js(`(async () => {
    window.nikoli.debug.home(); await new Promise(r => setTimeout(r, 80));
    const cell = document.querySelector('#daily-row .daily-cell');
    cell.click();
    await new Promise(r => setTimeout(r, 600));
    return { hash: location.hash, daily: window.__t.state().daily, seed: window.__t.state().seed }; })()`);
  ok('每日格点进去带的是今日种子', daily.daily === true && daily.seed.includes('loops-daily|'), daily);

  // ---- 手机视口：窄屏是另一套 flex 布局，半格目标更要点得着 ------------------
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 720, deviceScaleFactor: 2, mobile: true }, sessionId);
  await new Promise((r) => setTimeout(r, 400));
  // 窄屏要过两款坐标族：边玩法的命中框只有半个格，手机上是最容易点偏的地方；
  // 数桥又是另一种手势（一根桥一笔拖），它的最小手感和前两款不是一回事。
  const MOBILE = ['slitherlink', 'masyu', 'hashi'];
  for (const small of plan.map((p) => p.kind).filter((k) => MOBILE.includes(k.id))) {
    await js(`window.__t.goto('#/p/${small.id}/${small.sizes[0]}/${777}')`);
    await js(`window.__t.settle()`);
    await js(`window.__t.spy()`);
    const mGeom = await js(`window.__t.settle()`);
    ok(`390 视口 ${small.id}：点距不小于 MIN_CELL，否则半个格点不准`, mGeom.cell >= 26, mGeom);
    const mPlan = await js(`window.__t.steps('${small.id}', ${small.sizes[0]})`);
    const ptM = async (half) => {
      const g = await js(`window.__t.settle()`);
      return { x: Math.round(g.left + g.ox + (half[0] + 0.5) * g.sub), y: Math.round(g.top + g.oy + (half[1] + 0.5) * g.sub) };
    };
    if (mPlan.mode === 'drag') {
      const a = await ptM(mPlan.halves[0]);
      await fire({ type: 'mousePressed', ...a, button: 'left', buttons: 1, clickCount: 1 });
      for (const h of mPlan.halves.slice(1)) {
        await fire({ type: 'mouseMoved', ...(await ptM(h)), button: 'left', buttons: 1 });
      }
      await fire({ type: 'mouseReleased', ...(await ptM(mPlan.halves[mPlan.halves.length - 1])), button: 'left', buttons: 0 });
    } else {
      for (const pair of mPlan.lanes) {
        const lane = laneOf(pair[0], pair[1]);
        const a = await ptM(lane[0]);
        await fire({ type: 'mousePressed', ...a, button: 'left', buttons: 1, clickCount: 1 });
        for (const h of lane.slice(1)) await fire({ type: 'mouseMoved', ...(await ptM(h)), button: 'left', buttons: 1 });
        await fire({ type: 'mouseReleased', ...(await ptM(lane[lane.length - 1])), button: 'left', buttons: 0 });
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
    const mob = await js(`window.__t.report(window.nikoli.byId('${small.id}'), ${small.sizes[0]})`);
    const mTrace = await js(`window.__t.trace || []`);
    ok(`390×720 手机视口 ${small.id}：同样一路画到底`, mob.solved && mob.screen === 'result', { ...mob, trace: mTrace.slice(0, 5) });
    if (SHOTS) await snap(`mobile-${small.id}.png`);
  }

  ok('全程零控制台错误', cdp.errors.length === 0, cdp.errors.slice(0, 6));

  const fail = rows.filter((r) => !r.pass);
  console.log(JSON.stringify({ rows, fail: fail.map((f) => f.test), errors: cdp.errors.slice(0, 4) }, null, 2));
  ws.close();
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR: ' + (e.stack || e.message)); process.exit(2); });
