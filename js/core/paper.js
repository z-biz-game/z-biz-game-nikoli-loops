// Shared canvas primitives for the four boards: paper, rules, ink, lettering.
// Engines draw their own boards; this file only keeps the hand consistent.

import { T } from './theme.js';

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function paper(ctx, x, y, w, h, r = T.radius.md) {
  ctx.save();
  ctx.shadowColor = T.shadow;
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = T.card;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
}

// Hairline grid. Device pixels are not 1 CSS px, so lines are placed on half-pixel
// centres after the DPR scale — otherwise every other rule renders 2px and blurry.
export function rules(ctx, v, color = T.rule, boldEvery = 0) {
  const { cell, ox, oy, cols, rows } = v;
  ctx.save();
  ctx.lineWidth = 1 / v.dpr;
  for (let i = 0; i <= cols; i++) {
    const bold = boldEvery && i % boldEvery === 0;
    ctx.strokeStyle = bold ? T.ruleBold : color;
    ctx.lineWidth = (bold ? 1.6 : 1) / v.dpr;
    const x = Math.round(ox + i * cell) + (bold ? 0 : 0.5 / v.dpr);
    ctx.beginPath();
    ctx.moveTo(x, oy);
    ctx.lineTo(x, oy + rows * cell);
    ctx.stroke();
  }
  for (let j = 0; j <= rows; j++) {
    const bold = boldEvery && j % boldEvery === 0;
    ctx.strokeStyle = bold ? T.ruleBold : color;
    ctx.lineWidth = (bold ? 1.6 : 1) / v.dpr;
    const y = Math.round(oy + j * cell) + (bold ? 0 : 0.5 / v.dpr);
    ctx.beginPath();
    ctx.moveTo(ox, y);
    ctx.lineTo(ox + cols * cell, y);
    ctx.stroke();
  }
  ctx.restore();
}

export function inkCell(ctx, v, x, y, color, scale = 1) {
  const pad = v.cell * 0.09;
  const s = (v.cell - pad * 2) * scale;
  const cx = v.ox + x * v.cell + v.cell / 2;
  const cy = v.oy + y * v.cell + v.cell / 2;
  ctx.fillStyle = color;
  roundRect(ctx, cx - s / 2, cy - s / 2, s, s, s * 0.22);
  ctx.fill();
}

export function crossMark(ctx, v, x, y, color = T.inkFaint, scale = 1) {
  const r = v.cell * 0.24 * scale;
  const cx = v.ox + x * v.cell + v.cell / 2;
  const cy = v.oy + y * v.cell + v.cell / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.4, v.cell * 0.09);
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

export function label(ctx, str, x, y, { size = 12, color = T.ink, align = 'center', base = 'middle', bold = false, mono = false, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.font = `${bold ? '600 ' : ''}${size}px ${mono ? T.mono : T.font}`;
  ctx.fillText(str, x, y);
  ctx.restore();
}

export function lerp(a, b, t) { return a + (b - a) * t; }

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// 0→1 easing used by every animation in the app; kept here so the boards and the DOM
// chrome agree on what "snap" feels like.
export function easeOut(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }
export function easeInOut(t) { const x = clamp(t, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

export function pulse(now, period = 1400) {
  return 0.5 + 0.5 * Math.sin((now % period) / period * Math.PI * 2);
}

// Hex → rgba() without pulling in a colour library.
export function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
