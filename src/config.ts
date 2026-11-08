import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HarnessConfig, LeadConfig, PermissionPolicy } from "./types.js";

const McpServer = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const Permissions = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});

const Lead = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/, "lead id must be lowercase letters, digits, - or _"),
  name: z.string(),
  charter: z.string(),
  repos: z.array(z.string()).default([]),
  concurrency: z.number().int().min(1).max(8).default(1),
  onApprove: z.enum(["merge", "pr", "none"]).default("none"),
  model: z.string().optional(),
  subagentModel: z.string().optional(),
  permissions: Permissions.partial().optional(),
  mcpServers: z.record(z.string(), McpServer).optional(),
});

export const ConfigSchema = z.object({
  principal: z
    .object({
      name: z.string().default("Principal"),
      timezone: z.string().default("Europe/Berlin"),
      language: z.string().default("en"),
    })
    .default({ name: "Principal", timezone: "Europe/Berlin", language: "en" }),
  server: z.object({ host: z.string().default("127.0.0.1"), port: z.number().int().default(4242) }).default({ host: "127.0.0.1", port: 4242 }),
  models: z
    .object({
      chief: z.string().default("claude-opus-5-5"),
      lead: z.string().default("claude-opus-5-5"),
      subagent: z.string().default("claude-sonnet-5-5"),
      brain: z.string().default("claude-opus-5-5"),
    })
    .default({ chief: "claude-opus-5-5", lead: "claude-opus-5-5", subagent: "claude-sonnet-5-5", brain: "claude-opus-5-5" }),
  budget: z.object({ perTaskUsd: z.number().positive().default(10), perDayUsd: z.number().positive().default(100) }).default({ perTaskUsd: 10, perDayUsd: 100 }),
  chief: z.object({ intervalSec: z.number().int().min(10).default(60), dailyBriefHour: z.number().int().min(0).max(23).default(8) }).default({ intervalSec: 60, dailyBriefHour: 8 }),
  brain: z.object({ distillEveryDecisions: z.number().int().min(1).default(5), distillIntervalMin: z.number().int().min(5).default(360) }).default({ distillEveryDecisions: 5, distillIntervalMin: 360 }),
  review: z
    .object({
      staleAfterHours: z.number().positive().default(24),
      permissionWaitMin: z.number().positive().default(10),
      leadPollSec: z.number().int().min(2).default(15),
      maxTurns: z.number().int().min(5).default(300),
    })
    .default({ staleAfterHours: 24, permissionWaitMin: 10, leadPollSec: 15, maxTurns: 300 }),
  leads: z.array(Lead).min(1),
  permissions: Permissions.default({ allow: [], ask: [], deny: [] }),
  mcpServers: z.record(z.string(), McpServer).default({}),
  paths: z
    .object({
      data: z.string().default("data"),
      brain: z.string().default("brain"),
      inbox: z.string().default("inbox"),
    })
    .default({ data: "data", brain: "brain", inbox: "inbox" }),
});

export type RawConfig = z.input<typeof ConfigSchema>;

/** Sensible defaults that apply unless the config overrides them. Patterns use Claude Code's permission syntax. */
export const DEFAULT_PERMISSIONS: PermissionPolicy = {
  allow: [
    "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit", "TodoWrite", "Task", "WebFetch", "WebSearch", "Skill",
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git branch*)", "Bash(git checkout*)", "Bash(git switch*)", "Bash(git stash*)", "Bash(git show*)", "Bash(git rev-parse*)", "Bash(git worktree list*)",
    "Bash(ls*)", "Bash(cat*)", "Bash(head*)", "Bash(tail*)", "Bash(wc*)", "Bash(find*)", "Bash(grep*)", "Bash(rg*)", "Bash(pwd*)", "Bash(echo*)", "Bash(which*)", "Bash(env*)", "Bash(date*)", "Bash(mkdir*)", "Bash(cp*)", "Bash(mv*)", "Bash(touch*)", "Bash(diff*)", "Bash(sort*)", "Bash(uniq*)", "Bash(tr*)", "Bash(sed*)", "Bash(awk*)", "Bash(jq*)", "Bash(tree*)",
    "Bash(npm test*)", "Bash(npm run*)", "Bash(npm ci*)", "Bash(npm install*)", "Bash(npx*)", "Bash(pnpm*)", "Bash(yarn*)", "Bash(node*)", "Bash(tsc*)", "Bash(bun*)",
    "Bash(python*)", "Bash(python3*)", "Bash(pytest*)", "Bash(pip*)", "Bash(uv*)", "Bash(poetry*)",
    "Bash(cargo*)", "Bash(go *)", "Bash(make*)", "Bash(gradle*)", "Bash(mvn*)", "Bash(dotnet*)",
    "Bash(prettier*)", "Bash(eslint*)", "Bash(ruff*)", "Bash(black*)",
  ],
  ask: [
    "Bash(git push*)", "Bash(git merge*)", "Bash(git rebase*)", "Bash(git reset --hard*)", "Bash(git clean*)",
    "Bash(gh pr*)", "Bash(gh release*)",
    "Bash(rm -r*)", "Bash(rm -f*)", "Bash(rm -rf*)",
    "Bash(curl*)", "Bash(wget*)", "Bash(ssh*)", "Bash(scp*)", "Bash(docker*)", "Bash(kubectl*)", "Bash(terraform*)",
    "Bash(npm publish*)", "Bash(pip install*)", "Bash(brew*)", "Bash(apt*)",
  ],
  deny: ["Bash(sudo*)", "Bash(su *)", "Bash(git push --force*)", "Bash(git push -f*)", "Bash(mkfs*)", "Bash(dd *)", "Bash(shutdown*)", "Bash(reboot*)", "Bash(:(){*)"],
};

