import fs from "node:fs";
import path from "node:path";
import { query, type AgentDefinition, type CanUseTool, type McpServerConfig, type Options, type PermissionMode, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Bus, HarnessConfig, Logger } from "../types.js";
import type { Store } from "../store/db.js";
import { safeJson } from "../logger.js";

export interface RunSpec {
  /** "chief" | "lead:<id>" | "brain" | "system" */
  agent: string;
  taskId?: string | null;
  prompt: string;
  /** A custom system prompt, or Claude Code's own prompt with an appendix (right choice for coding leads). */
  systemPrompt: string | { preset: "claude_code"; append: string };
  cwd: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Tools auto-approved without consulting canUseTool. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Restrict the built-in tool set (e.g. ["Read","Grep"] for the chief). Omit for all. */
  tools?: string[];
  permissionMode?: PermissionMode;
  agents?: Record<string, AgentDefinition>;
  mcpServers?: Record<string, McpServerConfig>;
  settingSources?: SettingSource[];
  /** Resume an earlier session (the prompt becomes the next user turn). */
  resume?: string | null;
  canUseTool?: CanUseTool;
  /** When set, the run must end with JSON matching this schema (available as `structured`). */
  outputSchema?: Record<string, unknown>;
  abortController?: AbortController;
  onMessage?: (m: SDKMessage) => void;
}

export interface RunResult {
  runId: string;
  sessionId: string | null;
  status: "success" | "error" | "cancelled";
  /** Final assistant text (success only). */
  text: string;
  structured: unknown;
  costUsd: number;
  turns: number;
  errors: string[];
  permissionDenials: { tool_name: string; tool_input: Record<string, unknown> }[];
  /** Concatenated assistant text from the whole run (handy for summaries when the final text is empty). */
  transcriptText: string;
}

export interface ActiveRun {
  runId: string;
  agent: string;
  taskId: string | null;
  startedAt: string;
  lastActivity: string;
  lastText: string;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
  active(): ActiveRun[];
  cancel(runId: string): boolean;
  cancelTask(taskId: string): number;
}

interface Deps {
  config: HarnessConfig;
  db: Store;
  bus: Bus;
  log: Logger;
}

/**
 * Thin wrapper around the Claude Agent SDK: one `run()` = one Claude Code session (or a resumed one),
 * recorded as a row in `runs`, with a JSONL transcript under data/logs and progress events on the bus.
 */
