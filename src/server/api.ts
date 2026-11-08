import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessContext, Idea, IdeaStatus, ItemKind, ItemStatus, QueueItem, Run, Task, TaskStatus } from "../types.js";
import { brainStats, distillBrain } from "../agents/brain.js";

/**
 * JSON API route handlers for the queue app. Pure functions of (ctx, request) → response;
 * the HTTP layer (http.ts) does parsing, matching, error mapping and SSE.
 */

export interface ApiRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface ApiResponse {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type Handler = (ctx: HarnessContext, req: ApiRequest) => ApiResponse | Promise<ApiResponse>;

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const ITEM_KINDS: ItemKind[] = ["review", "decision", "question", "permission", "idea", "info"];
const TASK_STATUSES: TaskStatus[] = ["inbox", "triaged", "queued", "running", "waiting_human", "review", "done", "rejected", "failed", "parked"];
const EDITABLE_STATUSES: TaskStatus[] = ["inbox", "queued", "triaged", "parked"];
const RETRYABLE_STATUSES: TaskStatus[] = ["failed", "rejected", "parked"];
const UNDO_WINDOW_MS = 60_000;
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const HIDE_FINISHED_AFTER_MS = 7 * 24 * 3600_000;

// ---------- helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bodyOf(req: ApiRequest): Record<string, unknown> {
  if (req.body === undefined || req.body === null) return {};
  if (!isRecord(req.body)) throw new HttpError(400, "Request body must be a JSON object");
  return req.body;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `Field "${key}" must be a string`);
  return v;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const v = optionalString(body, key);
  if (v === undefined || v.trim() === "") throw new HttpError(400, `Field "${key}" is required`);
  return v;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (Number.isNaN(n)) throw new HttpError(400, `Field "${key}" must be a number`);
  return n;
}

function parseLimit(query: URLSearchParams, fallback: number, max = 1000): number {
  const raw = query.get("limit");
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Query parameter "limit" must be a positive integer');
  return Math.min(n, max);
}

function requireTask(ctx: HarnessContext, id: string): Task {
  const task = ctx.db.tasks.get(id);
  if (!task) throw new HttpError(404, `Task ${id} not found`);
  return task;
}

function requireItem(ctx: HarnessContext, id: string): QueueItem {
  const item = ctx.db.items.get(id);
  if (!item) throw new HttpError(404, `Queue item ${id} not found`);
  return item;
}

function requireLead(ctx: HarnessContext, id: string) {
  const lead = ctx.config.leads.find((l) => l.id === id);
  if (!lead) throw new HttpError(400, `Unknown lead "${id}"`);
  return lead;
}

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function ok(json: unknown, status = 200): ApiResponse {
  return { status, json };
}

let cachedVersion: string | null = null;