function mergePolicy(base: PermissionPolicy, extra?: Partial<PermissionPolicy>): PermissionPolicy {
  return {
    allow: [...base.allow, ...(extra?.allow ?? [])],
    ask: [...base.ask, ...(extra?.ask ?? [])],
    deny: [...base.deny, ...(extra?.deny ?? [])],
  };
}

export function findConfigFile(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "harness.config.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Load, validate and resolve the config. `file` defaults to the nearest harness.config.json. */
export function loadConfig(file?: string): HarnessConfig {
  const configPath = file ?? findConfigFile();
  if (!configPath) {
    throw new Error("No harness.config.json found. Run `harness init` in the directory where you want the harness to live.");
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return resolveConfig(raw, path.dirname(path.resolve(configPath)));
}

/** Validate a raw config object and resolve all paths relative to `root`. */
export function resolveConfig(raw: unknown, root: string): HarnessConfig {
  const parsed = ConfigSchema.parse(raw);
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));
  const data = abs(parsed.paths.data);
  const brainDir = abs(parsed.paths.brain);
  const inbox = abs(parsed.paths.inbox);
  const ids = new Set<string>();
  const leads: LeadConfig[] = parsed.leads.map((l) => {
    if (ids.has(l.id)) throw new Error(`Duplicate lead id: ${l.id}`);
    ids.add(l.id);
    return { ...l, repos: l.repos.map(abs) };
  });
  const policy = mergePolicy(DEFAULT_PERMISSIONS, parsed.permissions);
  const port = process.env.HARNESS_PORT ? Number(process.env.HARNESS_PORT) : parsed.server.port;
  return {
    principal: parsed.principal,
    server: { host: parsed.server.host, port },
    models: parsed.models,
    budget: parsed.budget,
    chief: parsed.chief,
    brain: parsed.brain,
    review: parsed.review,
    leads,
    permissions: policy,
    mcpServers: parsed.mcpServers,
    paths: {
      root,
      data,
      db: path.join(data, "harness.db"),
      attachments: path.join(data, "attachments"),
      workspaces: path.join(data, "workspaces"),
      logs: path.join(data, "logs"),
      brain: brainDir,
      brainDoc: path.join(brainDir, "principal.md"),
      inbox,
      inboxProcessed: path.join(data, "inbox-processed"),
      web: path.resolve(root, "web"),
    },
  };
}

/** Effective permission policy for one lead (global policy + lead extras). */
export function leadPolicy(config: HarnessConfig, lead: LeadConfig): PermissionPolicy {
  return mergePolicy(config.permissions, lead.permissions);
}

export function ensureDirs(config: HarnessConfig): void {
  for (const p of [config.paths.data, config.paths.attachments, config.paths.workspaces, config.paths.logs, config.paths.brain, config.paths.inbox, config.paths.inboxProcessed]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

export const EXAMPLE_CONFIG = {
  principal: { name: "Adrian", timezone: "Europe/Berlin", language: "en" },
  server: { host: "127.0.0.1", port: 4242 },
  models: { chief: "claude-opus-5-5", lead: "claude-opus-5-5", subagent: "claude-sonnet-5-5", brain: "claude-opus-5-5" },
  budget: { perTaskUsd: 10, perDayUsd: 100 },
  chief: { intervalSec: 60, dailyBriefHour: 8 },
  brain: { distillEveryDecisions: 5, distillIntervalMin: 360 },
  review: { staleAfterHours: 24, permissionWaitMin: 10, leadPollSec: 15, maxTurns: 300 },
  leads: [
    {
      id: "product",
      name: "Product Lead",
      charter: "Owns what we build and why: turns raw asks into crisp specs with acceptance criteria, proposes scope cuts, writes user-facing docs and release notes, and keeps a short roadmap. Produces documents, not code.",
      repos: [],
      concurrency: 1,
      onApprove: "none",
    },
    {
      id: "engineering",
      name: "Engineering Lead",
      charter: "Owns the codebases listed in repos: implements features and fixes on a branch, with tests, a security review and screenshots or a short recording for anything user-visible. Keeps changes small and reviewable.",
      repos: [],
      concurrency: 1,
      onApprove: "pr",
    },
    {
      id: "design",
      name: "Design Lead",
      charter: "Owns how things look and feel: UX flows, copy, visual consistency, accessibility. Produces mockups as HTML, annotated screenshots and concrete change proposals for engineering.",
      repos: [],
      concurrency: 1,
      onApprove: "none",
    },
    {
      id: "operations",
      name: "Operations Lead",
      charter: "Owns everything that keeps the business running: research, analyses, process documents, checklists, drafts of emails and memos, data clean-ups. Produces finished artefacts the principal can send or file as-is.",
      repos: [],
      concurrency: 2,
      onApprove: "none",
    },
  ],
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: {},
  paths: { data: "data", brain: "brain", inbox: "inbox" },
} satisfies RawConfig;
