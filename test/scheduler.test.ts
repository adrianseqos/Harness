import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOfLocalDay, recoverState, buildContext, costToday } from "../src/scheduler.js";
import { Store } from "../src/store/db.js";
import { resolveConfig, EXAMPLE_CONFIG } from "../src/config.js";

test("startOfLocalDay respects the timezone", () => {
  const now = new Date("2026-11-08T00:30:00Z"); // 01:30 in Berlin, 19:30 the day before in New York
  assert.equal(startOfLocalDay("Europe/Berlin", now), "2026-11-07T23:00:00.000Z");
  assert.equal(startOfLocalDay("America/New_York", now), "2026-11-07T05:00:00.000Z");
  assert.equal(startOfLocalDay("UTC", now), "2026-11-08T00:00:00.000Z");
});

test("recoverState requeues running tasks and cancels stale runs; isPaused follows settings and budget", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sched-"));
  const config = resolveConfig({ ...EXAMPLE_CONFIG, budget: { perTaskUsd: 1, perDayUsd: 0.5 } }, root);
  const db = new Store(":memory:");
  const ctx = buildContext(config, { db, logToFile: false });
  const t = db.tasks.create({ title: "x", lead: "engineering", status: "running" });
  const orphan = db.tasks.create({ title: "y", status: "running" });
  const run = db.runs.create({ task_id: t.id, agent: "lead:engineering" });
  recoverState(ctx);
  assert.equal(db.tasks.get(t.id)!.status, "queued");
  assert.equal(db.tasks.get(orphan.id)!.status, "inbox");
  assert.equal(db.runs.get(run.id)!.status, "cancelled");
  assert.equal(ctx.isPaused(), false);
  db.settings.set("paused", "1");
  assert.equal(ctx.isPaused(), true);
  db.settings.set("paused", "0");
  const r2 = db.runs.create({ agent: "chief" });
  db.runs.finish(r2.id, "success", { cost_usd: 0.75 });
  assert.ok(costToday(ctx) >= 0.75);
  assert.equal(ctx.isPaused(), true, "daily budget exhausted pauses the harness");
  db.close();
});
