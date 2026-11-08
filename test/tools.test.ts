import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store/db.js";
import { createBus } from "../src/bus.js";
import { createLogger, setLogLevel } from "../src/logger.js";
import { EXAMPLE_CONFIG, ensureDirs, resolveConfig } from "../src/config.js";
import { createHarnessTools, formatAnswer, pushStaged, stageFile, takeStaged, type ToolScope } from "../src/agents/tools.js";
import type { Evidence, HarnessContext, QueueItem } from "../src/types.js";

setLogLevel("error");

// ---------- fixtures ----------

/** A context with an in-memory store, a real bus, a stub runner and a short permission wait so ask_principal can be tested. */
function makeCtx(): HarnessContext & { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tools-"));
  const config = resolveConfig({ ...EXAMPLE_CONFIG, review: { ...EXAMPLE_CONFIG.review, permissionWaitMin: 0.005 } }, root);
  ensureDirs(config);
  const db = new Store(":memory:");
  return {
    root,
    config,
    db,
    bus: createBus(db),
    log: createLogger("test"),
    runner: {
      run: async () => {
        throw new Error("no runner in tests");
      },
      active: () => [],
      cancel: () => false,
      cancelTask: () => 0,
    },
    isPaused: () => false,
  };
}

interface Harness {
  ctx: HarnessContext & { root: string };
  toolNames: string[];
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** Connect an MCP client to the in-process harness server so tool handlers run exactly as the agent would call them. */
async function connect(ctx: HarnessContext & { root: string }, scope: ToolScope): Promise<Harness> {
  const { server, toolNames } = createHarnessTools(ctx, scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "harness-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    ctx,
    toolNames,
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
      const text = res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { text, isError: res.isError === true };
    },
    async close() {
      await client.close();
      await server.instance.close();
      ctx.db.close();
      fs.rmSync(ctx.root, { recursive: true, force: true });
    },
  };
}

function eventTypes(ctx: HarnessContext): string[] {
  return ctx.db.events.latest(100).map((e) => e.type);
}