function packageVersion(ctx: HarnessContext): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch (err) {
    ctx.log.error("could not read package.json version", { err });
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

function enrichItem(ctx: HarnessContext, item: QueueItem): QueueItem & { task_title: string | null; task_status: TaskStatus | null } {
  const task = item.task_id ? ctx.db.tasks.get(item.task_id) : null;
  return { ...item, task_title: task?.title ?? null, task_status: task?.status ?? null };
}

function nextOpenItemId(ctx: HarnessContext, exclude: string): string | null {
  const open = ctx.db.items.list({ status: "open", limit: 2 });
  return open.find((i) => i.id !== exclude)?.id ?? null;
}

function leadRunAgent(leadId: string): string {
  return `lead:${leadId}`;
}

// ---------- state ----------

function getState(ctx: HarnessContext): ApiResponse {
  const { config, db } = ctx;
  return ok({
    principal: config.principal,
    leads: config.leads.map((l) => ({ id: l.id, name: l.name, charter: l.charter, concurrency: l.concurrency, onApprove: l.onApprove, repos: l.repos })),
    counts: {
      tasks: db.tasks.countByStatus(),
      queue: db.items.countOpen(),
      stale: db.items.openOlderThan(config.review.staleAfterHours).length,
    },
    paused: ctx.isPaused(),
    pausedByUser: db.settings.get("paused") === "1",
    costToday: db.runs.costSince(startOfToday()),
    budget: config.budget,
    agreement: db.decisions.agreementStats().last20,
    version: packageVersion(ctx),
  });
}

// ---------- queue ----------

function listQueue(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const status = req.query.get("status") ?? "open";
  let statuses: ItemStatus | ItemStatus[] | undefined;
  if (status === "open") statuses = "open";
  else if (status === "answered") statuses = "answered";
  else if (status === "all") statuses = undefined;
  else throw new HttpError(400, 'Query parameter "status" must be open, answered or all');
  const kind = req.query.get("kind") ?? undefined;
  if (kind && !ITEM_KINDS.includes(kind as ItemKind)) throw new HttpError(400, `Unknown item kind "${kind}"`);
  const lead = req.query.get("lead") ?? undefined;
  const items = ctx.db.items.list({ status: statuses, kind: kind as ItemKind | undefined, lead, limit: parseLimit(req.query, 500), hideDeferred: status === "open" });
  return ok(items.map((i) => enrichItem(ctx, i)));
}

function getQueueItem(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const item = requireItem(ctx, req.params.id);
  const task = item.task_id ? ctx.db.tasks.get(item.task_id) : null;
  const runs = item.task_id ? ctx.db.runs.list({ task_id: item.task_id, limit: 3 }) : [];
  const children = task ? ctx.db.tasks.list({ parent_id: task.id }) : [];
  return ok({ item: enrichItem(ctx, item), task, runs, children });
}

function validateAnswer(item: QueueItem, option: string, comment: string): void {
  if (item.status !== "open") throw new HttpError(409, `Queue item is ${item.status}, not open`);
  const keys = item.options.map((o) => o.key);
  const allowed = keys.includes(option) || (option === "answer" && (item.kind === "question" || keys.length === 0));
  if (!allowed) throw new HttpError(400, `Option "${option}" is not one of: ${keys.join(", ") || "answer"}`);
  if ((option === "answer" || option === "request_changes") && comment.trim() === "") {
    throw new HttpError(400, option === "answer" ? "Please write your answer in the comment" : "Please say what should change");
  }
}

function ideaStatusFor(option: string): IdeaStatus | null {
  switch (option) {
    case "pursue":
      return "pursued";
    case "park":
      return "parked";
    case "discard":
      return "discarded";
    default:
      return null;
  }
}

/** Apply the side effects of an answered idea item: update the idea row and, on pursue, open a task. */
function applyIdeaAnswer(ctx: HarnessContext, item: QueueItem, option: string): QueueItem {
  const ideaId = typeof item.meta.idea_id === "string" ? item.meta.idea_id : null;
  const idea = ideaId ? ctx.db.ideas.get(ideaId) : null;
  if (!idea) {
    ctx.log.warn("idea item without a matching idea row", { item: item.id, idea: ideaId });
    return item;
  }
  const status = ideaStatusFor(option);
  if (status) ctx.db.ideas.update(idea.id, { status });
  if (option !== "pursue") return item;
  const task = ctx.db.tasks.create({ title: idea.title, brief: idea.body, source: "idea", status: "inbox", tags: ["idea"] });
  ctx.bus.emit({ type: "task.created", task_id: task.id, payload: { title: task.title, source: "idea", idea_id: idea.id } });
  return ctx.db.items.update(item.id, { meta: { ...item.meta, pursued_task_id: task.id } }) ?? item;
}

function answerQueueItem(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const body = bodyOf(req);
  const option = requiredString(body, "option");
  const comment = optionalString(body, "comment") ?? "";
  const item = requireItem(ctx, req.params.id);
  validateAnswer(item, option, comment);
  const result = ctx.db.items.answer(item.id, option, comment.trim());
  if (!result) throw new HttpError(409, "Queue item is no longer open");
  let answered = result.item;
  if (item.kind === "idea") answered = applyIdeaAnswer(ctx, answered, option);
  ctx.bus.emit({ type: "item.answered", item_id: item.id, task_id: item.task_id, payload: { option, comment: comment.trim(), kind: item.kind, lead: item.lead } });
  ctx.log.info("queue item answered", { item: item.id, kind: item.kind, option });
  return ok({ item: enrichItem(ctx, answered), decision: result.decision, next: nextOpenItemId(ctx, item.id) });
}

function deferQueueItem(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const body = bodyOf(req);
  const hours = optionalNumber(body, "hours") ?? 24;
  if (hours <= 0 || hours > 24 * 365) throw new HttpError(400, 'Field "hours" must be between 0 and 8760');
  const item = requireItem(ctx, req.params.id);
  if (item.status !== "open") throw new HttpError(409, `Queue item is ${item.status}, not open`);
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  const updated = ctx.db.items.defer(item.id, until) ?? item;
  ctx.bus.emit({ type: "item.updated", item_id: item.id, task_id: item.task_id, payload: { deferred_until: until, hours } });
  return ok({ item: enrichItem(ctx, updated) });
}

/** Reverse the side effects of a pursued idea when its answer is undone. */
function revertIdeaAnswer(ctx: HarnessContext, item: QueueItem): void {
  const ideaId = typeof item.meta.idea_id === "string" ? item.meta.idea_id : null;
  if (ideaId && ctx.db.ideas.get(ideaId)) ctx.db.ideas.update(ideaId, { status: "new" });
  const taskId = typeof item.meta.pursued_task_id === "string" ? item.meta.pursued_task_id : null;
  if (taskId) {
    const task = ctx.db.tasks.get(taskId);
    if (task && task.status === "inbox") {
      ctx.db.db.prepare("DELETE FROM tasks WHERE id = ? AND status = 'inbox'").run(taskId);
      ctx.bus.emit({ type: "task.cancelled", task_id: taskId, payload: { reason: "idea answer undone", deleted: true } });
    }
    const { pursued_task_id: _removed, ...meta } = item.meta;
    ctx.db.items.update(item.id, { meta });
  }
}

function undoQueueItem(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const item = requireItem(ctx, req.params.id);
  if (item.status !== "answered") throw new HttpError(409, "Only an answered item can be undone");
  const answeredAt = item.answered_at ? Date.parse(item.answered_at) : NaN;
  if (Number.isNaN(answeredAt) || Date.now() - answeredAt > UNDO_WINDOW_MS) throw new HttpError(409, "The undo window of 60 seconds has passed");
  if (item.meta.applied) throw new HttpError(409, "This answer has already been acted on and cannot be undone");
  if (!ctx.db.items.undo(item.id)) throw new HttpError(409, "Nothing to undo");
  if (item.kind === "idea") revertIdeaAnswer(ctx, item);
  ctx.bus.emit({ type: "item.undone", item_id: item.id, task_id: item.task_id, payload: { kind: item.kind, lead: item.lead, previous: item.answer } });
  ctx.log.info("queue item answer undone", { item: item.id });
  return ok({ item: enrichItem(ctx, requireItem(ctx, item.id)) });
}

// ---------- tasks ----------

function parseStatusList(raw: string | null): TaskStatus[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) if (!TASK_STATUSES.includes(p as TaskStatus)) throw new HttpError(400, `Unknown task status "${p}"`);
  return parts as TaskStatus[];
}

