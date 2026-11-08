import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Evidence, HarnessContext, LeadConfig, Task } from "./types.js";
import { scanForSecrets } from "./policy.js";
import { stageFile } from "./agents/tools.js";

/**
 * Workspaces for lead tasks.
 *
 * A task that touches a git repository gets its own worktree under data/workspaces/<task>/ on a
 * branch `harness/<task>`, so the lead never touches the principal's main checkout. Non-code tasks
 * get a plain directory. Every command shells out with execFile and explicit arguments; no shell
 * strings are ever built from paths.
 */

export interface WorkspaceInfo {
  kind: "git" | "dir";
  dir: string;
  repo?: string;
  branch?: string;
  baseRef?: string;
}

export interface CapturedEvidence {
  evidence: Evidence[];
  blockers: string[];
  appendix?: string;
}

export interface ApprovalResult {
  ok: boolean;
  message: string;
  url?: string;
}

const EXEC_TIMEOUT_MS = 120_000;
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const MAX_DELIVERABLES = 20;
const STAT_MAX_LINES = 60;
const EVIDENCE_SUBDIR = path.join(".harness", "evidence");
/** Commit identity used when the harness commits on the lead's behalf, so commits never fail on a missing identity. */
const HARNESS_IDENTITY = ["-c", "user.name=harness", "-c", "user.email=harness@local"];

// ---------- process helpers ----------

export class ExecError extends Error {
  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly code: number | string | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${cmd} ${args.join(" ")} failed (${code ?? "signal"}): ${(stderr || stdout).trim().slice(0, 2000)}`);
    this.name = "ExecError";
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a command with explicit arguments. Rejects with ExecError on a non-zero exit. */
export function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? EXEC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          reject(new ExecError(cmd, args, code, out, err));
          return;
        }
        resolve({ stdout: out, stderr: err });
      },
    );
  });
}

/** `git -C <cwd> <args>` with a non-interactive environment. */
function git(cwd: string, args: string[]): Promise<ExecResult> {
  return exec("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } });
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  try {
    const { stdout } = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function describeError(err: unknown): string {
  if (err instanceof ExecError) return (err.stderr || err.stdout || err.message).trim().slice(0, 2000);
  return err instanceof Error ? err.message : String(err);
}

function infoFromTask(task: Task): WorkspaceInfo {
  const dir = task.workdir ?? "";
  if (task.branch) return { kind: "git", dir, repo: task.repo ?? undefined, branch: task.branch, baseRef: task.base_ref ?? undefined };
  return { kind: "dir", dir };
}

function workspaceKind(task: Task): "git" | "dir" {
  return task.branch ? "git" : "dir";
}

// ---------- prepare ----------

/** Pick the repository a task should run in: the task's own, else the lead's only repo. */
function resolveRepo(task: Task, lead: LeadConfig): string | null {
  if (task.repo) return task.repo;
  if (lead.repos.length === 1) return lead.repos[0];
  return null;
}

/**
 * Create (or reuse) the workspace for a task and persist its location on the task.
 * Throws a clear error when the configured repository is missing or not a git repository.
 */
export async function prepareWorkspace(ctx: HarnessContext, task: Task, lead: LeadConfig): Promise<WorkspaceInfo> {
  const log = ctx.log.child("workspace");
  if (task.workdir && fs.existsSync(task.workdir)) {
    const info = infoFromTask(task);
    fs.mkdirSync(path.join(info.dir, EVIDENCE_SUBDIR), { recursive: true });
    log.debug(`reusing workspace for ${task.id}`, { dir: info.dir, kind: info.kind });
    return info;
  }

  const repo = resolveRepo(task, lead);
  const dir = path.join(ctx.config.paths.workspaces, task.id);
  let info: WorkspaceInfo;
  if (repo) {
    if (!fs.existsSync(repo)) throw new Error(`Repository path does not exist: ${repo} (task ${task.id}, lead ${lead.id}). Check the lead's repos in harness.config.json.`);
    if (!(await isGitRepo(repo))) throw new Error(`Not a git repository: ${repo} (task ${task.id}, lead ${lead.id}). Run git init there or point the lead at a real repository.`);
    info = await addWorktree(ctx, task, repo, dir);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    info = { kind: "dir", dir };
  }
  fs.mkdirSync(path.join(dir, EVIDENCE_SUBDIR), { recursive: true });
  if (info.kind === "git") await excludeHarnessDir(ctx, dir);

  ctx.db.tasks.update(task.id, { workdir: dir, branch: info.branch ?? null, base_ref: info.baseRef ?? null, repo: info.repo ?? task.repo ?? null });
  ctx.bus.emit({ type: "task.status", task_id: task.id, payload: { status: "running", workdir: dir, kind: info.kind, branch: info.branch ?? null } });
  log.info(`workspace ready for ${task.id}`, { dir, kind: info.kind, branch: info.branch, repo: info.repo });
  return info;
}