function openItems(ctx: HarnessContext, taskId?: string): QueueItem[] {
  return ctx.db.items.list({ status: "open", task_id: taskId, hideDeferred: false });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- tool lists ----------

test("chief scope exposes the triage tools, lead scope the task tools, neither leaks the other", async () => {
  const chief = await connect(makeCtx(), { agent: "chief" });
  const expectChief = ["search_decisions", "submit_idea", "report_progress", "list_leads", "list_tasks", "get_task", "assign_task", "split_task", "ask_principal", "park_task", "close_task", "queue_overview", "set_item_priority", "post_info", "decision_stats"];
  assert.deepEqual(
    chief.toolNames,
    expectChief.map((n) => `mcp__harness__${n}`),
  );
  assert.ok(chief.toolNames.includes("mcp__harness__assign_task"));
  assert.ok(!chief.toolNames.includes("mcp__harness__submit_for_review"));
  assert.equal(chief.ctx.config.principal.name, "Adrian");
  await chief.close();

  const leadCtx = makeCtx();
  const task = leadCtx.db.tasks.create({ title: "t", lead: "engineering" });
  const lead = await connect(leadCtx, { agent: "lead:engineering", lead: "engineering", taskId: task.id, workdir: leadCtx.root });
  const expectLead = ["search_decisions", "submit_idea", "report_progress", "ask_principal", "attach_evidence", "submit_for_review", "complete_task", "create_subtask"];
  assert.deepEqual(
    lead.toolNames,
    expectLead.map((n) => `mcp__harness__${n}`),
  );
  assert.ok(!lead.toolNames.includes("mcp__harness__assign_task"));
  await lead.close();

  const noTask = await connect(makeCtx(), { agent: "brain" });
  assert.deepEqual(noTask.toolNames, ["mcp__harness__search_decisions", "mcp__harness__submit_idea", "mcp__harness__report_progress"]);
  await noTask.close();
});

// ---------- chief tools ----------

test("chief: list_leads, list_tasks, get_task", async () => {
  const h = await connect(makeCtx(), { agent: "chief" });
  const { db } = h.ctx;
  const leads = await h.call("list_leads");
  assert.ok(leads.text.includes("- engineering (Engineering Lead)"));
  assert.ok(leads.text.includes("running 0/1 · queued 0"));

  assert.equal((await h.call("list_tasks")).text, "none");
  const t = db.tasks.create({ title: "Write the memo", brief: "two pages", source: "cli" });
  const inbox = await h.call("list_tasks");
  assert.ok(inbox.text.includes(t.id));
  assert.ok(inbox.text.includes("[p3] Write the memo"));
  assert.equal((await h.call("list_tasks", { status: "done" })).text, "none");

  const got = await h.call("get_task", { task_id: t.id });
  assert.ok(got.text.includes("Brief:\ntwo pages"));
  assert.ok(got.text.includes("Items:\n  none"));
  const missing = await h.call("get_task", { task_id: "task_nope" });
  assert.equal(missing.isError, true);
  assert.equal(missing.text, "ERROR: not found");
  await h.close();
});

test("chief: assign_task queues the task, rewrites the brief and emits task.assigned", async () => {
  const ctx = makeCtx();
  const repo = path.join(ctx.root, "repo");
  fs.mkdirSync(repo);
  ctx.config.leads[1].repos = [repo];
  const h = await connect(ctx, { agent: "chief" });
  const { db } = ctx;
  const t = db.tasks.create({ title: "fix thing", brief: "raw ask", source: "ui" });

  const unknownLead = await h.call("assign_task", { task_id: t.id, lead: "nobody", priority: 2, brief: "a sharpened brief for the lead" });
  assert.equal(unknownLead.isError, true);
  assert.match(unknownLead.text, /unknown lead nobody/);
  assert.equal(db.tasks.get(t.id)?.status, "inbox", "a failed assignment changes nothing");

  const badRepo = await h.call("assign_task", { task_id: t.id, lead: "engineering", priority: 2, brief: "a sharpened brief for the lead", repo: "/elsewhere" });
  assert.equal(badRepo.isError, true);
  assert.match(badRepo.text, /not configured for engineering/);

  const outOfRange = await h.call("assign_task", { task_id: t.id, lead: "engineering", priority: 9, brief: "a sharpened brief for the lead" });
  assert.equal(outOfRange.isError, true, "the input schema rejects priorities outside 1-5 before the handler runs");
  const shortBrief = await h.call("assign_task", { task_id: t.id, lead: "engineering", priority: 2, brief: "too short" });
  assert.equal(shortBrief.isError, true, "the brief must be at least 20 characters");

  const ok = await h.call("assign_task", { task_id: t.id, lead: "engineering", priority: 1, brief: "a sharpened brief for the lead", title: "Fix the thing", tags: ["bug"] });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /assigned .* to engineering at p1/);
  const after = db.tasks.get(t.id)!;
  assert.equal(after.status, "queued");
  assert.equal(after.lead, "engineering");
  assert.equal(after.priority, 1);
  assert.equal(after.brief, "a sharpened brief for the lead");
  assert.equal(after.title, "Fix the thing");
  assert.equal(after.repo, repo, "the lead's only repo is picked automatically");
  assert.deepEqual(after.tags, ["bug"]);
  assert.ok(eventTypes(ctx).includes("task.assigned"));

  const again = await h.call("assign_task", { task_id: t.id, lead: "engineering", priority: 1, brief: "a sharpened brief for the lead" });
  assert.equal(again.isError, true);
  assert.match(again.text, /task is queued/);

  const byName = db.tasks.create({ title: "other", status: "parked" });
  const named = await h.call("assign_task", { task_id: byName.id, lead: "engineering", priority: 3, brief: "a sharpened brief for the lead", repo: "repo" });
  assert.equal(named.isError, false);
  assert.equal(db.tasks.get(byName.id)?.repo, repo, "repos can be referred to by basename");
  await h.close();
});

