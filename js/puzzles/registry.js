// 玩法注册表：引擎只提供题与棋盘，这里补上"外壳需要知道、引擎不该关心"的那部分
// —— 首页图标、副笔在这个玩法里是什么意思。新增玩法只需要加一个文件加一行。
//
// 种子前缀与 nikoli 仓不同：两仓都往 localStorage 写每日完成记录，同名前缀会让
// 一边打的卡把另一边也标成打过。

import slitherlink from '../puzzles/slitherlink.js';
import masyu from '../puzzles/masyu.js';
import arukone from '../puzzles/arukone.js';
import hashi from '../puzzles/hashi.js';

const SHELL = {
  slitherlink: { glyph: '◯', dual: true, primary: '画环', secondary: '封边', tip: '沿两点之间拖出一条边，副笔把确定不在环上的边封掉' },
  masyu: { glyph: '◉', dual: true, primary: '画环', secondary: '封格', tip: '线走格心：白珠直穿两头各要一次拐弯，黑珠拐弯前后各伸出两格' },
  arukone: { glyph: '⇄', dual: true, primary: '画环', secondary: '封格', tip: '数字说：沿环往两个方向各数这么多格才第一次拐弯' },
  hashi: { glyph: '⊞', dual: true, primary: '搭桥', secondary: '封道', tip: '按住一座岛拖向另一座，一对岛最多两根桥，副笔封掉确定不搭的那条道' },
};

export const KINDS = [slitherlink, masyu, arukone, hashi].map((k) => ({ ...k, shell: SHELL[k.id] }));

export const byId = (id) => KINDS.find((k) => k.id === id) || null;

// 每日种子集中在这里算，首页和路由两条入口才能拿到同一道题。
export const dailySeed = (day, kindId) => `loops-daily|${day}|${kindId}`;

// 每日挑战的题面只由日期决定：同一天的每道题在所有设备上是同一套。
// 尺寸按日期轮转，这样"今天做哪档"也不是玩家能挑的 —— 挑不了才叫挑战。
export function dailySpec(day) {
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (Math.imul(h, 31) + day.charCodeAt(i)) >>> 0;
  return KINDS.map((k, i) => ({
    kindId: k.id,
    sizeKey: k.sizes[(h >> (i * 3)) % k.sizes.length].key,
    seed: dailySeed(day, k.id),
  }));
}
