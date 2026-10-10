// 应用外壳：路由、计时、记分、输入设备无关性都在这里。棋盘内部的一切属于引擎。

import { store, prefersReducedMotion, onReducedMotionChange } from '../core/storage.js';
import { sfx, haptic, applySound, soundState, toggleMuted } from '../core/audio.js';
import { todayKey } from '../core/rng.js';
import { KINDS, byId, dailySpec, dailySeed } from '../puzzles/registry.js';
import { LatticeView } from './lattice_view.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const fmt = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const S = {
  kind: null,
  sizeKey: 0,
  index: 0,
  daily: false,
  seed: '',
  engine: null,
  hints: 0,
  startedAt: 0,
  elapsed: 0,
  paused: false,
  pausedByBlur: false,
  tool: 0,
  lastSecond: -1,
};

let view = null;

// ---- 路由 -----------------------------------------------------------------------

const parseHash = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] !== 'p' || parts.length < 3) return null;
  const kind = byId(parts[1]);
  if (!kind) return null;
  const sizeKey = Number(parts[2]);
  if (!kind.sizes.some((s) => s.key === sizeKey)) return null;
  const tail = parts[3] || '';
  const daily = tail === 'd';
  const index = daily ? 0 : Math.max(0, Number(tail) || 0);
  return { kind, sizeKey, daily, index };
};

const route = () => {
  const r = parseHash();
  if (!r) {
    view && view.stop();
    S.kind = null;
    renderHome();
    show('home');
    return;
  }
  start(r.kind, r.sizeKey, r.index, r.daily);
};

function show(name) {
  for (const s of $$('.screen')) s.hidden = s.id !== name;
}

// ---- 暂停 / 全屏 --------------------------------------------------------------

