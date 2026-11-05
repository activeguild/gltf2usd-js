#!/usr/bin/env node
// Zero-dependency static server for the demo: `npm run demo`, then open
// http://localhost:8080/demo/ . Serves the repository root so the demo can
// import ../src/*.js directly (ES modules need http://, not file://).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT) || 8080;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".usdz": "model/vnd.usdz+zip",
  ".usda": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(302, { location: "/demo/" });
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400); // malformed percent-encoding; without this the server process crashed
    return res.end("bad request");
  }
  let path = normalize(join(root, pathname));
  if (path !== root.replace(/[\\/]$/, "") && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => {
  console.log(`gltf2usd.js demo: http://localhost:${port}/demo/`);
});
