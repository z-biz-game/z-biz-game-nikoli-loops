#!/usr/bin/env node
// 纸上逻辑 · 美术资产工厂（零依赖，node 标准库 + zlib 手写 PNG）
//
// 为什么仓内自带生成器：母题必须是可复现的。派工量具 make_icons.py 往仓外写母图，
// 而本仓的图标要跟着玩法自己长出来 —— 和纸底 + 方格点阵 + 一条墨绿环线。
// 运行：node assets/gen/gen_art.mjs   （幂等，重跑逐字节一致）
//
// 全部图形用 SDF（signed distance field）逐像素求覆盖度，所以任何尺寸都是
// 同一套几何定义渲染出来的，不存在"放大糊掉 / 缩小糊成一团"。
// 环线 = 若干胶囊(capsule)的距离取 min 后一次成图，胶囊接缝因此不可见。

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- 调色板：与 js/core/theme.js 同源（改了那边要改这里，两处都是唯一真源的半个） ----
const HEX = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  paper: HEX('#f4efe3'),
  paperDeep: HEX('#ece5d5'),
  card: HEX('#fbf8f0'),
  ink: HEX('#2b2a26'),
  rule: HEX('#cfc7b3'),
  ruleBold: HEX('#9a937f'),
  accent: HEX('#1f6f5c'),
  accentLift: HEX('#4aa383'),
  inkSoft: HEX('#6a655a'),
  gold: HEX('#c08a2e'),
};

// ---- PNG 编码（8-bit RGBA, filter 0） ----------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))]);
}

// ---- 画布：straight alpha 浮点缓冲 + source-over ------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.f = new Float64Array(w * h * 4); // r,g,b in 0..255, a in 0..1 (straight)
  }

  fill(color, a = 1) {
    const [r, g, b] = color;
    for (let i = 0; i < this.f.length; i += 4) {
      this.f[i] = r; this.f[i + 1] = g; this.f[i + 2] = b; this.f[i + 3] = a;
    }
    return this;
  }

  blend(x, y, r, g, b, a) {
    const i = (y * this.w + x) * 4;
    const da = this.f[i + 3];
    const oa = a + da * (1 - a);
    if (oa <= 0) { this.f[i + 3] = 0; return; }
    const k = (1 - a) * da / oa;
    this.f[i] = r * a / oa + this.f[i] * k;
    this.f[i + 1] = g * a / oa + this.f[i + 1] * k;
    this.f[i + 2] = b * a / oa + this.f[i + 2] * k;
    this.f[i + 3] = oa;
  }

  // sdf(x,y) < 0 表示在形内；aa 为羽化宽度（像素）
  paint(sdf, color, { aa = 1.3, alpha = 1, clip = null } = {}) {
    const [r, g, b] = color;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let cov = clamp(0.5 - sdf(x + 0.5, y + 0.5) / aa, 0, 1);
        if (clip) cov *= clip(x + 0.5, y + 0.5);
        if (cov <= 1 / 511) continue;
        this.blend(x, y, r, g, b, cov * alpha);
      }
    }
    return this;
  }

  toBuffer() {
    const out = Buffer.alloc(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      const a = this.f[i * 4 + 3];
      out[i * 4] = clamp(Math.round(this.f[i * 4]), 0, 255);
      out[i * 4 + 1] = clamp(Math.round(this.f[i * 4 + 1]), 0, 255);
      out[i * 4 + 2] = clamp(Math.round(this.f[i * 4 + 2]), 0, 255);
      out[i * 4 + 3] = Math.round(a * 255);
    }
    return out;
  }

  save(rel) {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, encodePNG(this.w, this.h, this.toBuffer()));
    return rel;
  }
}

// ---- SDF 基元（坐标一律像素，u 为归一化 0..1 比例） ---------------------------------
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy || 1e-9), 0, 1);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// 一条折线描粗 = 相邻点两两成胶囊；闭合时补上收尾那段
// 折线描粗 = 逐段胶囊距离取 min（一次成图，段与段的接缝不会出现二次混合暗边）
function sdPolyline(px, py, pts, w, closed = true) {
  const hw = w / 2;
  let d = 1e9;
  for (let i = 0; i + 1 < pts.length; i++) {
    d = Math.min(d, sdSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) - hw);
  }
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[0];
    d = Math.min(d, sdSegment(px, py, a[0], a[1], b[0], b[1]) - hw);
  }
  return d;
}
// 点阵：n×n 个圆点的距离场（用于"环从哪些点里穿过"的底纹）
function sdDots(n, w, h, r, inset) {
  const step = (w - inset * 2) / (n - 1);
  return (px, py) => {
    const gx = Math.round((px - inset) / step), gy = Math.round((py - inset) / step);
    if (gx < 0 || gy < 0 || gx > n - 1 || gy > n - 1) return 1e9;
    return sdCircle(px, py, inset + gx * step, inset + gy * step, r);
  };
}

