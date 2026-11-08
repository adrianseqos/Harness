import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, clampPriority, defaultPriority, newId, nowIso } from "../src/store/db.js";

function fresh(): Store {
  return new Store(":memory:");
}

/** Force a deterministic created_at so ordering tests do not depend on the clock. */
function setCreatedAt(db: Store, table: "tasks" | "queue_items", id: string, iso: string): void {
  db.db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(iso, id);
}

test("helpers: newId, nowIso, clampPriority, defaultPriority", () => {
  assert.match(newId("task"), /^task_[0-9a-f]{10}$/);
  assert.notEqual(newId("x"), newId("x"));
  assert.ok(!Number.isNaN(Date.parse(nowIso())));

  assert.equal(clampPriority(undefined), 3);
  assert.equal(clampPriority(null), 3);
  assert.equal(clampPriority(Number.NaN), 3);
  assert.equal(clampPriority(0), 1);
  assert.equal(clampPriority(9), 5);
  assert.equal(clampPriority(2.6), 3);

  assert.equal(defaultPriority("permission"), 1);
  assert.equal(defaultPriority("question"), 2);
  assert.equal(defaultPriority("decision"), 2);
  assert.equal(defaultPriority("review"), 3);
  assert.equal(defaultPriority("idea"), 4);
  assert.equal(defaultPriority("info"), 5);
});

test("tasks: create, get, list, update", () => {
  const db = fresh();
  const t = db.tasks.create({ title: "  Write the memo  ", brief: "Two pages", source: "cli", priority: 9, tags: ["ops"] });
  assert.equal(t.title, "Write the memo");
  assert.equal(t.status, "inbox");
  assert.equal(t.lead, null);
  assert.equal(t.priority, 5, "priority is clamped on create");
  assert.deepEqual(t.tags, ["ops"]);
  assert.equal(t.attempts, 0);
  assert.equal(t.cost_usd, 0);

  const assigned = db.tasks.create({ title: "Fix login", lead: "engineering" });
  assert.equal(assigned.status, "queued", "a task created with a lead is queued straight away");

  assert.deepEqual(db.tasks.get(t.id), t);
  assert.equal(db.tasks.get("task_missing"), null);

  const updated = db.tasks.update(t.id, { status: "queued", lead: "operations", priority: 0, tags: ["a", "b"], result_summary: undefined });
  assert.equal(updated?.status, "queued");
  assert.equal(updated?.lead, "operations");
  assert.equal(updated?.priority, 1, "priority is clamped on update");
  assert.deepEqual(updated?.tags, ["a", "b"]);
  assert.equal(updated?.result_summary, null, "undefined becomes NULL");
  assert.ok(updated!.updated_at >= t.updated_at);

  assert.deepEqual(db.tasks.update(t.id, {}), db.tasks.get(t.id), "empty patch is a no-op");

  assert.equal(db.tasks.list({ status: "queued" }).length, 2);
  assert.equal(db.tasks.list({ status: ["queued", "inbox"] }).length, 2);
  assert.equal(db.tasks.list({ lead: "engineering" }).length, 1);
  assert.equal(db.tasks.list({ limit: 1 }).length, 1);

  db.tasks.addCost(t.id, 0.25);
  db.tasks.addCost(t.id, 0.5);
  assert.equal(db.tasks.get(t.id)?.cost_usd, 0.75);

  db.tasks.setStatus(t.id, "failed", { result_summary: "boom" });
  assert.equal(db.tasks.get(t.id)?.status, "failed");
  assert.equal(db.tasks.get(t.id)?.result_summary, "boom");
  assert.deepEqual(db.tasks.countByStatus(), { failed: 1, queued: 1 });
  db.close();
});

test("tasks: list orders by priority then age; parent_id filter", () => {
  const db = fresh();
  const low = db.tasks.create({ title: "low", priority: 4 });
  const high = db.tasks.create({ title: "high", priority: 1 });
  const child = db.tasks.create({ title: "child", parent_id: high.id });
  setCreatedAt(db, "tasks", low.id, "2025-01-01T00:00:00.000Z");
  setCreatedAt(db, "tasks", high.id, "2025-01-02T00:00:00.000Z");
  assert.deepEqual(
    db.tasks.list().map((t) => t.id),
    [high.id, child.id, low.id],
  );
  assert.deepEqual(db.tasks.list({ parent_id: high.id }).map((t) => t.id), [child.id]);
  db.close();
});

