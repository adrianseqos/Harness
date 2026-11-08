import type { HarnessContext, Loop, QueueItem, Task } from "../types.js";
import type { RunResult } from "./runner.js";
import { createHarnessTools } from "./tools.js";
import { chiefBriefPrompt, chiefHealthPrompt, chiefSystemPrompt, chiefTriagePrompt, readBrain } from "./prompts.js";

/**
 * Chief of Staff: the one agent that looks at the inbox, routes work to the leads,
 * keeps the queue healthy and writes the daily brief. One run at a time, never overlapping.
 */

const HEALTH_INTERVAL_MS = 60 * 60_000;
const ERROR_ITEM_INTERVAL_MS = 60 * 60_000;
const WAKE_DEBOUNCE_MS = 3_000;

const SETTING_LAST_HEALTH = "last_health_at";
const SETTING_LAST_BRIEF = "last_brief_date";
const SETTING_LAST_ERROR_ITEM = "last_chief_error_item_at";

export interface PendingAnswer {
  task: Task;
  item: QueueItem;
}

// ---------- loop ----------

export function startChiefLoop(ctx: HarnessContext): Loop {
  const log = ctx.log.child("chief");
  const intervalMs = ctx.config.chief.intervalSec * 1000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  let wakeRequested = false;

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delayMs);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (current) {
      // A run is in flight; remember to come back as soon as it finishes.
      wakeRequested = true;
      return;
    }
    wakeRequested = false;
    current = runCycle(ctx, log).catch((err: unknown) => {
      log.error("chief cycle failed", { error: err instanceof Error ? err.message : String(err) });
    });
    try {
      await current;
    } finally {
      current = null;
      schedule(wakeRequested ? WAKE_DEBOUNCE_MS : intervalMs);
    }
  }

  function wake(): void {
    if (stopped) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void tick();
    }, WAKE_DEBOUNCE_MS);
  }

  const offCreated = ctx.bus.on("task.created", wake);
  const offAnswered = ctx.bus.on("item.answered", wake);
  schedule(WAKE_DEBOUNCE_MS);
  log.info(`chief loop started (every ${ctx.config.chief.intervalSec}s)`);

  return {
    name: "chief",
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (wakeTimer) clearTimeout(wakeTimer);
      timer = null;
      wakeTimer = null;
      offCreated();
      offAnswered();
      if (current) await current;
      log.info("chief loop stopped");
    },
  };
}

async function runCycle(ctx: HarnessContext, log: HarnessContext["log"]): Promise<void> {
  if (ctx.isPaused()) {
    log.debug("paused; skipping chief cycle");
    return;
  }
  const returned = returnAnsweredQuestions(ctx);
  const inbox = ctx.db.tasks.list({ status: "inbox", limit: 1 }).length;
  if (inbox > 0 || returned.length > 0) await runChiefTriage(ctx);

  if (ctx.isPaused()) return;
  if (isDue(ctx.db.settings.get(SETTING_LAST_HEALTH), HEALTH_INTERVAL_MS)) await runChiefHealth(ctx);

  if (ctx.isPaused()) return;
  if (briefIsDue(ctx)) await runDailyBrief(ctx);
}

function isDue(lastIso: string | null, intervalMs: number): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  return Number.isNaN(last) || Date.now() - last >= intervalMs;
}

function briefIsDue(ctx: HarnessContext): boolean {
  const { timezone } = ctx.config.principal;
  const now = new Date();
  const today = localDateString(now, timezone);
  if (ctx.db.settings.get(SETTING_LAST_BRIEF) === today) return false;
  return localParts(now, timezone).hour >= ctx.config.chief.dailyBriefHour;
}

// ---------- answered chief questions → back to the inbox ----------

/**
 * Tasks the chief parked in waiting_human with ask_principal come back to the inbox once
 * the principal answered, with the answer appended to the brief. Idempotent.
 */
