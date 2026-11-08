import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HarnessContext, Event, Logger } from "../types.js";
import { HttpError, matchRoute, pathExists, type ApiRequest, type ApiResponse } from "./api.js";
import { serveStatic } from "./static.js";

/**
 * The local web server behind the queue app: JSON API under /api/*, a live event stream
 * at /api/events/stream (SSE) and static files for the UI and evidence attachments.
 * Plain node:http, bound to config.server.host:port, no framework.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SSE_PING_MS = 15_000;
const TOKEN_FILE = ".harness-token";
const TOKEN_COOKIE = "harness_token";
const TOKEN_HEADER = "x-harness-token";

/**
 * Per-installation API token. The browser receives it as a cookie when it loads the app; the CLI reads
 * the file. Agents never see it: the policy denies reading the file and their environment is minimal,
 * so a lead cannot answer its own permission or review items by calling the API.
 */
export function ensureApiToken(dataDir: string): string {
  const file = path.join(dataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{32,}$/.test(existing)) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

export function readApiToken(dataDir: string): string | null {
  try {
    const t = fs.readFileSync(path.join(dataDir, TOKEN_FILE), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === "string" && header) return header;
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === TOKEN_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function tokensMatch(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Reject requests whose Host header is not this server (blocks DNS-rebinding from a web page). */
function hostAllowed(hostHeader: string | undefined, boundHost: string, boundPort: number): boolean {
  if (!hostHeader) return false;
  const m = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const name = m[1].replace(/^\[|\]$/g, "").toLowerCase();
  const port = m[2] ? Number(m[2]) : 80;
  if (port !== boundPort) return false;
  const local = new Set(["localhost", "127.0.0.1", "::1", boundHost.toLowerCase()]);
  return local.has(name);
}

export interface ServerHandle {
  close(): Promise<void>;
  port: number;
  url: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

/** Read and parse a JSON body (or return undefined for an empty one). Rejects with HttpError. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, "Request body is larger than 2 MB"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      if (!size) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Request body is not valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (!failed) reject(new HttpError(400, `Could not read request body: ${err.message}`));
    });
  });
}

function sendApiResponse(res: ServerResponse, out: ApiResponse): void {
  const status = out.status ?? 200;
  if (out.text !== undefined) {
    sendText(res, status, out.text, out.contentType ?? "text/plain; charset=utf-8");
    return;
  }
  sendJson(res, status, out.json ?? {});
}

// ---------- SSE ----------

interface SseClient {
  res: ServerResponse;
  off: () => void;
  ping: NodeJS.Timeout;
}

function startEventStream(ctx: HarnessContext, req: IncomingMessage, res: ServerResponse, clients: Set<SseClient>, log: Logger): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const send = (ev: Event) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const off = ctx.bus.on("*", send);
  const ping = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, SSE_PING_MS);
  const client: SseClient = { res, off, ping };
  clients.add(client);
  log.debug("event stream opened", { clients: clients.size });
  const cleanup = () => {
    if (!clients.has(client)) return;
    clients.delete(client);
    clearInterval(ping);
    off();
    log.debug("event stream closed", { clients: clients.size });
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function closeEventStreams(clients: Set<SseClient>): void {
  for (const c of Array.from(clients)) {
    clearInterval(c.ping);
    c.off();
    c.res.end();
    clients.delete(c);
  }
}

// ---------- request handling ----------

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function handleApi(ctx: HarnessContext, req: IncomingMessage, res: ServerResponse, url: URL, log: Logger): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const match = matchRoute(method, url.pathname);
  if (!match) {
    if (pathExists(url.pathname)) {
      sendJson(res, 405, { error: `Method ${method} is not allowed on ${url.pathname}` });
      return;
    }
    sendJson(res, 404, { error: `No such API route: ${method} ${url.pathname}` });
    return;
  }
  let body: unknown;
  try {
    body = method === "GET" || method === "HEAD" ? undefined : await readJsonBody(req);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    sendJson(res, status, { error: describeError(err) });
    return;
  }
  const apiReq: ApiRequest = { method, path: url.pathname, params: match.params, query: url.searchParams, body };
  try {
    const out = await match.route.handler(ctx, apiReq);
    sendApiResponse(res, out);
  } catch (err) {
    if (err instanceof HttpError) {
      log.debug("request rejected", { route: `${method} ${url.pathname}`, status: err.status, error: err.message });
      sendJson(res, err.status, { error: err.message });
      return;
    }
    log.error("request handler failed", { route: `${method} ${url.pathname}`, err });
    if (!res.headersSent) sendJson(res, 500, { error: `Internal error: ${describeError(err)}` });
    else res.end();
  }
}

/** Start the queue app server. Rejects with a clear message when the port is already in use. */
export async function startServer(ctx: HarnessContext): Promise<ServerHandle> {
  const log = ctx.log.child("http");
  const { host, port } = ctx.config.server;
  const clients = new Set<SseClient>();
  const token = ensureApiToken(ctx.config.paths.data);
  let boundPort = port;

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendJson(res, 400, { error: "Malformed request URL" });
      return;
    }
    res.on("finish", () => log.debug(`${method} ${url.pathname} → ${res.statusCode}`, { ms: Date.now() - started }));

    try {
      if (!hostAllowed(req.headers.host, host, boundPort)) {
        sendJson(res, 403, { error: "Host header does not match this server" });
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/")) {
        if (!tokensMatch(presentedToken(req), token)) {
          sendJson(res, 401, { error: "Missing or invalid harness token. Open the app in the browser, or pass the token from data/.harness-token in the x-harness-token header." });
          return;
        }
      } else if (url.pathname === "/" || url.pathname === "/index.html") {
        res.setHeader("Set-Cookie", `${TOKEN_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly`);
      }
      if (url.pathname === "/api/events/stream") {
        if (method !== "GET") {
          sendJson(res, 405, { error: "The event stream only supports GET" });
          return;
        }
        startEventStream(ctx, req, res, clients, log);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        void handleApi(ctx, req, res, url, log);
        return;
      }
      if (serveStatic(req, res, url.pathname, { config: ctx.config, log })) return;
      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      log.error("request failed", { route: `${method} ${url.pathname}`, err });
      if (!res.headersSent) sendJson(res, 500, { error: `Internal error: ${describeError(err)}` });
      else res.end();
    }
  });
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") reject(new Error(`Port ${port} on ${host} is already in use. Stop the other harness (or whatever listens there) or change server.port in harness.config.json / HARNESS_PORT.`));
      else if (err.code === "EACCES") reject(new Error(`No permission to bind ${host}:${port}. Choose a port above 1024 in harness.config.json.`));
      else reject(new Error(`Could not listen on ${host}:${port}: ${err.message}`));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address() as AddressInfo;
  const actualPort = address.port;
  boundPort = actualPort;
  const displayHost = address.family === "IPv6" && host.includes(":") ? `[${host}]` : host;
  const url = `http://${displayHost}:${actualPort}`;
  log.info("listening", { url });

  server.on("error", (err) => log.error("server error", { err }));

  return {
    port: actualPort,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        closeEventStreams(clients);
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
