import path from "node:path";
import type { PermissionPolicy } from "./types.js";

export type PolicyVerdict = { verdict: "allow" } | { verdict: "ask"; reason: string } | { verdict: "deny"; reason: string };

/**
 * Parse a Claude Code style permission rule: `Tool` or `Tool(pattern)`.
 * The pattern is a glob where `*` matches anything (including spaces and slashes).
 */
export function parseRule(rule: string): { tool: string; pattern: string | null } {
  const m = rule.trim().match(/^([A-Za-z0-9_:\-]+)(?:\((.*)\))?$/s);
  if (!m) return { tool: rule.trim(), pattern: null };
  return { tool: m[1], pattern: m[2] ?? null };
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "s");
}

/** Does a single rule match this tool call? For Bash the pattern is matched against the command; for file tools against the path. */
export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const { tool, pattern } = parseRule(rule);
  if (tool !== toolName && !(tool === "Edit" && toolName === "MultiEdit")) return false;
  if (pattern == null) return true;
  const subject = subjectOf(toolName, input);
  if (subject == null) return false;
  return globToRegExp(pattern).test(toolName === "Bash" ? subject.trim() : subject);
}

export function subjectOf(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Bash":
      return typeof input.command === "string" ? input.command : null;
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
    case "WebFetch":
      return typeof input.url === "string" ? input.url : null;
    case "Glob":
    case "Grep":
      return typeof input.pattern === "string" ? input.pattern : "";
    default:
      return typeof input.command === "string" ? input.command : "";
  }
}

/** Split a shell command on `&&`, `||`, `;`, `|` and newlines (outside of quotes). */
export function splitShell(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\n" || c === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    if ((c === "&" && cmd[i + 1] === "&") || (c === "|" && cmd[i + 1] === "|")) {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    // A single "&" backgrounds the command on its left and starts a new one (but ">&", "<&", "&>" are redirections).
    if (c === "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<" && cmd[i + 1] !== ">") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.filter((s) => s.trim().length > 0);
}

