// 环盘视图：一块点阵，玩家画的是"边"而不是"格"。
//
// 输入坐标是半格索引：把相邻两点之间的那段距离当作最小步进，
//   (偶, 偶) = 点；(奇, 偶) = 横边；(偶, 奇) = 竖边。
// 引擎因此仍然只吃整数坐标，键盘光标、鼠标点击、手指拖拽走同一条路径 ——
// 这也是无头复验能用真指针事件一路画完一条环的原因。

import { store } from '../core/storage.js';

const PAD = 10;
// 点距下限：环类玩法的可点目标是"一条边的中点附近"，实际命中带只有半个格。
// 再往下压就点不准了，所以宁可让大盘在手机上略微超出容器。
const MIN_CELL = 26;

export class LatticeView {
  constructor(canvas, wrap) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d');
    this.engine = null;
    this.view = null;
    this.hover = null;
    this.running = false;
    this.frame = null;
    this.dragging = false;
    this.lastHalf = null;
    this.winAt = 0;
    this.tool = 0;
    this.onInput = null;
    this.onFrame = null;
    this.onWin = null;

    const opt = { passive: false };
    canvas.addEventListener('pointerdown', (e) => this.down(e), opt);
    canvas.addEventListener('pointermove', (e) => this.move(e), opt);
    canvas.addEventListener('pointerup', (e) => this.up(e), opt);
    canvas.addEventListener('pointercancel', (e) => this.up(e), opt);
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.layout()).observe(wrap);
  }

  attach(engine) {
    this.engine = engine;
    this.hover = null;
    this.lastHalf = null;
    this.dragging = false;
    this.resetWin();
    this.layout();
    this.start();
  }

  // board 用"点"计数：cols/rows 是格数，所以点阵是 (cols+1)×(rows+1)。
  // 余量按格给（箭头迷宫的行列计数、数桥的岛名都画在余量里）。
  layout() {
    const e = this.engine;
    if (!e) return;
    const b = e.board;
    const availW = Math.max(120, this.wrap.clientWidth - 2);
    const availH = Math.max(120, this.wrap.clientHeight - 2);
    const totalW = b.cols + b.margin.l + b.margin.r;
    const totalH = b.rows + b.margin.t + b.margin.b;
    const cell = Math.max(MIN_CELL, Math.min(availW / totalW, availH / totalH));
    const w = Math.round(cell * totalW + PAD * 2);
    const h = Math.round(cell * totalH + PAD * 2);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.view = {
      cell,
      sub: cell / 2,
      ox: Math.round(PAD + b.margin.l * cell),
      oy: Math.round(PAD + b.margin.t * cell),
      cols: b.cols,
      rows: b.rows,
      w, h, dpr,
      hover: null,
      reduce: !!store.settings.reduceMotion,
    };
  }

  // 像素 → 半格索引。这里不做四舍五入：半格带本身就是命中框，
  // 越靠边线越该判给那条边，玩家看到的是"点上去就亮哪条"。
  halfAt(ev) {
    const v = this.view;
    if (!v) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left - v.ox) / v.sub);
    const y = Math.floor((ev.clientY - r.top - v.oy) / v.sub);
    return { x, y };
  }

  down(ev) {
    const e = this.engine;
    if (!e || !this.view) return;
    const c = this.halfAt(ev);
    if (!c) return;
    ev.preventDefault();
    try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* already captured */ }
    this.hover = c;
    this.view.hover = c;
    const btn = ev.button === 2 || ev.altKey ? 1 : (this.tool || 0);
    this.dragging = true;
    this.lastHalf = c;
    const changed = e.down(c.x, c.y, btn);
    this.afterInput(changed);
  }

  move(ev) {
    const e = this.engine;
    if (!e || !this.view) return;
    const c = this.halfAt(ev);
    this.hover = c;
    this.view.hover = c;
    if (!this.dragging) return;
    if (this.lastHalf && this.lastHalf.x === c.x && this.lastHalf.y === c.y) return;
    ev.preventDefault();
    // 拖过一条边要顺手把中间那个点也递过去：引擎据此判断这是"连续的线"而不是两次落子
    if (this.lastHalf && (Math.abs(c.x - this.lastHalf.x) + Math.abs(c.y - this.lastHalf.y) === 2)) {
      const mx = (this.lastHalf.x + c.x) / 2;
      const my = (this.lastHalf.y + c.y) / 2;
      if (mx % 2 === 0 && my % 2 === 0) e.move(mx, my);
    }
    this.lastHalf = c;
    const changed = e.move(c.x, c.y);
    this.afterInput(changed);
  }

  up() {
    if (!this.dragging) return;
    this.dragging = false;
    this.lastHalf = null;
    const changed = this.engine && this.engine.up();
    this.afterInput(!!changed);
  }

  afterInput(changed) {
    // 抬手才算一次完整输入：求解器级的检查不能跟着 pointermove 每帧跑
    if (changed && this.onInput) this.onInput(!this.dragging);
    if (this.engine && this.engine.solved()) {
      this.dragging = false;
      if (this.onWin) this.onWin();
    }
  }

  // 键盘光标按引擎自己声明的步进走：边玩法一次挪半个格，格心玩法一次挪一个格。
  // 光标初值必须落在该玩法的目标种类上，否则第一次"空格"会打在空白处。
  // 光标初值必须落在该玩法的目标种类上：边玩法的第一格是横边 (1,0)，格心玩法是格心 (1,1)。
  // 否则开局按空格会打在空白处，玩家以为键坏了。
  home() {
    const step = (this.engine && this.engine.step) || 1;
    return { x: 1, y: step === 2 ? 1 : 0 };
  }

  nudge(dx, dy) {
    const v = this.view;
    if (!v) return;
    const step = (this.engine && this.engine.step) || 1;
    const cur = this.hover || this.home();
    // 上界必须仍是该玩法的目标：格心玩法最右一格是 2*(cols-1)+1，夹到 2*cols 会停在边上
    const hi = step === 2 ? 2 * v.cols - 1 : 2 * v.cols;
    this.hover = {
      x: Math.max(0, Math.min(hi, cur.x + dx * step)),
      y: Math.max(0, Math.min(hi, cur.y + dy * step)),
    };
    v.hover = this.hover;
  }

  press(cursor = false) {
    if (!this.engine || !this.view) return;
    const c = cursor ? (this.hover || this.home()) : this.hover;
    if (!c) return;
    this.view.hover = c;
    const changed = this.engine.down(c.x, c.y, this.tool || 0);
    this.engine.up();
    this.afterInput(changed);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = (t) => {
      if (!this.running) return;
      this.render(t);
      if (this.onFrame) this.onFrame(t);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  render(t) {
    const e = this.engine;
    const v = this.view;
    if (!e || !v) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(v.dpr, v.dpr);
    ctx.clearRect(0, 0, v.w, v.h);
    if (this.winAt && !v.reduce) {
      const k = Math.min(1, (t - this.winAt) / 1100);
      if (e.celebrate) e.celebrate(ctx, v, t, k);
      else e.draw(ctx, v, t);
    } else {
      e.draw(ctx, v, t);
    }
    ctx.restore();
  }

  win() {
    this.winAt = performance.now();
  }

  resetWin() {
    this.winAt = 0;
  }
}

// 点阵几何（半格索引 ↔ 点/边/格）住在 core/lattice.js，引擎与视图共用同一份定义。
export { halfPoint, isVertex, isHEdge, isVEdge, isEdge, edgeEnds } from '../core/lattice.js';
