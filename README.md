# Harness

Harness is a local "agent organisation" you run on your own machine. A **Chief of Staff** agent triages every task you give it and hands it to a **lead agent** for the right area (engineering, product, operations, whatever you configure). Each lead works autonomously with its own sub-agents in an isolated workspace, then sends a **review package** to the one place you look: a prioritised queue in a local web app that you clear in batches with the keyboard or your voice. Every decision you make is logged and distilled into a **principal brain**, a short document injected into every agent prompt, so the organisation gets better at anticipating you and you make fewer corrections over time. Nothing is merged, pushed, sent or deleted without your explicit approval in that queue.

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

Every agent run is a real Claude Code session (via the Claude Agent SDK), so the leads have the same tools, sub-agents and resumable sessions you use in your terminal.

## Requirements

| Need | Why |
|---|---|
| Node.js 22.13 or newer | Runtime; the store uses the built-in `node:sqlite`, no native build |
| git | Leads work in git worktrees; approval merges or pushes |
| A Claude subscription **or** an API key | Subscription: `claude setup-token`. API: a key from platform.claude.com |
| `gh` CLI (optional) | Lets "approve" open a pull request. Without it the branch is pushed and you open the PR |
| Playwright in your projects (optional) | Leads record screenshots and short videos of user-visible changes when the project supports it |

## Quick start

```bash
npm install
cp .env.example .env            # then set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
$EDITOR harness.config.json     # your name, your leads, the repos each lead may work in
npm start                       # starts the web app, the chief of staff and one loop per lead
```

Open <http://127.0.0.1:4242>. The first item in your queue is an onboarding question: answer it in your own words (priorities, what "good" looks like, standing rules, how you want reviews written). That answer seeds the brain. From then on, give tasks and clear the queue.

To run Harness from a different directory, `npm run harness -- init` there writes a fresh `harness.config.json`, `brain/` and `inbox/`.

## Giving tasks

Three ways, all equivalent. A task lands in the chief's inbox; the chief writes a brief, picks a lead and a priority (1 = drop everything, 5 = whenever), or asks you first when the ask is ambiguous.

**Web app**: press `n` (or Ctrl/Cmd+K), type the title and an optional brief. You may pin a lead and a priority; otherwise the chief decides.

**Command line**:

```bash
npm run harness -- task "Add CSV export to the reports page"
npm run harness -- task "Draft the Q1 investor update" --lead operations --priority 2
npm run harness -- task "Migrate billing to Stripe" --brief specs/billing.md --repo ~/code/app
```

`--brief` takes text or a path to a Markdown file. With `--lead` the task skips triage and is queued for that lead directly. The command talks to the running harness; if it is not running the task is written to the database and picked up on the next start.

**Inbox folder**: drop a Markdown file into `inbox/`. The first heading is the title, the rest is the brief; optional front matter pins the routing:

```markdown
---
lead: engineering
priority: 2
repo: /Users/me/code/app
---
# Fix the login bug on Safari

Users on Safari 17 cannot log in. Repro: ...
```

Processed files move to `data/inbox-processed/`.

## Clearing the queue

The queue shows everything that needs you, highest priority first, with the evidence inline and the lead's recommendation pre-selected. One keystroke answers an item and moves to the next; `u` undoes within 60 seconds. Voice: press `v` and dictate your comment; it uses your browser's speech recognition, so use Chrome, Edge or Safari.