test("tasks: claimNext takes the highest priority, oldest first, and marks it running", () => {
  const db = fresh();
  const older = db.tasks.create({ title: "older p2", lead: "eng", priority: 2 });
  const newer = db.tasks.create({ title: "newer p2", lead: "eng", priority: 2 });
  const urgent = db.tasks.create({ title: "urgent p1", lead: "eng", priority: 1 });
  const otherLead = db.tasks.create({ title: "ops p1", lead: "ops", priority: 1 });
  setCreatedAt(db, "tasks", older.id, "2025-01-01T00:00:00.000Z");
  setCreatedAt(db, "tasks", newer.id, "2025-01-03T00:00:00.000Z");
  setCreatedAt(db, "tasks", urgent.id, "2025-01-05T00:00:00.000Z");

  const first = db.tasks.claimNext("eng");
  assert.equal(first?.id, urgent.id);
  assert.equal(first?.status, "running");
  assert.equal(first?.attempts, 1);
  assert.equal(db.tasks.runningByLead("eng"), 1);

  assert.equal(db.tasks.claimNext("eng")?.id, older.id, "same priority: oldest first");
  assert.equal(db.tasks.claimNext("eng")?.id, newer.id);
  assert.equal(db.tasks.claimNext("eng"), null, "nothing left for this lead");
  assert.equal(db.tasks.runningByLead("eng"), 3);
  assert.equal(db.tasks.get(otherLead.id)?.status, "queued", "other leads' tasks are untouched");

  db.tasks.setStatus(newer.id, "queued");
  const again = db.tasks.claimNext("eng");
  assert.equal(again?.id, newer.id);
  assert.equal(again?.attempts, 2, "attempts count every claim");
  db.close();
});

test("transaction rolls back on error", () => {
  const db = fresh();
  assert.throws(() =>
    db.transaction(() => {
      db.tasks.create({ title: "inside" });
      throw new Error("abort");
    }),
  );
  assert.equal(db.tasks.list().length, 0);
  db.close();
});

test("items: create with defaults, list ordering, update, addEvidence", () => {
  const db = fresh();
  const task = db.tasks.create({ title: "t" });
  const review = db.items.create({ task_id: task.id, lead: "eng", kind: "review", title: " Ship it ", options: [{ key: "approve", label: "Approve" }], recommended: "approve", evidence: [{ type: "text", text: "hi" }] });
  assert.equal(review.title, "Ship it");
  assert.equal(review.status, "open");
  assert.equal(review.priority, 3, "review defaults to priority 3");
  assert.equal(review.answer, null);
  assert.deepEqual(review.meta, {});
  const perm = db.items.create({ task_id: task.id, lead: "eng", kind: "permission", title: "git push?" });
  assert.equal(perm.priority, 1, "permissions default to priority 1");
  const info = db.items.create({ kind: "info", title: "brief", priority: 99 });
  assert.equal(info.priority, 5);

  assert.deepEqual(
    db.items.list({ status: "open" }).map((i) => i.id),
    [perm.id, review.id, info.id],
    "open items are sorted by priority",
  );
  assert.equal(db.items.list({ kind: "permission" }).length, 1);
  assert.equal(db.items.list({ lead: "eng" }).length, 2);
  assert.equal(db.items.list({ task_id: task.id }).length, 2);
  assert.equal(db.items.get("item_nope"), null);

  const upd = db.items.update(review.id, { priority: 0, meta: { note: "x" }, options: [{ key: "a", label: "A" }] });
  assert.equal(upd?.priority, 1);
  assert.deepEqual(upd?.meta, { note: "x" });
  assert.deepEqual(upd?.options, [{ key: "a", label: "A" }]);

  const withEvidence = db.items.addEvidence(review.id, [{ type: "image", path: "t/shot.png" }]);
  assert.equal(withEvidence?.evidence.length, 2);
  assert.equal(db.items.addEvidence("item_nope", []), null);
  db.close();
});

