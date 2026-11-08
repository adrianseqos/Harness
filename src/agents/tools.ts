import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { Evidence, HarnessContext, ItemOption, QueueItem } from "../types.js";
import { clampPriority } from "../store/db.js";
import { isInside } from "../policy.js";

export interface ToolScope {
  /** "chief" | "lead:<id>" | "brain" */
  agent: string;
  /** Lead id when the agent is a lead. */
  lead?: string;
  /** Task the agent is working on (leads only). */
  taskId?: string;
  /** Workspace directory (leads only). Evidence paths are resolved against it. */
  workdir?: string;
  /**
   * Called by submit_for_review / complete_task before the item is created.
   * Lead loops use it to commit, capture the diff and run the secrets scan.
   * Returning blockers prevents submission and the agent gets them as an error.
   */
  captureEvidence?: () => Promise<{ evidence: Evidence[]; blockers: string[]; appendix?: string }>;
}

export interface HarnessToolServer {
  server: McpSdkServerConfigWithInstance;
  /** Fully qualified tool names (mcp__harness__*) to put in allowedTools. */
  toolNames: string[];
}

const OptionSchema = z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(120), description: z.string().max(500).optional() });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(s: string) {
  return { content: [{ type: "text" as const, text: `ERROR: ${s}` }], isError: true };
}

/**
 * Build the in-process MCP server ("harness") exposed to an agent.
 * Which tools are included depends on the scope: leads get task tools, the chief gets triage tools.
 */