test("chief: split_task creates queued children and marks the parent triaged; close_task waits for them", async () => {
  const h = await connect(makeCtx(), { agent: "chief" });
  const { db } = h.ctx;
  const parent = db.tasks.create({ title: "big", brief: "lots" });
  const subtasks = [
    { title: "spec", brief: "write the spec with acceptance criteria", lead: "product", priority: 2 },
    { title: "build", brief: "implement it once the spec is approved", lead: "engineering", priority: 3 },
  ];
  // The unknown lead comes first: split_task creates children one by one and stops at the first bad entry.
  const bad = await h.call("split_task", { task_id: parent.id, subtasks: [{ ...subtasks[0], lead: "nobody" }, subtasks[1]] });
  assert.equal(bad.isError, true);
  assert.equal(db.tasks.list({ parent_id: parent.id }).length, 0);
  assert.equal(db.tasks.get(parent.id)?.status, "inbox");

  const res = await h.call("split_task", { task_id: parent.id, subtasks });
  assert.equal(res.isError, false);
  const children = db.tasks.list({ parent_id: parent.id });
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.status === "queued" && c.source === "chief"));
  assert.equal(db.tasks.get(parent.id)?.status, "triaged");
  assert.deepEqual(db.tasks.get(parent.id)?.tags, ["split"]);
  assert.ok(eventTypes(h.ctx).includes("task.split"));
  assert.equal(eventTypes(h.ctx).filter((t) => t === "task.created").length, 2);

  const early = await h.call("close_task", { task_id: parent.id, summary: "all done" });
  assert.equal(early.isError, true);
  assert.match(early.text, /2 subtasks still open/);
  for (const c of children) db.tasks.setStatus(c.id, "done");
  const closed = await h.call("close_task", { task_id: parent.id, summary: "all done" });
  assert.equal(closed.text, "closed");
  assert.equal(db.tasks.get(parent.id)?.status, "done");
  assert.equal(db.tasks.get(parent.id)?.result_summary, "all done");
  assert.ok(eventTypes(h.ctx).includes("task.done"));
  await h.close();
});

test("chief: ask_principal, park_task, post_info, set_item_priority, queue_overview, decision_stats", async () => {
  const h = await connect(makeCtx(), { agent: "chief" });
  const { db } = h.ctx;
  const t = db.tasks.create({ title: "vague ask" });

  const asked = await h.call("ask_principal", { task_id: t.id, question: "Which market?", options: [{ key: "de", label: "Germany" }, { key: "uk", label: "UK" }], recommended: "de" });
  assert.equal(asked.isError, false);
  assert.equal(db.tasks.get(t.id)?.status, "waiting_human");
  const [q] = openItems(h.ctx, t.id);
  assert.equal(q.kind, "decision");
  assert.equal(q.recommended, "de");
  assert.equal(q.priority, 2);
  assert.equal(q.lead, null, "chief questions carry no lead");
  assert.ok(q.body.includes("vague ask"));

  const freeText = await h.call("ask_principal", { task_id: t.id, question: "Anything else to consider?", recommended: "nonexistent" });
  assert.equal(freeText.isError, false);
  const free = openItems(h.ctx, t.id).find((i) => i.id !== q.id)!;
  assert.equal(free.kind, "question");
  assert.equal(free.recommended, null, "a recommendation that is not an option is dropped");
  assert.deepEqual(free.options, [{ key: "answer", label: "Answer in the comment box" }]);
  assert.equal((await h.call("ask_principal", { task_id: "task_nope", question: "Hello there?" })).isError, true);

  const parked = await h.call("park_task", { task_id: t.id, reason: "duplicate of another task" });
  assert.equal(parked.text, "parked");
  assert.equal(db.tasks.get(t.id)?.status, "parked");
  assert.equal(db.tasks.get(t.id)?.result_summary, "duplicate of another task");
  assert.ok(eventTypes(h.ctx).includes("task.parked"));

  const posted = await h.call("post_info", { title: "Daily brief", body: "Nothing happened overnight." });
  assert.match(posted.text, /^posted item_/);
  const info = db.items.list({ kind: "info" })[0];
  assert.equal(info.priority, 5);
  assert.equal(info.recommended, "ack");

  const rep = await h.call("set_item_priority", { item_id: info.id, priority: 1, note: "read this first" });
  assert.equal(rep.text, "ok");
  assert.equal(db.items.get(info.id)?.priority, 1);
  assert.equal(db.items.get(info.id)?.meta.chief_note, "read this first");
  assert.ok(eventTypes(h.ctx).includes("item.updated"));
  assert.equal((await h.call("set_item_priority", { item_id: "item_nope", priority: 1 })).isError, true);

  const overview = await h.call("queue_overview");
  assert.ok(overview.text.includes("Daily brief"));
  assert.ok(overview.text.includes("decision p2 chief"));

  db.items.answer(q.id, "uk", "we start in the UK");
  const stats = JSON.parse((await h.call("decision_stats")).text) as { overall: { total: number; agreed: number } };
  assert.deepEqual(stats.overall, { total: 1, agreed: 0, rate: 0 });
  await h.close();
});

