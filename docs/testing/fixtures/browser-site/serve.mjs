#!/usr/bin/env node
/**
 * Serves the fixture site. Delays GET /assets/slow.js by SLOW_MS (default 3000).
 * Usage: node serve.mjs [port]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 4177);
const slowMs = Number(process.env.SLOW_MS || 3000);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".bin": "application/octet-stream",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  if (rel === "/") rel = "/index.html";
  const filePath = path.normalize(path.join(root, rel));
  if (!filePath.startsWith(root)) {
    send(res, 403, "forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "not found");
    return;
  }
  if (rel.replace(/\\/g, "/") === "/assets/slow.js") {
    await new Promise((r) => setTimeout(r, slowMs));
  }
  const ext = path.extname(filePath);
  const body = fs.readFileSync(filePath);
  send(res, 200, body, {
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ZLI browser fixture at http://127.0.0.1:${port}/`);
  console.log(`slow.js delay ${slowMs}ms`);
});