function openItemCounts(ctx: HarnessContext): Map<string, number> {
  const rows = ctx.db.db.prepare("SELECT task_id, COUNT(*) AS n FROM queue_items WHERE status = 'open' AND task_id IS NOT NULL GROUP BY task_id").all() as { task_id: string; n: number }[];
  return new Map(rows.map((r) => [r.task_id, r.n]));
}

function latestRunStatuses(ctx: HarnessContext): Map<string, { id: string; status: string; started_at: string }> {
  const rows = ctx.db.db
    .prepare(
      `SELECT r.task_id, r.id, r.status, r.started_at FROM runs r
       WHERE r.task_id IS NOT NULL AND r.started_at = (SELECT MAX(started_at) FROM runs WHERE task_id = r.task_id)`,
    )
    .all() as { task_id: string; id: string; status: string; started_at: string }[];
  return new Map(rows.map((r) => [r.task_id, { id: r.id, status: r.status, started_at: r.started_at }]));
}

function isStaleFinished(task: Task, cutoffMs: number): boolean {
  return (task.status === "done" || task.status === "rejected" || task.status === "parked") && Date.parse(task.updated_at) < cutoffMs;
}

function listTasks(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const statuses = parseStatusList(req.query.get("status"));
  const lead = req.query.get("lead") ?? undefined;
  let tasks = ctx.db.tasks.list({ status: statuses, lead, limit: parseLimit(req.query, 500, 2000) });
  if (!statuses) {
    const cutoff = Date.now() - HIDE_FINISHED_AFTER_MS;
    tasks = tasks.filter((t) => !isStaleFinished(t, cutoff));
  }
  const openItems = openItemCounts(ctx);
  const lastRuns = latestRunStatuses(ctx);
  return ok(tasks.map((t) => ({ ...t, open_items: openItems.get(t.id) ?? 0, last_run: lastRuns.get(t.id) ?? null })));
}