test("items: answer records a decision with the agreed flag, undo reverses it", () => {
  const db = fresh();
  const task = db.tasks.create({ title: "t" });
  const agree = db.items.create({ task_id: task.id, lead: "eng", kind: "review", title: "a", options: [{ key: "approve", label: "Approve" }], recommended: "approve" });
  const disagree = db.items.create({ task_id: task.id, lead: "eng", kind: "review", title: "b", options: [{ key: "approve", label: "Approve" }], recommended: "approve" });
  const noRec = db.items.create({ task_id: task.id, lead: "ops", kind: "question", title: "c" });

  const r1 = db.items.answer(agree.id, "approve", "nice");
  assert.equal(r1?.item.status, "answered");
  assert.deepEqual(r1?.item.answer, { option: "approve", comment: "nice" });
  assert.ok(r1?.item.answered_at);
  assert.equal(r1?.decision.agreed, 1);
  assert.equal(r1?.decision.recommended, "approve");
  assert.equal(r1?.decision.lead, "eng");
  assert.equal(r1?.decision.kind, "review");
  assert.equal(r1?.decision.distilled, 0);

  assert.equal(db.items.answer(disagree.id, "reject")?.decision.agreed, 0);
  assert.equal(db.items.answer(noRec.id, "answer", "yes")?.decision.agreed, null, "no recommendation means no agreement signal");
  const perm = db.items.create({ task_id: task.id, lead: "eng", kind: "permission", title: "p", options: [{ key: "allow", label: "Allow" }, { key: "allow_always", label: "Allow for this task" }], recommended: "allow" });
  assert.equal(db.items.answer(perm.id, "allow_always")?.decision.agreed, 1, "allow_always counts as agreeing with a recommended allow");
  assert.equal(db.items.answer(agree.id, "reject"), null, "an answered item cannot be answered again");
  assert.equal(db.items.answer("item_nope", "x"), null);

  assert.equal(db.decisions.list().length, 4);
  assert.equal(db.items.undo(agree.id), true);
  assert.equal(db.items.get(agree.id)?.status, "open");
  assert.equal(db.items.get(agree.id)?.answer, null);
  assert.equal(db.decisions.list().length, 3, "undo deletes the decision row");
  assert.equal(db.items.undo(agree.id), false, "nothing to undo on an open item");
  assert.equal(db.items.undo("item_nope"), false);
  db.close();
});

test("items: defer hides from open lists until the time passes; withdrawForTask; openOlderThan; countOpen", () => {
  const db = fresh();
  const task = db.tasks.create({ title: "t" });
  const a = db.items.create({ task_id: task.id, lead: "eng", kind: "question", title: "a" });
  const b = db.items.create({ task_id: task.id, lead: "eng", kind: "review", title: "b" });
  const c = db.items.create({ kind: "info", title: "c" });

  const future = new Date(Date.now() + 3600_000).toISOString();
  db.items.defer(a.id, future);
  assert.deepEqual(db.items.list({ status: "open" }).map((i) => i.id), [b.id, c.id], "deferred items are hidden by default");
  assert.equal(db.items.list({ status: "open", hideDeferred: false }).length, 3);
  db.items.defer(a.id, new Date(Date.now() - 1000).toISOString());
  assert.equal(db.items.list({ status: "open" }).length, 3, "a deferral in the past is visible again");

  const counts = db.items.countOpen();
  assert.equal(counts.total, 3);
  assert.deepEqual(counts.byKind, { question: 1, review: 1, info: 1 });
  assert.deepEqual(counts.byLead, { eng: 2, chief: 1 });

  setCreatedAt(db, "queue_items", b.id, new Date(Date.now() - 48 * 3600_000).toISOString());
  assert.deepEqual(db.items.openOlderThan(24).map((i) => i.id), [b.id]);
  assert.equal(db.items.openOlderThan(72).length, 0);

  db.items.defer(a.id, future);
  assert.equal(db.items.withdrawForTask(task.id, "task cancelled"), 2, "withdraws deferred items too");
  assert.equal(db.items.get(a.id)?.status, "withdrawn");
  assert.equal(db.items.get(a.id)?.meta.withdrawn_reason, "task cancelled");
  assert.equal(db.items.get(c.id)?.status, "open", "items of other tasks stay open");
  assert.equal(db.items.withdrawForTask(task.id, "again"), 0);
  db.close();
});