const RISKY_SHELL = [/\$\(/, /`/, /<\(/, />\(/, /^\s*(eval|exec|xargs|source|watch|script)\b/, /^\s*\.\s/, /\bbase64\s+-d/, />\s*\/dev\/sd/, /\bchmod\s+[0-7]*7[0-7]*\s+\//];
/** Wrappers whose real command is in their arguments: evaluate what they run, not the wrapper. */
const WRAPPERS = new Set(["env", "timeout", "nice", "nohup", "time", "command", "builtin", "stdbuf", "ionice", "caffeinate"]);
/** `node -e`, `python -c` and friends execute arbitrary code: never covered by the interpreter's allow rule. */
const INLINE_CODE: Record<string, RegExp> = {
  node: /(^|\s)(-e|--eval|-p|--print|--input-type)(\s|=|$)/,
  bun: /(^|\s)(-e|--eval|-p|--print)(\s|=|$)/,
  deno: /(^|\s)(eval)(\s|$)/,
  python: /(^|\s)-c(\s|$)/,
  python3: /(^|\s)-c(\s|$)/,
  ruby: /(^|\s)-e(\s|$)/,
  perl: /(^|\s)-[eE](\s|$)/,
  php: /(^|\s)-r(\s|$)/,
  sh: /.*/,
  bash: /.*/,
  zsh: /.*/,
  dash: /.*/,
  fish: /.*/,
};
/** Commands that write to the paths they are given; their path arguments must stay inside the workspace. */
const WRITING_COMMANDS = new Set(["tee", "cp", "mv", "sed", "touch", "mkdir", "chmod", "chown", "ln", "rsync", "install", "truncate", "dd", "rm", "rmdir", "unzip", "tar", "zip", "gzip", "gunzip", "patch", "git"]);
/** The API token file must never be read by an agent. */
const TOKEN_FILE_MARK = ".harness-token";

/** Strip wrappers such as `env FOO=1 timeout 30 <cmd>` down to `<cmd>`; returns null if nothing is left. */
export function unwrapCommand(cmd: string): string {
  let tokens = cmd.trim().split(/\s+/);
  for (let guard = 0; guard < 6 && tokens.length; guard++) {
    const head = tokens[0];
    if (!WRAPPERS.has(head)) break;
    tokens = tokens.slice(1);
    if (head === "env") while (tokens.length && (tokens[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) tokens = tokens.slice(1);
    else if (head === "timeout") {
      while (tokens.length && tokens[0].startsWith("-")) tokens = tokens.slice(tokens[0] === "-s" || tokens[0] === "-k" ? 2 : 1);
      tokens = tokens.slice(1); // the duration
    } else {
      while (tokens.length && tokens[0].startsWith("-")) tokens = tokens.slice(/^-(n|c|p|k|s)$/.test(tokens[0]) ? 2 : 1);
    }
  }
  return tokens.join(" ");
}

/**
 * Evaluate a tool call against the policy.
 * Order: deny > ask > allow. Anything unmatched is "ask".
 * Extra guards: compound Bash commands must be fully covered; file writes outside the workdir ask.
 */
export function evaluate(policy: PermissionPolicy, toolName: string, input: Record<string, unknown>, opts: { workdir?: string; extraAllowed?: string[] } = {}): PolicyVerdict {
  if (toolName.startsWith("mcp__harness__")) return { verdict: "allow" };
  if (toolName === "Bash") {
    // Compound commands: every segment must pass on its own, so `git status && rm -rf /` is judged by its worst part.
    const segments = splitShell(subjectOf("Bash", input) ?? "").map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) {
      let worst: PolicyVerdict = { verdict: "allow" };
      for (const seg of segments) {
        const v = evaluate(policy, "Bash", { ...input, command: seg }, opts);
        if (v.verdict === "deny") return v;
        if (v.verdict === "ask") worst = v;
      }
      return worst;
    }
  }
  if (toolName === "Bash") {
    const raw = subjectOf("Bash", input) ?? "";
    if (raw.includes(TOKEN_FILE_MARK)) return { verdict: "deny", reason: "the harness token file is off limits" };
    for (const re of RISKY_SHELL) if (re.test(raw)) return { verdict: "ask", reason: "command uses shell constructs that need a human look" };
    const unwrapped = unwrapCommand(raw);
    if (unwrapped && unwrapped !== raw.trim()) {
      // `env X=1 git push`, `timeout 30 rm -rf /`: judge the wrapped command on its own.
      return evaluate(policy, "Bash", { ...input, command: unwrapped }, opts);
    }
  }

  for (const r of policy.deny) if (ruleMatches(r, toolName, input)) return { verdict: "deny", reason: `blocked by policy rule ${r}` };
  for (const r of policy.ask) if (ruleMatches(r, toolName, input)) return { verdict: "ask", reason: `policy rule ${r} requires approval` };

  if (toolName === "Bash") {
    const cmd = (subjectOf("Bash", input) ?? "").trim();
    const head = cmd.split(/\s+/)[0] ?? "";
    const inline = INLINE_CODE[head];
    if (inline && inline.test(cmd)) return { verdict: "ask", reason: `inline code passed to ${head} needs a human look` };
    if (opts.workdir) {
      const writes = WRITING_COMMANDS.has(head) || /(^|[^<>])>{1,2}\s*\S/.test(cmd);
      if (writes && mentionsPathOutside(cmd, opts.workdir)) return { verdict: "ask", reason: "writes to a path outside the workspace" };
    }
  }

  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    const p = subjectOf(toolName, input) ?? "";
    if (p.includes(TOKEN_FILE_MARK)) return { verdict: "deny", reason: "the harness token file is off limits" };
  }

  if (opts.workdir && (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit")) {
    const p = subjectOf(toolName, input);
    if (p && !isInside(path.resolve(opts.workdir, p), opts.workdir)) return { verdict: "ask", reason: `writes outside the workspace (${p})` };
  }

  const allowed = [...policy.allow, ...(opts.extraAllowed ?? [])];
  for (const r of allowed) if (ruleMatches(r, toolName, input)) return { verdict: "allow" };
  return { verdict: "ask", reason: "not covered by the allow list" };
}

export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when any path-like token (including redirection targets) points outside the workspace. */
export function mentionsPathOutside(cmd: string, workdir: string): boolean {
  const tokens = cmd
    .split(/\s+/)
    .map((t) => t.replace(/^[<>]+/, "").replace(/^['"]|['"]$/g, ""))
    .filter((t) => t.startsWith("/") || t.startsWith("~") || t.startsWith("..") || t.includes("/../") || /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\"));
  return tokens.some((t) => t.startsWith("~") || !isInside(path.resolve(workdir, t), workdir));
}

/** Summarise a tool call for a human: "Bash: git push origin main". */
export function describeCall(toolName: string, input: Record<string, unknown>): string {
  const s = subjectOf(toolName, input);
  if (s) return `${toolName}: ${s.length > 300 ? s.slice(0, 300) + "…" : s}`;
  const str = JSON.stringify(input);
  return `${toolName}: ${str.length > 300 ? str.slice(0, 300) + "…" : str}`;
}

// ---------- secrets scan for diffs ----------

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: "OpenAI-style key", re: /sk-[A-Za-z0-9]{32,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9\-]{10,}/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: "Generic secret assignment", re: /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
];

export function scanForSecrets(diff: string): string[] {
  const findings: string[] = [];
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) {
        findings.push(`${p.name} at added line ${i + 1}: ${line.slice(0, 80)}`);
        break;
      }
    }
  }
  return findings;
}