// ---------- shared tools ----------

test("shared: submit_idea, report_progress, search_decisions", async () => {
  const h = await connect(makeCtx(), { agent: "chief" });
  const { db } = h.ctx;
  const idea = await h.call("submit_idea", { title: "Cache the API", body: "Responses are slow; a cache would cut cost and latency." });
  assert.match(idea.text, /Idea recorded \(idea_/);
  const stored = db.ideas.list()[0];
  const item = db.items.get(stored.item_id!)!;
  assert.equal(item.kind, "idea");
  assert.equal(item.title, "Idea: Cache the API");
  assert.equal(item.recommended, null, "ideas carry no recommendation so parking one is not an overrule");
  assert.deepEqual(
    item.options.map((o) => o.key),
    ["pursue", "park", "discard"],
  );
  assert.equal(item.meta.idea_id, stored.id);
  assert.ok(eventTypes(h.ctx).includes("item.created"));

  const noted = await h.call("report_progress", { message: "plan ready" });
  assert.equal(noted.text, "noted");
  const progress = db.events.latest(100).find((e) => e.type === "task.progress");
  assert.deepEqual(progress?.payload, { agent: "chief", message: "plan ready" });

  assert.equal((await h.call("search_decisions", { query: "cache" })).text, "No matching decisions yet.");
  db.items.answer(item.id, "park", "not this quarter");
  const found = await h.call("search_decisions", { query: "cache" });
  assert.ok(found.text.includes('chose "park"'));
  assert.ok(!found.text.includes("(recommended:"));
  assert.ok(found.text.includes("not this quarter"));
  await h.close();
});

// ---------- lead tools ----------

test("lead: create_subtask routes to a lead or to the chief's inbox", async () => {
  const ctx = makeCtx();
  const task = ctx.db.tasks.create({ title: "parent", lead: "engineering" });
  const h = await connect(ctx, { agent: "lead:engineering", lead: "engineering", taskId: task.id, workdir: ctx.root });
  const routed = await h.call("create_subtask", { title: "Write release notes", brief: "Summarise the change for customers.", lead: "product", priority: 2 });
  assert.match(routed.text, /queued for product/);
  const inbox = await h.call("create_subtask", { title: "Something else", brief: "Not sure who owns this one." });
  assert.match(inbox.text, /inbox, chief will triage/);
  assert.equal((await h.call("create_subtask", { title: "Nope", brief: "Unknown lead given here.", lead: "nobody" })).isError, true);
  const children = ctx.db.tasks.list({ parent_id: task.id });
  assert.equal(children.length, 2);
  assert.deepEqual(new Set(children.map((c) => `${c.status}:${c.lead}:${c.source}`)), new Set(["queued:product:lead", "inbox:null:lead"]));
  assert.equal(eventTypes(ctx).filter((t) => t === "task.created").length, 2);
  await h.close();
});

test("lead: attach_evidence stages files from inside the workspace only", async () => {
  const ctx = makeCtx();
  const task = ctx.db.tasks.create({ title: "t", lead: "design" });
  const workdir = path.join(ctx.root, "ws");
  fs.mkdirSync(workdir);
  fs.writeFileSync(path.join(workdir, "shot.png"), "png");
  fs.writeFileSync(path.join(ctx.root, "outside.txt"), "no");
  const h = await connect(ctx, { agent: "lead:design", lead: "design", taskId: task.id, workdir });

  const ok = await h.call("attach_evidence", { path: "shot.png", caption: "Home page" });
  assert.equal(ok.text, `attached ${task.id}/shot.png`);
  assert.ok(fs.existsSync(path.join(ctx.config.paths.attachments, task.id, "shot.png")));
  assert.deepEqual(ctx.db.settings.getJson<Evidence[]>(`evidence:${task.id}`, []), [{ type: "image", path: `${task.id}/shot.png`, caption: "Home page" }]);

  const outside = await h.call("attach_evidence", { path: path.join(ctx.root, "outside.txt") });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /inside the workspace/);
  const missing = await h.call("attach_evidence", { path: "nope.png" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /file not found/);
  await h.close();

  const noWs = makeCtx();
  const t2 = noWs.db.tasks.create({ title: "t", lead: "design" });
  const h2 = await connect(noWs, { agent: "lead:design", lead: "design", taskId: t2.id });
  assert.match((await h2.call("attach_evidence", { path: "x.png" })).text, /no workspace/);
  await h2.close();
});

test("lead: submit_for_review builds the review package and respects blockers", async () => {
  const ctx = makeCtx();
  const task = ctx.db.tasks.create({ title: "Add caching", lead: "engineering", priority: 2 });
  let blockers: string[] = ["Secrets found in the diff"];
  const h = await connect(ctx, {
    agent: "lead:engineering",
    lead: "engineering",
    taskId: task.id,
    workdir: ctx.root,
    captureEvidence: async () => ({ evidence: [{ type: "diff", path: `${task.id}/changes.diff`, caption: "2 files changed" }], blockers, appendix: "## Changes\nsrc/a.ts" }),
  });
  pushStaged(ctx, task.id, { type: "image", path: `${task.id}/shot.png` });

  const blocked = await h.call("submit_for_review", { summary: "Added an LRU cache in front of the API client." });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /cannot submit yet:\n- Secrets found in the diff/);
  assert.equal(openItems(ctx, task.id).length, 0, "no item is created when blocked");
  assert.equal(ctx.db.tasks.get(task.id)?.status, "queued");
  assert.equal(ctx.db.settings.getJson<Evidence[]>(`evidence:${task.id}`, []).length, 0, "staged evidence is consumed either way");

  pushStaged(ctx, task.id, { type: "image", path: `${task.id}/shot.png` });
  blockers = [];
  const ok = await h.call("submit_for_review", { summary: "Added an LRU cache in front of the API client.", recommended: "approve", rationale: "small and tested", risks: "cache invalidation", verification: "npm test green" });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /Submitted as review item item_/);
  const [review] = openItems(ctx, task.id);
  assert.equal(review.kind, "review");
  assert.equal(review.title, "Add caching");
  assert.equal(review.priority, 2, "review inherits the task priority");
  assert.equal(review.recommended, "approve");
  assert.equal(review.rationale, "small and tested");
  assert.deepEqual(
    review.options.map((o) => o.key),
    ["approve", "request_changes", "reject"],
  );
  assert.equal(review.options[0].description, "Push the branch and open a pull request", "the approve option explains the lead's onApprove action");
  assert.deepEqual(
    review.evidence.map((e) => e.type),
    ["diff", "image"],
    "captured evidence comes first, then staged evidence",
  );
  assert.ok(review.body.includes("## Verification\n\nnpm test green"));
  assert.ok(review.body.includes("## Risks and open points\n\ncache invalidation"));
  assert.ok(review.body.includes("## Changes\nsrc/a.ts"));
  assert.equal(ctx.db.tasks.get(task.id)?.status, "review");
  assert.equal(ctx.db.tasks.get(task.id)?.result_summary, "Added an LRU cache in front of the API client.");
  assert.ok(eventTypes(ctx).includes("item.created"));
  await h.close();
});

