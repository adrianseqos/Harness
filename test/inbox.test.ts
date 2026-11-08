import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInboxFile, startInboxWatcher } from "../src/inbox.js";
import { Store } from "../src/store/db.js";
import { createBus } from "../src/bus.js";
import { createLogger } from "../src/logger.js";
import { resolveConfig, EXAMPLE_CONFIG, ensureDirs } from "../src/config.js";
import type { HarnessContext } from "../src/types.js";

test("parseInboxFile: heading becomes the title, front matter is read", () => {
  const p = parseInboxFile(`---\nlead: engineering\npriority: 2\nrepo: /x/y\n---\n# Fix the login bug\n\nUsers cannot log in on Safari.\n`, "fix.md");
  assert.equal(p.title, "Fix the login bug");
  assert.equal(p.brief, "Users cannot log in on Safari.");
  assert.equal(p.lead, "engineering");
  assert.equal(p.priority, 2);
  assert.equal(p.repo, "/x/y");
});

test("parseInboxFile: falls back to the file name", () => {
  const p = parseInboxFile("just a brief", "write-the-memo.md");
  assert.equal(p.title, "write the memo");
  assert.equal(p.brief, "just a brief");
  assert.equal(p.lead, undefined);
});

test("inbox watcher turns a dropped file into a task and moves it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-inbox-"));
  const config = resolveConfig(EXAMPLE_CONFIG, root);
  ensureDirs(config);
  const db = new Store(":memory:");
  const ctx: HarnessContext = { config, db, bus: createBus(db), log: createLogger("test"), runner: { run: async () => { throw new Error("no runner") }, active: () => [], cancel: () => false, cancelTask: () => 0 }, isPaused: () => false };
  const loop = startInboxWatcher(ctx);
  fs.writeFileSync(path.join(config.paths.inbox, "hello.md"), "# Say hello\n\nWrite a greeting.\n");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && db.tasks.list().length === 0) await new Promise((r) => setTimeout(r, 100));
  await loop.stop();
  const tasks = db.tasks.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Say hello");
  assert.equal(tasks[0].status, "inbox");
  assert.equal(tasks[0].source, "inbox");
  assert.equal(fs.existsSync(path.join(config.paths.inbox, "hello.md")), false);
  assert.ok(fs.readdirSync(config.paths.inboxProcessed).some((f) => f.endsWith("hello.md")));
  db.close();
});
