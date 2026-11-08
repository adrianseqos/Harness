import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HarnessConfig, Logger } from "../types.js";

/**
 * Static files for the queue app: the web/ directory, evidence attachments
 * (data/attachments/<task>/<file>) and the vendored markdown renderer.
 * Every path is resolved and checked against its root so nothing outside can be read.
 */

const WEB_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** Attachments are evidence produced by agents: text-like files are always served as plain text, html included. */
const ATTACHMENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".htm": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
};

const RANGE_TYPES = new Set([".webm", ".mp4", ".mov"]);

/** Resolve `rel` under `root`; returns null when the result would escape `root` or the path is malformed. */
export function safeResolve(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === ".." || s === "." || s.includes("\\"))) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

/** Stream one file with the right headers. Honours Range requests for media when `allowRange` is set. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, contentType: string, allowRange: boolean, cache: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    sendJsonError(res, 404, "File not found");
    return;
  }
  if (!stat.isFile()) {
    sendJsonError(res, 404, "File not found");
    return;
  }
  const headers: Record<string, string | number> = {
    "Content-Type": contentType,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
  };
  if (allowRange) headers["Accept-Ranges"] = "bytes";
  const range = allowRange ? parseRange(req.headers.range, stat.size) : null;
  if (range === "invalid") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers["Content-Length"] = range.end - range.start + 1;
    res.writeHead(206, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  headers["Content-Length"] = stat.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

let markedPath: string | null | undefined;

/** Locate marked's UMD bundle once; null when the package is missing. */
function resolveMarked(log: Logger): string | null {
  if (markedPath !== undefined) return markedPath;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("marked/package.json");
    markedPath = path.join(path.dirname(pkg), "lib", "marked.umd.js");
    if (!fs.existsSync(markedPath)) {
      log.error("marked bundle not found", { path: markedPath });
      markedPath = null;
    }
  } catch (err) {
    log.error("marked package could not be resolved", { err });
    markedPath = null;
  }
  return markedPath;
}

interface StaticDeps {
  config: HarnessConfig;
  log: Logger;
}

/**
 * Try to serve `pathname` as a static file. Returns true when the response was handled
 * (including error responses), false when the path is not a static route.
 */
export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, deps: StaticDeps): boolean {
  const { config, log } = deps;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  if (pathname === "/vendor/marked.js") {
    const file = resolveMarked(log);
    if (!file) {
      sendJsonError(res, 404, "marked is not installed");
      return true;
    }
    sendFile(req, res, file, WEB_TYPES[".js"], false, "public, max-age=86400");
    return true;
  }

  if (pathname.startsWith("/attachments/")) {
    const rel = pathname.slice("/attachments/".length);
    const file = safeResolve(config.paths.attachments, rel);
    if (!file) {
      log.warn("rejected attachment path", { path: pathname });
      sendJsonError(res, 400, "Invalid attachment path");
      return true;
    }
    const ext = path.extname(file).toLowerCase();
    const type = ATTACHMENT_TYPES[ext] ?? "application/octet-stream";
    sendFile(req, res, file, type, RANGE_TYPES.has(ext), "private, max-age=3600");
    return true;
  }

  if (pathname.startsWith("/api/")) return false;

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = safeResolve(config.paths.web, rel);
  if (!file) {
    log.warn("rejected static path", { path: pathname });
    sendJsonError(res, 400, "Invalid path");
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  const type = WEB_TYPES[ext];
  if (!type) {
    sendJsonError(res, 404, "Not found");
    return true;
  }
  sendFile(req, res, file, type, false, "no-cache");
  return true;
}