function createTask(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const body = bodyOf(req);
  const title = requiredString(body, "title").trim();
  const brief = optionalString(body, "brief") ?? "";
  const leadId = optionalString(body, "lead");
  const repo = optionalString(body, "repo");
  const priority = optionalNumber(body, "priority");
  if (priority !== undefined && (priority < 1 || priority > 5)) throw new HttpError(400, 'Field "priority" must be between 1 and 5');
  if (repo && !leadId) throw new HttpError(400, "A repo can only be set together with a lead");
  if (leadId) {
    const lead = requireLead(ctx, leadId);
    if (repo && !lead.repos.includes(repo)) throw new HttpError(400, `Repo "${repo}" is not one of the repos of lead "${lead.id}"`);
  }
  const task = ctx.db.tasks.create({ title, brief, source: "ui", lead: leadId ?? null, priority, repo: repo ?? null, status: leadId ? "queued" : "inbox" });
  ctx.bus.emit({ type: "task.created", task_id: task.id, payload: { title: task.title, source: "ui", lead: task.lead, status: task.status } });
  ctx.log.info("task created", { task: task.id, lead: task.lead });
  return ok(task, 201);
}

function getTask(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const task = requireTask(ctx, req.params.id);
  return ok({
    task,
    runs: ctx.db.runs.list({ task_id: task.id, limit: 20 }),
    items: ctx.db.items.list({ task_id: task.id, hideDeferred: false }),
    children: ctx.db.tasks.list({ parent_id: task.id }),
    events: ctx.db.events.latest(50, task.id),
  });
}

function cancelTask(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const task = requireTask(ctx, req.params.id);
  // Final status first, then abort the run: the lead loop leaves a task alone once it is no longer "running".
  let updated = task;
  if (task.status !== "done") updated = ctx.db.tasks.setStatus(task.id, "rejected", { result_summary: "cancelled by principal" }) ?? task;
  const cancelledRuns = ctx.runner.cancelTask(task.id);
  const withdrawn = ctx.db.items.withdrawForTask(task.id, "task cancelled");
  ctx.bus.emit({ type: "task.cancelled", task_id: task.id, payload: { previous: task.status, runs: cancelledRuns, withdrawn } });
  ctx.log.info("task cancelled", { task: task.id, runs: cancelledRuns, withdrawn });
  return ok({ task: updated, cancelledRuns, withdrawnItems: withdrawn });
}

function retryTask(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const task = requireTask(ctx, req.params.id);
  if (!RETRYABLE_STATUSES.includes(task.status)) throw new HttpError(409, `A task in status "${task.status}" cannot be retried`);
  const status: TaskStatus = task.lead ? "queued" : "inbox";
  const updated = ctx.db.tasks.setStatus(task.id, status, { result_summary: null }) ?? task;
  ctx.bus.emit({ type: "task.status", task_id: task.id, payload: { status, previous: task.status, reason: "retry" } });
  ctx.log.info("task retried", { task: task.id, status });
  return ok({ task: updated });
}

