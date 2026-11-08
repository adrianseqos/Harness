/**
 * Shared domain types and module contracts for the harness.
 * Every module imports from here; keep it dependency-free.
 */

// ---------- Config ----------

export type ApproveAction = "merge" | "pr" | "none";

export interface LeadConfig {
  /** Stable identifier, e.g. "engineering". Used in task.lead and queue_items.lead. */
  id: string;
  /** Display name, e.g. "Engineering Lead". */
  name: string;
  /** What this lead owns, in plain language. Injected into its system prompt. */
  charter: string;
  /** Git repositories (absolute or config-relative paths) this lead may work in. Empty = non-code work. */
  repos: string[];
  /** How many tasks this lead may run at once. */
  concurrency: number;
  /** What happens when the principal approves a code change. */
  onApprove: ApproveAction;
  /** Optional model override for this lead. */
  model?: string;
  /** Optional model override for this lead's sub-agents. */
  subagentModel?: string;
  /** Extra permission rules for this lead only. */
  permissions?: Partial<PermissionPolicy>;
  /** Extra MCP servers (stdio) made available to this lead. */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

export interface PermissionPolicy {
  /** Patterns auto-approved without asking (e.g. "Bash(git status*)", "Read", "Edit"). */
  allow: string[];
  /** Patterns that always go to the queue, even if a broader allow pattern matches. */
  ask: string[];
  /** Patterns denied outright, with a message to the agent. */
  deny: string[];
}

export interface HarnessConfig {
  principal: { name: string; timezone: string; language: string };
  server: { host: string; port: number };
  models: { chief: string; lead: string; subagent: string; brain: string };
  budget: { perTaskUsd: number; perDayUsd: number };
  chief: { intervalSec: number; dailyBriefHour: number };
  brain: { distillEveryDecisions: number; distillIntervalMin: number };
  review: { staleAfterHours: number; permissionWaitMin: number; leadPollSec: number; maxTurns: number };
  leads: LeadConfig[];
  permissions: PermissionPolicy;
  /** MCP servers (stdio) available to every lead. */
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Extra environment variable names handed to agent sessions (on top of PATH, HOME, proxy and Claude auth variables). */
  agentEnv: string[];
  /** Resolved absolute paths, filled in by config.ts. */
  paths: {
    root: string;
    data: string;
    db: string;
    attachments: string;
    workspaces: string;
    logs: string;
    brain: string;
    brainDoc: string;
    inbox: string;
    inboxProcessed: string;
    web: string;
  };
}

// ---------- Domain ----------

export type TaskStatus =
  | "inbox" // just created, waiting for the chief
  | "triaged" // chief looked at it but it is not ready to run (e.g. waiting for a question)
  | "queued" // assigned to a lead, waiting for a free slot
  | "running" // a lead session is active
  | "waiting_human" // blocked on a queue item
  | "review" // review package submitted, waiting for the principal
  | "done"
  | "rejected"
  | "failed"
  | "parked";

export type TaskSource = "ui" | "cli" | "inbox" | "chief" | "lead" | "idea" | "system";

export interface Task {
  id: string;
  title: string;
  brief: string;
  source: TaskSource;
  status: TaskStatus;
  lead: string | null;
  priority: number; // 1 (highest) .. 5
  parent_id: string | null;
  repo: string | null;
  workdir: string | null;
  branch: string | null;
  base_ref: string | null; // commit the branch started from
  session_id: string | null; // Claude Agent SDK session id of the lead run
  result_summary: string | null;
  cost_usd: number;
  attempts: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  due_at: string | null;
}

export type ItemKind = "review" | "decision" | "question" | "permission" | "idea" | "info";
export type ItemStatus = "open" | "answered" | "withdrawn" | "expired";

export interface ItemOption {
  key: string;
  label: string;
  description?: string;
}

export type EvidenceType = "image" | "video" | "diff" | "file" | "link" | "text";

export interface Evidence {
  type: EvidenceType;
  /** Path relative to the attachments dir (served at /attachments/...), or an absolute URL for links. */
  path?: string;
  url?: string;
  caption?: string;
  /** Inline text for type=text (short). */
  text?: string;
}

export interface QueueItem {
  id: string;
  task_id: string | null;
  lead: string | null;
  kind: ItemKind;
  title: string;
  body: string; // markdown
  options: ItemOption[];
  recommended: string | null;
  rationale: string | null;
  evidence: Evidence[];
  priority: number;
  status: ItemStatus;
  answer: { option: string; comment: string } | null;
  meta: Record<string, unknown>;
  created_at: string;
  answered_at: string | null;
  deadline_at: string | null;
  deferred_until: string | null;
}

export interface Decision {
  id: string;
  item_id: string;
  task_id: string | null;
  lead: string | null;
  kind: ItemKind;
  option: string;
  comment: string;
  recommended: string | null;
  agreed: number | null; // 1 / 0 / null when there was no recommendation
  created_at: string;
  distilled: number; // 0/1
}

export type RunStatus = "running" | "success" | "error" | "cancelled";

export interface Run {
  id: string;
  task_id: string | null;
  agent: string; // "chief" | "lead:<id>" | "brain" | "system"
  session_id: string | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  cost_usd: number;
  turns: number;
  summary: string | null;
  log_path: string | null;
}

export type IdeaStatus = "new" | "queued" | "parked" | "discarded" | "pursued";

export interface Idea {
  id: string;
  lead: string | null;
  task_id: string | null;
  title: string;
  body: string;
  status: IdeaStatus;
  item_id: string | null;
  created_at: string;
}

export interface Event {
  id: number;
  ts: string;
  type: string;
  task_id: string | null;
  item_id: string | null;
  run_id: string | null;
  payload: Record<string, unknown>;
}

export interface BrainVersion {
  id: string;
  created_at: string;
  content: string;
  decisions_covered: number;
  notes: string | null;
}

// ---------- Module contracts ----------

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Shape of events emitted on the in-process bus (mirrors the `events` table). */
export interface BusEvent {
  type: string;
  task_id?: string | null;
  item_id?: string | null;
  run_id?: string | null;
  payload?: Record<string, unknown>;
}

export interface Bus {
  emit(ev: BusEvent): void;
  on(type: string | "*", handler: (ev: Event) => void): () => void;
  /** Resolves when an event of `type` matching `pred` arrives or the timeout passes (resolves null). */
  waitFor(type: string, pred: (ev: Event) => boolean, timeoutMs: number): Promise<Event | null>;
}

/** Context handed to every loop and agent. */
export interface HarnessContext {
  config: HarnessConfig;
  db: import("./store/db.js").Store;
  bus: Bus;
  log: Logger;
  runner: import("./agents/runner.js").Runner;
  /** True while the principal has paused all agents or the daily budget is exhausted. */
  isPaused(): boolean;
}

export interface Loop {
  name: string;
  stop(): Promise<void>;
}