test("decisions: list, search, markDistilled, countUndistilled, agreementStats", () => {
  const db = fresh();
  const mk = (lead: string, title: string, recommended: string | null) => db.items.create({ lead, kind: "review", title, body: "body text", options: [{ key: "approve", label: "Approve" }], recommended });
  const d1 = db.items.answer(mk("eng", "Add caching", "approve").id, "approve", "ship it")!.decision;
  const d2 = db.items.answer(mk("eng", "Remove feature", "approve").id, "reject", "keep it")!.decision;
  const d3 = db.items.answer(mk("ops", "Draft memo", "approve").id, "approve")!.decision;
  const d4 = db.items.answer(mk("ops", "Free text", null).id, "answer", "whatever")!.decision;

  assert.equal(db.decisions.get(d1.id)?.id, d1.id);
  assert.equal(db.decisions.get("dec_nope"), null);
  assert.equal(db.decisions.list({ lead: "ops" }).length, 2);
  assert.equal(db.decisions.list({ limit: 1 }).length, 1);
  assert.deepEqual(db.decisions.search("caching").map((d) => d.id), [d1.id], "search matches the item title");
  assert.deepEqual(db.decisions.search("keep it").map((d) => d.id), [d2.id], "search matches the comment");
  assert.equal(db.decisions.search("body text").length, 4, "search matches the item body");
  assert.equal(db.decisions.search("100%_literal").length, 0, "LIKE wildcards are escaped");

  const stats = db.decisions.agreementStats();
  assert.deepEqual(stats.overall, { total: 3, agreed: 2, rate: 2 / 3 });
  assert.deepEqual(stats.byLead.eng, { total: 2, agreed: 1, rate: 0.5 });
  assert.deepEqual(stats.byLead.ops, { total: 1, agreed: 1, rate: 1 });
  assert.equal(stats.last20, 2 / 3);
  assert.equal(fresh().decisions.agreementStats().last20, null);

  assert.equal(db.decisions.countUndistilled(), 4);
  db.decisions.markDistilled([d1.id, d3.id]);
  db.decisions.markDistilled([]);
  assert.equal(db.decisions.countUndistilled(), 2);
  assert.deepEqual(new Set(db.decisions.list({ undistilledOnly: true }).map((d) => d.id)), new Set([d2.id, d4.id]));
  db.close();
});

test("runs: create, update, finish, list, costSince, cancelStale", () => {
  const db = fresh();
  const task = db.tasks.create({ title: "t" });
  const r1 = db.runs.create({ task_id: task.id, agent: "lead:eng", log_path: "/tmp/a.jsonl" });
  assert.equal(r1.status, "running");
  assert.equal(r1.cost_usd, 0);
  assert.equal(r1.ended_at, null);
  assert.equal(db.runs.get("run_nope"), null);

  const done = db.runs.finish(r1.id, "success", { cost_usd: 1.5, turns: 12, summary: "ok", session_id: "sess_1" });
  assert.equal(done?.status, "success");
  assert.equal(done?.cost_usd, 1.5);
  assert.equal(done?.turns, 12);
  assert.equal(done?.session_id, "sess_1");
  assert.ok(done?.ended_at);

  const r2 = db.runs.create({ agent: "chief" });
  db.runs.update(r2.id, { cost_usd: 0.5 });
  const r3 = db.runs.create({ agent: "brain" });
  db.runs.finish(r3.id, "error", { cost_usd: 0.25, summary: "failed" });

  assert.equal(db.runs.list({ task_id: task.id }).length, 1);
  assert.equal(db.runs.list({ agent: "chief" }).length, 1);
  assert.equal(db.runs.list({ status: "running" }).length, 1);
  assert.equal(db.runs.list({ limit: 2 }).length, 2);
  assert.equal(db.runs.costSince("2000-01-01T00:00:00.000Z"), 2.25);
  assert.equal(db.runs.costSince(new Date(Date.now() + 60_000).toISOString()), 0);

  assert.equal(db.runs.cancelStale(), 1, "only runs still marked running are cancelled");
  assert.equal(db.runs.get(r2.id)?.status, "cancelled");
  assert.equal(db.runs.get(r2.id)?.summary, "process restarted");
  assert.equal(db.runs.get(r3.id)?.summary, "failed", "existing summaries are kept");
  assert.equal(db.runs.cancelStale(), 0);
  db.close();
});