// ---- 母题：一张方格稿纸 + 一条墨绿环线 ------------------------------------------------
// 环线折点写在 0..1 归一化空间里；直角 + 小圆角，正是"用钢笔沿格线描一圈"的手感。
const LOOP_U = [
  [0.30, 0.20], [0.70, 0.20], [0.70, 0.46], [0.50, 0.46],
  [0.50, 0.80], [0.30, 0.80],
];

function scalePts(pts, w, h, padX, padY) {
  return pts.map(([u, v]) => [padX + u * (w - padX * 2), padY + v * (h - padY * 2)]);
}

function paperGradient(img, c0 = C.paper, c1 = C.paperDeep) {
  const { w, h, f } = img;
  for (let y = 0; y < h; y++) {
    const k = y / (h - 1 || 1);
    const r = c0[0] + (c1[0] - c0[0]) * k;
    const g = c0[1] + (c1[1] - c0[1]) * k;
    const b = c0[2] + (c1[2] - c0[2]) * k;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      f[i] = r; f[i + 1] = g; f[i + 2] = b; f[i + 3] = 1;
    }
  }
  return img;
}

// 应用图标：方形圆角稿纸卡 + 点阵 + 环线（16px 时只剩环线与点，仍认得出"绕一圈"）
function makeIcon(size, { maskable = false, plate = true } = {}) {
  const img = new Canvas(size, size);
  const radius = size * 0.225;
  paperGradient(img);
  // 圆角外的像素要真透明：非 maskable 时按圆角距离场削掉 alpha
  if (!maskable) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = sdRoundBox(x + 0.5, y + 0.5, size / 2, size / 2, size / 2, size / 2, radius);
        const cov = clamp(0.5 - d / 1.2, 0, 1);
        if (cov < 1) img.f[(y * size + x) * 4 + 3] *= cov;
      }
    }
  }

  const pad = size * (maskable ? 0.24 : 0.10);
  const dotN = 5;
  if (size >= 48) {
    const step = (size - pad * 2) / (dotN - 1);
    img.paint(sdDots(dotN, size, size, Math.max(0.7, size * 0.011), pad), C.ruleBold, { aa: 1, alpha: 0.5 });
    if (size >= 96) gridLinesIn(img, dotN, pad, step, size);
  }

  const pts = scalePts(LOOP_U, size, size, pad, pad);
  const wgt = Math.max(1.6, size * (size < 40 ? 0.16 : 0.115));
  if (plate) img.paint((x, y) => sdPolyline(x, y, pts, wgt * 1.55), C.paperDeep, { aa: 1.3, alpha: 0.9 });
  img.paint((x, y) => sdPolyline(x, y, pts, wgt), C.accent, { aa: 1.3 });

  // 环上的两个"珍珠"节点：白底 + 墨绿描边，是珍珠链玩法的记号
  if (size >= 32) {
    const beadR = size * 0.062;
    const ring = Math.max(1.2, size * 0.02);
    for (const [u, v] of [[0.50, 0.20], [0.40, 0.80]]) {
      const cx = pad + u * (size - pad * 2), cy = pad + v * (size - pad * 2);
      img.paint((x, y) => sdCircle(x, y, cx, cy, beadR), C.card, { aa: 1.2 });
      // 环 = 外圆与内圆的距离场取 max，画出来是一圈而不是一个饼
      img.paint((x, y) => Math.max(sdCircle(x, y, cx, cy, beadR), -sdCircle(x, y, cx, cy, beadR - ring)),
        C.gold, { aa: 1.2 });
    }
  }
  return img;
}

function gridLinesIn(img, n, pad, step, size) {
  const weight = Math.max(0.6, size * 0.006);
  for (let i = 0; i < n; i++) {
    const c = pad + i * step;
    const a = pad - step * 0.34, b = size - pad + step * 0.34;
    img.paint((x, y) => (y > a && y < b ? Math.abs(x - c) - weight / 2 : 1e9), C.rule, { aa: 0.8, alpha: 0.85 });
    img.paint((x, y) => (x > a && x < b ? Math.abs(y - c) - weight / 2 : 1e9), C.rule, { aa: 0.8, alpha: 0.85 });
  }
}