test("lead: complete_task posts an info item and closes the task", async () => {
  const ctx = makeCtx();
  const task = ctx.db.tasks.create({ title: "Research competitors", lead: "operations", priority: 2 });
  const h = await connect(ctx, { agent: "lead:operations", lead: "operations", taskId: task.id, workdir: ctx.root });
  const res = await h.call("complete_task", { summary: "Three competitors matter; details below." });
  assert.match(res.text, /Task completed \(item item_/);
  const [info] = openItems(ctx, task.id);
  assert.equal(info.kind, "info");
  assert.equal(info.title, "Done: Research competitors");
  assert.equal(info.priority, 4, "info items never jump the queue");
  assert.deepEqual(
    info.options.map((o) => o.key),
    ["ack", "request_changes"],
  );
  assert.equal(ctx.db.tasks.get(task.id)?.status, "done");
  assert.ok(eventTypes(ctx).includes("task.done"));
  await h.close();
});

test("lead: ask_principal blocks the task, returns pending on timeout and the answer when it arrives", async () => {
  const ctx = makeCtx();
  const task = ctx.db.tasks.create({ title: "t", lead: "product", status: "running" });
  const h = await connect(ctx, { agent: "lead:product", lead: "product", taskId: task.id, workdir: ctx.root });

  const pending = await h.call("ask_principal", { question: "Which tone should the memo take?", context: "Draft is formal." });
  assert.match(pending.text, /^pending: no answer within/);
  assert.equal(ctx.db.tasks.get(task.id)?.status, "waiting_human");
  const [q] = openItems(ctx, task.id);
  assert.equal(q.kind, "question");
  assert.equal(q.meta.blocking, true);
  assert.ok(q.body.includes("**Context**"));

  const answering = h.call("ask_principal", { question: "Ship with or without the appendix?", options: [{ key: "with", label: "With appendix" }, { key: "without", label: "Without" }], recommended: "with" });
  await sleep(30);
  const decision = openItems(ctx, task.id).find((i) => i.kind === "decision")!;
  assert.equal(decision.recommended, "with");
  ctx.db.items.answer(decision.id, "without", "keep it short");
  ctx.bus.emit({ type: "item.answered", item_id: decision.id, task_id: task.id, payload: { option: "without", comment: "keep it short", kind: "decision", lead: "product" } });
  const answered = await answering;
  assert.equal(answered.text, 'Principal answered "Without" with comment: keep it short.');
  assert.equal(ctx.db.tasks.get(task.id)?.status, "running", "the task resumes once answered");
  await h.close();
});

// ---------- exported helpers ----------

test("formatAnswer uses the option label and the comment", () => {
  const base: QueueItem = {
    id: "item_1", task_id: null, lead: null, kind: "decision", title: "q", body: "", options: [{ key: "a", label: "Option A" }], recommended: null, rationale: null, evidence: [], priority: 2, status: "answered", answer: null, meta: {}, created_at: "", answered_at: null, deadline_at: null, deferred_until: null,
  };
  assert.equal(formatAnswer(base), "no answer recorded");
  assert.equal(formatAnswer({ ...base, answer: { option: "a", comment: "" } }), 'Principal answered "Option A".');
  assert.equal(formatAnswer({ ...base, answer: { option: "zzz", comment: "go" } }), 'Principal answered "zzz" with comment: go.');
});

test("stageFile copies into attachments/<task>, infers the type, avoids collisions and inlines short text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-stage-"));
  const attachments = path.join(root, "attachments");
  const src = path.join(root, "notes.log");
  fs.writeFileSync(src, "hello log");
  fs.writeFileSync(path.join(root, "clip.webm"), "video");
  fs.writeFileSync(path.join(root, "report.xyz"), "?");

  const ev1 = stageFile(attachments, "task_1", src);
  assert.deepEqual(ev1, { type: "text", path: "task_1/notes.log", caption: "notes.log", text: "hello log" });
  assert.equal(fs.readFileSync(path.join(attachments, "task_1", "notes.log"), "utf8"), "hello log");

  const ev2 = stageFile(attachments, "task_1", src, "second copy");
  assert.equal(ev2.path, "task_1/notes-1.log", "a second file with the same name gets a suffix");
  assert.equal(ev2.caption, "second copy");
  assert.equal(stageFile(attachments, "task_1", src).path, "task_1/notes-2.log");

  assert.equal(stageFile(attachments, "task_1", path.join(root, "clip.webm")).type, "video");
  assert.equal(stageFile(attachments, "task_1", path.join(root, "report.xyz")).type, "file", "unknown extensions fall back to file");
  assert.equal(stageFile(attachments, "task_1", path.join(root, "report.xyz"), undefined, "diff").type, "diff", "an explicit type wins");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pushStaged / takeStaged keep per-task evidence in settings and clear on take", () => {
  const ctx = makeCtx();
  assert.deepEqual(takeStaged(ctx, "task_1"), []);
  pushStaged(ctx, "task_1", { type: "image", path: "task_1/a.png" });
  pushStaged(ctx, "task_1", { type: "video", path: "task_1/b.webm" });
  pushStaged(ctx, "task_2", { type: "file", path: "task_2/c.pdf" });
  assert.deepEqual(
    takeStaged(ctx, "task_1").map((e) => e.path),
    ["task_1/a.png", "task_1/b.webm"],
  );
  assert.deepEqual(takeStaged(ctx, "task_1"), [], "take empties the stage");
  assert.equal(takeStaged(ctx, "task_2").length, 1, "tasks are isolated");
  ctx.db.close();
  fs.rmSync(ctx.root, { recursive: true, force: true });
});
