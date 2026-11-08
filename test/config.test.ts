import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PERMISSIONS, EXAMPLE_CONFIG, ensureDirs, leadPolicy, loadConfig, resolveConfig } from "../src/config.js";

const ROOT = path.resolve(os.tmpdir(), "harness-config-root");

test("resolveConfig(EXAMPLE_CONFIG): resolves every path under the root", () => {
  const c = resolveConfig(EXAMPLE_CONFIG, ROOT);
  assert.equal(c.principal.name, "Adrian");
  assert.equal(c.server.port, 4242);
  assert.equal(c.server.host, "127.0.0.1");
  assert.equal(c.paths.root, ROOT);
  assert.equal(c.paths.data, path.join(ROOT, "data"));
  assert.equal(c.paths.db, path.join(ROOT, "data", "harness.db"));
  assert.equal(c.paths.attachments, path.join(ROOT, "data", "attachments"));
  assert.equal(c.paths.workspaces, path.join(ROOT, "data", "workspaces"));
  assert.equal(c.paths.logs, path.join(ROOT, "data", "logs"));
  assert.equal(c.paths.inboxProcessed, path.join(ROOT, "data", "inbox-processed"));
  assert.equal(c.paths.brain, path.join(ROOT, "brain"));
  assert.equal(c.paths.brainDoc, path.join(ROOT, "brain", "principal.md"));
  assert.equal(c.paths.inbox, path.join(ROOT, "inbox"));
  assert.equal(c.paths.web, path.join(ROOT, "web"));
  assert.deepEqual(
    c.leads.map((l) => l.id),
    ["product", "engineering", "design", "operations"],
  );
  assert.equal(c.leads[1].onApprove, "pr");
  assert.equal(c.leads[3].concurrency, 2);
  assert.deepEqual(c.permissions, DEFAULT_PERMISSIONS, "empty custom rules leave the defaults untouched");
  assert.deepEqual(c.mcpServers, {});
});

test("resolveConfig: absolute paths are kept, relative repo paths are resolved against the root", () => {
  const c = resolveConfig(
    { leads: [{ id: "eng", name: "Eng", charter: "code", repos: ["../sibling", "/abs/repo"] }], paths: { data: "/var/harness", brain: "docs/brain", inbox: "inbox" } },
    ROOT,
  );
  assert.deepEqual(c.leads[0].repos, [path.resolve(ROOT, "../sibling"), "/abs/repo"]);
  assert.equal(c.paths.data, "/var/harness");
  assert.equal(c.paths.db, path.join("/var/harness", "harness.db"));
  assert.equal(c.paths.brainDoc, path.join(ROOT, "docs", "brain", "principal.md"));
});

test("resolveConfig: defaults fill every missing section", () => {
  const c = resolveConfig({ leads: [{ id: "x", name: "X", charter: "c" }] }, ROOT);
  assert.equal(c.principal.name, "Principal");
  assert.equal(c.principal.timezone, "Europe/Berlin");
  assert.equal(c.principal.language, "en");
  assert.equal(c.server.host, "127.0.0.1");
  assert.equal(c.server.port, 4242);
  assert.equal(c.models.chief, "claude-opus-5-5");
  assert.equal(c.models.subagent, "claude-sonnet-5-5");
  assert.deepEqual(c.budget, { perTaskUsd: 10, perDayUsd: 100 });
  assert.deepEqual(c.chief, { intervalSec: 60, dailyBriefHour: 8 });
  assert.deepEqual(c.brain, { distillEveryDecisions: 5, distillIntervalMin: 360 });
  assert.deepEqual(c.review, { staleAfterHours: 24, permissionWaitMin: 10, leadPollSec: 15, maxTurns: 300 });
  assert.deepEqual(c.leads[0], { id: "x", name: "X", charter: "c", repos: [], concurrency: 1, onApprove: "none" });
  assert.deepEqual(c.permissions, DEFAULT_PERMISSIONS);
  assert.equal(c.paths.data, path.join(ROOT, "data"));
});

test("resolveConfig: partial sections keep the remaining defaults", () => {
  const c = resolveConfig({ principal: { name: "Kim" }, server: { port: 5000 }, budget: { perDayUsd: 20 }, leads: [{ id: "x", name: "X", charter: "c" }] }, ROOT);
  assert.equal(c.principal.name, "Kim");
  assert.equal(c.principal.timezone, "Europe/Berlin");
  assert.equal(c.server.port, 5000);
  assert.equal(c.server.host, "127.0.0.1");
  assert.deepEqual(c.budget, { perTaskUsd: 10, perDayUsd: 20 });
});