async function addWorktree(ctx: HarnessContext, task: Task, repo: string, dir: string): Promise<WorkspaceInfo> {
  const log = ctx.log.child("workspace");
  const branch = `harness/${task.id}`;
  const baseRef = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  // Stale registrations from a crashed earlier attempt would make `worktree add` refuse.
  await gitOk(repo, ["worktree", "prune"]);
  if (fs.existsSync(dir)) {
    if (await isGitRepo(dir)) {
      log.warn(`worktree for ${task.id} already exists on disk; reusing it`, { dir });
      const current = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      return { kind: "git", dir, repo, branch: current || branch, baseRef: task.base_ref ?? baseRef };
    }
    log.warn(`removing leftover directory before creating the worktree for ${task.id}`, { dir });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const branchExists = await gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists) await git(repo, ["worktree", "add", dir, branch]);
  else await git(repo, ["worktree", "add", dir, "-b", branch, "HEAD"]);
  return { kind: "git", dir, repo, branch, baseRef: task.base_ref ?? baseRef };
}

/** Keep .harness/ (evidence, scratch) out of the lead's commits without touching the repo's .gitignore. */
async function excludeHarnessDir(ctx: HarnessContext, dir: string): Promise<void> {
  try {
    const rel = (await git(dir, ["rev-parse", "--git-path", "info/exclude"])).stdout.trim();
    const excludeFile = path.isAbsolute(rel) ? rel : path.join(dir, rel);
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    if (!current.split("\n").some((l) => l.trim() === ".harness/")) fs.appendFileSync(excludeFile, `${current.endsWith("\n") || !current ? "" : "\n"}.harness/\n`);
  } catch (err) {
    ctx.log.child("workspace").warn(`could not write .harness/ to the git exclude file for ${dir}`, { error: describeError(err) });
  }
}

// ---------- evidence ----------

/**
 * Collect everything the principal should see for a review: the committed diff (git tasks), files
 * under .harness/evidence/, and top-level deliverables (plain directories). Blockers stop the submission.
 */
export async function captureWorkspaceEvidence(ctx: HarnessContext, task: Task): Promise<CapturedEvidence> {
  const log = ctx.log.child("workspace");
  const kind = workspaceKind(task);
  const dir = task.workdir;
  if (!dir || !fs.existsSync(dir)) {
    if (kind === "git") return { evidence: [], blockers: [`The workspace directory for ${task.id} is missing (${dir ?? "none"}); nothing can be reviewed.`] };
    return { evidence: [], blockers: [], appendix: "No files were produced." };
  }

  const evidence: Evidence[] = [];
  const blockers: string[] = [];
  let appendix: string | undefined;

  if (kind === "git") {
    try {
      const diff = await captureDiff(ctx, task, dir);
      blockers.push(...diff.blockers);
      evidence.push(...diff.evidence);
      appendix = diff.appendix;
    } catch (err) {
      const msg = describeError(err);
      log.error(`could not capture the diff for ${task.id}`, { error: msg });
      blockers.push(`Could not capture the diff: ${msg}`);
    }
  }

  const fromEvidenceDir = safeStage(ctx, task, collectEvidenceFiles(path.join(dir, EVIDENCE_SUBDIR)), log);
  evidence.push(...fromEvidenceDir);

  if (kind === "dir") {
    const deliverables = safeStage(ctx, task, collectDeliverables(dir), log);
    evidence.push(...deliverables);
    if (!evidence.length) appendix = "No files were produced.";
  }

  return { evidence, blockers, appendix };
}