test("ideas: create, list by status, update", () => {
  const db = fresh();
  const idea = db.ideas.create({ lead: "eng", title: "  Cache the API  ", body: "faster" });
  assert.equal(idea.title, "Cache the API");
  assert.equal(idea.status, "new");
  assert.equal(idea.item_id, null);
  db.ideas.update(idea.id, { status: "parked", item_id: "item_1" });
  assert.equal(db.ideas.get(idea.id)?.status, "parked");
  assert.equal(db.ideas.get(idea.id)?.item_id, "item_1");
  assert.equal(db.ideas.list({ status: "parked" }).length, 1);
  assert.equal(db.ideas.list({ status: "new" }).length, 0);
  assert.equal(db.ideas.list().length, 1);
  assert.equal(db.ideas.get("idea_nope"), null);
  db.close();
});

test("events: insert, since, latest, lastId", () => {
  const db = fresh();
  assert.equal(db.events.lastId(), 0);
  const e1 = db.events.insert({ type: "task.created", task_id: "t1", item_id: null, run_id: null, payload: { title: "x" } });
  const e2 = db.events.insert({ type: "item.created", task_id: "t1", item_id: "i1", run_id: null, payload: {} });
  const e3 = db.events.insert({ type: "run.started", task_id: "t2", item_id: null, run_id: "r1", payload: { agent: "chief" } });
  assert.equal(e1.id, 1);
  assert.equal(db.events.lastId(), 3);
  assert.deepEqual(db.events.since(e1.id).map((e) => e.id), [e2.id, e3.id]);
  assert.equal(db.events.since(0, 2).length, 2);
  assert.deepEqual(db.events.latest(2).map((e) => e.id), [e2.id, e3.id], "latest returns the newest in chronological order");
  assert.deepEqual(db.events.latest(10, "t1").map((e) => e.type), ["task.created", "item.created"]);
  assert.deepEqual(db.events.latest(10)[2].payload, { agent: "chief" });
  db.close();
});

test("brain versions: saveVersion, versions, latest, get", () => {
  const db = fresh();
  assert.equal(db.brain.latest(), null);
  const v1 = db.brain.saveVersion("# v1", 3, "first");
  db.db.prepare("UPDATE brain_versions SET created_at = ? WHERE id = ?").run("2025-01-01T00:00:00.000Z", v1.id);
  const v2 = db.brain.saveVersion("# v2", 8, null);
  assert.equal(db.brain.latest()?.id, v2.id);
  assert.equal(db.brain.get(v1.id)?.content, "# v1");
  assert.equal(db.brain.get(v1.id)?.decisions_covered, 3);
  assert.equal(db.brain.get(v1.id)?.notes, "first");
  assert.equal(db.brain.get(v2.id)?.notes, null);
  assert.deepEqual(db.brain.versions().map((v) => v.id), [v2.id, v1.id]);
  assert.equal(db.brain.versions(1).length, 1);
  assert.equal(db.brain.get("brain_nope"), null);
  db.close();
});

test("settings: get/set and json helpers", () => {
  const db = fresh();
  assert.equal(db.settings.get("paused"), null);
  db.settings.set("paused", "1");
  db.settings.set("paused", "0");
  assert.equal(db.settings.get("paused"), "0", "set upserts");
  assert.deepEqual(db.settings.getJson("evidence:t1", []), []);
  db.settings.setJson("evidence:t1", [{ type: "image", path: "t1/a.png" }]);
  assert.deepEqual(db.settings.getJson("evidence:t1", []), [{ type: "image", path: "t1/a.png" }]);
  db.settings.set("broken", "{not json");
  assert.deepEqual(db.settings.getJson("broken", { fallback: true }), { fallback: true });
  db.close();
});
