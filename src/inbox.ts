import fs from "node:fs";
import path from "node:path";
import type { HarnessContext, Loop } from "./types.js";

/**
 * Watch the inbox folder: every Markdown file dropped there becomes a task.
 * Front matter (between --- lines) may set lead, priority, repo, title.
 */
export function startInboxWatcher(ctx: HarnessContext): Loop {
  const { config, db, bus } = ctx;
  const log = ctx.log.child("inbox");
  const dir = config.paths.inbox;
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(config.paths.inboxProcessed, { recursive: true });
  const pending = new Map<string, NodeJS.Timeout>();

  function schedule(file: string) {
    const existing = pending.get(file);
    if (existing) clearTimeout(existing);
    pending.set(
      file,
      setTimeout(() => {
        pending.delete(file);
        try {
          ingest(file);
        } catch (err) {
          log.error(`failed to ingest ${file}`, { err });
        }
      }, 1500),
    );
  }

  function ingest(file: string) {
    const abs = path.join(dir, file);
    if (!fs.existsSync(abs) || !/\.(md|markdown|txt)$/i.test(file) || file.startsWith(".") || file.toLowerCase() === "readme.md") return;
    const raw = fs.readFileSync(abs, "utf8");
    const parsed = parseInboxFile(raw, file);
    const lead = parsed.lead && config.leads.some((l) => l.id === parsed.lead) ? parsed.lead : null;
    const task = db.tasks.create({ title: parsed.title, brief: parsed.brief, source: "inbox", lead, priority: parsed.priority ?? 3, repo: parsed.repo ?? null, status: lead ? "queued" : "inbox" });
    const dest = path.join(config.paths.inboxProcessed, `${new Date().toISOString().replace(/[:.]/g, "-")}-${file}`);
    fs.renameSync(abs, dest);
    bus.emit({ type: "task.created", task_id: task.id, payload: { title: task.title, source: "inbox", lead } });
    log.info(`ingested ${file} as ${task.id}`);
  }

  function scan() {
    try {
      for (const f of fs.readdirSync(dir)) schedule(f);
    } catch (err) {
      log.error("scan failed", { err });
    }
  }

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename) schedule(String(filename));
    });
    watcher.on("error", (err) => log.warn("watcher error; relying on polling", { err }));
  } catch (err) {
    log.warn("fs.watch unavailable; relying on polling", { err });
  }
  scan();
  const poll = setInterval(scan, 30_000);

  return {
    name: "inbox",
    stop: async () => {
      clearInterval(poll);
      watcher?.close();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}

export function parseInboxFile(raw: string, filename: string): { title: string; brief: string; lead?: string; priority?: number; repo?: string } {
  let body = raw.replace(/^﻿/, "");
  const meta: Record<string, string> = {};
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/);
      if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
    }
    body = body.slice(fm[0].length);
  }
  let title = meta.title ?? "";
  const heading = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (!title && heading) {
    title = heading[1].trim();
    body = body.replace(heading[0], "");
  }
  if (!title) title = path.basename(filename, path.extname(filename)).replace(/[-_]+/g, " ").trim() || "Untitled task";
  const priority = meta.priority ? Number(meta.priority) : undefined;
  return { title, brief: body.trim(), lead: meta.lead || undefined, priority: Number.isFinite(priority) ? priority : undefined, repo: meta.repo || undefined };
}
