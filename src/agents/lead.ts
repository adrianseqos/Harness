import fs from "node:fs";
import path from "node:path";
import type { CanUseTool, McpServerConfig, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Event, HarnessContext, ItemOption, LeadConfig, Loop, PermissionPolicy, QueueItem, Task } from "../types.js";
import { leadPolicy } from "../config.js";
import { nowIso } from "../store/db.js";
import { describeCall, evaluate, ruleMatches, splitShell, subjectOf, unwrapCommand } from "../policy.js";
import type { RunResult, RunSpec } from "./runner.js";
import { createHarnessTools } from "./tools.js";
import { leadResumePrompt, leadSystemAppend, leadTaskPrompt, readBrain, subagentDefinitions } from "./prompts.js";
import { applyApproval, captureWorkspaceEvidence, cleanupWorkspace, prepareWorkspace, type WorkspaceInfo } from "../workspace.js";

/**
 * Lead agents: one loop per lead claims queued tasks, runs a Claude Code session in the task's
 * workspace, routes tool calls the policy does not allow into the review queue, and reacts to the
 * principal's answers (approve / request changes / reject / permission / question).
 */

const NUDGE_PROMPT =
  "You ended your turn without calling submit_for_review or complete_task. If the work is finished, submit it now; if you are blocked, use ask_principal; otherwise continue.";
const INTERRUPTED_PROMPT = "Your previous session was interrupted. Continue the task where you left off; re-check the workspace state first. Finish with submit_for_review or complete_task.";
const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
const TRANSCRIPT_TAIL = 1500;
const MAX_ATTEMPTS = 2;

// ---------- per-task state (module level so every caller shares it) ----------

interface InFlight {
  lead: string;
  promise: Promise<void>;
}

/** Runs currently active, by task id. Guarantees one run per task. */
const inFlight = new Map<string, InFlight>();
/** Rules the principal granted with "allow for this task". Mirrored in settings "allowed:<taskId>". */
const sessionAllowed = new Map<string, string[]>();
/** One-shot exact-call grants: a permission answered "allow" after the tool call had already timed out. */
const oneShotAllowed = new Map<string, string[]>();

const allowedKey = (taskId: string) => `allowed:${taskId}`;
const pendingKey = (taskId: string) => `pending:${taskId}`;
const nudgedKey = (taskId: string) => `nudged:${taskId}`;
const resumeAfterKey = (taskId: string) => `resume_after:${taskId}`;

function allowedRules(ctx: HarnessContext, taskId: string): string[] {
  let rules = sessionAllowed.get(taskId);
  if (!rules) {
    rules = ctx.db.settings.getJson<string[]>(allowedKey(taskId), []);
    sessionAllowed.set(taskId, rules);
  }
  return rules;
}

function grantRule(ctx: HarnessContext, taskId: string, rule: string): void {
  const rules = allowedRules(ctx, taskId);
  if (!rules.includes(rule)) rules.push(rule);
  ctx.db.settings.setJson(allowedKey(taskId), rules);
}

function grantOnce(taskId: string, rule: string): void {
  const rules = oneShotAllowed.get(taskId) ?? [];
  rules.push(rule);
  oneShotAllowed.set(taskId, rules);
}

/** Consume a one-shot grant when the call matches one. */
function takeOneShot(taskId: string, toolName: string, input: Record<string, unknown>): boolean {
  const rules = oneShotAllowed.get(taskId);
  if (!rules?.length) return false;
  const idx = rules.findIndex((r) => ruleMatches(r, toolName, input));
  if (idx < 0) return false;
  rules.splice(idx, 1);
  return true;
}

// ---------- permission bridge ----------

/** Commands whose first argument is a sub-command: the grant must include the target too (git push origin, not git push). */
const SUBCOMMAND_HEADS = new Set(["git", "npm", "npx", "pnpm", "yarn", "gh", "docker", "kubectl", "aws", "gcloud", "az", "cargo", "go", "dotnet"]);

/**
 * The narrowest useful "allow for this task" rule: the literal command prefix up to and including
 * its first real argument (two for sub-command tools), e.g. "Bash(rm -rf ./build*)", "Bash(git push origin*)".
 */