export function returnAnsweredQuestions(ctx: HarnessContext): PendingAnswer[] {
  const { db, bus, config } = ctx;
  const log = ctx.log.child("chief");
  const moved: PendingAnswer[] = [];
  for (const task of db.tasks.list({ status: "waiting_human" })) {
    const answered = db.items
      .list({ task_id: task.id, status: "answered", hideDeferred: false })
      .filter((i) => i.meta.chief_question === true && i.meta.chief_returned !== true && i.answer);
    if (!answered.length) continue;
    const appendix = answered.map((item) => formatAnswerSection(config.principal.name, item)).join("");
    db.tasks.update(task.id, { brief: `${task.brief}${appendix}`, status: "inbox" });
    bus.emit({ type: "task.status", task_id: task.id, payload: { status: "inbox", from: "waiting_human", reason: "chief question answered" } });
    for (const item of answered) {
      db.items.update(item.id, { meta: { ...item.meta, chief_returned: true } });
      bus.emit({ type: "item.updated", item_id: item.id, task_id: task.id, payload: { chief_returned: true } });
      moved.push({ task: db.tasks.get(task.id) ?? task, item });
    }
    log.info(`task ${task.id} back in the inbox with ${answered.length} answer(s)`);
  }
  return moved;
}

function formatAnswerSection(principal: string, item: QueueItem): string {
  const a = item.answer;
  if (!a) return "";
  const label = item.options.find((o) => o.key === a.option)?.label ?? a.option;
  const answer = [label, a.comment?.trim()].filter(Boolean).join(" ");
  return `\n\n## Answer from ${principal} (item ${item.id})\nQ: ${item.title}\nA: ${answer}`;
}

/** Inbox tasks that carry an answered chief question, so the triage prompt can list them first. */
function pendingAnswers(ctx: HarnessContext, inbox: Task[]): PendingAnswer[] {
  const out: PendingAnswer[] = [];
  for (const task of inbox) {
    const item = ctx.db.items
      .list({ task_id: task.id, status: "answered", hideDeferred: false })
      .filter((i) => i.meta.chief_question === true && i.answer)
      .sort((a, b) => (b.answered_at ?? "").localeCompare(a.answered_at ?? ""))[0];
    if (item) out.push({ task, item });
  }
  return out;
}

// ---------- runs ----------

export async function runChiefTriage(ctx: HarnessContext): Promise<RunResult | null> {
  const log = ctx.log.child("chief");
  returnAnsweredQuestions(ctx);
  const inbox = ctx.db.tasks.list({ status: "inbox" });
  if (!inbox.length) return null;
  const pending = pendingAnswers(ctx, inbox);
  log.info(`triage: ${inbox.length} task(s) in the inbox`, { pendingAnswers: pending.length });
  const result = await runChief(ctx, "triage", chiefTriagePrompt(ctx.config, inbox.length, pending));
  const untouched = ctx.db.tasks.list({ status: "inbox" }).filter((t) => inbox.some((i) => i.id === t.id));
  if (untouched.length) log.warn(`${untouched.length} inbox task(s) not triaged this round; they stay in the inbox`, { ids: untouched.map((t) => t.id) });
  return result;
}

export async function runChiefHealth(ctx: HarnessContext): Promise<RunResult | null> {
  const result = await runChief(ctx, "health", chiefHealthPrompt(ctx.config, ctx.config.review.staleAfterHours));
  ctx.db.settings.set(SETTING_LAST_HEALTH, new Date().toISOString());
  return result;
}

export async function runDailyBrief(ctx: HarnessContext): Promise<RunResult | null> {
  const stats = briefStats(ctx);
  const result = await runChief(ctx, "brief", chiefBriefPrompt(ctx.config, stats));
  ctx.db.settings.set(SETTING_LAST_BRIEF, localDateString(new Date(), ctx.config.principal.timezone));
  return result;
}