// ---- 单线体拉丁字（0..1 归一化，y 向下）：纸上逻辑没有美术字体资产，字是描出来的 ------
const ARC = (cx, cy, rx, ry, a0, a1, n = 14) => {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (a1 - a0) * (i / n);
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
};
const HALF_PI = Math.PI / 2;
const GLYPHS = {
  A: [[[0, 1], [0.5, 0], [1, 1]], [[0.21, 0.63], [0.79, 0.63]]],
  B: [[[0.06, 0], [0.06, 1]], [[0.06, 0], [0.62, 0], [0.66, 0.2], [0.5, 0.48], [0.06, 0.48]],
    [[0.06, 0.48], [0.68, 0.48], [0.74, 0.72], [0.58, 1], [0.06, 1]]],
  C: [ARC(0.5, 0.5, 0.46, 0.5, -Math.PI / 3, -Math.PI * 5 / 3)],
  D: [[[0.06, 0], [0.06, 1]], [[0.06, 0], [0.4, 0], ...ARC(0.4, 0.5, 0.44, 0.5, -HALF_PI, HALF_PI).map(([x, y]) => [x, y]), [0.06, 1]]],
  E: [[[0.9, 0], [0.06, 0], [0.06, 1], [0.9, 1]], [[0.06, 0.5], [0.72, 0.5]]],
  F: [[[0.9, 0], [0.06, 0], [0.06, 1]], [[0.06, 0.5], [0.72, 0.5]]],
  G: [ARC(0.52, 0.5, 0.46, 0.5, HALF_PI * 0.72, HALF_PI * 2.35), [[0.94, 0.5], [0.62, 0.5], [0.62, 0.78]]],
  H: [[[0.06, 0], [0.06, 1]], [[0.94, 0], [0.94, 1]], [[0.06, 0.5], [0.94, 0.5]]],
  I: [[[0.5, 0], [0.5, 1]], [[0.24, 0], [0.76, 0]], [[0.24, 1], [0.76, 1]]],
  J: [[[0.86, 0], [0.86, 0.7], ...ARC(0.5, 0.7, 0.36, 0.3, HALF_PI * 0.0, HALF_PI).map(([x, y]) => [x, y]).slice(1)]],
  K: [[[0.06, 0], [0.06, 1]], [[0.9, 0], [0.1, 0.52], [0.9, 1]]],
  L: [[[0.08, 0], [0.08, 1], [0.9, 1]]],
  M: [[[0.04, 1], [0.04, 0], [0.5, 0.62], [0.96, 0], [0.96, 1]]],
  N: [[[0.06, 1], [0.06, 0], [0.94, 1], [0.94, 0]]],
  O: [ARC(0.5, 0.5, 0.46, 0.5, -HALF_PI, HALF_PI * 3).concat([ARC(0.5, 0.5, 0.46, 0.5, -HALF_PI, -HALF_PI)][0])],
  P: [[[0.06, 1], [0.06, 0], [0.6, 0], ...ARC(0.6, 0.26, 0.3, 0.26, -HALF_PI, HALF_PI), [0.06, 0.52]]],
  Q: [ARC(0.5, 0.5, 0.46, 0.5, -HALF_PI, HALF_PI * 3), [[0.58, 0.62], [0.98, 1.06]]],
  R: [[[0.06, 1], [0.06, 0], [0.6, 0], ...ARC(0.6, 0.26, 0.3, 0.26, -HALF_PI, HALF_PI), [0.06, 0.52]], [[0.42, 0.52], [0.94, 1]]],
  // S 用手工折点：两段半椭圆拼出来的是"开口朝右的 C"，不是 S
  S: [[[0.92, 0.13], [0.7, 0.02], [0.4, 0.02], [0.14, 0.17], [0.14, 0.4], [0.34, 0.5],
    [0.66, 0.56], [0.86, 0.68], [0.86, 0.87], [0.6, 0.99], [0.3, 0.99], [0.08, 0.87]]],
  T: [[[0.04, 0], [0.96, 0]], [[0.5, 0], [0.5, 1]]],
  U: [[[0.06, 0], [0.06, 0.62], ...ARC(0.5, 0.62, 0.44, 0.38, Math.PI, 0), [0.94, 0]]],
  V: [[[0.04, 0], [0.5, 1], [0.96, 0]]],
  W: [[[0.02, 0], [0.27, 1], [0.5, 0.42], [0.73, 1], [0.98, 0]]],
  X: [[[0.06, 0], [0.94, 1]], [[0.94, 0], [0.06, 1]]],
  Y: [[[0.04, 0], [0.5, 0.52], [0.96, 0]], [[0.5, 0.52], [0.5, 1]]],
  Z: [[[0.06, 0], [0.94, 0], [0.06, 1], [0.94, 1]]],
  '.': [[[0.5, 0.94], [0.5, 1.0]]],
  '·': [[[0.42, 0.55], [0.58, 0.55]]],
  '0': [ARC(0.5, 0.5, 0.46, 0.5, -HALF_PI, HALF_PI * 3), [[0.86, 0.82], [0.14, 0.18]]],
  '1': [[[0.24, 0.16], [0.5, 0], [0.5, 1]], [[0.28, 1], [0.72, 1]]],
  '2': [ARC(0.5, 0.28, 0.42, 0.28, -HALF_PI, HALF_PI * 0.85), [[0.3, 0.52], [0.06, 1], [0.94, 1]]],
  '3': [ARC(0.52, 0.28, 0.4, 0.28, -HALF_PI * 0.95, HALF_PI * 0.55), ARC(0.5, 0.72, 0.42, 0.28, -HALF_PI * 0.5, HALF_PI * 1.15)],
  '4': [[[0.68, 1], [0.68, 0], [0.06, 0.68], [0.94, 0.68]]],
  '5': [[[0.9, 0], [0.16, 0], [0.14, 0.44], ...ARC(0.52, 0.72, 0.4, 0.28, -HALF_PI * 0.6, HALF_PI * 1.2)], [[0.14, 0.44], [0.6, 0.4]]],
};