async function captureDiff(ctx: HarnessContext, task: Task, dir: string): Promise<CapturedEvidence> {
  const log = ctx.log.child("workspace");
  const status = (await git(dir, ["status", "--porcelain"])).stdout;
  if (status.trim()) {
    await git(dir, [...HARNESS_IDENTITY, "add", "-A"]);
    await git(dir, [...HARNESS_IDENTITY, "commit", "-q", "-m", `harness: auto-commit remaining work for ${task.id}`]);
    log.info(`auto-committed leftover changes for ${task.id}`);
  }
  const base = await resolveBaseRef(task, dir);
  if (!base) return { evidence: [], blockers: [`No base commit is recorded for ${task.id}, so the diff cannot be computed.`] };
  const range = `${base}..HEAD`;
  const stat = (await git(dir, ["diff", range, "--stat"])).stdout;
  const full = (await git(dir, ["diff", range])).stdout;
  if (!full.trim()) {
    return { evidence: [], blockers: ["No committed changes on the branch — nothing to review. If the task needed no code change, use complete_task instead."] };
  }
  const blockers = scanForSecrets(full).map((f) => `Possible secret in the diff: ${f}; remove it and use an environment variable or a config file that is git-ignored`);

  const attachDir = path.join(ctx.config.paths.attachments, task.id);
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, "changes.diff"), full);
  const files = countChangedFiles(stat);
  const evidence: Evidence[] = [{ type: "diff", path: `${task.id}/changes.diff`, caption: `${files} file${files === 1 ? "" : "s"} changed` }];
  const statLines = stat.trimEnd().split("\n");
  const shown = statLines.length > STAT_MAX_LINES ? [...statLines.slice(0, STAT_MAX_LINES), `… ${statLines.length - STAT_MAX_LINES} more lines`] : statLines;
  return { evidence, blockers, appendix: `## Changes\n\`\`\`\n${shown.join("\n")}\n\`\`\`` };
}

async function resolveBaseRef(task: Task, dir: string): Promise<string | null> {
  if (task.base_ref) return task.base_ref;
  if (!task.repo) return null;
  try {
    const head = (await git(task.repo, ["rev-parse", "HEAD"])).stdout.trim();
    return (await git(dir, ["merge-base", "HEAD", head])).stdout.trim() || null;
  } catch {
    return null;
  }
}

function countChangedFiles(stat: string): number {
  const m = stat.match(/(\d+) files? changed/);
  if (m) return Number(m[1]);
  return stat
    .trimEnd()
    .split("\n")
    .filter((l) => l.includes("|")).length;
}

interface StagedCandidate {
  abs: string;
  name: string;
}

/** Regular, non-hidden files under the evidence directory, recursively, within the size limit. */
function collectEvidenceFiles(root: string): StagedCandidate[] {
  if (!fs.existsSync(root)) return [];
  const out: StagedCandidate[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && withinSize(abs)) out.push({ abs, name: path.relative(root, abs) });
    }
  };
  walk(root);
  return out;
}