async function runChief(ctx: HarnessContext, round: "triage" | "health" | "brief", prompt: string): Promise<RunResult> {
  const { config } = ctx;
  const log = ctx.log.child("chief");
  const { server, toolNames } = createHarnessTools(ctx, { agent: "chief" });
  const result = await ctx.runner.run({
    agent: "chief",
    prompt,
    systemPrompt: chiefSystemPrompt(config, readBrain(config)),
    cwd: config.paths.root,
    model: config.models.chief,
    tools: [],
    allowedTools: toolNames,
    mcpServers: { harness: server },
    permissionMode: "default",
    settingSources: [],
    maxTurns: 80,
    maxBudgetUsd: 3,
    effort: "high",
  });
  if (result.status === "success") {
    log.info(`${round} round finished`, { cost: result.costUsd, turns: result.turns, summary: result.text.slice(0, 200) });
  } else {
    log.error(`${round} round ${result.status}`, { errors: result.errors, cost: result.costUsd });
    notifyRunFailure(ctx, round, result);
  }
  return result;
}

/** Post an info item about a failed chief run, at most once per hour, so the human notices. */
function notifyRunFailure(ctx: HarnessContext, round: string, result: RunResult): void {
  if (result.status === "cancelled") return;
  if (!isDue(ctx.db.settings.get(SETTING_LAST_ERROR_ITEM), ERROR_ITEM_INTERVAL_MS)) return;
  const reason = result.errors.join("; ").slice(0, 1500) || "no result message";
  const item = ctx.db.items.create({
    kind: "info",
    title: `Chief of staff run failed: ${round}`,
    body: `The chief of staff's ${round} run ended with an error, so the inbox may not have been triaged.\n\n\`\`\`\n${reason}\n\`\`\`\n\nThe harness retries on the next cycle. Check the run log (${result.runId}) if it keeps failing.`,
    options: [{ key: "ack", label: "Got it" }],
    recommended: "ack",
    priority: 2,
    meta: { chief_error: true, run_id: result.runId },
  });
  ctx.db.settings.set(SETTING_LAST_ERROR_ITEM, new Date().toISOString());
  ctx.bus.emit({ type: "item.created", item_id: item.id, run_id: result.runId, payload: { kind: "info", title: item.title } });
}

// ---------- stats ----------

export interface BriefStats {
  doneToday: number;
  inFlight: number;
  waiting: number;
  stale: number;
  spendToday: number;
  spendCap: number;
  agreement: string;
}

export function briefStats(ctx: HarnessContext): BriefStats {
  const { db, config } = ctx;
  const dayStart = startOfLocalDayIso(new Date(), config.principal.timezone);
  const counts = db.tasks.countByStatus();
  return {
    doneToday: db.tasks.list({ status: "done" }).filter((t) => t.updated_at >= dayStart).length,
    inFlight: (counts.running ?? 0) + (counts.review ?? 0) + (counts.waiting_human ?? 0),
    waiting: db.items.countOpen().total,
    stale: db.items.openOlderThan(config.review.staleAfterHours).length,
    spendToday: db.runs.costSince(dayStart),
    spendCap: config.budget.perDayUsd,
    agreement: formatAgreement(db.decisions.agreementStats()),
  };
}

function formatAgreement(s: ReturnType<HarnessContext["db"]["decisions"]["agreementStats"]>): string {
  if (!s.overall.total) return "no recommendations decided on yet";
  const pct = (r: number | null) => (r == null ? "n/a" : `${Math.round(r * 100)}%`);
  const leads = Object.entries(s.byLead)
    .map(([lead, v]) => `${lead} ${pct(v.rate)} (${v.agreed}/${v.total})`)
    .join(", ");
  return `overall ${pct(s.overall.rate)} (${s.overall.agreed}/${s.overall.total}), last 20: ${pct(s.last20)}${leads ? `; by lead: ${leads}` : ""}`;
}

// ---------- time helpers ----------

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(fmt.formatToParts(date).find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** YYYY-MM-DD in the given time zone. */
export function localDateString(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** ISO timestamp of midnight (local time in `timeZone`) of the day containing `date`. */
export function startOfLocalDayIso(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - offsetMs).toISOString();
}