export function createRunner(deps: Deps): Runner {
  const { config, db, bus } = deps;
  const log = deps.log.child("runner");
  const active = new Map<string, ActiveRun & { abort: AbortController }>();

  async function run(spec: RunSpec): Promise<RunResult> {
    const abort = spec.abortController ?? new AbortController();
    fs.mkdirSync(config.paths.logs, { recursive: true });
    const runRow = db.runs.create({ task_id: spec.taskId ?? null, agent: spec.agent, session_id: spec.resume ?? null });
    const logPath = path.join(config.paths.logs, `${runRow.id}.jsonl`);
    db.runs.update(runRow.id, { log_path: logPath });
    const out = fs.createWriteStream(logPath, { flags: "a" });
    const started = new Date().toISOString();
    const state: ActiveRun & { abort: AbortController } = { runId: runRow.id, agent: spec.agent, taskId: spec.taskId ?? null, startedAt: started, lastActivity: started, lastText: "", abort };
    active.set(runRow.id, state);
    bus.emit({ type: "run.started", run_id: runRow.id, task_id: spec.taskId ?? null, payload: { agent: spec.agent, resume: !!spec.resume, model: spec.model } });

    const result: RunResult = { runId: runRow.id, sessionId: spec.resume ?? null, status: "error", text: "", structured: undefined, costUsd: 0, turns: 0, errors: [], permissionDenials: [], transcriptText: "" };
    const textParts: string[] = [];
    let lastProgressEmit = 0;

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model,
      effort: spec.effort,
      maxTurns: spec.maxTurns ?? config.review.maxTurns,
      maxBudgetUsd: spec.maxBudgetUsd,
      allowedTools: spec.allowedTools,
      disallowedTools: spec.disallowedTools,
      tools: spec.tools,
      permissionMode: spec.permissionMode ?? "default",
      agents: spec.agents,
      mcpServers: spec.mcpServers,
      settingSources: spec.settingSources ?? [],
      resume: spec.resume ?? undefined,
      canUseTool: spec.canUseTool,
      abortController: abort,
      systemPrompt: typeof spec.systemPrompt === "string" ? spec.systemPrompt : { type: "preset", preset: "claude_code", append: spec.systemPrompt.append },
      outputFormat: spec.outputSchema ? { type: "json_schema", schema: spec.outputSchema } : undefined,
      env: { ...process.env },
      persistSession: true,
    };

    out.write(JSON.stringify({ ts: started, type: "harness.run", agent: spec.agent, taskId: spec.taskId ?? null, model: spec.model, resume: spec.resume ?? null, prompt: spec.prompt }) + "\n");

    try {
      const q = query({ prompt: spec.prompt, options });
      for await (const m of q) {
        state.lastActivity = new Date().toISOString();
        out.write(JSON.stringify({ ts: state.lastActivity, ...compact(m) }) + "\n");
        spec.onMessage?.(m);
        if (m.type === "system" && m.subtype === "init") {
          result.sessionId = m.session_id;
          db.runs.update(runRow.id, { session_id: m.session_id });
        } else if (m.type === "assistant") {
          for (const block of m.message.content) {
            if (block.type === "text" && block.text.trim()) {
              textParts.push(block.text);
              state.lastText = block.text.slice(-400);
            } else if (block.type === "tool_use") {
              state.lastText = `→ ${block.name}`;
            }
          }
          const now = Date.now();
          if (now - lastProgressEmit > 3000) {
            lastProgressEmit = now;
            bus.emit({ type: "run.progress", run_id: runRow.id, task_id: spec.taskId ?? null, payload: { agent: spec.agent, text: state.lastText.slice(-200) } });
          }
        } else if (m.type === "result") {
          result.sessionId = m.session_id;
          result.costUsd = m.total_cost_usd ?? 0;
          result.turns = m.num_turns ?? 0;
          result.permissionDenials = (m.permission_denials ?? []).map((d) => ({ tool_name: d.tool_name, tool_input: d.tool_input }));
          if (m.subtype === "success") {
            result.status = "success";
            result.text = m.result ?? "";
            result.structured = m.structured_output;
          } else {
            result.status = abort.signal.aborted ? "cancelled" : "error";
            result.errors = m.errors ?? [m.subtype];
          }
        }
      }
      if (result.status === "error" && !result.errors.length) result.errors = ["run ended without a result message"];
    } catch (err) {
      result.status = abort.signal.aborted ? "cancelled" : "error";
      result.errors.push(err instanceof Error ? err.message : String(err));
      log.error(`run ${runRow.id} (${spec.agent}) failed`, { error: result.errors.at(-1) });
    } finally {
      result.transcriptText = textParts.join("\n\n");
      out.write(JSON.stringify({ ts: new Date().toISOString(), type: "harness.result", status: result.status, cost: result.costUsd, turns: result.turns, errors: result.errors }) + "\n");
      out.end();
      active.delete(runRow.id);
      db.runs.finish(runRow.id, result.status, { cost_usd: result.costUsd, turns: result.turns, session_id: result.sessionId, summary: summarize(result) });
      if (spec.taskId) db.tasks.addCost(spec.taskId, result.costUsd);
      bus.emit({ type: "run.finished", run_id: runRow.id, task_id: spec.taskId ?? null, payload: { agent: spec.agent, status: result.status, cost: result.costUsd, turns: result.turns, errors: result.errors.slice(0, 3) } });
    }
    return result;
  }

  return {
    run,
    active: () => Array.from(active.values()).map(({ abort: _a, ...rest }) => rest),
    cancel(runId) {
      const r = active.get(runId);
      if (!r) return false;
      r.abort.abort();
      return true;
    },
    cancelTask(taskId) {
      let n = 0;
      for (const r of active.values()) if (r.taskId === taskId) {
        r.abort.abort();
        n++;
      }
      return n;
    },
  };
}

function summarize(r: RunResult): string {
  if (r.status === "success") return (r.text || r.transcriptText).slice(0, 2000);
  return `${r.status}: ${r.errors.join("; ").slice(0, 1500)}`;
}

/** Keep transcripts readable: drop big binary-ish payloads, truncate long tool results. */
function compact(m: SDKMessage): Record<string, unknown> {
  if (m.type === "assistant") {
    return {
      type: "assistant",
      content: m.message.content.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "tool_use") return { type: "tool_use", name: b.name, input: truncateDeep(b.input, 2000) };
        if (b.type === "thinking") return { type: "thinking" };
        return { type: b.type };
      }),
      parent_tool_use_id: m.parent_tool_use_id,
    };
  }
  if (m.type === "user") {
    const content = m.message.content;
    if (typeof content === "string") return { type: "user", text: content.slice(0, 4000) };
    return {
      type: "user",
      content: (content as unknown as Array<Record<string, unknown>>).map((b) => {
        if (b.type === "tool_result") {
          const c = b.content;
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : `[${(x as { type?: string })?.type}]`)).join("\n") : "";
          return { type: "tool_result", is_error: b.is_error ?? false, text: text.slice(0, 4000) };
        }
        if (b.type === "text") return { type: "text", text: String(b.text ?? "").slice(0, 4000) };
        return { type: b.type };
      }),
    };
  }
  if (m.type === "result") {
    return { type: "result", subtype: m.subtype, cost: m.total_cost_usd, turns: m.num_turns, text: m.subtype === "success" ? m.result : undefined, errors: m.subtype === "success" ? undefined : m.errors };
  }
  if (m.type === "system") return { type: "system", subtype: m.subtype, session_id: "session_id" in m ? m.session_id : undefined, model: "model" in m ? m.model : undefined };
  return { type: m.type, subtype: (m as { subtype?: string }).subtype };
}

function truncateDeep(v: unknown, max: number): unknown {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + `… [${v.length - max} more chars]` : v;
  if (Array.isArray(v)) return v.map((x) => truncateDeep(x, max));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = truncateDeep(val, max);
    return o;
  }
  return v;
}

export { safeJson };