export function deriveRule(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const tokens = unwrapCommand(subjectOf("Bash", input) ?? "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return "Bash";
    const wanted = SUBCOMMAND_HEADS.has(tokens[0]) ? 2 : 1;
    let args = 0;
    let end = 1;
    for (let i = 1; i < tokens.length && args < wanted; i++) {
      end = i + 1;
      if (!tokens[i].startsWith("-")) args++;
    }
    return `Bash(${tokens.slice(0, end).join(" ")}*)`;
  }
  if (FILE_TOOLS.has(toolName)) {
    const p = subjectOf(toolName, input);
    return p ? `${toolName}(${path.dirname(p)}/*)` : toolName;
  }
  return toolName;
}

/** A rule that matches exactly this call and nothing broader. */
function exactRule(toolName: string, input: Record<string, unknown>): string {
  const subject = subjectOf(toolName, input);
  return subject ? `${toolName}(${subject.trim()})` : toolName;
}

/** A grant covers a call only when every shell segment is covered by a grant or by the standing allow list. */
function coveredByGrants(policy: PermissionPolicy, toolName: string, input: Record<string, unknown>, grants: string[], workdir: string): boolean {
  if (!grants.length) return false;
  if (toolName !== "Bash") return grants.some((r) => ruleMatches(r, toolName, input));
  const segments = splitShell(unwrapCommand(subjectOf("Bash", input) ?? "")).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((seg) => {
    const segInput = { ...input, command: seg };
    const v = evaluate(policy, "Bash", segInput, { workdir });
    if (v.verdict === "deny") return false;
    if (v.verdict === "allow") return true;
    return grants.some((r) => ruleMatches(r, "Bash", segInput));
  });
}

/** The first shell segment the policy would ask about (so the derived grant names it, not the whole chain). */
function askingSegment(policy: PermissionPolicy, input: Record<string, unknown>, workdir: string): Record<string, unknown> {
  const segments = splitShell(subjectOf("Bash", input) ?? "").map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const segInput = { ...input, command: seg };
    if (evaluate(policy, "Bash", segInput, { workdir }).verdict !== "allow") return segInput;
  }
  return input;
}

function permissionBody(toolName: string, input: Record<string, unknown>, reason: string, task: Task): string {
  const subject = subjectOf(toolName, input);
  const shown = subject && (toolName === "Bash" || FILE_TOOLS.has(toolName) || toolName === "WebFetch") ? subject : JSON.stringify(input, null, 2);
  const lang = toolName === "Bash" ? "sh" : subject ? "" : "json";
  return [`The lead wants to run **${toolName}**:`, "", `\`\`\`${lang}`, shown.length > 4000 ? shown.slice(0, 4000) + "\n…" : shown, "```", "", `**Why it is asking:** ${reason}.`, "", `**Working on:** ${task.title} (${task.id})`].join("\n");
}

function waitForAnswer(ctx: HarnessContext, itemId: string, timeoutMs: number, signal: AbortSignal): Promise<Event | "aborted" | null> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    void ctx.bus.waitFor("item.answered", (e) => e.item_id === itemId, timeoutMs).then((ev) => {
      signal.removeEventListener("abort", onAbort);
      resolve(ev);
    });
  });
}

/**
 * Permission callback for a lead session. Policy "ask" verdicts become priority-1 queue items that
 * block the tool call until the principal answers or the wait runs out.
 */