function patchTask(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const body = bodyOf(req);
  const task = requireTask(ctx, req.params.id);
  if (!EDITABLE_STATUSES.includes(task.status)) throw new HttpError(409, `A task in status "${task.status}" cannot be edited`);
  const patch: Partial<Task> = {};
  const priority = optionalNumber(body, "priority");
  if (priority !== undefined) {
    if (priority < 1 || priority > 5) throw new HttpError(400, 'Field "priority" must be between 1 and 5');
    patch.priority = priority;
  }
  const leadId = optionalString(body, "lead");
  if (leadId !== undefined) {
    if (leadId === "") patch.lead = null;
    else patch.lead = requireLead(ctx, leadId).id;
  }
  const title = optionalString(body, "title");
  if (title !== undefined) {
    if (title.trim() === "") throw new HttpError(400, "Title cannot be empty");
    patch.title = title.trim();
  }
  const brief = optionalString(body, "brief");
  if (brief !== undefined) patch.brief = brief;
  if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to change: send priority, lead, title or brief");
  if (patch.lead && task.status === "inbox") patch.status = "queued";
  const updated = ctx.db.tasks.update(task.id, patch) ?? task;
  ctx.bus.emit({ type: "task.status", task_id: task.id, payload: { status: updated.status, previous: task.status, changed: Object.keys(patch) } });
  return ok({ task: updated });
}

// ---------- agents ----------

function costTodayFor(ctx: HarnessContext, agent: string): number {
  const r = ctx.db.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE agent = ? AND started_at >= ?").get(agent, startOfToday()) as { c: number } | undefined;
  return r?.c ?? 0;
}

function getAgents(ctx: HarnessContext): ApiResponse {
  const active = ctx.runner.active();
  const activeByTask = new Map(active.filter((a) => a.taskId).map((a) => [a.taskId as string, a]));
  const leads = ctx.config.leads.map((lead) => {
    const agent = leadRunAgent(lead.id);
    const running = ctx.db.tasks.list({ lead: lead.id, status: "running" }).map((t) => {
      const run = activeByTask.get(t.id);
      return { ...t, runId: run?.runId ?? null, startedAt: run?.startedAt ?? null, lastActivity: run?.lastActivity ?? null, lastText: run?.lastText ?? "" };
    });
    return {
      id: lead.id,
      name: lead.name,
      concurrency: lead.concurrency,
      running,
      queued: ctx.db.tasks.list({ lead: lead.id, status: "queued" }).length,
      waiting: ctx.db.tasks.list({ lead: lead.id, status: "waiting_human" }).length,
      review: ctx.db.tasks.list({ lead: lead.id, status: "review" }).length,
      costToday: costTodayFor(ctx, agent),
      active: active.filter((a) => a.agent === agent),
    };
  });
  return ok({
    chief: { lastRun: ctx.db.runs.list({ agent: "chief", limit: 1 })[0] ?? null, active: active.filter((a) => a.agent === "chief"), costToday: costTodayFor(ctx, "chief") },
    leads,
    brain: { active: active.filter((a) => a.agent === "brain"), costToday: costTodayFor(ctx, "brain") },
  });
}

// ---------- brain ----------

