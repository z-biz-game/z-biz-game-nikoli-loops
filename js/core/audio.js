// Synthesised sound only — no audio files in the repo. The context is created lazily
// on the first gesture because browsers refuse to start audio before one.

import { store } from './storage.js';

let ctx = null;
let master = null;

function ensure() {
  if (ctx) return ctx;
  if (!store.settings.sound) return null;
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