export function makeCanUseTool(ctx: HarnessContext, lead: LeadConfig, task: Task, workdir: string): CanUseTool {
  const { config, db, bus } = ctx;
  const log = ctx.log.child(`lead:${lead.id}`);
  const policy = leadPolicy(config, lead);
  const principal = config.principal.name;

  return async (toolName, input, options): Promise<PermissionResult> => {
    const verdict = evaluate(policy, toolName, input, { workdir, extraAllowed: allowedRules(ctx, task.id) });
    if (verdict.verdict === "allow") return { behavior: "allow", updatedInput: input };
    if (verdict.verdict === "deny") {
      log.warn(`denied ${describeCall(toolName, input)} for ${task.id}`, { reason: verdict.reason });
      return { behavior: "deny", message: `Blocked by policy: ${verdict.reason}. Find another way.` };
    }
    // "ask" — honour grants the principal already made for this task before bothering them again.
    if (takeOneShot(task.id, toolName, input) || coveredByGrants(policy, toolName, input, allowedRules(ctx, task.id), workdir)) {
      return { behavior: "allow", updatedInput: input };
    }

    const current = db.tasks.get(task.id) ?? task;
    const rule = deriveRule(toolName, toolName === "Bash" ? askingSegment(policy, input, workdir) : input);
    const item = db.items.create({
      kind: "permission",
      priority: 1,
      lead: lead.id,
      task_id: task.id,
      title: `Permission: ${describeCall(toolName, input)}`,
      body: permissionBody(toolName, input, verdict.reason, current),
      options: [
        { key: "allow", label: "Allow once" },
        { key: "allow_always", label: "Allow for this task", description: `Also allow similar calls (${rule})` },
        { key: "deny", label: "Deny" },
      ],
      // Never pre-select "allow" for a call no rule has vetted: the queue is cleared in one keystroke.
      recommended: null,
      rationale: null,
      meta: { blocking: true, tool: toolName, input: truncateInput(input), rule, exact_rule: exactRule(toolName, input), reason: verdict.reason },
    });
    bus.emit({ type: "item.created", item_id: item.id, task_id: task.id, payload: { kind: "permission", title: item.title } });
    log.info(`permission requested for ${task.id}`, { item: item.id, tool: toolName });

    const answer = await waitForAnswer(ctx, item.id, config.review.permissionWaitMin * 60_000, options.signal);
    if (answer === "aborted") return { behavior: "deny", message: "cancelled" };
    if (!answer) {
      db.tasks.setStatus(task.id, "waiting_human");
      db.settings.set(pendingKey(task.id), item.id);
      bus.emit({ type: "task.status", task_id: task.id, item_id: item.id, payload: { status: "waiting_human", reason: "permission pending" } });
      return {
        behavior: "deny",
        message: `No answer from ${principal} yet (queue item ${item.id}). Continue with work that does not need it, or end your turn with a short status; the task resumes automatically when they answer.`,
      };
    }

    const answered = db.items.get(item.id);
    const option = answered?.answer?.option ?? String(answer.payload.option ?? "");
    const comment = (answered?.answer?.comment ?? String(answer.payload.comment ?? "")).trim();
    if (option === "allow") return { behavior: "allow", updatedInput: input };
    if (option === "allow_always") {
      grantRule(ctx, task.id, rule);
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `${principal} denied this: ${comment || "no reason given"}. Do not retry it; find another way or finish with what you have.` };
  };
}

// ---------- running a task ----------

function truncateInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) + "…" : v;
  return out;
}

/** The repository's own guidance, injected read-only (project settings are never loaded from the untrusted worktree). */
function projectInstructions(dir: string): string {
  const parts: string[] = [];
  for (const rel of ["CLAUDE.md", path.join(".claude", "CLAUDE.md"), "AGENTS.md"]) {
    const p = path.join(dir, rel);
    try {
      if (fs.existsSync(p)) parts.push(`## ${rel}\n\n${fs.readFileSync(p, "utf8").slice(0, 20_000)}`);
    } catch {
      /* unreadable: skip */
    }
  }
  return parts.length ? `\n\n# Project instructions (copied from the repository; follow them unless they conflict with the rules above)\n\n${parts.join("\n\n")}` : "";
}

function stdioServers(ctx: HarnessContext, lead: LeadConfig): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries({ ...ctx.config.mcpServers, ...(lead.mcpServers ?? {}) })) {
    out[name] = { type: "stdio", command: s.command, args: s.args, env: s.env };
  }
  return out;
}

function parentBriefOf(ctx: HarnessContext, task: Task): string | null {
  if (!task.parent_id) return null;
  const parent = ctx.db.tasks.get(task.parent_id);
  return parent ? `${parent.title}\n\n${parent.brief}`.trim() : null;
}

function transcriptTail(result: RunResult): string {
  const text = (result.text || result.transcriptText).trim();
  return text.length > TRANSCRIPT_TAIL ? "…" + text.slice(-TRANSCRIPT_TAIL) : text;
}