| Kind | What it is | Options and what each does |
|---|---|---|
| **permission** | A lead wants to run a tool call the policy does not allow (push, curl, write outside its workspace...). The lead is blocked until you answer. | `allow` this one call · `allow_always` this and similar calls for the rest of the task · `deny` (the lead is told why and continues otherwise) |
| **question** | A lead or the chief needs an answer it cannot infer. | `answer` with free text in the comment box |
| **decision** | Same, with concrete options and a recommendation. | the option keys the agent proposed |
| **review** | A finished piece of work: summary, diff, test output, screenshots or recording, risks, recommendation. | `approve` runs the lead's `onApprove` action (merge, PR or nothing) and closes the task · `request_changes` sends your comment back; the same session continues · `reject` closes the task, nothing is applied |
| **idea** | Something a lead noticed that you did not ask for. | `pursue` creates a task · `park` keeps it for later · `discard` |
| **info** | Daily brief, "done" notes for tasks that needed no approval, failures, budget notices. | `ack` · `request_changes` sends a comment back to the lead (`retry` on failures) |

Your comment travels with every answer: on a review it goes back to the lead verbatim, on everything else it feeds the brain.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` or arrows | Move selection |
| `Enter` | Open or focus the item |
| `1`...`9` | Choose option by number |
| `a` | Take the recommended option (or approve) |
| `r` | Request changes / answer |
| `x` | Reject, deny or discard |
| `d` | Defer 24 hours |
| `s` | Skip to the next item |
| `c` | Focus the comment box |
| `v` | Toggle voice input |
| `u` | Undo the last answer (60 s window) |
| Ctrl/Cmd+Enter | Submit from the comment box |
| `n` or Ctrl/Cmd+K | New task |
| `g` then `q` `t` `a` `b` `i` `l` | Go to Queue, Tasks, Agents, Brain, Ideas, Activity |
| `?` | Show this list |

The other tabs: **Tasks** (every task with status, cost, runs and items; cancel or retry), **Agents** (leads with live status and spend, pause/resume all), **Brain** (the document, its versions, the agreement metric, "distill now"), **Ideas**, **Activity** (the event feed).

## How it works

1. **Triage.** The chief loop wakes every `chief.intervalSec` seconds (or when a task arrives), reads the brain and the inbox, and for each task calls one of: `assign_task` (lead, priority, sharpened brief, optional repo), `split_task` (several leads or too big for one session), `ask_principal` (ambiguous) or `park_task` (duplicate, not now). Once an hour it also re-prioritises the queue, chases stale reviews and posts a daily brief at `chief.dailyBriefHour`.
2. **Execution.** Each lead loop claims its highest-priority queued task (up to `concurrency` at once), prepares a workspace and starts a Claude Code session with the lead's charter, the brain, the task brief and five sub-agents: `implementer`, `tester`, `reviewer`, `security`, `researcher`. For a task with a repo the workspace is a git worktree under `data/workspaces/<task>/` on a branch `harness/<task>`, so your own checkout is never touched. Non-code work gets a plain directory.
3. **Harness tools.** Leads reach the organisation through an in-process MCP server: `report_progress`, `ask_principal`, `attach_evidence`, `submit_for_review`, `complete_task`, `create_subtask`, `submit_idea`, `search_decisions` (precedent from your past answers). The chief has `list_leads`, `list_tasks`, `assign_task`, `split_task`, `park_task`, `close_task`, `queue_overview`, `set_item_priority`, `post_info`, `decision_stats`.
4. **Permission bridge.** Every tool call goes through the policy (see below). `allow` runs, `deny` is refused with a message, `ask` becomes a priority-1 queue item. The lead waits up to `review.permissionWaitMin` minutes; if you have not answered, it is told to carry on with other work or end its turn with a status, and the task shows as `waiting_human`. Your later answer resumes the exact same session.
5. **Review package.** `submit_for_review` makes the harness commit leftover changes, compute the diff against the base commit, collect everything under `.harness/evidence/` in the workspace plus files the lead attached, and run a secrets scan. Secrets or an empty diff block the submission and the lead is told to fix it. The item carries the summary, verification, risks, diff and media.
6. **Your decision.** Approve runs the lead's `onApprove`: `merge` merges `harness/<task>` into the repo's current branch (refused if your checkout is dirty), `pr` pushes the branch and opens a pull request with `gh`, `none` keeps the branch and artefacts. The result is posted back as an `approval.applied` event and the task is `done`. Request changes resumes the session with your comment. Reject closes the task and removes the worktree (the branch is kept).
7. **Resumable sessions.** Every run is a Claude Code session with a session id stored on the task. Answers to questions, permissions and change requests resume that session rather than starting over, so context is not lost. After a crash or restart, runs left open are marked cancelled and their tasks go back to the queue.

Task statuses: `inbox` → `queued` → `running` → (`waiting_human`) → `review` → `done` | `rejected`; plus `failed`, `parked`, and `triaged` for an umbrella task that was split.

## The brain

`brain/principal.md` is the organisation's model of you. Every agent prompt starts with it. It has fixed sections: who you are and what you care about, ranked priorities, decision rules, quality bar and definition of done, communication and review preferences, standing instructions, per-area notes, open questions.

**What is distilled.** Every answer in the queue becomes a `decisions` row (option, comment, what the lead recommended, whether you agreed). After every `brain.distillEveryDecisions` undistilled decisions, or every `brain.distillIntervalMin` minutes, the distiller agent reads the current document and the new decisions and rewrites the document conservatively: it keeps what is there, adds rules it can cite to specific decisions, and never invents. Each version is stored; the changelog is appended to `brain/changelog.md`. Press "Distill now" on the Brain tab or run `npm run harness -- brain distill` to force it.

**How to edit.** Edit the document in the Brain tab or in your editor; the distiller keeps what you write. The more concrete the rules ("never contact customers directly", "PRs under 300 lines", "German for anything the team sees"), the fewer questions you get.

**The agreement metric.** For every item with a recommendation, the harness records whether you chose it. The Brain tab shows the agreement rate overall, per lead and for the last 20 decisions. Rising agreement means the leads anticipate you better; the chief uses the per-lead number in the daily brief to flag leads that need recalibration.

## Configuration reference

`harness.config.json` lives next to `package.json`. Every section has defaults; `leads` is the only required one.

| Field | Default | Meaning |
|---|---|---|
| `principal.name` | `"Principal"` | How the agents address you |
| `principal.timezone` | `"Europe/Berlin"` | Daily brief time and daily budget reset |
| `principal.language` | `"en"` | Language the agents write in |
| `server.host` / `server.port` | `127.0.0.1` / `4242` | Where the web app listens. `HARNESS_PORT` overrides the port |
| `models.chief` / `lead` / `subagent` / `brain` | opus / opus / sonnet / opus | Model per role |
| `budget.perTaskUsd` | `10` | Hard cap per lead session |
| `budget.perDayUsd` | `100` | When reached, all agents pause until the next local day |
| `chief.intervalSec` | `60` | Triage loop interval (min 10) |
| `chief.dailyBriefHour` | `8` | Local hour of the daily brief |
| `brain.distillEveryDecisions` | `5` | Distill after this many new decisions |
| `brain.distillIntervalMin` | `360` | ... or after this many minutes (min 5) |
| `review.staleAfterHours` | `24` | Open items older than this are chased by the chief |
| `review.permissionWaitMin` | `10` | How long a lead waits for a permission or question answer |
| `review.leadPollSec` | `15` | How often a lead loop looks for queued work |
| `review.maxTurns` | `300` | Turn cap per lead session |
| `permissions.allow` / `ask` / `deny` | `[]` | Extra rules merged on top of the built-in policy |
| `mcpServers` | `{}` | MCP servers (stdio) available to every lead |
| `agentEnv` | `[]` | Extra environment variable names passed to agent sessions (everything else from your environment is withheld) |
| `paths.data` / `brain` / `inbox` | `data` / `brain` / `inbox` | Relative to the config file or absolute |

Each entry in `leads`:

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Lowercase letters, digits, `-` or `_`; used everywhere the lead is referenced |
| `name` | required | Display name |
| `charter` | required | What the lead owns, in plain language; goes into its system prompt |
| `repos` | `[]` | Git repositories the lead may work in (absolute or config-relative). Empty means non-code work |
| `concurrency` | `1` | Tasks the lead runs at once (1-8) |
| `onApprove` | `"none"` | `merge`, `pr` or `none`, see above |
| `model` / `subagentModel` | global | Per-lead model overrides |
| `permissions` | none | Extra `allow` / `ask` / `deny` rules for this lead only |
| `mcpServers` | none | Extra MCP servers for this lead, e.g. `{ "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } } }` |

### Permission rules

Rules use Claude Code's syntax: a bare tool name (`Read`, `WebFetch`) or `Tool(pattern)` where `*` matches anything. For `Bash` the pattern is matched against the command, for file tools against the path.

```json
"permissions": {
  "allow": ["Bash(terraform plan*)", "Write(/Users/me/code/app/*)"],
  "ask":   ["Bash(npm test*)"],
  "deny":  ["Bash(aws *)", "WebFetch"]
}
```

Evaluation order is `deny` > `ask` > `allow`; anything unmatched asks. Compound commands (`a && b`, `a; b`, `a | b`, `a & b`) are judged by their worst part, so `git status && rm -rf /` asks. Wrappers such as `env`, `timeout` and `nice` are unwrapped and the real command is judged. Command substitution, process substitution, backticks, `eval`, `source`, `xargs`, shells (`bash -c`) and inline code (`node -e`, `python -c`) always ask. Writing commands (`tee`, `cp`, `mv`, `sed -i`, `rm`, redirections, …) that target paths outside the task workspace ask, as do `Write`/`Edit` calls outside it. "Allow for this task" grants the narrowest rule that covers the call (for example `Bash(git push origin*)`) and is checked per shell segment. The built-in policy allows the usual read, edit, git-local, build and test commands, asks for `git push`, `gh pr`, `rm -r`, `curl`, `docker`, package publishing and the like, and denies `sudo`, `git push --force`, `mkfs`, `dd`, `shutdown`. See `DEFAULT_PERMISSIONS` in `src/config.ts` for the full list.

When you answer a permission with `allow_always`, the harness derives a rule from the call (`Bash(git push*)`, `Write(/that/dir/*)`) and adds it for the rest of that task only.

## Making it yours

The four leads in the example config (product, engineering, design, operations) are just a starting point. Rename, remove or add leads by editing `leads`; the `id` is what you pass to `--lead` and what appears in the queue, the `charter` is what shapes the lead's behaviour, so write it the way you would brief a new hire. Leads without repos do knowledge work and deliver documents under their workspace; leads with repos deliver branches.

A small M&A / investment firm might run:

```json
{
  "principal": { "name": "Frederic", "timezone": "Europe/Berlin", "language": "en" },
  "leads": [
    {
      "id": "deal-sourcing",
      "name": "Deal Sourcing Lead",
      "charter": "Finds and qualifies acquisition targets that fit our investment profile. Produces one-page target profiles with owner situation, size, fit score and a recommended next step. Drafts first-contact emails for the principal to send; never contacts anyone directly."
    },
    {
      "id": "due-diligence",
      "name": "Due Diligence Lead",
      "charter": "Runs commercial and financial diligence on live deals: data room review, red-flag lists, question lists for management meetings, valuation ranges with assumptions stated. Every number carries its source.",
      "concurrency": 2
    },
    {
      "id": "portfolio-ops",
      "name": "Portfolio Operations Lead",
      "charter": "Supports the portfolio companies: monthly reporting packs, KPI dashboards, 100-day plans, board memos. Produces finished documents the principal can forward as-is."
    },
    {
      "id": "engineering",
      "name": "Engineering Lead",
      "charter": "Owns our internal tools (deal tracker, data pipelines). Implements on a branch with tests and a security review; small, reviewable changes.",
      "repos": ["/Users/frederic/code/deal-tracker", "/Users/frederic/code/pipelines"],
      "onApprove": "pr",
      "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } }
    }
  ],
  "budget": { "perTaskUsd": 15, "perDayUsd": 150 }
}
```

Connect the leads to your systems through `mcpServers` (CRM, data room, email drafts) and write the standing rules into the brain ("never send, only draft").

## Safety model

- **Nothing leaves without you.** Merges, pushes, pull requests, publishing, sending and deleting are all `ask` or `deny` in the policy, and the only path to a merge or PR is your `approve` on a review item. The brain's standing instructions repeat this to every agent.
- **Permission bridge.** Anything the policy does not allow blocks the lead until you answer; a denied call cannot be retried silently. Session grants (`allow_always`) are scoped to one task.
- **Isolated workspaces.** Leads work in their own worktree and branch; file writes and `rm` outside it ask. Your main checkout is only touched by an approved merge, and only when it is clean.
- **Security review and secrets scan.** Leads must run the `security` sub-agent on their diff before submitting; the harness additionally scans every added line of the diff for API keys, tokens, private keys and password assignments and blocks the submission if it finds any.
- **Cost caps.** `budget.perTaskUsd` stops a runaway session; `budget.perDayUsd` pauses the whole organisation until the next day (you get an info item). Spend is visible per task, per lead and per day.
- **Local only, token-protected.** The web app binds to `127.0.0.1`. Every API and attachment request needs the per-installation token in `data/.harness-token`: the browser gets it as a cookie when it opens the app, the CLI reads the file, and requests with a foreign `Host` header are refused. Agents cannot read the token file (the policy denies it) and cannot answer their own queue items. Everything (database, attachments, workspaces, logs, transcripts) stays in `data/`.
- **Agents see a minimal environment.** Sessions receive `PATH`, `HOME`, proxy and Claude auth variables only, never the rest of your `.env`. Add names to `agentEnv` in the config when a lead genuinely needs one.
- **Worktree settings are never loaded.** A repository's `.claude/settings.json` and hooks cannot widen a lead's permissions; its `CLAUDE.md` is injected as read-only guidance.
- **Approvals apply to what you reviewed.** If a branch gained commits after the review package was built, the approval is refused and you can ask for a new review.
- **Pause.** The Pause button (or `npm run harness -- pause`) stops every loop from starting new work; running sessions finish their current turn. Resume with the button or `npm run harness -- resume`.

## Operating

```
data/
  harness.db            SQLite database (tasks, queue, decisions, runs, events, brain versions, settings)
  attachments/<task>/   evidence files served at /attachments/<task>/<file>
  workspaces/<task>/    git worktrees and plain working directories of the leads
  logs/harness.log      the harness log
  logs/<run>.jsonl      one transcript per agent session (Agent SDK messages)
  inbox-processed/      inbox files after ingestion, timestamped
  harness.pid           pid of the running harness
brain/principal.md      the brain document (keep it in version control if you like)
brain/changelog.md      what each distillation changed and why
```

**CLI** (`npm run harness -- <command>`): `start`, `init`, `task "..." [--brief ...] [--lead id] [--priority n] [--repo path]`, `status` (counts, running agents, spend today), `queue` (open items), `answer <item> <option> [comment]`, `brain [distill]`, `pause`, `resume`. Set `HARNESS_LOG_LEVEL=debug` for verbose logs.

**Backups.** Stop the harness and copy `data/harness.db` and `brain/`. Workspaces are reproducible from the repos' `harness/*` branches; transcripts and attachments are nice to have.

**Resetting.** Stop the harness, delete `data/` (or just `data/harness.db` to keep attachments and logs), and start again; the onboarding question is posted anew. Run `git worktree prune` in each repo to drop registrations of deleted workspaces. The brain document is yours; delete `brain/principal.md` only if you want to start from the seed.

**Running in the background.** With pm2: `pm2 start npm --name harness -- start` then `pm2 save`. On macOS with launchd, a `~/Library/LaunchAgents/com.harness.plist` running `node --no-warnings=ExperimentalWarning --import tsx src/index.ts start` with `WorkingDirectory` set to this folder and `KeepAlive` true does the same; the `.env` file is read from the working directory on start.

**Updating.** `git pull && npm install`, then restart. The database schema is created with `CREATE TABLE IF NOT EXISTS`, so existing data is kept.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Runs fail immediately with an authentication error | `.env` needs `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). The file is read on `start`; restart after editing. |
| `EADDRINUSE` on start | Another harness (check `data/harness.pid`) or app uses the port. Stop it, or set `HARNESS_PORT=4243` / `server.port`. |
| A lead never submits | Check the Tasks tab: `waiting_human` means it is blocked on a queue item of yours (permission or question); `running` for a very long time means a long session, watch its transcript under Agents. Lower `review.maxTurns` or `budget.perTaskUsd` to force earlier submissions. Request changes with a clear comment resumes the same session. |
| Worktree conflicts (`fatal: ... already exists`, `is already checked out`) | Run `git worktree prune` in the repo and retry the task. If a `harness/<task>` branch from an old attempt is in the way, delete it with `git branch -D harness/<task>`. |
| "Repo has uncommitted changes; merge manually" | `onApprove: merge` refuses to merge into a dirty checkout. Commit or stash, then `git merge harness/<task>` yourself, or switch the lead to `pr`. |
| Approve says the branch was pushed but no PR appeared | `gh` is not installed or not logged in (`gh auth login`). The message contains the remote URL; open the PR there. |
| Agents are paused and you did not pause them | The daily budget is reached (an info item says so). Raise `budget.perDayUsd` and restart, or wait for the next local day. |
| The chief keeps asking questions | Answer them with a sentence of reasoning, then let the brain distill; or write the rule into `brain/principal.md` directly. |
| Voice input does nothing | Your browser lacks speech recognition or the microphone permission was refused. Chrome, Edge and Safari work. |

Logs: `data/logs/harness.log` for the harness, `data/logs/<run>.jsonl` for what an agent actually did (also under Agents → run → transcript).

**`401 Missing or invalid harness token` from curl or a script.** Send the token from `data/.harness-token` in the `x-harness-token` header, e.g. `curl -H "x-harness-token: $(cat data/.harness-token)" http://127.0.0.1:4242/api/queue`. The browser and the CLI do this for you.

## Roadmap and extension points

- **Delivery channels.** Queue items are events on the bus (`item.created`, `item.answered`, ...), persisted in the `events` table and streamed at `/api/events/stream`. A Slack or email bridge is a small consumer of that stream that posts back through `POST /api/queue/:id/answer`.
- **More tools for leads.** Add stdio MCP servers globally or per lead in `mcpServers`; no code change needed.
- **Other hosts.** The HTTP API in `src/server/api.ts` is the contract between the server and the web UI; a mobile or terminal client can use the same routes.
- **Automatic recordings.** Leads are told to record Playwright videos when a project supports it; the UI already renders `.webm`/`.mp4` evidence.
- **Not in scope yet.** Multi-user review, remote access and authentication. Keep the port local.

## Development

```bash
npm test            # unit tests (store, policy, config, harness tools, inbox, scheduler)
npm run typecheck   # strict TypeScript, no emit
npm run dev         # start with file watching
```

The code is plain TypeScript run with `tsx`, no build step: `src/types.ts` holds the domain types and module contracts, `src/store/db.ts` the SQLite store, `src/policy.ts` the permission policy and secrets scan, `src/agents/*` the chief, leads, brain, prompts and the harness MCP tools, `src/server/*` and `web/*` the queue app, `src/scheduler.ts` and `src/index.ts` the supervisor and CLI. `PLAN.md` is the design document.
