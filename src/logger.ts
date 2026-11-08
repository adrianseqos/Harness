import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./types.js";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = (process.env.HARNESS_LOG_LEVEL as Level) || "info";
let fileStream: fs.WriteStream | null = null;

export function setLogFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fileStream = fs.createWriteStream(file, { flags: "a" });
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function write(level: Level, scope: string, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? " " + safeJson(meta) : "";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${metaStr}`;
  if (level === "error") console.error(line);
  else console.log(line);
  fileStream?.write(line + "\n");
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { message: val.message, stack: val.stack } : val));
  } catch {
    return String(v);
  }
}

export function createLogger(scope = "harness"): Logger {
  return {
    info: (m, meta) => write("info", scope, m, meta),
    warn: (m, meta) => write("warn", scope, m, meta),
    error: (m, meta) => write("error", scope, m, meta),
    debug: (m, meta) => write("debug", scope, m, meta),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