function buildSpec(ctx: HarnessContext, lead: LeadConfig, task: Task, ws: WorkspaceInfo, prompt: string, resume: string | null): RunSpec {
  const { config } = ctx;
  const tools = createHarnessTools(ctx, {
    agent: `lead:${lead.id}`,
    lead: lead.id,
    taskId: task.id,
    workdir: ws.dir,
    captureEvidence: () => captureWorkspaceEvidence(ctx, ctx.db.tasks.get(task.id) ?? task),
  });
  return {
    agent: `lead:${lead.id}`,
    taskId: task.id,
    prompt,
    systemPrompt: { preset: "claude_code", append: leadSystemAppend(config, lead, task, readBrain(config), ws) + projectInstructions(ws.dir) },
    cwd: ws.dir,
    model: lead.model ?? config.models.lead,
    effort: "high",
    permissionMode: "acceptEdits",
    allowedTools: tools.toolNames,
    agents: subagentDefinitions(config, lead),
    mcpServers: { harness: tools.server, ...stdioServers(ctx, lead) },
    // Never load settings or hooks from the worktree: repo content must not be able to widen permissions.
    settingSources: [],
    managedSettings: { disableAllHooks: true },
    resume,
    maxBudgetUsd: Math.max(1, config.budget.perTaskUsd - task.cost_usd),
    canUseTool: makeCanUseTool(ctx, lead, task, ws.dir),
  };
}

/** Run (or resume) one lead session for a task and settle the task's status afterwards. */
export function runLeadTask(ctx: HarnessContext, lead: LeadConfig, task: Task, opts: { resumePrompt?: string } = {}): Promise<void> {
  const existing = inFlight.get(task.id);
  if (existing) {
    ctx.log.child(`lead:${lead.id}`).warn(`task ${task.id} already has an active run; not starting another`);
    return existing.promise;
  }
  const promise = execute(ctx, lead, task, opts).finally(() => inFlight.delete(task.id));
  inFlight.set(task.id, { lead: lead.id, promise });
  return promise;
}

async function execute(ctx: HarnessContext, lead: LeadConfig, task: Task, opts: { resumePrompt?: string }): Promise<void> {
  const { db, bus, config } = ctx;
  const log = ctx.log.child(`lead:${lead.id}`);
  try {
    const ws = await prepareWorkspace(ctx, task, lead);
    const fresh = db.tasks.get(task.id) ?? task;
    if (["rejected", "done", "parked", "failed"].includes(fresh.status) && !opts.resumePrompt) {
      log.info(`task ${task.id} was ${fresh.status} before its run started; not running`);
      return;
    }
    const prompt = opts.resumePrompt ?? (fresh.session_id && fresh.attempts > 1 ? INTERRUPTED_PROMPT : leadTaskPrompt(config, fresh, parentBriefOf(ctx, fresh)));
    const resume = opts.resumePrompt || (fresh.session_id && fresh.attempts > 1) ? fresh.session_id : null;
    if (["queued", "waiting_human", "review"].includes(fresh.status) || (opts.resumePrompt && fresh.status === "done")) {
      db.tasks.setStatus(task.id, "running");
      bus.emit({ type: "task.status", task_id: task.id, payload: { status: "running", resumed: !!resume } });
    }
    log.info(`${resume ? "resuming" : "starting"} task ${task.id}`, { title: fresh.title, workspace: ws.dir, session: resume });
    const result = await ctx.runner.run(buildSpec(ctx, lead, fresh, ws, prompt, resume));
    await settle(ctx, lead, task.id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`task ${task.id} failed`, { error: message });
    db.tasks.setStatus(task.id, "failed", { result_summary: message.slice(0, 2000) });
    bus.emit({ type: "task.failed", task_id: task.id, payload: { error: message.slice(0, 500) } });
    postFailureInfo(ctx, lead, task.id, `Lead run failed: ${task.title}`, `The run for **${task.title}** threw an error:\n\n\`\`\`\n${message.slice(0, 1500)}\n\`\`\``);
  }
}