// 暂停要做三件事：计时停、rAF 停（一帧都不推，仿真自然不推进）、输入拒收。
// 只把界面盖住而让回路继续跑的"暂停"是假的：计时会继续涨，笔迹还会落进棋盘。
function setPaused(on) {
  if (!S.kind) return;
  const want = !!on;
  if (S.paused === want && !want) return;
  if (want) {
    S.elapsed = elapsedMs();
    S.paused = true;
    view && view.setPaused(true);
  } else {
    S.startedAt = performance.now();
    S.paused = false;
    view && view.setPaused(false);
  }
  const veil = $('#paused-veil');
  if (veil) veil.hidden = !S.paused;
  const btn = $('#pause-btn');
  if (btn) {
    btn.textContent = S.paused ? '继续' : '暂停';
    btn.setAttribute('aria-pressed', S.paused ? 'true' : 'false');
  }
  updateHud();
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

// 全屏按钮绑在 index.html 里真实存在的 #fs-btn 上；iOS Safari 没有
// requestFullscreen（只有 video 元素能全屏），所以这条路要给出声的降级而不是静默失败。
function toggleFullscreen() {
  const el = document.documentElement;
  const go = el.requestFullscreen || el.webkitRequestFullscreen;
  if (isFullscreen()) {
    const out = document.exitFullscreen || document.webkitExitFullscreen;
    if (out) Promise.resolve(out.call(document)).catch(() => toast('系统不让退出全屏'));
  } else if (go) {
    Promise.resolve(go.call(el)).catch(() => toast('这个浏览器不给全屏（iOS Safari 只能靠系统手势）'));
  } else {
    toast('这个浏览器不给全屏（iOS Safari 只能靠系统手势）');
  }
}

function syncFullscreenBtn() {
  const b = $('#fs-btn');
  if (!b) return;
  const on = isFullscreen();
  b.textContent = on ? '⛶' : '⤢';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? '退出全屏 (F)' : '全屏 (F)';
}

// ---- 首页 -----------------------------------------------------------------------

function renderHome() {
  const day = todayKey();
  $('#daily-date').textContent = day.replaceAll('-', ' / ');
  const done = store.dailyDone(day);
  const row = $('#daily-row');
  row.textContent = '';
  const nDone = Object.keys(done).length;
  $('#daily-done').textContent = String(nDone);
  for (const d of dailySpec(day)) {
    const k = byId(d.kindId);
    const b = make('button', 'daily-cell' + (done[k.id] ? ' done' : ''));
    b.appendChild(make('span', 'g', k.shell.glyph));
    b.appendChild(make('span', 'n', k.title));
    b.appendChild(make('span', 's', sizeLabel(k, d.sizeKey)));
    b.onclick = () => {
      sfx.click();
      location.hash = `#/p/${k.id}/${d.sizeKey}/d`;
    };
    row.appendChild(b);
  }

  const grid = $('#kinds');
  grid.textContent = '';
  for (const k of KINDS) {
    const card = make('article', 'kind');
    const top = make('div', 'kind-top');
    top.appendChild(make('span', 'kind-glyph', k.shell.glyph));
    top.appendChild(make('span', 'kind-latin', k.latin));
    card.appendChild(top);
    const name = make('div');
    name.appendChild(make('div', 'kind-name', k.title));
    name.appendChild(make('div', 'kind-tag', k.tagline));
    card.appendChild(name);

    const foot = make('div', 'kind-foot');
    const chips = make('div', 'kind-sizes');
    for (const s of k.sizes) {
      const chip = make('button', 'size-chip', s.label);
      chip.title = s.tier + ' · 开这一档';
      chip.onclick = () => {
        sfx.click();
        location.hash = `#/p/${k.id}/${s.key}/${randomIndex()}`;
      };
      chips.appendChild(chip);
    }
    foot.appendChild(chips);
    const rec = bestAcrossSizes(k);
    foot.appendChild(make('span', 'kind-best', rec));
    card.appendChild(foot);

    const help = make('button', 'kind-help', '?');
    help.title = '怎么玩';
    help.onclick = (e) => { e.stopPropagation(); openHowto(k); };
    card.appendChild(help);
    card.onclick = () => {
      sfx.click();
      location.hash = `#/p/${k.id}/${k.sizes[0].key}/${randomIndex()}`;
    };
    grid.appendChild(card);
  }

  $('#stat-solves').textContent = String(store.totalSolves());
  const g = store.statsObj();
  $('#stat-nohint').textContent = String(g.noHint);
  $('#stat-hints').textContent = String(g.hints);
  const sk = store.streak(day);
  $('#stat-streak').textContent = String(sk.count);
  $('#streak-chip').textContent = `${sk.count} 天`;
  $('#streak-chip').title = sk.alive ? '连续中' : '今天还没做';
}

function bestAcrossSizes(k) {
  let best = 0;
  let label = '';
  for (const s of k.sizes) {
    const r = store.record(`${k.id}:${s.key}`);
    if (r && r.bestMs && (!best || r.bestMs < best)) { best = r.bestMs; label = s.label; }
  }
  return best ? `最佳 ${fmt(best)} · ${label}` : '还没有纪录';
}

// 档位名得由玩法自己给：孔明棋的 sizeKey 是孔数，印成 "33×33" 就是在描述一块不存在的棋盘。
const sizeLabel = (kind, sizeKey) =>
  kind.sizes.find((s) => s.key === sizeKey)?.label || `${sizeKey}×${sizeKey}`;

const randomIndex = () => Math.floor(Math.random() * 1e6) + Date.now() % 1000;

// ---- 一局 -----------------------------------------------------------------------

function start(kind, sizeKey, index, daily) {
  S.kind = kind;
  S.sizeKey = sizeKey;
  S.index = index;
  S.daily = daily;
  S.seed = daily ? dailySeed(todayKey(), kind.id) : `${kind.id}:${sizeKey}:${index}`;
  const spec = kind.generate(S.seed, sizeKey);
  S.engine = kind.create(spec);
  S.hints = 0;
  S.tool = 0;
  S.startedAt = performance.now();
  S.elapsed = 0;
  S.paused = false;
  S.lastSecond = -1;

  view.attach(S.engine);
  view.tool = 0;
  view.setPaused(false);
  view.layout();
  S.paused = false;
  { const veil = $('#paused-veil'); if (veil) veil.hidden = true; }
  { const pb = $('#pause-btn'); if (pb) { pb.textContent = '暂停'; pb.setAttribute('aria-pressed', 'false'); } }
  $('#play-title').textContent = kind.title;
  $('#play-size').textContent = sizeLabel(kind, sizeKey) + (daily ? ' · 今日' : '');
  $('#hint-note').textContent = kind.shell.tip;
  $('#hint-count').textContent = '0';
  const dual = kind.shell.dual;
  $('#tool-toggle').hidden = !dual;
  $('#tool-primary').textContent = kind.shell.primary || '主笔';
  $('#tool-secondary').textContent = kind.shell.secondary || '副笔';
  $$('#tool-toggle button').forEach((b) => b.classList.toggle('on', Number(b.dataset.tool) === S.tool));
  show('play');
  updateHud();
  history.replaceState(null, '', `#/p/${kind.id}/${sizeKey}/${daily ? 'd' : index}`);
}

function elapsedMs() {
  return S.paused ? S.elapsed : S.elapsed + (performance.now() - S.startedAt);
}

function updateHud() {
  const e = S.engine;
  if (!e) return;
  const st = e.stats();
  $('#progress-bar').style.width = `${st.total ? Math.min(100, (st.done / st.total) * 100) : 0}%`;
  const unit = S.kind.unit || '';
  $('#status-text').textContent =
    `${st.done} / ${st.total} ${unit}` + ` · 步 ${st.moves}` + (st.par ? ` / 基准 ${st.par}` : '');
  $('#hint-count').textContent = String(S.hints);
  const timer = $('#play-timer');
  const sec = Math.floor(elapsedMs() / 1000);
  if (sec !== S.lastSecond) {
    S.lastSecond = sec;
    timer.textContent = fmt(elapsedMs());
  }
  $$('[data-action=undo]').forEach((b) => { b.disabled = !e.canUndo(); });
  $$('[data-action=redo]').forEach((b) => { b.disabled = !e.canRedo(); });
}

// ---- 结算 -----------------------------------------------------------------------

function finish() {
  if (!S.kind) return;
  const e = S.engine;
  const ms = elapsedMs();
  S.paused = true;
  view.win();
  sfx.win();
  haptic(30);
  flashBoard();
  const st = e.stats();
  const id = `${S.kind.id}:${S.sizeKey}`;
  const prev = store.record(id);
  const rec = store.finish(id, { ms, moves: st.moves, hints: S.hints });
  const isNewBest = !prev || !prev.bestMs || ms <= rec.bestMs;
  if (S.daily) {
    const bumped = store.markDaily(todayKey(), S.kind.id);
    if (bumped >= 3) toast(`连续 ${bumped} 天 · 中间断一天就会归零`);
  }

  const stars = starsOf(st, S.hints);
  window.setTimeout(() => {
    $('#result-title').textContent = S.daily ? '今日挑战完成' : '解开了';
    $('#result-sub').textContent = `${S.kind.title} · ${sizeLabel(S.kind, S.sizeKey)} · ${S.kind.latin}`;
    $('#result-mark').textContent = S.hints ? '◇' : '✦';
    $$('#result-stars i').forEach((n, i) => n.classList.toggle('on', i < stars));
    const rows = $('#result-rows');
    rows.textContent = '';
    const add = (label, value, hot) => {
      const d = make('div');
      d.appendChild(make('dt', null, label));
      const dd = make('dd', hot ? 'best' : null, value);
      d.appendChild(dd);
      rows.appendChild(d);
    };
    add('用时', fmt(ms), isNewBest);
    add('最少用时纪录', fmt(rec.bestMs), false);
    add('步数', st.par ? `${st.moves} / 基准 ${st.par}` : String(st.moves), false);
    add('提示', S.hints ? `用了 ${S.hints} 次` : '没用', false);
    add('本档累计解题', String(rec.solves), false);
    add('无提示完成', String(rec.noHintSolves), false);
    show('result');
    view.stop();
  }, 950);
}

function starsOf(st, hints) {
  let s = 1;
  if (!hints) s++;
  if (!hints && st.par && st.moves <= Math.ceil(st.par * 1.2)) s++;
  return s;
}

function flashBoard() {
  const f = $('#flash');
  f.hidden = false;
  f.addEventListener('animationend', () => { f.hidden = true; }, { once: true });
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---- 抽屉 -----------------------------------------------------------------------

function openHowto(kind) {
  $('#howto-title').textContent = `${kind.title} · ${kind.latin}`;
  const body = $('#howto-body');
  body.textContent = '';
  for (const r of kind.rules) body.appendChild(make('li', null, r));
  $('#howto').showModal();
}

function syncSettings() {
  $$('#settings input[data-setting]').forEach((i) => {
    const v = store.settings[i.dataset.setting];
    i.checked = i.dataset.setting === 'reduceMotion' ? prefersReducedMotion() : !!v;
  });
  const btn = $('#sound-btn');
  const on = !!store.settings.sound;
  btn.classList.toggle('off', !on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  // 真静音：把已经活着的 AudioContext 挂起（静音态不再新建振荡器节点）
  applySound(on);
}

// ---- 装配 -----------------------------------------------------------------------

export function boot() {
  view = new LatticeView($('#board'), $('#board-wrap'));
  // 落子音每一步都放；错题检查要跑一遍求解器，只在抬手时算，15×15 才不掉帧
  view.onInput = (strokeEnd) => {
    if (S.tool === 1 && S.kind.shell.dual) sfx.mark();
    else sfx.tap();
    haptic(6);
    if (strokeEnd && S.engine.badCells && S.engine.badCells().length) sfx.bad();
    updateHud();
  };
  view.onWin = () => finish();
  view.onFrame = () => { if (!S.paused) updateHud(); };

  document.body.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'home') location.hash = '#/';
    else if (a === 'settings') { syncSettings(); $('#settings').showModal(); }
    else if (a === 'howto-global') openHowto(KINDS[0]);
    else if (a === 'toggle-sound') {
      toggleMuted();
      syncSettings();
      sfx.click();
    } else if (a === 'pause') setPaused(!S.paused);
    else if (a === 'fullscreen') toggleFullscreen();
    else if (a === 'undo' && doUndo()) { /* played sound */ }
    else if (a === 'redo' && doRedo()) { /* ditto */ }
    else if (a === 'hint') doHint();
    else if (a === 'restart') doRestart();
    else if (a === 'next') location.hash = `#/p/${S.kind.id}/${S.sizeKey}/${randomIndex()}`;
    else if (a === 'replay') doRestart();
    else if (a === 'export') {
      navigator.clipboard && navigator.clipboard.writeText(store.exportText());
      toast('存档已复制到剪贴板');
    } else if (a === 'import') $('#import-box').hidden = false;
    else if (a === 'import-apply') {
      try { store.importText($('#import-text').value.trim()); syncSettings(); renderHome(); toast('存档已载入'); }
      catch { toast('这不是有效的存档字符串'); }
    } else if (a === 'reset') { store.reset(); syncSettings(); renderHome(); toast('已清空'); }
  });

  $$('#tool-toggle button').forEach((b) => {
    b.onclick = () => {
      S.tool = Number(b.dataset.tool);
      view.tool = S.tool;
      $$('#tool-toggle button').forEach((x) => x.classList.toggle('on', x === b));
      sfx.click();
    };
  });

  $$('#settings input[data-setting]').forEach((i) => {
    i.onchange = () => {
      store.set(i.dataset.setting, i.checked);
      syncSettings();
      view.layout();
    };
  });

  const veil = $('#paused-veil');
  if (veil) veil.addEventListener('click', () => setPaused(false));
  document.addEventListener('fullscreenchange', syncFullscreenBtn);
  document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
  onReducedMotionChange(() => { if (view) view.layout(); });

  window.addEventListener('hashchange', route);
  // 切后台 = 自动暂停（走同一个 setPaused，计时/回路/输入三件事一起停），
  // 回到前台只在"因为后台而暂停"时自动续上 —— 玩家自己按的暂停不许被切后台抹掉。
  document.addEventListener('visibilitychange', () => {
    if (!S.kind || $('#play').hidden) return;
    if (document.hidden) {
      if (!S.paused) { setPaused(true); S.pausedByBlur = true; }
    } else if (S.pausedByBlur) {
      S.pausedByBlur = false;
      setPaused(false);
    }
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if ($('#settings').open || $('#howto').open) return;
    const k = ev.key;
    if (k === 'Escape') { if (S.paused) { setPaused(false); return; } location.hash = '#/'; return; }
    if ($('#play').hidden) return;
    if (k === 'p' || k === 'P') { setPaused(!S.paused); return; }
    if (k === 'm' || k === 'M') { toggleMuted(); syncSettings(); return; }
    if (k === 'f' || k === 'F') { toggleFullscreen(); return; }
    if (k === '?') { openHowto(S.kind); return; }
    const nav = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    if (nav) { view.nudge(...nav); ev.preventDefault(); return; }
    if (k === ' ' || k === 'Enter') { view.press(true); ev.preventDefault(); return; }
    if (k === 'z' || k === 'Z') { ev.preventDefault(); k === 'Z' ? doRedo() : doUndo(); return; }
    if (k === 'h') { doHint(); return; }
    if (k === 'r') { doRestart(); return; }
    if (k === '1' || k === '2') {
      const b = $(`#tool-toggle button[data-tool="${Number(k) - 1}"]`);
      if (b && !b.closest('#tool-toggle').hidden) b.click();
    }
  });

  syncSettings();
  syncFullscreenBtn();
  renderHome();
  route();
}