// 描一行字：size 为字高（px），返回画完后的光标 x
function text(img, str, x, y, size, color, { weight = 0.09, tracking = 0.28, alpha = 1 } = {}) {
  const wgt = Math.max(0.9, size * weight);
  let cx = x;
  for (const ch of str) {
    if (ch === ' ') { cx += size * (0.5 + tracking); continue; }
    const g = GLYPHS[ch];
    if (!g) { cx += size * (0.9 + tracking); continue; }
    const gw = size * 0.82;
    const pts = g.map((stroke) => stroke.map(([u, v]) => [cx + u * gw, y + v * size]));
    for (const p of pts) img.paint((px, py) => sdPolyline(px, py, p, wgt, false), color, { aa: 1.25, alpha });
    cx += gw + size * tracking;
  }
  return cx;
}

// ---- 和纸纹理：可平铺的纸纤维（256²，游戏内 #board-wrap 与 body 的底色） ---------------
// 平铺不接缝的做法：噪声格点按 mod 取样（左右/上下绕回来），细节散点同样取模。
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t) => t * t * (3 - 2 * t);
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const at = (a, b) => hash2(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}
function makeGrain(size = 256) {
  const img = new Canvas(size, size);
  paperGradient(img, C.paper, C.paper);
  const { w, h, f } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 四层：粗云团 + 中频 + 纤维丝 + 细砂，振幅都很小 —— 纹理要"感觉到"而不是"看见"
      let n = 0;
      n += (valueNoise(x / 32, y / 32, 8, 3) - 0.5) * 6.5;
      n += (valueNoise(x / 12, y / 12, 21, 7) - 0.5) * 4.2;
      const fiber = valueNoise(x / 3, y / 26, size, 11);
      n += (fiber - 0.5) * 3.4;
      n += (hash2(x, y, 13) - 0.5) * 3.0;
      const i = (y * w + x) * 4;
      f[i] = clamp(C.paper[0] + n, 0, 255);
      f[i + 1] = clamp(C.paper[1] + n * 0.97, 0, 255);
      f[i + 2] = clamp(C.paper[2] + n * 0.9, 0, 255);
      f[i + 3] = 1;
    }
  }
  return img;
}