/** Decide what happens to the task once its run has ended. Never leaves the task in "running". */
async function settle(ctx: HarnessContext, lead: LeadConfig, taskId: string, result: RunResult): Promise<void> {
  const { db, bus } = ctx;
  const log = ctx.log.child(`lead:${lead.id}`);
  const task = db.tasks.get(taskId);
  if (!task) {
    log.error(`task ${taskId} vanished during its run`);
    return;
  }
  if (result.sessionId && result.sessionId !== task.session_id) db.tasks.update(taskId, { session_id: result.sessionId });
  const current = db.tasks.get(taskId)!;

  if (result.status === "cancelled") {
    if (current.status === "running") {
      db.tasks.setStatus(taskId, "queued");
      bus.emit({ type: "task.status", task_id: taskId, payload: { status: "queued", reason: "run cancelled" } });
    }
    log.info(`run for ${taskId} was cancelled`, { status: db.tasks.get(taskId)?.status });
    return;
  }

  const answeredWhileRunning = db.settings.get(resumeAfterKey(taskId));
  db.settings.set(resumeAfterKey(taskId), "");

  if (["review", "done"].includes(current.status) && answeredWhileRunning) {
    // A change request that arrived while the lead was still finishing its turn.
    const item = db.items.get(answeredWhileRunning);
    if (item?.answer?.option === "request_changes") {
      log.info(`task ${taskId}: change request arrived during the run; resuming`, { item: item.id });
      await resumeWithAnswer(ctx, lead, current, item);
      return;
    }
  }

  if (["review", "done", "rejected", "failed", "parked"].includes(current.status)) {
    log.info(`task ${taskId} ended its run in status ${current.status}`, { cost: result.costUsd, turns: result.turns });
    return;
  }

  if (current.status === "waiting_human") {
    const item = answeredWhileRunning ? db.items.get(answeredWhileRunning) : null;
    if (item?.answer) {
      log.info(`task ${taskId} got its answer while running; resuming with it`, { item: item.id });
      await resumeWithAnswer(ctx, lead, current, item);
      return;
    }
    log.info(`task ${taskId} is waiting for ${ctx.config.principal.name}`, { pending: db.settings.get(pendingKey(taskId)) });
    return;
  }

  // status is still "running": the session ended without settling the task.
  if (result.status === "success") {
    if (db.settings.get(nudgedKey(taskId)) !== "1") {
      db.settings.set(nudgedKey(taskId), "1");
      log.warn(`lead ended without submitting ${taskId}; nudging once`);
      await runAgain(ctx, lead, current, NUDGE_PROMPT);
      return;
    }
    const summary = transcriptTail(result) || "(no text)";
    db.tasks.setStatus(taskId, "failed", { result_summary: summary.slice(0, 2000) });
    bus.emit({ type: "task.failed", task_id: taskId, payload: { reason: "ended without submitting" } });
    postFailureInfo(ctx, lead, taskId, `Lead ended without submitting: ${current.title}`, `The ${lead.name} ended its session twice without calling submit_for_review or complete_task. Last words:\n\n${summary}`);
    return;
  }

  const error = result.errors.join("; ").slice(0, 1500) || "unknown error";
  if (current.attempts < MAX_ATTEMPTS) {
    log.warn(`run for ${taskId} errored; re-queuing (attempt ${current.attempts})`, { error });
    db.tasks.setStatus(taskId, "queued");
    bus.emit({ type: "task.status", task_id: taskId, payload: { status: "queued", reason: "run error, will retry", error: error.slice(0, 300) } });
    return;
  }
  db.tasks.setStatus(taskId, "failed", { result_summary: `error: ${error}`.slice(0, 2000) });
  bus.emit({ type: "task.failed", task_id: taskId, payload: { error: error.slice(0, 500) } });
  postFailureInfo(ctx, lead, taskId, `Lead run failed: ${current.title}`, `The run for **${current.title}** failed after ${current.attempts} attempts:\n\n\`\`\`\n${error}\n\`\`\``);
}

/** Start a follow-up run for the same task after the current one has fully ended. */
async function runAgain(ctx: HarnessContext, lead: LeadConfig, task: Task, resumePrompt: string): Promise<void> {
  inFlight.delete(task.id);
  await runLeadTask(ctx, lead, task, { resumePrompt });
}

async function resumeWithAnswer(ctx: HarnessContext, lead: LeadConfig, task: Task, item: QueueItem): Promise<void> {
  const option = item.answer?.option;
  ctx.db.settings.set(nudgedKey(task.id), "0");
  if (item.kind === "permission" && (option === "allow" || option === "allow_always")) {
    const exact = typeof item.meta.exact_rule === "string" ? item.meta.exact_rule : null;
    const rule = typeof item.meta.rule === "string" ? item.meta.rule : null;
    if (option === "allow_always" && rule) grantRule(ctx, task.id, rule);
    else if (exact) grantOnce(task.id, exact);
  }
  if (ctx.db.settings.get(pendingKey(task.id)) === item.id) ctx.db.settings.set(pendingKey(task.id), "");
  await runAgain(ctx, lead, task, leadResumePrompt(ctx.config, item));
}

