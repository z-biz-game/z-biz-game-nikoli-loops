'use strict';
// 离线可用 + 永不被旧缓存钉住。
//
// 两条实测换来的口径：
//   1) 一律 **网络优先**，命中网络才回填缓存。手工 VERSION + cache-first 的组合，
//      发出去的 HTML 会配上上一版的 js/css，出一个"新界面配旧逻辑"的鬼状态，
//      而且玩家自己无法恢复（只能等缓存过期）。
//   2) 缓存名带版本号（activate 时清掉非本版的名字）。改版**不需要**同步 bump：
//      同名文件重绘之后，网络优先这一条保证客户端下一次联网就拿到新字节。
const VERSION = 'nikoli-loops-v1';
const CACHE = `${VERSION}-shell`;
// 清单里每一项都必须真的在盘上：`addAll` 是**原子**的，缺一个就整份 reject，
// 连 index.html 都存不下来。而下面那个 catch 曾把 reject 吞成静默，于是失败
// 既不改退出码也不留痕迹，首屏壳从来没进过缓存、"断网时至少能打开界面"这句
// 也就从来没兑现过。test/precache.test.mjs 钉住这条不变量。
//
// 本仓踩过：这里曾列 'manifest.webmanifest'，而仓里没有这个文件
// （find . -name 'manifest*' 为空），所以 precache 一直是**整份失败**的。
const PRECACHE = ['index.html'];

self.addEventListener('install', (ev) => {
  // 首屏先抓下来：断网时至少能打开界面，而不是浏览器的错误页。
  // catch 不再吞：precache 失败必须看得见，否则下面的 caches.match 离线回落
  // 永远等不到那份壳，而代码里没有第二处会为这件事报错。
  ev.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch((e) => console.warn('[sw] precache 失败，离线壳将不可用：', e))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 导航请求（地址栏/刷新/桌面图标）离线时回落到缓存的那份壳，不白屏。
        if (req.mode === 'navigate') {
          const shell = await caches.match('index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
