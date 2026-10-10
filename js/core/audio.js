// Synthesised sound only — no audio files in the repo. The context is created lazily
// on the first gesture because browsers refuse to start audio before one.

import { store } from './storage.js';

let ctx = null;
let master = null;

function ensure() {
  // 静音判定必须在"复用已有上下文"之前：写成 if (ctx) return ctx 打头，
  // 一旦上下文建起来，静音态照样每步新建振荡器（还会顺手把 suspended 的它 resume 回去），
  // 那就是标准的假静音 —— 听不见，但节点在长、电在耗。
  if (!store.settings.sound) return null;
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  return ctx;
}

function tone({ f = 440, to = f, dur = 0.09, type = 'sine', gain = 0.15, delay = 0 }) {
  const c = ensure();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (to !== f) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.06, gain = 0.08, filter = 1200 }) {
  const c = ensure();
  if (!c) return;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bq = c.createBiquadFilter();
  bq.type = 'lowpass';
  bq.frequency.value = filter;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(bq).connect(g).connect(master);
  src.start();
}

export const sfx = {
  tap: () => { tone({ f: 620, to: 520, dur: 0.05, type: 'triangle', gain: 0.09 }); noise({ dur: 0.03, gain: 0.05, filter: 2600 }); },
  mark: () => tone({ f: 300, to: 240, dur: 0.05, type: 'square', gain: 0.05 }),
  erase: () => { noise({ dur: 0.06, gain: 0.07, filter: 900 }); },
  line: () => tone({ f: 480, to: 640, dur: 0.06, type: 'sine', gain: 0.07 }),
  click: () => tone({ f: 380, to: 300, dur: 0.045, type: 'triangle', gain: 0.07 }),
  bad: () => tone({ f: 190, to: 120, dur: 0.14, type: 'sawtooth', gain: 0.06 }),
  hint: () => { tone({ f: 880, dur: 0.07, gain: 0.09 }); tone({ f: 1170, dur: 0.09, gain: 0.07, delay: 0.06 }); },
  undo: () => tone({ f: 320, to: 220, dur: 0.07, type: 'triangle', gain: 0.06 }),
  complete: () => { noise({ dur: 0.09, gain: 0.1, filter: 700 }); tone({ f: 200, to: 90, dur: 0.18, type: 'square', gain: 0.07 }); },
  win: () => [0, 0.1, 0.2, 0.34].forEach((d, i) => tone({ f: [523, 659, 784, 1047][i], dur: 0.3, gain: 0.11, delay: d, type: 'triangle' })),
  unlock: () => ensure(),
};

export function haptic(ms = 8) {
  if (navigator.vibrate && store.settings.sound) navigator.vibrate(ms);
}

// 真静音：把 AudioContext 挂起，而不是把 master gain 设成 0。
// gain=0 的上下文仍在跑、仍在按节拍消耗资源，且新落的音仍会创建振荡器节点（只是听不见），
// 断电式静音才是"节点不再增加"。ensure() 在 sound=false 时直接返回 null，
// 所以静音期间根本不会有新振荡器；这里负责把已经活着的那个停下来。
export function applySound(on) {
  if (!ctx) return 'idle';               // 还没建过上下文：没什么可停的
  const want = on ? 'running' : 'suspended';
  if (ctx.state !== want) {
    const p = ctx[on ? 'resume' : 'suspend']();
    if (p && p.catch) p.catch(() => { /* 手势之外调用被拒：状态下一拍自然修正 */ });
  }
  return ctx.state;
}

export function soundState() {
  return ctx ? ctx.state : 'idle';
}

// 静音态的统一入口：写盘 + 挂起上下文，两件事必须一起做（只做一件就是假静音）。
export function isMuted() {
  return !store.settings.sound;
}

export function toggleMuted() {
  store.set('sound', isMuted());
  applySound(!isMuted());
  return isMuted();
}
