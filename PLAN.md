# Harness — plan

Goal: an agent organisation that lets the principal (you) hand work to Claude autonomously and
review the results from **one prioritised queue**, in the shape Brian Armstrong described:

```
                 ┌──────────────┐    ┌──────────────┐    sub-agents per lead
  new task ───▶  │ Chief of     │──▶ │ Lead agents  │──▶ implementer · tester · reviewer
  (UI / CLI /    │ Staff agent  │    │ (per area)   │    security · researcher
   inbox/*.md)   └──────────────┘    └──────┬───────┘
                        ▲                   │ review packages, questions,
                        │ ideas             │ permission requests, ideas
                        │                   ▼
                 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐
                 │ Principal    │◀── │ Prioritised  │──▶ │ You (batch   │──▶ │ Approve →   │
                 │ Brain        │    │ queue (web)  │    │ keys+voice)  │    │ merge / PR  │
                 └──────────────┘    └──────────────┘    └──────────────┘    └─────────────┘
```

## Components

| Component | What it does | Where |
|---|---|---|
| **Chief of Staff** | Triages every new task, writes a brief, assigns it to a lead with a priority, splits big asks, asks you when the ask is ambiguous, re-prioritises the queue, chases stale reviews, curates ideas, writes the daily brief. | `src/agents/chief.ts` |
| **Lead agents** | One per area of focus (configurable). Each runs all the time, claims its queued tasks, works in an isolated workspace (git worktree for repos), delegates to sub-agents, runs a security review, and submits a **review package** (summary, diff, test output, screenshots/video) to the queue. Resumes its session when you answer. | `src/agents/lead.ts`, `src/workspace.ts` |
| **Sub-agents** | `implementer`, `tester`, `reviewer`, `security`, `researcher` — Claude Code subagents defined per lead. | `src/agents/prompts.ts` |
| **Queue web app** | Local web app at `http://127.0.0.1:4242`. Items sorted by priority, evidence inline, options with the lead's recommendation pre-selected, keyboard shortcuts, voice comments, batch clearing, undo. Also tabs for tasks, agents, brain, ideas, activity. | `src/server/*`, `web/*` |
| **Principal Brain** | Every decision + comment is logged. A distiller agent periodically rewrites `brain/principal.md` (priorities, decision rules, quality bar, communication preferences, standing instructions, per-area notes). The doc is injected into every agent prompt. Agreement rate between the leads' recommendations and your actual decisions is tracked, so the goal "fewer corrections per change" is measurable. | `src/agents/brain.ts`, `brain/` |
| **Guardrails** | Permission bridge: tool calls the policy does not allow become queue items that block the agent until you answer. Security sub-agent reviews every diff before submission; the harness scans diffs for secrets. Nothing merges or is pushed without your explicit approval. Per-task and per-day cost caps. | `src/policy.ts`, `src/agents/tools.ts` |
| **Supervisor** | Starts the web server, chief loop, one loop per lead, brain scheduler, inbox watcher, stale-review chaser; restarts crashed loops; graceful shutdown. | `src/scheduler.ts`, `src/index.ts` |