// ---- 社交卡 1200×630：左边一张大盘环线，右边描字 ----------------------------------------
function makeCover() {
  const W = 1200, H = 630;
  const img = new Canvas(W, H);
  paperGradient(img, C.card, C.paperDeep);
  // 纸纹
  const grain = makeGrain(256);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gi = ((y % 256) * 256 + (x % 256)) * 4;
      const i = (y * W + x) * 4;
      const d = (grain.f[gi] - C.paper[0]) * 0.9;
      img.f[i] = clamp(img.f[i] + d, 0, 255);
      img.f[i + 1] = clamp(img.f[i + 1] + d, 0, 255);
      img.f[i + 2] = clamp(img.f[i + 2] + d, 0, 255);
    }
  }
  // 稿纸卡（左）
  const bx = 60, by = 60, bw = 400, bh = 400;
  img.paint((x, y) => sdRoundBox(x, y, bx + bw / 2, by + bh / 2, bw / 2, bh / 2, 22), C.paper, { aa: 1.4 });
  const n = 7, pad = 46, step = (bw - pad * 2) / (n - 1);
  const gl = 0.9, lo = bx + pad * 0.45, hi = bx + bw - pad * 0.45;
  for (let i = 0; i < n; i++) {
    const cx = bx + pad + i * step, cy = by + pad + i * step;
    img.paint((x, y) => (y > lo && y < hi ? Math.abs(x - cx) - gl : 1e9), C.rule, { aa: 0.9, alpha: 0.8 });
    img.paint((x, y) => (x > lo && x < bx + bw - pad * 0.45 ? Math.abs(y - cy) - gl : 1e9), C.rule, { aa: 0.9, alpha: 0.8 });
  }
  for (let yy = 0; yy < n; yy++) {
    for (let xx = 0; xx < n; xx++) {
      img.paint((x, y) => sdCircle(x, y, bx + pad + xx * step, by + pad + yy * step, 3.4), C.ruleBold, { aa: 1.1, alpha: 0.7 });
    }
  }
  // 环线（把母题折点映到卡内点阵的格点上）
  const nodeU = (u) => bx + pad + (u - 0.30) / 0.40 * (4 * step);
  const nodeV = (v) => by + pad + (v - 0.20) / 0.60 * (4 * step);
  const big = LOOP_U.map(([u, v]) => [nodeU(u), nodeV(v)]);
  img.paint((x, y) => sdPolyline(x, y, big, 34), C.paperDeep, { aa: 1.4, alpha: 0.95 });
  img.paint((x, y) => sdPolyline(x, y, big, 24), C.accent, { aa: 1.5 });
  for (const [u, v] of LOOP_U) {
    img.paint((x, y) => sdCircle(x, y, nodeU(u), nodeV(v), 13), C.accent, { aa: 1.4 });
  }
  // 右侧文字
  const tx = 540;
  text(img, 'NIKOLI', tx, 150, 86, C.accent, { weight: 0.085, tracking: 0.34 });
  text(img, 'LOOPS', tx, 258, 86, C.ink, { weight: 0.085, tracking: 0.34 });
  img.paint((x, y) => Math.abs(y - 392) - 1.6, C.gold, { aa: 1, alpha: 0.9,
    clip: (x) => (x >= tx && x <= tx + 470 ? 1 : 0) });
  text(img, 'SLITHERLINK · MASYU', tx, 424, 30, C.ink, { weight: 0.075, tracking: 0.18 });
  text(img, 'ARUKONE · HASHI', tx, 478, 30, C.inkSoft, { weight: 0.075, tracking: 0.18 });
  text(img, 'FOUR PUZZLES · ONE LOOP', tx, 540, 21, C.ruleBold, { weight: 0.07, tracking: 0.2 });
  return img;
}

// ---- 出图 -------------------------------------------------------------------------
const WEB_SIZES = [16, 32, 48, 64, 96, 180, 192, 512, 1024];
const written = [];
for (const s of WEB_SIZES) written.push(makeIcon(s).save(`icons/icon-${s}.png`));
written.push(makeIcon(512, { maskable: true }).save('icons/icon-maskable-512.png'));
written.push(makeIcon(180).save('icons/apple-touch-icon.png'));
written.push(makeIcon(32).save('icons/favicon-32.png'));
written.push(makeIcon(16).save('icons/favicon-16.png'));
written.push(makeGrain(256).save('assets/img/paper-grain.png'));
written.push(makeCover().save('assets/img/og-cover.png'));

for (const rel of written) {
  const st = fs.statSync(path.join(ROOT, rel));
  process.stdout.write(`${rel}  ${st.size}B\n`);
}
process.stdout.write(`共 ${written.length} 个文件\n`);
