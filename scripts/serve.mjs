import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(here, '..', 'public');
const HOST = '127.0.0.1';
const PORT = 8080;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function resolveAsset(requestUrl, root = publicRoot) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname); }
  catch { return null; }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const target = resolve(root, `.${pathname}`);
  const inside = relative(root, target);
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  return target;
}

export async function handleRequest(request, response) {
  const finish = (status, message, extra = {}) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extra });
    response.end(request.method === 'HEAD' ? undefined : message);
  };
  if (!['GET', 'HEAD'].includes(request.method)) return finish(405, '仅支持 GET / HEAD。', { Allow: 'GET, HEAD' });
  let path = resolveAsset(request.url);
  if (!path) return finish(400, '路径无效。');
  try {
    let info = await stat(path);
    if (info.isDirectory()) {
      path = resolve(path, 'index.html');
      info = await stat(path);
    }
    const inside = relative(realpathSync(publicRoot), realpathSync(path));
    if (inside.startsWith('..') || isAbsolute(inside) || !info.isFile()) return finish(404, '文件不存在。');
    const body = await readFile(path);
    response.writeHead(200, {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    finish(404, '文件不存在。');
  }
}

export function startServer() {
  const server = createServer(handleRequest);
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? '8080 端口已被占用。请关闭先前启动的窗口，再重新运行。'
      : `无法启动：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`余讯 6.1 已启动： http://${HOST}:${PORT}`);
    console.log('请在浏览器中打开以上地址。关闭本窗口或按 Ctrl+C 停止。');
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