export function createHarnessTools(ctx: HarnessContext, scope: ToolScope): HarnessToolServer {
  const { db, bus, config } = ctx;
  const log = ctx.log.child(`tools:${scope.agent}`);
  const waitMs = config.review.permissionWaitMin * 60_000;
  const tools: SdkMcpToolDefinition<any>[] = [];

  // ---------- shared ----------

  tools.push(
    tool(
      "search_decisions",
      `Search ${config.principal.name}'s past decisions and comments for precedent before guessing what they would want. Returns the most relevant recent decisions with the question they answered.`,
      { query: z.string().min(2).max(200).describe("keywords to look for in questions, answers and comments") },
      async ({ query }) => {
        const rows = db.decisions.search(query, 15);
        if (!rows.length) return text("No matching decisions yet.");
        const lines = rows.map((d) => {
          const item = db.items.get(d.item_id);
          return `- [${d.created_at.slice(0, 10)}] ${item?.title ?? "(item)"} → chose "${d.option}"${d.recommended ? ` (recommended: ${d.recommended})` : ""}${d.comment ? ` — "${d.comment}"` : ""}`;
        });
        return text(lines.join("\n"));
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "submit_idea",
      "Propose something the principal has not asked for but should consider (an opportunity, a risk, a simplification). It lands in their queue as a low-priority item they can pursue, park or discard.",
      { title: z.string().min(3).max(140), body: z.string().min(10).max(4000).describe("what, why it matters, rough effort; markdown ok") },
      async ({ title, body }) => {
        const idea = db.ideas.create({ lead: scope.lead ?? null, task_id: scope.taskId ?? null, title, body });
        const item = db.items.create({
          task_id: scope.taskId ?? null,
          lead: scope.lead ?? null,
          kind: "idea",
          title: `Idea: ${title}`,
          body,
          options: [
            { key: "pursue", label: "Pursue", description: "Create a task for it" },
            { key: "park", label: "Park", description: "Keep it, not now" },
            { key: "discard", label: "Discard" },
          ],
          recommended: "pursue",
          rationale: `Proposed by ${scope.agent}`,
          meta: { idea_id: idea.id },
        });
        db.ideas.update(idea.id, { item_id: item.id });
        bus.emit({ type: "item.created", item_id: item.id, task_id: scope.taskId ?? null, payload: { kind: "idea", title: item.title } });
        return text(`Idea recorded (${idea.id}). The principal will see it in the queue.`);
      },
    ),
    tool(
      "report_progress",
      "Post a one-line progress note for the activity feed. Use it at milestones (plan ready, tests passing, blocked on X), not for every step.",
      { message: z.string().min(3).max(500) },
      async ({ message }) => {
        bus.emit({ type: "task.progress", task_id: scope.taskId ?? null, payload: { agent: scope.agent, message } });
        return text("noted");
      },
    ),
  );

  // ---------- lead tools (need a task) ----------

  if (scope.taskId) {
    const taskId = scope.taskId;

    tools.push(
      tool(
        "ask_principal",
        `Ask ${config.principal.name} a question you cannot answer from the brief, the brain or precedent. Give options when you can (they can answer with one key) and say which one you recommend. The call waits up to ${config.review.permissionWaitMin} minutes for an answer; if none arrives it returns "pending" — then finish your turn with a short status and you will be resumed with the answer.`,
        {
          question: z.string().min(5).max(2000),
          context: z.string().max(4000).optional().describe("what you already know / tried, so the principal can decide in seconds"),
          options: z.array(OptionSchema).max(6).optional(),
          recommended: z.string().optional().describe("key of the option you recommend"),
          rationale: z.string().max(1000).optional(),
        },
        async ({ question, context, options, recommended, rationale }) => {
          const opts: ItemOption[] = options?.length ? options : [{ key: "answer", label: "Answer in the comment box" }];
          const item = db.items.create({
            task_id: taskId,
            lead: scope.lead ?? null,
            kind: options?.length ? "decision" : "question",
            title: question.length > 120 ? question.slice(0, 117) + "…" : question,
            body: [question, context ? `\n\n**Context**\n\n${context}` : ""].join(""),
            options: opts,
            recommended: recommended && opts.some((o) => o.key === recommended) ? recommended : null,
            rationale: rationale ?? null,
            priority: 2,
            meta: { blocking: true },
          });
          db.tasks.setStatus(taskId, "waiting_human");
          bus.emit({ type: "item.created", item_id: item.id, task_id: taskId, payload: { kind: item.kind, title: item.title } });
          const ev = await bus.waitFor("item.answered", (e) => e.item_id === item.id, waitMs);
          if (!ev) {
            return text(`pending: no answer within ${config.review.permissionWaitMin} minutes (item ${item.id}). Finish your turn now with a short status of what is done and what you are waiting for. You will be resumed with the answer.`);
          }
          db.tasks.setStatus(taskId, "running");
          const answered = db.items.get(item.id)!;
          return text(formatAnswer(answered));
        },
      ),
      tool(
        "attach_evidence",
        "Attach a file from your workspace (screenshot, recording, document, log) to the upcoming review so the principal can see the result without opening anything. Call it once per file. Files under .harness/evidence/ in the workspace are attached automatically.",
        {
          path: z.string().describe("path relative to the workspace, or absolute inside it"),
          caption: z.string().max(300).optional(),
          type: z.enum(["image", "video", "file", "diff", "text"]).optional().describe("inferred from the extension when omitted"),
        },
        async ({ path: p, caption, type }) => {
          if (!scope.workdir) return err("no workspace for this task");
          const abs = path.isAbsolute(p) ? p : path.join(scope.workdir, p);
          if (!isInside(abs, scope.workdir)) return err("file must be inside the workspace");
          if (!fs.existsSync(abs)) return err(`file not found: ${p}`);
          const ev = stageFile(config.paths.attachments, taskId, abs, caption, type);
          pushStaged(ctx, taskId, ev);
          return text(`attached ${ev.path}`);
        },
      ),
      tool(
        "submit_for_review",
        `Submit your finished work for ${config.principal.name}'s approval. This is the normal way to end a task. Write the summary the way you would brief a busy executive: what changed, why, how it was verified, what the risks are, and what you recommend. The harness adds the diff and the evidence folder automatically. After this call, end your turn.`,
        {
          summary: z.string().min(20).max(12000).describe("markdown; lead with the outcome"),
          recommended: z.enum(["approve", "request_changes"]).default("approve").describe("what you expect the principal to do"),
          rationale: z.string().max(1000).optional().describe("why you recommend that, in one or two sentences"),
          risks: z.string().max(3000).optional().describe("what could go wrong, what you were unsure about"),
          verification: z.string().max(4000).optional().describe("tests run, outputs observed, what the screenshots/recording show"),
          title: z.string().max(140).optional().describe("short title for the queue; defaults to the task title"),
        },
        async ({ summary, recommended, rationale, risks, verification, title }) => {
          const task = db.tasks.get(taskId);
          if (!task) return err("task not found");
          let evidence = takeStaged(ctx, taskId);
          let appendix = "";
          if (scope.captureEvidence) {
            const cap = await scope.captureEvidence();
            if (cap.blockers.length) return err(`cannot submit yet:\n- ${cap.blockers.join("\n- ")}\nFix these and call submit_for_review again.`);
            evidence = [...cap.evidence, ...evidence];
            appendix = cap.appendix ?? "";
          }
          const body = [summary, verification ? `\n\n## Verification\n\n${verification}` : "", risks ? `\n\n## Risks and open points\n\n${risks}` : "", appendix ? `\n\n${appendix}` : ""].join("");
          // Questions or permission requests the lead no longer needs are moot once it submits.
          const withdrawn = db.items.withdrawForTask(taskId, "superseded by the lead's submission");
          if (withdrawn) bus.emit({ type: "item.updated", task_id: taskId, payload: { withdrawn } });
          const item = db.items.create({
            task_id: taskId,
            lead: scope.lead ?? null,
            kind: "review",
            title: title?.trim() || task.title,
            body,
            options: [
              { key: "approve", label: "Approve", description: approveDescription(ctx, task.lead) },
              { key: "request_changes", label: "Request changes", description: "Send your comment back to the lead; the session continues" },
              { key: "reject", label: "Reject", description: "Close the task without applying anything" },
            ],
            recommended,
            rationale: rationale ?? null,
            evidence,
            priority: task.priority,
          });
          db.tasks.setStatus(taskId, "review", { result_summary: summary.slice(0, 2000) });
          bus.emit({ type: "item.created", item_id: item.id, task_id: taskId, payload: { kind: "review", title: item.title } });
          log.info(`review submitted for ${taskId}`, { item: item.id });
          return text(`Submitted as review item ${item.id}. End your turn now with a one-paragraph summary. You will be resumed if the principal requests changes.`);
        },
      ),
      tool(
        "complete_task",
        "Finish a task that needs no approval (a research note, an answer, a document the principal only needs to read). The result still appears in the queue as an informational item. If anything should be merged, sent or published, use submit_for_review instead.",
        {
          summary: z.string().min(10).max(12000).describe("markdown; the deliverable itself if it is short, otherwise where it is"),
          title: z.string().max(140).optional(),
        },
        async ({ summary, title }) => {
          const task = db.tasks.get(taskId);
          if (!task) return err("task not found");
          let evidence = takeStaged(ctx, taskId);
          let appendix = "";
          if (scope.captureEvidence) {
            const cap = await scope.captureEvidence();
            if (cap.blockers.length) return err(`cannot complete yet:\n- ${cap.blockers.join("\n- ")}`);
            evidence = [...cap.evidence, ...evidence];
            appendix = cap.appendix ?? "";
          }
          const withdrawn = db.items.withdrawForTask(taskId, "superseded by the lead's completion");
          if (withdrawn) bus.emit({ type: "item.updated", task_id: taskId, payload: { withdrawn } });
          const item = db.items.create({
            task_id: taskId,
            lead: scope.lead ?? null,
            kind: "info",
            title: title?.trim() || `Done: ${task.title}`,
            body: appendix ? `${summary}\n\n${appendix}` : summary,
            options: [
              { key: "ack", label: "Got it" },
              { key: "request_changes", label: "Request changes", description: "Send a comment back; the lead continues" },
            ],
            recommended: "ack",
            evidence,
            priority: Math.max(task.priority, 4),
          });
          db.tasks.setStatus(taskId, "done", { result_summary: summary.slice(0, 2000) });
          bus.emit({ type: "item.created", item_id: item.id, task_id: taskId, payload: { kind: "info", title: item.title } });
          bus.emit({ type: "task.done", task_id: taskId, payload: { title: task.title } });
          return text(`Task completed (item ${item.id}). End your turn now.`);
        },
      ),
      tool(
        "create_subtask",
        "Hand a separable piece of work to another lead (or back to the chief of staff for triage when you omit the lead). Use it for work outside your charter, not to split your own task.",
        {
          title: z.string().min(3).max(140),
          brief: z.string().min(10).max(8000),
          lead: z.string().optional().describe(`one of: ${config.leads.map((l) => l.id).join(", ")}; omit to let the chief decide`),
          priority: z.number().int().min(1).max(5).optional(),
        },
        async ({ title, brief, lead, priority }) => {
          if (lead && !config.leads.some((l) => l.id === lead)) return err(`unknown lead ${lead}`);
          const t = db.tasks.create({ title, brief, source: "lead", lead: lead ?? null, priority: priority ?? 3, parent_id: taskId, status: lead ? "queued" : "inbox" });
          bus.emit({ type: "task.created", task_id: t.id, payload: { title, source: "lead", parent: taskId, lead: lead ?? null } });
          return text(`created ${t.id} (${lead ? `queued for ${lead}` : "inbox, chief will triage"})`);
        },
      ),
    );
  }

  // ---------- chief tools ----------

  if (scope.agent === "chief") {
    tools.push(
      tool(
        "list_leads",
        "The leads you can assign work to, their charters, repos and current load.",
        {},
        async () => {
          const lines = config.leads.map((l) => {
            const running = db.tasks.runningByLead(l.id);
            const queued = db.tasks.list({ status: "queued", lead: l.id }).length;
            return `- ${l.id} (${l.name}): ${l.charter}\n  repos: ${l.repos.length ? l.repos.join(", ") : "none (non-code work)"} · running ${running}/${l.concurrency} · queued ${queued}`;
          });
          return text(lines.join("\n"));
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "list_tasks",
        "Tasks by status (defaults to the inbox). Returns id, title, lead, priority, age, brief (truncated).",
        { status: z.enum(["inbox", "triaged", "queued", "running", "waiting_human", "review", "done", "rejected", "failed", "parked"]).optional(), limit: z.number().int().min(1).max(100).optional() },
        async ({ status, limit }) => {
          const rows = db.tasks.list({ status: status ?? "inbox", limit: limit ?? 50 });
          if (!rows.length) return text("none");
          return text(
            rows
              .map((t) => `- ${t.id} [p${t.priority}] ${t.title} · lead=${t.lead ?? "-"} · ${age(t.created_at)} · source=${t.source}${t.parent_id ? ` · parent=${t.parent_id}` : ""}\n  ${oneLine(t.brief, 300)}`)
              .join("\n"),
          );
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "get_task",
        "Full details of one task including its queue items and runs.",
        { task_id: z.string() },
        async ({ task_id }) => {
          const t = db.tasks.get(task_id);
          if (!t) return err("not found");
          const items = db.items.list({ task_id, hideDeferred: false }).map((i) => `  - ${i.id} ${i.kind} [${i.status}] ${i.title}${i.answer ? ` → ${i.answer.option}${i.answer.comment ? `: ${i.answer.comment}` : ""}` : ""}`);
          const runs = db.runs.list({ task_id, limit: 5 }).map((r) => `  - ${r.id} ${r.agent} ${r.status} $${r.cost_usd.toFixed(2)} ${r.summary ? oneLine(r.summary, 200) : ""}`);
          return text(`${JSON.stringify({ ...t, brief: undefined }, null, 1)}\nBrief:\n${t.brief}\nItems:\n${items.join("\n") || "  none"}\nRuns:\n${runs.join("\n") || "  none"}`);
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "assign_task",
        "Assign an inbox task to a lead with a priority and a sharpened brief. The brief you write replaces the raw ask, so include everything the lead needs: goal, constraints, definition of done, what evidence to bring back.",
        {
          task_id: z.string(),
          lead: z.string(),
          priority: z.number().int().min(1).max(5).describe("1 = drop everything, 3 = normal, 5 = whenever"),
          brief: z.string().min(20).max(12000),
          repo: z.string().optional().describe("one of the lead's repos when the task touches code; omit for non-code work"),
          title: z.string().max(140).optional().describe("cleaner title if the original is vague"),
          tags: z.array(z.string().max(30)).max(8).optional(),
        },
        async ({ task_id, lead, priority, brief, repo, title, tags }) => {
          const t = db.tasks.get(task_id);
          if (!t) return err("task not found");
          if (!["inbox", "triaged", "parked", "failed"].includes(t.status)) return err(`task is ${t.status}; only inbox/triaged/parked/failed tasks can be assigned`);
          const l = config.leads.find((x) => x.id === lead);
          if (!l) return err(`unknown lead ${lead}; use list_leads`);
          let repoPath: string | null = null;
          if (repo) {
            repoPath = l.repos.find((r) => r === repo || path.basename(r) === repo || r.endsWith(repo)) ?? null;
            if (!repoPath) return err(`repo ${repo} is not configured for ${lead}; its repos: ${l.repos.join(", ") || "none"}`);
          } else if (l.repos.length === 1) {
            repoPath = l.repos[0];
          }
          db.tasks.update(task_id, { lead, priority: clampPriority(priority), brief, repo: repoPath, status: "queued", title: title?.trim() || t.title, tags: tags ?? t.tags });
          bus.emit({ type: "task.assigned", task_id, payload: { lead, priority, repo: repoPath } });
          return text(`assigned ${task_id} to ${lead} at p${priority}${repoPath ? ` in ${repoPath}` : ""}`);
        },
      ),
      tool(
        "split_task",
        "Split a task that spans several leads or is too big for one session into subtasks. The parent stays open as the umbrella; close it with close_task when the children are done.",
        {
          task_id: z.string(),
          subtasks: z.array(z.object({ title: z.string().min(3).max(140), brief: z.string().min(20).max(8000), lead: z.string(), priority: z.number().int().min(1).max(5), repo: z.string().optional() })).min(2).max(8),
        },
        async ({ task_id, subtasks }) => {
          const t = db.tasks.get(task_id);
          if (!t) return err("task not found");
          const created: string[] = [];
          for (const s of subtasks) {
            const l = config.leads.find((x) => x.id === s.lead);
            if (!l) return err(`unknown lead ${s.lead}`);
            const repoPath = s.repo ? l.repos.find((r) => r === s.repo || path.basename(r) === s.repo) ?? null : l.repos.length === 1 ? l.repos[0] : null;
            const c = db.tasks.create({ title: s.title, brief: s.brief, source: "chief", lead: s.lead, priority: s.priority, parent_id: task_id, repo: repoPath, status: "queued" });
            created.push(c.id);
            bus.emit({ type: "task.created", task_id: c.id, payload: { title: s.title, source: "chief", parent: task_id, lead: s.lead } });
          }
          db.tasks.update(task_id, { status: "triaged", tags: Array.from(new Set([...t.tags, "split"])) });
          bus.emit({ type: "task.split", task_id, payload: { children: created } });
          return text(`split into ${created.join(", ")}`);
        },
      ),
      tool(
        "ask_principal",
        `Ask ${config.principal.name} before assigning when the ask is ambiguous in a way that would waste a lead's time. Give options when possible. The task waits; when answered it comes back to your inbox with the answer appended.`,
        {
          task_id: z.string(),
          question: z.string().min(5).max(2000),
          options: z.array(OptionSchema).max(6).optional(),
          recommended: z.string().optional(),
          rationale: z.string().max(1000).optional(),
        },
        async ({ task_id, question, options, recommended, rationale }) => {
          const t = db.tasks.get(task_id);
          if (!t) return err("task not found");
          const opts: ItemOption[] = options?.length ? options : [{ key: "answer", label: "Answer in the comment box" }];
          const item = db.items.create({
            task_id,
            lead: null,
            kind: options?.length ? "decision" : "question",
            title: question.length > 120 ? question.slice(0, 117) + "…" : question,
            body: `${question}\n\n_Regarding task: **${t.title}**_`,
            options: opts,
            recommended: recommended && opts.some((o) => o.key === recommended) ? recommended : null,
            rationale: rationale ?? null,
            priority: 2,
            meta: { chief_question: true },
          });
          db.tasks.setStatus(task_id, "waiting_human");
          bus.emit({ type: "item.created", item_id: item.id, task_id, payload: { kind: item.kind, title: item.title } });
          return text(`asked (item ${item.id}); the task will return to the inbox once answered`);
        },
      ),
      tool(
        "park_task",
        "Park a task that should not run now (duplicate, superseded, not worth it yet). Say why; the principal sees the reason.",
        { task_id: z.string(), reason: z.string().min(5).max(1000) },
        async ({ task_id, reason }) => {
          const t = db.tasks.get(task_id);
          if (!t) return err("task not found");
          db.tasks.setStatus(task_id, "parked", { result_summary: reason });
          bus.emit({ type: "task.parked", task_id, payload: { reason } });
          return text("parked");
        },
      ),
      tool(
        "close_task",
        "Close an umbrella task whose subtasks are all done, or a task that turned out to need nothing.",
        { task_id: z.string(), summary: z.string().min(5).max(2000) },
        async ({ task_id, summary }) => {
          const t = db.tasks.get(task_id);
          if (!t) return err("task not found");
          const openChildren = db.tasks.list({ parent_id: task_id }).filter((c) => !["done", "rejected", "parked", "failed"].includes(c.status));
          if (openChildren.length) return err(`${openChildren.length} subtasks still open: ${openChildren.map((c) => c.id).join(", ")}`);
          db.tasks.setStatus(task_id, "done", { result_summary: summary });
          bus.emit({ type: "task.done", task_id, payload: { title: t.title } });
          return text("closed");
        },
      ),
      tool(
        "queue_overview",
        "Everything currently waiting for the principal: open items with kind, priority, lead, age and whether a lead is blocked on it.",
        {},
        async () => {
          const items = db.items.list({ status: "open", hideDeferred: false });
          if (!items.length) return text("queue is empty");
          return text(items.map((i) => `- ${i.id} ${i.kind} p${i.priority} ${i.lead ?? "chief"} · ${age(i.created_at)} · ${i.title}${i.meta.blocking ? " · BLOCKING a lead" : ""}${i.deferred_until ? ` · deferred until ${i.deferred_until}` : ""}`).join("\n"));
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "set_item_priority",
        "Re-prioritise a queue item (1 = top). Use it to surface blocked leads and stale reviews, or to push low-value items down.",
        { item_id: z.string(), priority: z.number().int().min(1).max(5), note: z.string().max(300).optional() },
        async ({ item_id, priority, note }) => {
          const it = db.items.get(item_id);
          if (!it) return err("item not found");
          db.items.update(item_id, { priority, meta: note ? { ...it.meta, chief_note: note } : it.meta });
          bus.emit({ type: "item.updated", item_id, payload: { priority, note } });
          return text("ok");
        },
      ),
      tool(
        "post_info",
        "Post an informational item to the queue (daily brief, a heads-up, a summary of what happened overnight). Keep it short; the principal clears these in one keystroke.",
        { title: z.string().min(3).max(140), body: z.string().min(10).max(8000), priority: z.number().int().min(1).max(5).optional() },
        async ({ title, body, priority }) => {
          const item = db.items.create({ kind: "info", title, body, options: [{ key: "ack", label: "Got it" }], recommended: "ack", priority: priority ?? 5, lead: null });
          bus.emit({ type: "item.created", item_id: item.id, payload: { kind: "info", title } });
          return text(`posted ${item.id}`);
        },
      ),
      tool(
        "decision_stats",
        "How often the principal agreed with the leads' recommendations (overall, per lead, last 20). Use it in the daily brief and to spot leads that need recalibration.",
        {},
        async () => text(JSON.stringify(db.decisions.agreementStats(), null, 1)),
        { annotations: { readOnlyHint: true } },
      ),
    );
  }

  const server = createSdkMcpServer({ name: "harness", version: "0.1.0", tools, alwaysLoad: true });
  const toolNames = tools.map((t) => `mcp__harness__${t.name}`);
  return { server, toolNames };
}

// ---------- helpers ----------

export function formatAnswer(item: QueueItem): string {
  const a = item.answer;
  if (!a) return "no answer recorded";
  const opt = item.options.find((o) => o.key === a.option);
  return `Principal answered "${opt?.label ?? a.option}"${a.comment ? ` with comment: ${a.comment}` : ""}.`;
}

function approveDescription(ctx: HarnessContext, leadId: string | null): string {
  const lead = ctx.config.leads.find((l) => l.id === leadId);
  switch (lead?.onApprove) {
    case "merge":
      return "Merge the branch into the repo's current branch";
    case "pr":
      return "Push the branch and open a pull request";
    default:
      return "Mark as done and keep the branch/artefacts";
  }
}

function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

const EXT_TYPES: Record<string, Evidence["type"]> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image",
  ".webm": "video", ".mp4": "video", ".mov": "video",
  ".diff": "diff", ".patch": "diff",
  ".txt": "text", ".log": "text", ".md": "file",
};

/** Copy a file into data/attachments/<task>/ and describe it as evidence. */
export function stageFile(attachmentsDir: string, taskId: string, absFile: string, caption?: string, type?: Evidence["type"]): Evidence {
  const dir = path.join(attachmentsDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(absFile);
  let dest = path.join(dir, base);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(dir, `${path.parse(base).name}-${n++}${path.extname(base)}`);
  fs.copyFileSync(absFile, dest);
  const ext = path.extname(base).toLowerCase();
  const t = type ?? EXT_TYPES[ext] ?? "file";
  const ev: Evidence = { type: t, path: `${taskId}/${path.basename(dest)}`, caption: caption ?? base };
  if (t === "text" && fs.statSync(dest).size < 20_000) ev.text = fs.readFileSync(dest, "utf8");
  return ev;
}

function stagedKey(taskId: string) {
  return `evidence:${taskId}`;
}

export function pushStaged(ctx: HarnessContext, taskId: string, ev: Evidence): void {
  const cur = ctx.db.settings.getJson<Evidence[]>(stagedKey(taskId), []);
  ctx.db.settings.setJson(stagedKey(taskId), [...cur, ev]);
}

export function takeStaged(ctx: HarnessContext, taskId: string): Evidence[] {
  const cur = ctx.db.settings.getJson<Evidence[]>(stagedKey(taskId), []);
  ctx.db.settings.setJson(stagedKey(taskId), []);
  return cur;
}