function readBrainDoc(ctx: HarnessContext): string {
  try {
    return fs.readFileSync(ctx.config.paths.brainDoc, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") ctx.log.error("could not read the brain document", { err });
    return "";
  }
}

function writeBrainDocAtomically(ctx: HarnessContext, content: string): void {
  const file = ctx.config.paths.brainDoc;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function getBrain(ctx: HarnessContext): ApiResponse {
  return ok({
    content: readBrainDoc(ctx),
    stats: brainStats(ctx),
    versions: ctx.db.brain.versions(20).map((v) => ({ id: v.id, created_at: v.created_at, decisions_covered: v.decisions_covered, notes: v.notes, length: v.content.length })),
  });
}

function getBrainStats(ctx: HarnessContext): ApiResponse {
  return ok(brainStats(ctx));
}

function getBrainVersion(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const v = ctx.db.brain.get(req.params.id);
  if (!v) throw new HttpError(404, `Brain version ${req.params.id} not found`);
  return ok(v);
}

function putBrain(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const body = bodyOf(req);
  const content = optionalString(body, "content");
  if (content === undefined) throw new HttpError(400, 'Field "content" is required');
  writeBrainDocAtomically(ctx, content);
  const version = ctx.db.brain.saveVersion(content, 0, "edited by principal");
  ctx.bus.emit({ type: "brain.updated", payload: { version: version.id, source: "principal", length: content.length } });
  ctx.log.info("brain document edited by principal", { version: version.id });
  return ok({ version: { id: version.id, created_at: version.created_at, decisions_covered: version.decisions_covered, notes: version.notes, length: content.length } });
}

async function postBrainDistill(ctx: HarnessContext): Promise<ApiResponse> {
  const result = await distillBrain(ctx, { force: true });
  return ok(result);
}

// ---------- ideas, events, decisions, runs ----------

function listIdeas(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const ideas: Idea[] = ctx.db.ideas.list({ limit: parseLimit(req.query, 200) });
  return ok(ideas);
}

function listEvents(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const since = req.query.get("since");
  const limit = parseLimit(req.query, 100, 1000);
  if (since === null || since === "") return ok(ctx.db.events.latest(limit));
  const id = Number(since);
  if (!Number.isInteger(id) || id < 0) throw new HttpError(400, 'Query parameter "since" must be an event id');
  return ok(ctx.db.events.since(id, limit));
}

function listDecisions(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const decisions = ctx.db.decisions.list({ limit: parseLimit(req.query, 100, 1000) });
  return ok(
    decisions.map((d) => {
      const item = ctx.db.items.get(d.item_id);
      return { ...d, item_title: item?.title ?? null, task_title: d.task_id ? (ctx.db.tasks.get(d.task_id)?.title ?? null) : null };
    }),
  );
}

function readLogTail(file: string): string {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function getRunLog(ctx: HarnessContext, req: ApiRequest): ApiResponse {
  const run: Run | null = ctx.db.runs.get(req.params.id);
  if (!run) throw new HttpError(404, `Run ${req.params.id} not found`);
  if (!run.log_path || !fs.existsSync(run.log_path)) throw new HttpError(404, "This run has no transcript on disk");
  return { status: 200, text: readLogTail(run.log_path), contentType: "text/plain; charset=utf-8" };
}

// ---------- pause / resume ----------

function pause(ctx: HarnessContext): ApiResponse {
  ctx.db.settings.set("paused", "1");
  ctx.bus.emit({ type: "harness.paused", payload: { by: "principal" } });
  ctx.log.info("harness paused by principal");
  return ok({ paused: true });
}

function resume(ctx: HarnessContext): ApiResponse {
  ctx.db.settings.set("paused", "0");
  ctx.bus.emit({ type: "harness.resumed", payload: { by: "principal" } });
  ctx.log.info("harness resumed by principal");
  return ok({ paused: ctx.isPaused() });
}

// ---------- routing table ----------

function route(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { method, pattern: new RegExp(`^${source}/?$`), keys, handler };
}

export const apiRoutes: Route[] = [
  route("GET", "/api/state", getState),
  route("GET", "/api/queue", listQueue),
  route("GET", "/api/queue/:id", getQueueItem),
  route("POST", "/api/queue/:id/answer", answerQueueItem),
  route("POST", "/api/queue/:id/defer", deferQueueItem),
  route("POST", "/api/queue/:id/undo", undoQueueItem),
  route("GET", "/api/tasks", listTasks),
  route("POST", "/api/tasks", createTask),
  route("GET", "/api/tasks/:id", getTask),
  route("POST", "/api/tasks/:id/cancel", cancelTask),
  route("POST", "/api/tasks/:id/retry", retryTask),
  route("PATCH", "/api/tasks/:id", patchTask),
  route("GET", "/api/agents", getAgents),
  route("GET", "/api/brain", getBrain),
  route("GET", "/api/brain/stats", getBrainStats),
  route("GET", "/api/brain/versions/:id", getBrainVersion),
  route("PUT", "/api/brain", putBrain),
  route("POST", "/api/brain/distill", postBrainDistill),
  route("GET", "/api/ideas", listIdeas),
  route("GET", "/api/events", listEvents),
  route("GET", "/api/decisions", listDecisions),
  route("GET", "/api/runs/:id/log", getRunLog),
  route("POST", "/api/pause", pause),
  route("POST", "/api/resume", resume),
];

/** Find the route for a request. Returns null when nothing matches (→ 404). */
export function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const r of apiRoutes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]);
    });
    return { route: r, params };
  }
  return null;
}

/** True when some route has this path with a different method (→ 405 rather than 404). */
export function pathExists(pathname: string): boolean {
  return apiRoutes.some((r) => r.pattern.test(pathname));
}