test("resolveConfig: rejects duplicate, bad or missing leads and out-of-range values", () => {
  const lead = (id: string) => ({ id, name: id, charter: "c" });
  assert.throws(() => resolveConfig({ leads: [lead("eng"), lead("eng")] }, ROOT), /Duplicate lead id: eng/);
  assert.throws(() => resolveConfig({ leads: [lead("Eng Lead")] }, ROOT), /lowercase/);
  assert.throws(() => resolveConfig({ leads: [lead("-bad")] }, ROOT));
  assert.throws(() => resolveConfig({ leads: [] }, ROOT), "at least one lead is required");
  assert.throws(() => resolveConfig({}, ROOT));
  assert.throws(() => resolveConfig({ leads: [{ ...lead("x"), concurrency: 0 }] }, ROOT));
  assert.throws(() => resolveConfig({ leads: [{ ...lead("x"), onApprove: "deploy" }] }, ROOT));
  assert.throws(() => resolveConfig({ leads: [lead("x")], chief: { intervalSec: 1 } }, ROOT), "chief interval below 10 s is rejected");
  assert.throws(() => resolveConfig({ leads: [lead("x")], budget: { perDayUsd: -1 } }, ROOT));
  assert.doesNotThrow(() => resolveConfig({ leads: [lead("deal-sourcing"), lead("ops_2")] }, ROOT));
});

test("resolveConfig: custom permissions are appended to the defaults", () => {
  const c = resolveConfig({ leads: [{ id: "x", name: "X", charter: "c" }], permissions: { allow: ["Bash(deploy*)"], deny: ["WebFetch"] } }, ROOT);
  assert.equal(c.permissions.allow.length, DEFAULT_PERMISSIONS.allow.length + 1);
  assert.ok(c.permissions.allow.includes("Bash(deploy*)"));
  assert.ok(c.permissions.allow.includes("Bash(git status*)"));
  assert.deepEqual(c.permissions.ask, DEFAULT_PERMISSIONS.ask);
  assert.ok(c.permissions.deny.includes("WebFetch"));
  assert.ok(c.permissions.deny.includes("Bash(sudo*)"));
});

test("leadPolicy: merges the lead's extra rules on top of the global policy", () => {
  const c = resolveConfig(
    {
      leads: [
        { id: "eng", name: "Eng", charter: "c", permissions: { allow: ["Bash(terraform plan*)"], ask: ["Bash(npm test*)"] } },
        { id: "ops", name: "Ops", charter: "c" },
      ],
      permissions: { deny: ["Bash(aws*)"] },
    },
    ROOT,
  );
  const eng = leadPolicy(c, c.leads[0]);
  assert.ok(eng.allow.includes("Bash(terraform plan*)"));
  assert.ok(eng.ask.includes("Bash(npm test*)"));
  assert.ok(eng.deny.includes("Bash(aws*)"), "global custom rules carry over");
  assert.ok(eng.deny.includes("Bash(sudo*)"), "defaults carry over");
  const ops = leadPolicy(c, c.leads[1]);
  assert.deepEqual(ops, c.permissions, "a lead without extras gets the global policy");
  assert.ok(!ops.allow.includes("Bash(terraform plan*)"), "lead extras do not leak into other leads");
  assert.notEqual(ops.allow, c.permissions.allow, "leadPolicy returns fresh arrays");
});

test("resolveConfig: per-lead model overrides and mcpServers pass through", () => {
  const c = resolveConfig(
    {
      leads: [{ id: "eng", name: "Eng", charter: "c", model: "claude-sonnet-5-5", subagentModel: "claude-haiku-5", mcpServers: { github: { command: "gh-mcp", args: ["--stdio"], env: { TOKEN: "x" } } } }],
      mcpServers: { fs: { command: "mcp-fs" } },
    },
    ROOT,
  );
  assert.equal(c.leads[0].model, "claude-sonnet-5-5");
  assert.equal(c.leads[0].subagentModel, "claude-haiku-5");
  assert.deepEqual(c.leads[0].mcpServers, { github: { command: "gh-mcp", args: ["--stdio"], env: { TOKEN: "x" } } });
  assert.deepEqual(c.mcpServers, { fs: { command: "mcp-fs" } });
});

test("HARNESS_PORT overrides the configured port", () => {
  const before = process.env.HARNESS_PORT;
  try {
    process.env.HARNESS_PORT = "5151";
    assert.equal(resolveConfig(EXAMPLE_CONFIG, ROOT).server.port, 5151);
    delete process.env.HARNESS_PORT;
    assert.equal(resolveConfig(EXAMPLE_CONFIG, ROOT).server.port, 4242);
  } finally {
    if (before === undefined) delete process.env.HARNESS_PORT;
    else process.env.HARNESS_PORT = before;
  }
});

test("loadConfig reads a file and resolves relative to its directory; ensureDirs creates the data layout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-config-"));
  fs.writeFileSync(path.join(root, "harness.config.json"), JSON.stringify({ principal: { name: "Kim" }, leads: [{ id: "x", name: "X", charter: "c" }] }));
  const c = loadConfig(path.join(root, "harness.config.json"));
  assert.equal(c.principal.name, "Kim");
  assert.equal(c.paths.root, root);
  ensureDirs(c);
  for (const p of [c.paths.data, c.paths.attachments, c.paths.workspaces, c.paths.logs, c.paths.brain, c.paths.inbox, c.paths.inboxProcessed]) {
    assert.ok(fs.statSync(p).isDirectory(), `${p} exists`);
  }
  assert.doesNotThrow(() => ensureDirs(c), "ensureDirs is idempotent");
  fs.rmSync(root, { recursive: true, force: true });
});