function doUndo() {
  if (!S.engine || !S.engine.undo()) return false;
  sfx.undo();
  view.resetWin();
  updateHud();
  return true;
}

function doRedo() {
  if (!S.engine || !S.engine.redo()) return false;
  sfx.tap();
  updateHud();
  return true;
}

function doHint() {
  if (!S.engine || S.paused) return;
  const h = S.engine.hint();
  if (!h) { toast('这一步推不出来了 —— 要么已经解完，要么得先退回一步'); sfx.bad(); return; }
  S.hints++;
  sfx.hint();
  $('#hint-note').textContent = h.note || '提示已落子';
  updateHud();
}

function doRestart() {
  if (!S.kind) return;
  start(S.kind, S.sizeKey, S.index, S.daily);
  sfx.erase();
}

// 无头复验（tools/playtest.mjs）需要一个稳定的入口来切题、读状态、按提示把题解完。
// 只暴露读与"像玩家一样操作"的动词，不提供任何绕过引擎判定的后门。
export const debug = {
  state: S,
  view: () => view,
  start,
  store,
  todayKey,
  elapsed: elapsedMs,
  home: () => { location.hash = '#/'; },
  setPaused,
  // 给帧率对拍/无头复验读的只读快照：任何量具读不到状态就等于没测（简报 §3 最后一条）。
  probe: () => ({
    phase: S.kind ? ($('#play').hidden ? 'result' : 'play') : 'home',
    paused: !!S.paused,
    running: !!(view && view.running),
    frames: view ? view.frames : 0,
    lastT: view ? view.lastT : 0,
    winAt: view ? view.winAt : 0,
    elapsedMs: elapsedMs(),
    timerText: $('#play-timer') ? $('#play-timer').textContent : '',
    hints: S.hints,
    tool: S.tool,
    sound: { want: !!store.settings.sound, ctx: soundState() },
    reduceMotion: prefersReducedMotion(),
    fullscreen: isFullscreen(),
    stats: S.engine ? S.engine.stats() : null,
  }),
};
