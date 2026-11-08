import fs from "node:fs";
import path from "node:path";
import type { BrainVersion, Decision, HarnessContext, Loop, QueueItem } from "../types.js";
import type { Store } from "../store/db.js";
import { BRAIN_OUTPUT_SCHEMA, brainDistillPrompt, brainSystemPrompt, onboardingQuestion, readBrain } from "./prompts.js";

/**
 * Principal brain: turns the human's decisions and comments into a preferences document
 * (brain/principal.md) that every agent prompt carries. The distiller rewrites it conservatively;
 * every version is kept in the store and a changelog sits next to the document.
 */

const LOOP_INTERVAL_MS = 60_000;
const MIN_DOC_CHARS = 200;
const MIN_DOC_RATIO = 0.25;
const SETTING_BACKOFF = "distill_backoff_until";
const FAILURE_BACKOFF_MS = 30 * 60_000;
const DECISION_BATCH = 60;

const SETTING_ONBOARDING = "onboarding_posted";
const SETTING_LAST_DISTILL = "last_distill_at";

export interface DistillResult {
  changed: boolean;
  version?: BrainVersion;
  changelog?: string;
  reason?: string;
}

export interface BrainStats {
  agreement: ReturnType<Store["decisions"]["agreementStats"]>;
  undistilled: number;
  versions: number;
  lastDistilled: string | null;
  lastChangelog: string | null;
}

interface DistillOutput {
  document: string;
  changelog: string;
  confidence: "low" | "medium" | "high";
}

// ---------- onboarding ----------

/** Post the one-time onboarding question that seeds the brain from the principal's own words. */
export function ensureOnboarding(ctx: HarnessContext): void {
  const { db, bus, config } = ctx;
  if (db.settings.get(SETTING_ONBOARDING) === "1") return;
  const q = onboardingQuestion(config);
  const item = db.items.create({
    kind: "question",
    title: q.title,
    body: q.body,
    options: [{ key: "answer", label: "Answer in the comment box" }],
    priority: 2,
    meta: { onboarding: true },
  });
  db.settings.set(SETTING_ONBOARDING, "1");
  bus.emit({ type: "item.created", item_id: item.id, payload: { kind: "question", title: item.title } });
  ctx.log.child("brain").info(`onboarding question posted (${item.id})`);
}

// ---------- distillation ----------

let inFlight: Promise<DistillResult> | null = null;

/** Rewrite the brain document from undistilled decisions. Concurrent calls share one run. */
export function distillBrain(ctx: HarnessContext, opts: { force?: boolean } = {}): Promise<DistillResult> {
  if (inFlight) return inFlight;
  inFlight = distillOnce(ctx, opts.force === true).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function distillOnce(ctx: HarnessContext, force: boolean): Promise<DistillResult> {
  const { db, config } = ctx;
  const log = ctx.log.child("brain");
  const all = db.decisions.list({ undistilledOnly: true, limit: DECISION_BATCH });
  const meaningful = new Set(db.decisions.list({ undistilledOnly: true, meaningfulOnly: true, limit: DECISION_BATCH }).map((d) => d.id));
  const decisions = all.filter((d) => meaningful.has(d.id));
  const lowSignal = all.filter((d) => !meaningful.has(d.id));
  if (lowSignal.length) db.decisions.markDistilled(lowSignal.map((d) => d.id));
  if (!decisions.length && !force) return { changed: false, reason: lowSignal.length ? "only low-signal decisions since the last distillation" : "nothing new" };

  const pairs = decisions.map((decision) => ({ decision, item: db.items.get(decision.item_id) }));
  const current = readBrain(config);
  log.info(`distilling ${decisions.length} decision(s)`, { force });

  const result = await ctx.runner.run({
    agent: "brain",
    prompt: brainDistillPrompt(config, current, pairs),
    systemPrompt: brainSystemPrompt(config),
    cwd: config.paths.root,
    model: config.models.brain,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    permissionMode: "default",
    settingSources: [],
    maxTurns: 6,
    maxBudgetUsd: 2,
    outputSchema: BRAIN_OUTPUT_SCHEMA,
    effort: "high",
  });
  if (result.status !== "success") {
    const reason = `distiller run ${result.status}: ${result.errors.join("; ") || "no result"}`;
    log.error(reason, { run: result.runId });
    db.settings.set(SETTING_BACKOFF, new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString());
    return { changed: false, reason };
  }

  const output = parseOutput(result.structured);
  if (!output) {
    log.error("distiller returned no usable document", { run: result.runId });
    db.settings.set(SETTING_BACKOFF, new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString());
    return { changed: false, reason: "distiller returned no usable document" };
  }
  const tooShort = rejectIfTooShort(output.document, current);
  if (tooShort) {
    log.warn(tooShort, { run: result.runId, length: output.document.length, current: current.length });
    db.settings.set(SETTING_BACKOFF, new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString());
    return { changed: false, reason: tooShort };
  }

  return applyDistillation(ctx, { current, output, decisions, pairs });
}

function parseOutput(raw: unknown): DistillOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.document !== "string" || typeof o.changelog !== "string") return null;
  const confidence = o.confidence === "low" || o.confidence === "medium" || o.confidence === "high" ? o.confidence : "low";
  return { document: o.document, changelog: o.changelog, confidence };
}

