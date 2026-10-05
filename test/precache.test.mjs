// Service Worker precache 清单的完整性闸门。
//
// 为什么单独一个文件：`caches.addAll()` 是**原子**的 —— 清单里只要有一项 404，
// 整个 promise 就 reject，那一项之外的东西**一个都存不下来**。而 sw.js 里那句
// `addAll(PRECACHE).catch(() => {})` 把 reject 吞成静默，于是失败既不改退出码、
// 也不留痕迹：首屏壳没进缓存，"断网时至少能打开界面"这个承诺从来没兑现过。
//
// 本仓实际踩过：PRECACHE 列了 'manifest.webmanifest'，而仓里根本没有这个文件
// （`find . -name 'manifest*'` 为空），所以 precache 一直是**整份失败**的。
//
// 这条闸门查的是「清单里的每一项都真的在盘上」，不是「有没有 precache」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

// 只认数组字面量里的字符串字面量；带插值/变量的条目无法静态判定，单独点名，
// 不静默当它们过关。
const listMatch = SW.match(/\bPRECACHE\s*=\s*\[([\s\S]*?)\]/);
const entries = listMatch
  ? [...listMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  : [];

test('sw.js 里的 PRECACHE 清单能被抓到（防止判据自己空过）', () => {
  assert.ok(listMatch, 'sw.js 里找不到 PRECACHE = [...] —— 判据失效，不是清单为空');
  assert.ok(entries.length > 0, 'PRECACHE 抓到了但一条都没有 —— 判据失效');
});

test('PRECACHE 清单里没有插值条目（否则静态判不了，得先消掉）', () => {
  const body = listMatch ? listMatch[1] : '';
  const templated = [...body.matchAll(/`[^`]*`/g)].map((m) => m[0]);
  assert.deepEqual(templated, [],
    `PRECACHE 里有模板串 ${JSON.stringify(templated)}，静态判不了；先把它拆成字面量`);
});

test('PRECACHE 的每一项都真的在盘上（addAll 是原子的，缺一个就整份失败）', () => {
  const missing = entries
    .map((e) => (e.startsWith('./') ? e.slice(2) : e))
    .filter((e) => e !== '' && e !== '/')
    .filter((e) => !fs.existsSync(path.join(ROOT, e)));
  assert.deepEqual(missing, [],
    `PRECACHE 指向不存在的文件：${JSON.stringify(missing)}`
    + ' —— addAll 会整份 reject，缓存里一个文件都不会有');
});
