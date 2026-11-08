import fs from "node:fs";
import path from "node:path";
import { ensureDirs } from "./config.js";
import { Store } from "./store/db.js";
import { createBus } from "./bus.js";
import { createLogger, setLogFile } from "./logger.js";
import { createRunner } from "./agents/runner.js";
import { startChiefLoop } from "./agents/chief.js";
import { startBrainLoop, ensureOnboarding } from "./agents/brain.js";
import { startLeadLoop } from "./agents/lead.js";
import { startServer } from "./server/http.js";
import { startInboxWatcher } from "./inbox.js";
import type { HarnessConfig, HarnessContext, Loop } from "./types.js";

export interface RunningHarness {
  ctx: HarnessContext;
  url: string;
  stop(): Promise<void>;
}

/** Start of the current day in the principal's timezone, as an ISO string in UTC. */
export function startOfLocalDay(timezone: string, now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const h = parts.hour === "24" ? 0 : Number(parts.hour);
  const localSeconds = h * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return new Date(now.getTime() - localSeconds * 1000 - now.getMilliseconds()).toISOString();
}

export function buildContext(config: HarnessConfig, opts: { db?: Store; logToFile?: boolean } = {}): HarnessContext {
  ensureDirs(config);
  if (opts.logToFile ?? true) setLogFile(path.join(config.paths.logs, "harness.log"));
  const log = createLogger("harness");
  const db = opts.db ?? new Store(config.paths.db);
  const bus = createBus(db);
  const runner = createRunner({ config, db, bus, log });
  const ctx: HarnessContext = {
    config,
    db,
    bus,
    log,
    runner,
    isPaused: () => db.settings.get("paused") === "1" || costToday(ctx) >= config.budget.perDayUsd,
  };
  return ctx;
}

export function costToday(ctx: HarnessContext): number {
  return ctx.db.runs.costSince(startOfLocalDay(ctx.config.principal.timezone));
}

/**
 * Bring the database back to a consistent state after a restart:
 * runs left "running" are cancelled, tasks left "running" go back to the queue.
 */
export function recoverState(ctx: HarnessContext): void {
  const cancelled = ctx.db.runs.cancelStale();
  const stuck = ctx.db.tasks.list({ status: "running" });
  for (const t of stuck) {
    ctx.db.tasks.setStatus(t.id, t.lead ? "queued" : "inbox");
    ctx.bus.emit({ type: "task.status", task_id: t.id, payload: { status: t.lead ? "queued" : "inbox", reason: "harness restarted" } });
  }
  if (cancelled || stuck.length) ctx.log.info(`recovered state after restart`, { cancelledRuns: cancelled, requeuedTasks: stuck.length });
}

/** Posts a budget notice once per local day when the cap is hit. */
function startBudgetWatch(ctx: HarnessContext): Loop {
  const log = ctx.log.child("budget");
  const timer = setInterval(() => {
    try {
      const spent = costToday(ctx);
      const cap = ctx.config.budget.perDayUsd;
      const day = startOfLocalDay(ctx.config.principal.timezone).slice(0, 10);
      if (spent >= cap && ctx.db.settings.get("budget_notice_day") !== day) {
        ctx.db.settings.set("budget_notice_day", day);
        const item = ctx.db.items.create({
          kind: "info",
          title: `Daily budget reached ($${spent.toFixed(2)} of $${cap})`,
          body: `The agents are paused until the next day in ${ctx.config.principal.timezone}. Raise \`budget.perDayUsd\` in harness.config.json and restart to continue today. Work in progress is kept and resumes automatically.`,
          options: [{ key: "ack", label: "Got it" }],
          recommended: "ack",
          priority: 1,
        });
        ctx.bus.emit({ type: "item.created", item_id: item.id, payload: { kind: "info", title: item.title } });
        ctx.bus.emit({ type: "harness.paused", payload: { reason: "budget" } });
        log.warn("daily budget reached; agents paused", { spent, cap });
      }
    } catch (err) {
      log.error("budget check failed", { err });
    }
  }, 60_000);
  return {
    name: "budget",
    stop: async () => {
      clearInterval(timer);
    },
  };
}

export async function startHarness(config: HarnessConfig): Promise<RunningHarness> {
  const ctx = buildContext(config);
  const log = ctx.log;
  log.info("starting harness", { root: config.paths.root, leads: config.leads.map((l) => l.id), models: config.models });
  recoverState(ctx);
  ensureOnboarding(ctx);

  const server = await startServer(ctx);
  log.info(`queue app listening`, { url: server.url });

  const loops: Loop[] = [];
  loops.push(startChiefLoop(ctx));
  loops.push(startBrainLoop(ctx));
  for (const lead of config.leads) loops.push(startLeadLoop(ctx, lead));
  loops.push(startInboxWatcher(ctx));
  loops.push(startBudgetWatch(ctx));
  ctx.bus.emit({ type: "harness.started", payload: { url: server.url, leads: config.leads.map((l) => l.id) } });

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      log.info("stopping harness");
      await Promise.allSettled(loops.map((l) => l.stop().catch((err) => log.error(`loop ${l.name} failed to stop`, { err }))));
      await server.close().catch((err) => log.error("server failed to close", { err }));
      ctx.db.close();
      log.info("harness stopped");
    })());

  return { ctx, url: server.url, stop };
}

export function writePidFile(config: HarnessConfig): void {
  fs.writeFileSync(path.join(config.paths.data, "harness.pid"), String(process.pid));
}
