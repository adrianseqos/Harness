#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_CONFIG, findConfigFile, loadConfig } from "./config.js";
import { Store } from "./store/db.js";
import { startHarness, writePidFile, buildContext, costToday } from "./scheduler.js";
import type { HarnessConfig } from "./types.js";

const HELP = `harness — your agent organisation with one review queue

Usage:
  harness start                      start the queue app, chief of staff and all leads
  harness init                       create harness.config.json, brain/ and inbox/ in the current directory
  harness task "<title>" [options]   hand the chief of staff a task
      --brief <text|file.md>  --lead <id>  --priority <1-5>  --repo <path>
  harness status                     counts, running agents, spend today
  harness queue                      open items waiting for you
  harness answer <item> <option> [comment]
  harness brain [distill]            print the brain document (or distill it now)
  harness pause | resume             pause/resume all agents
  harness help

The web app lives at http://<host>:<port> from harness.config.json (default http://127.0.0.1:4242).`;

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | true> } {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

function readBriefFlag(v: string | true | undefined): string {
  if (!v || v === true) return "";
  if (fs.existsSync(v) && fs.statSync(v).isFile()) return fs.readFileSync(v, "utf8");
  return v;
}

async function api(config: HarnessConfig, method: string, route: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown } | null> {
  const url = `http://${config.server.host}:${config.server.port}${route}`;
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return null; // server not running
  }
}

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "init") {
    const root = process.cwd();
    const cfgPath = path.join(root, "harness.config.json");
    if (fs.existsSync(cfgPath)) console.log(`harness.config.json already exists at ${cfgPath}`);
    else {
      fs.writeFileSync(cfgPath, JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n");
      console.log(`wrote ${cfgPath}`);
    }
    for (const d of ["brain", "inbox", "data"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    const seedSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../brain/principal.md");
    const seedDst = path.join(root, "brain", "principal.md");
    if (!fs.existsSync(seedDst) && fs.existsSync(seedSrc)) fs.copyFileSync(seedSrc, seedDst);
    console.log(`Next: edit harness.config.json (your name, your leads, their repos), set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, then run: harness start`);
    return;
  }

  const config = loadConfig(typeof flags.config === "string" ? flags.config : undefined);

  if (cmd === "start") {
    loadDotEnv(config.paths.root);
    const running = await startHarness(config);
    writePidFile(config);
    console.log(`\n  Harness is running. Open ${running.url}\n  Leads: ${config.leads.map((l) => l.id).join(", ")}  ·  Ctrl+C to stop\n`);
    const shutdown = (sig: string) => {
      console.log(`\n${sig} received, stopping…`);
      running.stop().finally(() => process.exit(0));
      setTimeout(() => process.exit(1), 20_000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    return;
  }

  if (cmd === "task") {
    const title = positional.join(" ").trim();
    if (!title) throw new Error('usage: harness task "<title>" [--brief ...] [--lead id] [--priority n] [--repo path]');
    const body = {
      title,
      brief: readBriefFlag(flags.brief),
      lead: typeof flags.lead === "string" ? flags.lead : undefined,
      priority: typeof flags.priority === "string" ? Number(flags.priority) : undefined,
      repo: typeof flags.repo === "string" ? path.resolve(flags.repo) : undefined,
    };
    const viaServer = await api(config, "POST", "/api/tasks", body);
    if (viaServer) {
      if (!viaServer.ok) throw new Error(`server rejected the task: ${JSON.stringify(viaServer.json)}`);
      const t = viaServer.json as { id?: string; task?: { id: string } };
      console.log(`created ${t.id ?? t.task?.id} (via running harness)`);
      return;
    }
    if (body.lead && !config.leads.some((l) => l.id === body.lead)) throw new Error(`unknown lead ${body.lead}; leads: ${config.leads.map((l) => l.id).join(", ")}`);
    const db = new Store(config.paths.db);
    const t = db.tasks.create({ title, brief: body.brief, source: "cli", lead: body.lead ?? null, priority: body.priority, repo: body.repo ?? null, status: body.lead ? "queued" : "inbox" });
    db.events.insert({ type: "task.created", task_id: t.id, item_id: null, run_id: null, payload: { title, source: "cli", lead: body.lead ?? null } });
    db.close();
    console.log(`created ${t.id} (harness not running; it will be picked up on the next start)`);
    return;
  }

  if (cmd === "status") {
    const ctx = buildContext(config, { logToFile: false });
    const tasks = ctx.db.tasks.countByStatus();
    const open = ctx.db.items.countOpen();
    const running = ctx.db.tasks.list({ status: "running" });
    console.log(`Tasks: ${Object.entries(tasks).map(([k, v]) => `${k}=${v}`).join("  ") || "none"}`);
    console.log(`Queue: ${open.total} open (${Object.entries(open.byKind).map(([k, v]) => `${k}=${v}`).join(", ") || "-"})`);
    console.log(`Running: ${running.map((t) => `${t.lead}: ${t.title}`).join("; ") || "nothing"}`);
    console.log(`Spend today: $${costToday(ctx).toFixed(2)} of $${config.budget.perDayUsd}${ctx.isPaused() ? "  (PAUSED)" : ""}`);
    const alive = await api(config, "GET", "/api/state");
    console.log(alive ? `Web app: http://${config.server.host}:${config.server.port}` : "Web app: not running");
    ctx.db.close();
    return;
  }

  if (cmd === "queue") {
    const db = new Store(config.paths.db);
    const items = db.items.list({ status: "open" });
    if (!items.length) console.log("Queue is empty.");
    for (const it of items) {
      console.log(`${it.id}  p${it.priority}  ${it.kind.padEnd(10)} ${it.lead ?? "chief"}  ${it.title}`);
      console.log(`    options: ${it.options.map((o) => o.key + (o.key === it.recommended ? "*" : "")).join(" | ")}`);
    }
    db.close();
    return;
  }

  if (cmd === "answer") {
    const [itemId, option, ...rest] = positional;
    if (!itemId || !option) throw new Error("usage: harness answer <item> <option> [comment]");
    const comment = rest.join(" ");
    const viaServer = await api(config, "POST", `/api/queue/${itemId}/answer`, { option, comment });
    if (viaServer) {
      if (!viaServer.ok) throw new Error(`rejected: ${JSON.stringify(viaServer.json)}`);
      console.log("answered (via running harness)");
      return;
    }
    const db = new Store(config.paths.db);
    const r = db.items.answer(itemId, option, comment);
    if (!r) throw new Error("item not found or not open");
    db.events.insert({ type: "item.answered", task_id: r.item.task_id, item_id: itemId, run_id: null, payload: { option, comment, kind: r.item.kind, lead: r.item.lead } });
    db.close();
    console.log("answered (harness not running; leads will act on it when started)");
    return;
  }

  if (cmd === "brain") {
    if (positional[0] === "distill") {
      const r = await api(config, "POST", "/api/brain/distill");
      if (!r) throw new Error("the harness must be running to distill (start it first)");
      console.log(JSON.stringify(r.json, null, 2));
      return;
    }
    console.log(fs.existsSync(config.paths.brainDoc) ? fs.readFileSync(config.paths.brainDoc, "utf8") : "(no brain document yet)");
    return;
  }

  if (cmd === "pause" || cmd === "resume") {
    const r = await api(config, "POST", `/api/${cmd}`);
    if (r) {
      console.log(r.ok ? `${cmd}d` : `failed: ${JSON.stringify(r.json)}`);
      return;
    }
    const db = new Store(config.paths.db);
    db.settings.set("paused", cmd === "pause" ? "1" : "0");
    db.close();
    console.log(`${cmd}d (takes effect when the harness runs)`);
    return;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exitCode = 1;
}

/** Minimal .env loader (KEY=value lines) so `harness start` works without extra tooling. */
function loadDotEnv(root: string) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export { findConfigFile };
