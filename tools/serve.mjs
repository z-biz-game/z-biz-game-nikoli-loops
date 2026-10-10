// 十几行的静态文件服务器：游戏是裸的 ES Module，浏览器需要 http:// 而不是 file://
// 才肯按模块图加载；用 python -m http.server 也行，但这个默认端口与 verify.sh 对齐。
// 默认端口刻意避开姊妹辑的 5173：两仓常同时起服，撞了端口会对着对面的页面做复验。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.argv[2] || process.env.PORT || 5189);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// The repo is the document root and there is nothing above it to hide, but a
// traversal that escapes ROOT would serve the whole disk — reject it.
const safe = (p) => {
  const file = normalize(join(ROOT, decodeURIComponent(p.split('?')[0])));
  return file.startsWith(ROOT) ? file : null;
};

createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url;
  const file = safe(path);
  if (!file) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`nikoli-loops → http://127.0.0.1:${PORT}/`));
