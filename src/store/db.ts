import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  BrainVersion, Decision, Event, Evidence, Idea, IdeaStatus, ItemKind, ItemOption, ItemStatus, QueueItem, Run, RunStatus, Task, TaskSource, TaskStatus,
} from "../types.js";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ui',
  status TEXT NOT NULL DEFAULT 'inbox',
  lead TEXT,
  priority INTEGER NOT NULL DEFAULT 3,
  parent_id TEXT,
  repo TEXT,
  workdir TEXT,
  branch TEXT,
  base_ref TEXT,
  session_id TEXT,
  result_summary TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  due_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, lead, priority, created_at);

CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  lead TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  recommended TEXT,
  rationale TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  answered_at TEXT,
  deadline_at TEXT,
  deferred_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON queue_items(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_items_task ON queue_items(task_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  task_id TEXT,
  lead TEXT,
  kind TEXT NOT NULL,
  option TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  recommended TEXT,
  agreed INTEGER,
  created_at TEXT NOT NULL,
  distilled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_decisions_distilled ON decisions(distilled, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  agent TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  log_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  lead TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  item_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  task_id TEXT,
  item_id TEXT,
  run_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(id);

CREATE TABLE IF NOT EXISTS brain_versions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  content TEXT NOT NULL,
  decisions_covered INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function j<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(r: Row): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    brief: r.brief as string,
    source: r.source as TaskSource,
    status: r.status as TaskStatus,
    lead: (r.lead as string) ?? null,
    priority: r.priority as number,
    parent_id: (r.parent_id as string) ?? null,
    repo: (r.repo as string) ?? null,
    workdir: (r.workdir as string) ?? null,
    branch: (r.branch as string) ?? null,
    base_ref: (r.base_ref as string) ?? null,
    session_id: (r.session_id as string) ?? null,
    result_summary: (r.result_summary as string) ?? null,
    cost_usd: (r.cost_usd as number) ?? 0,
    attempts: (r.attempts as number) ?? 0,
    tags: j<string[]>(r.tags, []),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    due_at: (r.due_at as string) ?? null,
  };
}

function rowToItem(r: Row): QueueItem {
  return {
    id: r.id as string,
    task_id: (r.task_id as string) ?? null,
    lead: (r.lead as string) ?? null,
    kind: r.kind as ItemKind,
    title: r.title as string,
    body: r.body as string,
    options: j<ItemOption[]>(r.options, []),
    recommended: (r.recommended as string) ?? null,
    rationale: (r.rationale as string) ?? null,
    evidence: j<Evidence[]>(r.evidence, []),
    priority: r.priority as number,
    status: r.status as ItemStatus,
    answer: j<{ option: string; comment: string } | null>(r.answer, null),
    meta: j<Record<string, unknown>>(r.meta, {}),
    created_at: r.created_at as string,
    answered_at: (r.answered_at as string) ?? null,
    deadline_at: (r.deadline_at as string) ?? null,
    deferred_until: (r.deferred_until as string) ?? null,
  };
}

function rowToDecision(r: Row): Decision {
  return {
    id: r.id as string,
    item_id: r.item_id as string,
    task_id: (r.task_id as string) ?? null,
    lead: (r.lead as string) ?? null,
    kind: r.kind as ItemKind,
    option: r.option as string,
    comment: r.comment as string,
    recommended: (r.recommended as string) ?? null,
    agreed: (r.agreed as number) ?? null,
    created_at: r.created_at as string,
    distilled: r.distilled as number,
  };
}

function rowToRun(r: Row): Run {
  return {
    id: r.id as string,
    task_id: (r.task_id as string) ?? null,
    agent: r.agent as string,
    session_id: (r.session_id as string) ?? null,
    status: r.status as RunStatus,
    started_at: r.started_at as string,
    ended_at: (r.ended_at as string) ?? null,
    cost_usd: (r.cost_usd as number) ?? 0,
    turns: (r.turns as number) ?? 0,
    summary: (r.summary as string) ?? null,
    log_path: (r.log_path as string) ?? null,
  };
}

function rowToIdea(r: Row): Idea {
  return {
    id: r.id as string,
    lead: (r.lead as string) ?? null,
    task_id: (r.task_id as string) ?? null,
    title: r.title as string,
    body: r.body as string,
    status: r.status as IdeaStatus,
    item_id: (r.item_id as string) ?? null,
    created_at: r.created_at as string,
  };
}

function rowToEvent(r: Row): Event {
  return {
    id: r.id as number,
    ts: r.ts as string,
    type: r.type as string,
    task_id: (r.task_id as string) ?? null,
    item_id: (r.item_id as string) ?? null,
    run_id: (r.run_id as string) ?? null,
    payload: j<Record<string, unknown>>(r.payload, {}),
  };
}

function rowToBrain(r: Row): BrainVersion {
  return {
    id: r.id as string,
    created_at: r.created_at as string,
    content: r.content as string,
    decisions_covered: r.decisions_covered as number,
    notes: (r.notes as string) ?? null,
  };
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  lead?: string;
  parent_id?: string;
  limit?: number;
}

export interface ItemFilter {
  status?: ItemStatus | ItemStatus[];
  kind?: ItemKind;
  lead?: string;
  task_id?: string;
  limit?: number;
  /** When true, items whose deferred_until is in the future are hidden (default true for open lists). */
  hideDeferred?: boolean;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- tasks ----------

  readonly tasks = {
    create: (input: { title: string; brief?: string; source?: TaskSource; lead?: string | null; priority?: number; parent_id?: string | null; repo?: string | null; tags?: string[]; status?: TaskStatus; due_at?: string | null }): Task => {
      const id = newId("task");
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, brief, source, status, lead, priority, parent_id, repo, tags, created_at, updated_at, due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title.trim(),
          input.brief ?? "",
          input.source ?? "ui",
          input.status ?? (input.lead ? "queued" : "inbox"),
          input.lead ?? null,
          clampPriority(input.priority),
          input.parent_id ?? null,
          input.repo ?? null,
          JSON.stringify(input.tags ?? []),
          ts,
          ts,
          input.due_at ?? null,
        );
      return this.tasks.get(id)!;
    },
    get: (id: string): Task | null => {
      const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
      return r ? rowToTask(r) : null;
    },
    list: (f: TaskFilter = {}): Task[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (f.status) {
        const arr = Array.isArray(f.status) ? f.status : [f.status];
        where.push(`status IN (${arr.map(() => "?").join(",")})`);
        params.push(...arr);
      }
      if (f.lead) {
        where.push("lead = ?");
        params.push(f.lead);
      }
      if (f.parent_id) {
        where.push("parent_id = ?");
        params.push(f.parent_id);
      }
      const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY priority ASC, created_at ASC LIMIT ?`;
      params.push(f.limit ?? 500);
      return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map(rowToTask);
    },
    update: (id: string, patch: Partial<Omit<Task, "id" | "created_at">>): Task | null => {
      const keys = Object.keys(patch).filter((k) => k !== "id" && k !== "created_at");
      if (!keys.length) return this.tasks.get(id);
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      const vals = keys.map((k) => {
        const v = (patch as Record<string, unknown>)[k];
        if (k === "tags") return JSON.stringify(v ?? []);
        if (k === "priority") return clampPriority(v as number);
        return v === undefined ? null : v;
      });
      this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...(vals as never[]), nowIso(), id);
      return this.tasks.get(id);
    },
    setStatus: (id: string, status: TaskStatus, extra: Partial<Task> = {}): Task | null => this.tasks.update(id, { ...extra, status }),
    addCost: (id: string, usd: number): void => {
      this.db.prepare("UPDATE tasks SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?").run(usd, nowIso(), id);
    },
    /** Atomically claim the next queued task for a lead. Returns null when nothing is queued. */
    claimNext: (lead: string): Task | null =>
      this.transaction(() => {
        const r = this.db
          .prepare("SELECT * FROM tasks WHERE status = 'queued' AND lead = ? ORDER BY priority ASC, created_at ASC LIMIT 1")
          .get(lead) as Row | undefined;
        if (!r) return null;
        this.db.prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), r.id as string);
        return this.tasks.get(r.id as string);
      }),
    countByStatus: (): Record<string, number> => {
      const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Row[];
      const out: Record<string, number> = {};
      for (const r of rows) out[r.status as string] = r.n as number;
      return out;
    },
    runningByLead: (lead: string): number => {
      const r = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE lead = ? AND status = 'running'").get(lead) as Row;
      return r.n as number;
    },
  };

  // ---------- queue items ----------

  readonly items = {
    create: (input: {
      task_id?: string | null;
      lead?: string | null;
      kind: ItemKind;
      title: string;
      body?: string;
      options?: ItemOption[];
      recommended?: string | null;
      rationale?: string | null;
      evidence?: Evidence[];
      priority?: number;
      meta?: Record<string, unknown>;
      deadline_at?: string | null;
    }): QueueItem => {
      const id = newId("item");
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO queue_items (id, task_id, lead, kind, title, body, options, recommended, rationale, evidence, priority, status, meta, created_at, deadline_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(
          id,
          input.task_id ?? null,
          input.lead ?? null,
          input.kind,
          input.title.trim(),
          input.body ?? "",
          JSON.stringify(input.options ?? []),
          input.recommended ?? null,
          input.rationale ?? null,
          JSON.stringify(input.evidence ?? []),
          clampPriority(input.priority ?? defaultPriority(input.kind)),
          JSON.stringify(input.meta ?? {}),
          ts,
          input.deadline_at ?? null,
        );
      return this.items.get(id)!;
    },
    get: (id: string): QueueItem | null => {
      const r = this.db.prepare("SELECT * FROM queue_items WHERE id = ?").get(id) as Row | undefined;
      return r ? rowToItem(r) : null;
    },
    list: (f: ItemFilter = {}): QueueItem[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (f.status) {
        const arr = Array.isArray(f.status) ? f.status : [f.status];
        where.push(`status IN (${arr.map(() => "?").join(",")})`);
        params.push(...arr);
      }
      if (f.kind) {
        where.push("kind = ?");
        params.push(f.kind);
      }
      if (f.lead) {
        where.push("lead = ?");
        params.push(f.lead);
      }
      if (f.task_id) {
        where.push("task_id = ?");
        params.push(f.task_id);
      }
      if (f.hideDeferred ?? (f.status === "open")) {
        where.push("(deferred_until IS NULL OR deferred_until <= ?)");
        params.push(nowIso());
      }
      const sql = `SELECT * FROM queue_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, priority ASC, created_at ASC LIMIT ?`;
      params.push(f.limit ?? 500);
      return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map(rowToItem);
    },
    update: (id: string, patch: Partial<Omit<QueueItem, "id" | "created_at">>): QueueItem | null => {
      const keys = Object.keys(patch).filter((k) => k !== "id" && k !== "created_at");
      if (!keys.length) return this.items.get(id);
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      const vals = keys.map((k) => {
        const v = (patch as Record<string, unknown>)[k];
        if (k === "options" || k === "evidence" || k === "meta") return JSON.stringify(v ?? (k === "meta" ? {} : []));
        if (k === "answer") return v == null ? null : JSON.stringify(v);
        if (k === "priority") return clampPriority(v as number);
        return v === undefined ? null : v;
      });
      this.db.prepare(`UPDATE queue_items SET ${sets} WHERE id = ?`).run(...(vals as never[]), id);
      return this.items.get(id);
    },
    addEvidence: (id: string, ev: Evidence[]): QueueItem | null => {
      const item = this.items.get(id);
      if (!item) return null;
      return this.items.update(id, { evidence: [...item.evidence, ...ev] });
    },
    /** Record the principal's answer and the matching decision row. Returns null if the item is not open. */
    answer: (id: string, option: string, comment = ""): { item: QueueItem; decision: Decision } | null =>
      this.transaction(() => {
        const item = this.items.get(id);
        if (!item || item.status !== "open") return null;
        const ts = nowIso();
        this.db.prepare("UPDATE queue_items SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(JSON.stringify({ option, comment }), ts, id);
        const agreed = item.recommended ? (item.recommended === option ? 1 : 0) : null;
        const did = newId("dec");
        this.db
          .prepare(
            `INSERT INTO decisions (id, item_id, task_id, lead, kind, option, comment, recommended, agreed, created_at, distilled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(did, id, item.task_id, item.lead, item.kind, option, comment, item.recommended, agreed, ts);
        return { item: this.items.get(id)!, decision: this.decisions.get(did)! };
      }),
    /** Undo an answer: reopens the item and deletes its decision. Returns false if nothing to undo. */
    undo: (id: string): boolean =>
      this.transaction(() => {
        const item = this.items.get(id);
        if (!item || item.status !== "answered") return false;
        this.db.prepare("DELETE FROM decisions WHERE item_id = ?").run(id);
        this.db.prepare("UPDATE queue_items SET status = 'open', answer = NULL, answered_at = NULL WHERE id = ?").run(id);
        return true;
      }),
    defer: (id: string, until: string): QueueItem | null => this.items.update(id, { deferred_until: until }),
    withdrawForTask: (task_id: string, reason: string): number => {
      const open = this.items.list({ task_id, status: "open", hideDeferred: false });
      for (const it of open) this.items.update(it.id, { status: "withdrawn", meta: { ...it.meta, withdrawn_reason: reason } });
      return open.length;
    },
    countOpen: (): { total: number; byKind: Record<string, number>; byLead: Record<string, number>; stale: number } => {
      const rows = this.db.prepare("SELECT kind, lead, created_at FROM queue_items WHERE status = 'open' AND (deferred_until IS NULL OR deferred_until <= ?)").all(nowIso()) as Row[];
      const byKind: Record<string, number> = {};
      const byLead: Record<string, number> = {};
      for (const r of rows) {
        byKind[r.kind as string] = (byKind[r.kind as string] ?? 0) + 1;
        const l = (r.lead as string) ?? "chief";
        byLead[l] = (byLead[l] ?? 0) + 1;
      }
      return { total: rows.length, byKind, byLead, stale: 0 };
    },
    openOlderThan: (hours: number): QueueItem[] => {
      const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
      return (this.db.prepare("SELECT * FROM queue_items WHERE status = 'open' AND created_at < ? ORDER BY priority ASC, created_at ASC").all(cutoff) as Row[]).map(rowToItem);
    },
  };

  // ---------- decisions ----------

  readonly decisions = {
    get: (id: string): Decision | null => {
      const r = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
      return r ? rowToDecision(r) : null;
    },
    list: (f: { undistilledOnly?: boolean; limit?: number; lead?: string } = {}): Decision[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (f.undistilledOnly) where.push("distilled = 0");
      if (f.lead) {
        where.push("lead = ?");
        params.push(f.lead);
      }
      const sql = `SELECT * FROM decisions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
      params.push(f.limit ?? 200);
      return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map(rowToDecision);
    },
    search: (q: string, limit = 20): Decision[] => {
      const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
      return (
        this.db
          .prepare(
            `SELECT d.* FROM decisions d JOIN queue_items i ON i.id = d.item_id
             WHERE d.comment LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\'
             ORDER BY d.created_at DESC LIMIT ?`,
          )
          .all(like, like, like, limit) as Row[]
      ).map(rowToDecision);
    },
    markDistilled: (ids: string[]): void => {
      if (!ids.length) return;
      this.db.prepare(`UPDATE decisions SET distilled = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    },
    countUndistilled: (): number => (this.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE distilled = 0").get() as Row).n as number,
    /** Agreement between the leads' recommendations and the principal's actual choice. */
    agreementStats: (): { overall: { total: number; agreed: number; rate: number | null }; byLead: Record<string, { total: number; agreed: number; rate: number | null }>; last20: number | null } => {
      const rows = this.db.prepare("SELECT lead, agreed, created_at FROM decisions WHERE agreed IS NOT NULL ORDER BY created_at DESC").all() as Row[];
      const byLead: Record<string, { total: number; agreed: number; rate: number | null }> = {};
      let total = 0;
      let agreed = 0;
      for (const r of rows) {
        const l = (r.lead as string) ?? "chief";
        byLead[l] ??= { total: 0, agreed: 0, rate: null };
        byLead[l].total++;
        total++;
        if (r.agreed === 1) {
          byLead[l].agreed++;
          agreed++;
        }
      }
      for (const l of Object.keys(byLead)) byLead[l].rate = byLead[l].total ? byLead[l].agreed / byLead[l].total : null;
      const last = rows.slice(0, 20);
      const last20 = last.length ? last.filter((r) => r.agreed === 1).length / last.length : null;
      return { overall: { total, agreed, rate: total ? agreed / total : null }, byLead, last20 };
    },
  };

  // ---------- runs ----------

  readonly runs = {
    create: (input: { task_id?: string | null; agent: string; session_id?: string | null; log_path?: string | null }): Run => {
      const id = newId("run");
      this.db
        .prepare("INSERT INTO runs (id, task_id, agent, session_id, status, started_at, log_path) VALUES (?, ?, ?, ?, 'running', ?, ?)")
        .run(id, input.task_id ?? null, input.agent, input.session_id ?? null, nowIso(), input.log_path ?? null);
      return this.runs.get(id)!;
    },
    get: (id: string): Run | null => {
      const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
      return r ? rowToRun(r) : null;
    },
    update: (id: string, patch: Partial<Omit<Run, "id">>): Run | null => {
      const keys = Object.keys(patch);
      if (!keys.length) return this.runs.get(id);
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      const vals = keys.map((k) => ((patch as Record<string, unknown>)[k] === undefined ? null : (patch as Record<string, unknown>)[k]));
      this.db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...(vals as never[]), id);
      return this.runs.get(id);
    },
    finish: (id: string, status: RunStatus, extra: { cost_usd?: number; turns?: number; summary?: string | null; session_id?: string | null } = {}): Run | null =>
      this.runs.update(id, { status, ended_at: nowIso(), ...extra }),
    list: (f: { task_id?: string; agent?: string; limit?: number; status?: RunStatus } = {}): Run[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (f.task_id) {
        where.push("task_id = ?");
        params.push(f.task_id);
      }
      if (f.agent) {
        where.push("agent = ?");
        params.push(f.agent);
      }
      if (f.status) {
        where.push("status = ?");
        params.push(f.status);
      }
      const sql = `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC LIMIT ?`;
      params.push(f.limit ?? 100);
      return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map(rowToRun);
    },
    costSince: (iso: string): number => {
      const r = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE started_at >= ?").get(iso) as Row;
      return (r.c as number) ?? 0;
    },
    /** Mark runs left 'running' by a previous process as cancelled. */
    cancelStale: (): number => {
      const r = this.db.prepare("UPDATE runs SET status = 'cancelled', ended_at = ?, summary = COALESCE(summary, 'process restarted') WHERE status = 'running'").run(nowIso());
      return Number(r.changes);
    },
  };

  // ---------- ideas ----------

  readonly ideas = {
    create: (input: { lead?: string | null; task_id?: string | null; title: string; body?: string }): Idea => {
      const id = newId("idea");
      this.db.prepare("INSERT INTO ideas (id, lead, task_id, title, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)").run(id, input.lead ?? null, input.task_id ?? null, input.title.trim(), input.body ?? "", nowIso());
      return this.ideas.get(id)!;
    },
    get: (id: string): Idea | null => {
      const r = this.db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as Row | undefined;
      return r ? rowToIdea(r) : null;
    },
    list: (f: { status?: IdeaStatus; limit?: number } = {}): Idea[] => {
      const sql = f.status ? "SELECT * FROM ideas WHERE status = ? ORDER BY created_at DESC LIMIT ?" : "SELECT * FROM ideas ORDER BY created_at DESC LIMIT ?";
      const params = f.status ? [f.status, f.limit ?? 200] : [f.limit ?? 200];
      return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map(rowToIdea);
    },
    update: (id: string, patch: Partial<Pick<Idea, "status" | "item_id" | "title" | "body">>): Idea | null => {
      const keys = Object.keys(patch);
      if (!keys.length) return this.ideas.get(id);
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      const vals = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
      this.db.prepare(`UPDATE ideas SET ${sets} WHERE id = ?`).run(...(vals as never[]), id);
      return this.ideas.get(id);
    },
  };

  // ---------- events ----------

  readonly events = {
    insert: (ev: { type: string; task_id: string | null; item_id: string | null; run_id: string | null; payload: Record<string, unknown> }): Event => {
      const ts = nowIso();
      const r = this.db.prepare("INSERT INTO events (ts, type, task_id, item_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?)").run(ts, ev.type, ev.task_id, ev.item_id, ev.run_id, JSON.stringify(ev.payload ?? {}));
      return { id: Number(r.lastInsertRowid), ts, ...ev };
    },
    since: (id: number, limit = 200): Event[] => (this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(id, limit) as Row[]).map(rowToEvent),
    latest: (limit = 100, task_id?: string): Event[] => {
      const rows = task_id
        ? (this.db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(task_id, limit) as Row[])
        : (this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Row[]);
      return rows.map(rowToEvent).reverse();
    },
    lastId: (): number => ((this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as Row).m as number) ?? 0,
  };

  // ---------- brain ----------

  readonly brain = {
    saveVersion: (content: string, decisions_covered: number, notes: string | null): BrainVersion => {
      const id = newId("brain");
      this.db.prepare("INSERT INTO brain_versions (id, created_at, content, decisions_covered, notes) VALUES (?, ?, ?, ?, ?)").run(id, nowIso(), content, decisions_covered, notes);
      return this.brain.get(id)!;
    },
    get: (id: string): BrainVersion | null => {
      const r = this.db.prepare("SELECT * FROM brain_versions WHERE id = ?").get(id) as Row | undefined;
      return r ? rowToBrain(r) : null;
    },
    versions: (limit = 20): BrainVersion[] => (this.db.prepare("SELECT id, created_at, content, decisions_covered, notes FROM brain_versions ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(rowToBrain),
    latest: (): BrainVersion | null => {
      const r = this.db.prepare("SELECT * FROM brain_versions ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
      return r ? rowToBrain(r) : null;
    },
  };

  // ---------- settings ----------

  readonly settings = {
    get: (key: string): string | null => {
      const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
      return r ? (r.value as string) : null;
    },
    set: (key: string, value: string): void => {
      this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
    getJson: <T>(key: string, fallback: T): T => j<T>(this.settings.get(key), fallback),
    setJson: (key: string, value: unknown): void => this.settings.set(key, JSON.stringify(value)),
  };
}

export function clampPriority(p: number | undefined | null): number {
  if (p == null || Number.isNaN(Number(p))) return 3;
  return Math.min(5, Math.max(1, Math.round(Number(p))));
}

export function defaultPriority(kind: ItemKind): number {
  switch (kind) {
    case "permission":
      return 1;
    case "question":
      return 2;
    case "decision":
      return 2;
    case "review":
      return 3;
    case "idea":
      return 4;
    case "info":
      return 5;
  }
}

export function openStore(file: string): Store {
  return new Store(file);
}
