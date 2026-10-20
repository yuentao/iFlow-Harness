/**
 * Local static server for the mock webview (UI 调试入口).
 *
 * Usage:
 *   node scripts/serve-webview.mjs              # http://127.0.0.1:8791/
 *   node scripts/serve-webview.mjs 5173         # 指定端口
 *   node scripts/serve-webview.mjs 5173 webview/dist
 *
 * 为什么需要 HTTP：vite 产物的 index.html 以绝对路径引用 /assets/...，
 * 用 file:// 直接打开会被 CORS 拒绝，页面空白。
 *
 * 配合 npm run webview:dev（vite build --watch）：改完样式或组件后刷新
 * 浏览器即可。响应头是 no-store，重建产物不会被缓存挡住。
 *
 * 浏览器打开 http://127.0.0.1:<port>/ ，webview/src/store.ts 的 createMockHost()
 * 会装载 demo 快照（审批卡 / 提问卡 / Plan 卡 / 用量说明）。
 *
 * 仅本地调试用：只读文件、无鉴权、无目录穿越防护，不要对外暴露端口。
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PORT = 8791;
const DEFAULT_DIR = "webview/dist";

const [portArg, dirArg] = process.argv.slice(2);
const port = Number(portArg ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`端口无效: ${portArg}（需要 1-65535 的整数）`);
  process.exit(1);
}
const root = path.resolve(dirArg ?? DEFAULT_DIR);
if (!fs.existsSync(path.join(root, "index.html"))) {
  console.error(`找不到 ${path.join(root, "index.html")}`);
  console.error("先构建 webview：npx vite build webview（或 npm run webview:dev）");
  process.exit(1);
}

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const rel = url === "/" || url === "" ? "/index.html" : url;
  const file = path.join(root, rel);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(`404 ${rel}\n`);
    console.error(`404 ${rel}`);
    return;
  }
  res.writeHead(200, {
    "content-type": (mime[path.extname(file).toLowerCase()] ?? "application/octet-stream") + "; charset=utf-8",
    // Rebuilt bundles must show up on the next reload.
    "cache-control": "no-store",
  });
  res.end(buf);
}).listen(port, "127.0.0.1");

console.log(`serving ${root}`);
console.log(`open http://127.0.0.1:${port}/`);