function postFailureInfo(ctx: HarnessContext, lead: LeadConfig, taskId: string, title: string, body: string): void {
  const options: ItemOption[] = [
    { key: "retry", label: "Retry", description: "Queue the task again for the lead" },
    { key: "ack", label: "Got it" },
  ];
  const item = ctx.db.items.create({ kind: "info", lead: lead.id, task_id: taskId, title, body, options, recommended: "retry", priority: 3, meta: { failure: true } });
  ctx.bus.emit({ type: "item.created", item_id: item.id, task_id: taskId, payload: { kind: "info", title } });
}

// ---------- reacting to answers ----------

async function handleReviewAnswer(ctx: HarnessContext, lead: LeadConfig, task: Task, item: QueueItem, option: string): Promise<void> {
  const { db, bus } = ctx;
  const log = ctx.log.child(`lead:${lead.id}`);
  switch (option) {
    case "approve":
      await approve(ctx, lead, task, item);
      return;
    case "request_changes":
      if (inFlight.has(task.id)) {
        // The submitting run is still finishing its turn; resume with the comment once it ends.
        db.settings.set(resumeAfterKey(task.id), item.id);
        log.info(`changes requested on ${task.id} while its run is in flight; will resume after`, { item: item.id });
        return;
      }
      log.info(`changes requested on ${task.id}`, { item: item.id });
      db.settings.set(nudgedKey(task.id), "0");
      await runLeadTask(ctx, lead, task, { resumePrompt: leadResumePrompt(ctx.config, item) });
      return;
    case "reject":
      db.tasks.setStatus(task.id, "rejected");
      db.items.withdrawForTask(task.id, "task rejected");
      bus.emit({ type: "task.status", task_id: task.id, item_id: item.id, payload: { status: "rejected", comment: item.answer?.comment ?? "" } });
      log.info(`task ${task.id} rejected`);
      await cleanupWorkspace(ctx, task);
      return;
    default:
      log.warn(`unknown review answer "${option}" on ${item.id}`);
  }
}