## Runtime choices

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): every agent run is a real Claude Code session with built-in tools, subagents, hooks, sessions that can be resumed, and a `canUseTool` callback we route into the queue. Auth: `ANTHROPIC_API_KEY` or a Claude subscription token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`).
- **Node 22+ / TypeScript**, `node:sqlite` for the store (no native build), plain `node:http` + vanilla JS front end (no bundler), `zod` for config and tool schemas, `marked` for markdown rendering.
- Everything is local: the database, attachments, workspaces and logs live in `data/` (gitignored).

## Data model (SQLite, `data/harness.db`)

- `tasks` — id, title, brief, source, status (`inbox → triaged → queued → running → waiting_human → review → done | rejected | failed | parked`), lead, priority (1 = highest … 5), parent_id, repo, workdir, branch, session_id, result_summary, cost_usd, attempts, tags.
- `queue_items` — id, task_id, lead, kind (`review | decision | question | permission | idea | info`), title, body (markdown), options `[{key,label,description}]`, recommended + rationale, evidence `[{type: image|video|diff|file|link|text, path|url, caption}]`, priority, status (`open | answered | withdrawn | expired`), answer `{option, comment}`, timestamps.
- `decisions` — one row per answer: option, comment, whether it agreed with the recommendation (feeds the brain and the agreement metric).
- `runs` — every agent session: agent, task, SDK session id, cost, turns, status, summary, log path (JSONL transcript).
- `ideas`, `events` (activity feed / SSE), `brain_versions`, `settings`.

## Main flows

1. **Give a task**: UI "New task" box (⌘K), `harness task "…"`, or drop a markdown file in `inbox/`. → `tasks.status = inbox`.
2. **Triage**: chief loop wakes (interval or inbox event), reads the brain, and for each inbox task calls `assign_task` (lead, priority, brief, optional repo), `split_task`, `ask_principal` (ambiguous), or `park_task`.
3. **Execution**: a lead claims the highest-priority queued task, prepares its workspace (git worktree + branch `harness/<task>` when a repo is configured), runs a Claude Code session with the lead prompt + brain + subagents. Harness tools available to it: `report_progress`, `ask_principal`, `attach_evidence`, `submit_for_review`, `complete_task`, `create_subtask`, `submit_idea`, `search_decisions`.
4. **Permission bridge**: tool calls not covered by the policy allow-list → `queue_items.kind = permission` (priority 1). The agent waits up to N minutes; on timeout it is told to stop and the task goes to `waiting_human`; your later answer resumes the session.
5. **Review package**: on `submit_for_review` the harness auto-commits leftover changes, captures the diff and evidence directory (`.harness/evidence/` in the workspace), runs a secrets scan, and posts a `review` item with options `approve | request_changes | reject` and the lead's recommendation.
6. **Your decision**: approve → `onApprove` action for that lead (`merge` into the repo's current branch, `pr` push + PR, or `none`) and task `done`; request changes → session resumed with your comment; reject → task closed. Every answer becomes a `decisions` row.
7. **Brain**: after every K decisions (or every N hours) the distiller rewrites `brain/principal.md` conservatively, citing decision ids, and keeps a changelog. On first start the harness posts an onboarding question so the brain is seeded from your own words.
8. **Ideas**: leads submit ideas; each becomes a low-priority `idea` item (pursue / park / discard). Pursue → new task in the inbox.
9. **Daily brief**: chief posts an `info` item (done / in flight / waiting on you / stale / spend).

## HTTP API (contract between server and web UI)

```
GET  /api/state                         → { principal, leads, counts, paused, costToday }
GET  /api/queue?status=open&kind=&lead= → items (+ task title)
GET  /api/queue/:id                     → item + task + evidence + run summary
POST /api/queue/:id/answer {option, comment}
POST /api/queue/:id/defer  {hours}
POST /api/queue/:id/undo                → reopen last answer (within 60 s)
GET  /api/tasks?status=   POST /api/tasks {title, brief, lead?, priority?, repo?}
GET  /api/tasks/:id (+runs, +items)  POST /api/tasks/:id/cancel  POST /api/tasks/:id/retry
GET  /api/agents                         → leads with live status, chief status, spend
GET  /api/brain  PUT /api/brain {content}  POST /api/brain/distill  GET /api/brain/stats
GET  /api/ideas  GET /api/events?since=  GET /api/events/stream (SSE)
GET  /api/runs/:id/log                   → JSONL transcript
POST /api/pause  POST /api/resume
GET  /attachments/<task>/<file>          static evidence
```

## Build order

1. Core: `types`, `config`, `store/db`, `bus`, `logger`, `policy`, `agents/runner` (SDK wrapper), `agents/tools` (in-process MCP server), `agents/prompts`.
2. In parallel: `agents/chief` + `agents/brain`; `agents/lead` + `workspace`; `server/*`; `web/*`; README + tests.
3. Glue: `scheduler`, `inbox`, `index` (CLI). Typecheck, unit tests, real end-to-end run.
4. Adversarial review (correctness, security, UX, robustness) → fixes → ship.

## Out of scope for v1 (extension points left in place)

- Slack / email delivery of queue items (the `events` bus and `mcpServers` config are the hooks).
- Multi-user review, remote access (bind to localhost only).
- Automatic video recording of every feature — leads are instructed to record with Playwright when the project supports it; the UI renders any `.webm`/`.mp4` evidence.