function rejectIfTooShort(doc: string, current: string): string | null {
  const len = doc.trim().length;
  if (len < MIN_DOC_CHARS) return `rejected: new document is only ${len} characters`;
  if (current.trim().length && len < current.trim().length * MIN_DOC_RATIO) return `rejected: new document (${len} chars) is less than ${Math.round(MIN_DOC_RATIO * 100)}% of the current one (${current.trim().length} chars)`;
  return null;
}

function applyDistillation(ctx: HarnessContext, args: { current: string; output: DistillOutput; decisions: Decision[]; pairs: { decision: Decision; item: QueueItem | null }[] }): DistillResult {
  const { db, bus, config } = ctx;
  const log = ctx.log.child("brain");
  const { current, output, decisions } = args;
  const doc = output.document.endsWith("\n") ? output.document : `${output.document}\n`;
  const now = new Date().toISOString();

  if (!db.brain.latest() && current.trim()) db.brain.saveVersion(current, 0, "seed");
  writeAtomic(config.paths.brainDoc, doc);
  fs.appendFileSync(path.join(config.paths.brain, "changelog.md"), `## ${now} (${output.confidence})\n${output.changelog.trim()}\n\n`);
  const version = db.brain.saveVersion(doc, decisions.length, output.changelog);
  db.decisions.markDistilled(decisions.map((d) => d.id));
  db.settings.set(SETTING_LAST_DISTILL, now);
  bus.emit({ type: "brain.updated", payload: { version: version.id, decisions: decisions.length, confidence: output.confidence } });
  log.info(`brain updated (${version.id})`, { decisions: decisions.length, confidence: output.confidence, chars: doc.length });
  return { changed: true, version, changelog: output.changelog };
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

// ---------- scheduler ----------

export function startBrainLoop(ctx: HarnessContext): Loop {
  const log = ctx.log.child("brain");
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<unknown> | null = null;

  function track(p: Promise<unknown>): void {
    current = p.finally(() => {
      current = null;
    });
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => void tick(), LOOP_INTERVAL_MS);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      if (!ctx.isPaused() && !current && distillIsDue(ctx)) {
        const p = distillBrain(ctx);
        track(p);
        await p;
      }
    } catch (err) {
      log.error("scheduled distillation failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      schedule();
    }
  }

  const offAnswered = ctx.bus.on("item.answered", (ev) => {
    if (stopped || !ev.item_id) return;
    const item = ctx.db.items.get(ev.item_id);
    if (item?.meta.onboarding !== true) return;
    log.info("onboarding answered; seeding the brain now");
    const p = distillBrain(ctx, { force: true }).catch((err: unknown) => {
      log.error("onboarding distillation failed", { error: err instanceof Error ? err.message : String(err) });
    });
    track(p);
  });

  schedule();
  log.info("brain loop started");
  return {
    name: "brain",
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      offAnswered();
      if (current) await current;
      log.info("brain loop stopped");
    },
  };
}

function distillIsDue(ctx: HarnessContext): boolean {
  const { db, config } = ctx;
  // After a failed or rejected distillation, wait before spending on another attempt.
  const backoff = db.settings.get(SETTING_BACKOFF);
  if (backoff && Date.parse(backoff) > Date.now()) return false;
  const undistilled = db.decisions.countUndistilled(true);
  if (undistilled >= config.brain.distillEveryDecisions) return true;
  if (undistilled < 1) return false;
  const last = db.settings.get(SETTING_LAST_DISTILL);
  if (!last) return true;
  const age = Date.now() - Date.parse(last);
  return Number.isNaN(age) || age >= config.brain.distillIntervalMin * 60_000;
}

// ---------- stats ----------

export function brainStats(ctx: HarnessContext): BrainStats {
  const { db } = ctx;
  const latest = db.brain.latest();
  const count = db.db.prepare("SELECT COUNT(*) AS n FROM brain_versions").get() as { n: number } | undefined;
  return {
    agreement: db.decisions.agreementStats(),
    undistilled: db.decisions.countUndistilled(true),
    versions: count?.n ?? 0,
    lastDistilled: db.settings.get(SETTING_LAST_DISTILL),
    lastChangelog: latest?.notes ?? null,
  };
}