/** Top-level, non-hidden regular files of a plain workspace. */
function collectDeliverables(dir: string): StagedCandidate[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith(".") && withinSize(path.join(dir, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_DELIVERABLES)
    .map((e) => ({ abs: path.join(dir, e.name), name: e.name }));
}

function withinSize(abs: string): boolean {
  try {
    return fs.statSync(abs).size <= MAX_EVIDENCE_BYTES;
  } catch {
    return false;
  }
}

/** Copy candidates into the attachments dir; images and videos first. Failures are logged, never thrown. */
function safeStage(ctx: HarnessContext, task: Task, candidates: StagedCandidate[], log: HarnessContext["log"]): Evidence[] {
  const staged: Evidence[] = [];
  for (const c of candidates) {
    try {
      staged.push(stageFile(ctx.config.paths.attachments, task.id, c.abs, c.name));
    } catch (err) {
      log.warn(`could not stage evidence file for ${task.id}`, { file: c.abs, error: describeError(err) });
    }
  }
  const rank = (e: Evidence) => (e.type === "image" ? 0 : e.type === "video" ? 1 : 2);
  return staged.sort((a, b) => rank(a) - rank(b));
}

// ---------- approval ----------

/** Apply the lead's onApprove action after the principal approved a review. Always emits approval.applied. */
export async function applyApproval(ctx: HarnessContext, task: Task, lead: LeadConfig): Promise<ApprovalResult> {
  const log = ctx.log.child("workspace");
  let result: ApprovalResult;
  try {
    result = await doApply(task, lead);
  } catch (err) {
    result = { ok: false, message: `Approval could not be applied: ${describeError(err)}` };
  }
  if (result.ok) log.info(`approval applied for ${task.id}`, { action: lead.onApprove, message: result.message, url: result.url });
  else log.error(`approval failed for ${task.id}`, { action: lead.onApprove, message: result.message });
  ctx.bus.emit({ type: "approval.applied", task_id: task.id, payload: { ok: result.ok, message: result.message, ...(result.url ? { url: result.url } : {}), action: lead.onApprove } });
  return result;
}

async function doApply(task: Task, lead: LeadConfig): Promise<ApprovalResult> {
  if (lead.onApprove === "none") return { ok: true, message: "Approved; branch/artefacts kept." };
  if (!task.branch || !task.workdir) return { ok: true, message: "Approved; artefacts kept (no branch to merge or push)." };
  if (lead.onApprove === "merge") return mergeBranch(task);
  return pushAndOpenPr(task);
}

async function mergeBranch(task: Task): Promise<ApprovalResult> {
  const repo = task.repo;
  const branch = task.branch!;
  if (!repo || !(await isGitRepo(repo))) return { ok: false, message: `Repository ${repo ?? "(unknown)"} is missing; merge manually: git merge ${branch}` };
  const dirty = (await git(repo, ["status", "--porcelain"])).stdout.trim();
  if (dirty) return { ok: false, message: `Repo has uncommitted changes; merge manually: git merge ${branch}` };
  const identity = (await gitOk(repo, ["config", "user.email"])) ? [] : HARNESS_IDENTITY;
  try {
    await git(repo, [...identity, "merge", "--no-ff", "--no-edit", branch]);
  } catch (err) {
    await gitOk(repo, ["merge", "--abort"]);
    return { ok: false, message: `Merge of ${branch} failed and was aborted: ${describeError(err)}` };
  }
  const target = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  return { ok: true, message: `Merged ${branch} into ${target || "the current branch"} of ${repo}.` };
}

async function pushAndOpenPr(task: Task): Promise<ApprovalResult> {
  const dir = task.workdir!;
  const branch = task.branch!;
  try {
    await git(dir, ["push", "-u", "origin", branch]);
  } catch (err) {
    return { ok: false, message: `Push of ${branch} failed: ${describeError(err)}` };
  }
  const remote = await remoteUrl(dir);
  const manual = `Branch pushed; open the PR manually: ${remote ?? `(no origin URL found) branch ${branch}`}`;
  if (!(await hasGh())) return { ok: true, message: manual };
  try {
    const { stdout } = await exec("gh", ["pr", "create", "--fill", "--head", branch], { cwd: dir, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    const url = stdout.split("\n").map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
    if (url) return { ok: true, message: `Pull request opened: ${url}`, url };
    return { ok: true, message: `Pull request created for ${branch}. ${stdout.trim() || manual}` };
  } catch (err) {
    return { ok: true, message: `${manual} (gh pr create failed: ${describeError(err).split("\n")[0]})` };
  }
}

async function remoteUrl(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["remote", "get-url", "origin"])).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function hasGh(): Promise<boolean> {
  try {
    await exec("gh", ["--version"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------- cleanup ----------

/** Remove a task's worktree (the branch is kept). Plain directories are left alone. Never throws. */
export async function cleanupWorkspace(ctx: HarnessContext, task: Task): Promise<void> {
  const log = ctx.log.child("workspace");
  if (workspaceKind(task) !== "git" || !task.workdir || !task.repo) return;
  if (!fs.existsSync(task.workdir)) return;
  try {
    await git(task.repo, ["worktree", "remove", "--force", task.workdir]);
    log.info(`removed worktree for ${task.id}`, { dir: task.workdir, branch: task.branch });
  } catch (err) {
    log.warn(`could not remove worktree for ${task.id}`, { dir: task.workdir, error: describeError(err) });
  }
}