async function approve(ctx: HarnessContext, lead: LeadConfig, task: Task, item: QueueItem): Promise<void> {
  const { db, bus } = ctx;
  const expectedHead = typeof item.meta.reviewed_head === "string" ? item.meta.reviewed_head : null;
  const result = await applyApproval(ctx, task, lead, { expectedHead });
  const current = db.items.get(item.id) ?? item;
  db.items.update(item.id, { meta: { ...current.meta, applied: result.ok, approval: result } });
  bus.emit({ type: "item.updated", item_id: item.id, task_id: task.id, payload: { applied: result.ok, message: result.message } });
  if (result.ok) {
    db.tasks.setStatus(task.id, "done");
    db.items.withdrawForTask(task.id, "task finished");
    bus.emit({ type: "task.done", task_id: task.id, item_id: item.id, payload: { title: task.title, message: result.message, url: result.url ?? null } });
    if (lead.onApprove === "merge") await cleanupWorkspace(ctx, task);
    return;
  }
  const info = db.items.create({
    kind: "info",
    lead: lead.id,
    task_id: task.id,
    title: `Approval could not be applied: ${result.message.slice(0, 100)}`,
    body: `You approved **${item.title}**, but the ${lead.onApprove} step failed:\n\n> ${result.message}\n\nThe branch is untouched${task.branch ? ` (${task.branch}` : ""}${task.workdir ? `${task.branch ? ", " : " ("}workspace ${task.workdir}` : ""}${task.branch || task.workdir ? ")" : ""}.`,
    options: [
      { key: "retry_approval", label: "Try again", description: `Run the ${lead.onApprove} step again` },
      { key: "re_review", label: "Ask for a new review", description: "The lead submits the current state of the branch again" },
      { key: "mark_done", label: "Mark done", description: "I handled it myself" },
      { key: "ack", label: "Leave in review" },
    ],
    recommended: "retry_approval",
    priority: 2,
    meta: { review_item: item.id, approval_failed: true },
  });
  bus.emit({ type: "item.created", item_id: info.id, task_id: task.id, payload: { kind: "info", title: info.title } });
}

async function handleBlockingAnswer(ctx: HarnessContext, lead: LeadConfig, task: Task, item: QueueItem): Promise<void> {
  const log = ctx.log.child(`lead:${lead.id}`);
  if (inFlight.has(task.id)) {
    // The session is still active. If the waiting tool call is still open it receives the answer through
    // the bus; only an answer to the call that already timed out must be replayed once the run ends.
    if (ctx.db.settings.get(pendingKey(task.id)) === item.id) ctx.db.settings.set(resumeAfterKey(task.id), item.id);
    log.debug(`answer for ${item.id} arrived while ${task.id} is running`);
    return;
  }
  if (task.status === "waiting_human") {
    await resumeWithAnswer(ctx, lead, task, item);
    return;
  }
  log.info(`answer for ${item.id} ignored; task ${task.id} is ${task.status}`);
}

async function handleInfoAnswer(ctx: HarnessContext, lead: LeadConfig, task: Task, item: QueueItem, option: string): Promise<void> {
  const { db, bus } = ctx;
  const log = ctx.log.child(`lead:${lead.id}`);
  switch (option) {
    case "request_changes":
      if (inFlight.has(task.id)) {
        db.settings.set(resumeAfterKey(task.id), item.id);
        return;
      }
      if (!task.session_id) {
        log.warn(`cannot resume ${task.id} for a change request: no session recorded; re-queuing instead`);
        db.tasks.setStatus(task.id, "queued");
        bus.emit({ type: "task.status", task_id: task.id, item_id: item.id, payload: { status: "queued", reason: "change request without a session" } });
        return;
      }
      log.info(`changes requested on completed task ${task.id}; resuming`, { item: item.id });
      await runLeadTask(ctx, lead, task, { resumePrompt: leadResumePrompt(ctx.config, item) });
      return;
    case "retry":
      if (inFlight.has(task.id)) return;
      db.settings.set(nudgedKey(task.id), "0");
      db.tasks.setStatus(task.id, "queued");
      bus.emit({ type: "task.status", task_id: task.id, item_id: item.id, payload: { status: "queued", reason: "retry requested" } });
      return;
    case "retry_approval": {
      const reviewId = typeof item.meta.review_item === "string" ? item.meta.review_item : null;
      const review = reviewId ? db.items.get(reviewId) : null;
      await approve(ctx, lead, task, review ?? item);
      return;
    }
    case "re_review":
      if (inFlight.has(task.id)) return;
      db.settings.set(nudgedKey(task.id), "0");
      await runLeadTask(ctx, lead, task, { resumePrompt: `${ctx.config.principal.name} approved an earlier version, but the branch changed after you submitted it. Re-check the current state of the workspace, verify it again, and call submit_for_review with what is there now.` });
      return;
    case "mark_done":
      db.tasks.setStatus(task.id, "done");
      db.items.withdrawForTask(task.id, "task finished");
      bus.emit({ type: "task.done", task_id: task.id, item_id: item.id, payload: { title: task.title, message: "marked done by the principal" } });
      return;
    default:
      log.debug(`info answer "${option}" on ${item.id} needs nothing from the lead`);
  }
}

async function handleAnswer(ctx: HarnessContext, lead: LeadConfig, ev: Event): Promise<void> {
  if (!ev.item_id) return;
  const item = ctx.db.items.get(ev.item_id);
  if (!item?.task_id) return;
  const task = ctx.db.tasks.get(item.task_id);
  if (!task || task.lead !== lead.id) return;
  if (item.meta.acted_at) return;
  // Mark the answer as consumed before any await so an undo can no longer reopen it.
  ctx.db.items.update(item.id, { meta: { ...item.meta, acted_at: nowIso() } });
  if (item.meta.chief_question) return; // the chief's own question: its loop returns the task to the inbox
  const option = item.answer?.option ?? String(ev.payload.option ?? "");
  // Answers on informational items act on finished tasks too: a change request reopens a completed task.
  if (item.kind === "info" && (option === "retry" || option === "mark_done" || option === "retry_approval" || option === "request_changes" || option === "re_review")) {
    await handleInfoAnswer(ctx, lead, task, item, option);
    return;
  }
  if (task.status === "done" || task.status === "rejected") return;
  switch (item.kind) {
    case "review":
      await handleReviewAnswer(ctx, lead, task, item, option);
      return;
    case "permission":
    case "question":
    case "decision":
      await handleBlockingAnswer(ctx, lead, task, item);
      return;
    case "info":
      await handleInfoAnswer(ctx, lead, task, item, option);
      return;
    default:
      return;
  }
}

// ---------- the loop ----------

function inFlightForLead(leadId: string): string[] {
  return Array.from(inFlight.entries())
    .filter(([, v]) => v.lead === leadId)
    .map(([id]) => id);
}

/** Tasks marked running for this lead with no live run (left over from a crash) go back to the queue. */
function recoverOrphans(ctx: HarnessContext, lead: LeadConfig): void {
  for (const t of ctx.db.tasks.list({ status: "running", lead: lead.id })) {
    if (inFlight.has(t.id)) continue;
    ctx.log.child(`lead:${lead.id}`).warn(`task ${t.id} was running with no active run; re-queuing`);
    ctx.db.tasks.setStatus(t.id, "queued");
    ctx.bus.emit({ type: "task.status", task_id: t.id, payload: { status: "queued", reason: "recovered after restart" } });
  }
}

/** Answers recorded while no loop was listening (CLI while stopped, a crash) are handled on start and periodically. */
function replayUnacted(ctx: HarnessContext, lead: LeadConfig, log: HarnessContext["log"]): void {
  for (const item of ctx.db.items.answeredUnacted(lead.id)) {
    log.info(`replaying unhandled answer on ${item.id}`, { task: item.task_id, kind: item.kind, option: item.answer?.option });
    const ev: Event = { id: 0, ts: item.answered_at ?? nowIso(), type: "item.answered", task_id: item.task_id, item_id: item.id, run_id: null, payload: { option: item.answer?.option, comment: item.answer?.comment, kind: item.kind, lead: item.lead, replayed: true } };
    void handleAnswer(ctx, lead, ev).catch((err) => log.error(`replay of ${item.id} failed`, { error: err instanceof Error ? err.message : String(err) }));
  }
}

export function startLeadLoop(ctx: HarnessContext, lead: LeadConfig): Loop {
  const log = ctx.log.child(`lead:${lead.id}`);
  let stopped = false;
  let polls = 0;

  recoverOrphans(ctx, lead);
  replayUnacted(ctx, lead, log);

  function poll(): void {
    if (stopped) return;
    if (++polls % 8 === 0) replayUnacted(ctx, lead, log);
    if (ctx.isPaused()) return;
    try {
      while (!stopped) {
        const busy = Math.max(ctx.db.tasks.runningByLead(lead.id), inFlightForLead(lead.id).length);
        if (busy >= lead.concurrency) return;
        const task = ctx.db.tasks.claimNext(lead.id);
        if (!task) return;
        log.info(`claimed ${task.id}`, { title: task.title, priority: task.priority, attempt: task.attempts });
        void runLeadTask(ctx, lead, task).catch((err) => log.error(`run for ${task.id} threw`, { error: err instanceof Error ? err.message : String(err) }));
      }
    } catch (err) {
      log.error("poll failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const timer = setInterval(poll, ctx.config.review.leadPollSec * 1000);
  const off = ctx.bus.on("item.answered", (ev) => {
    if (stopped) return;
    void handleAnswer(ctx, lead, ev).catch((err) => log.error(`could not handle answer on ${ev.item_id}`, { error: err instanceof Error ? err.message : String(err) }));
  });
  setTimeout(poll, 0);
  log.info(`lead loop started`, { pollSec: ctx.config.review.leadPollSec, concurrency: lead.concurrency });

  return {
    name: `lead:${lead.id}`,
    async stop() {
      stopped = true;
      clearInterval(timer);
      off();
      const ids = inFlightForLead(lead.id);
      for (const id of ids) ctx.runner.cancelTask(id);
      await Promise.allSettled(ids.map((id) => inFlight.get(id)?.promise));
      log.info("lead loop stopped", { cancelled: ids.length });
    },
  };
}
