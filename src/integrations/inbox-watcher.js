// Inbox watcher: reads any markdown / text file dropped into
// .openagi/inbox/ and parses it for task lines. Designed to support
// reMarkable users (point your Dropbox→reMarkable sync at the inbox
// folder), Obsidian, paper notes you scanned to text, etc.
//
// Parse rules:
//   - GitHub-style checkboxes ("- [ ] X") become pending tasks
//   - Checked items ("- [x] X") become completed tasks
//   - Lines starting with "TODO:", "TASK:", "REMINDER:" become tasks
//   - The first line of the file (if not a task) becomes the source file's
//     "title" used for grouping
//
// Each parsed task gets sourceId = "inbox:<filename>:<line>" so re-parsing
// the same file doesn't duplicate.
//
// Files are moved to .openagi/inbox/processed/ after parsing so the watch
// loop doesn't re-pick them up.

import path from "node:path";
import fs from "node:fs";
import { ensureDir } from "../file-utils.js";
import { nowIso } from "../utils.js";
import { resolveDataDir } from "../data-dir.js";

const POLL_INTERVAL_MS = 30 * 1000;

export class InboxWatcher {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.inboxDir = path.join(this.dataDir, "inbox");
    this.processedDir = path.join(this.inboxDir, "processed");
    ensureDir(this.inboxDir);
    ensureDir(this.processedDir);
  }

  isConfigured() {
    return Boolean(this.runtime?.tasks?.add);
  }

  async sweep() {
    if (!this.isConfigured()) return { skipped: true, reason: "task store not available" };

    let files;
    try {
      files = fs.readdirSync(this.inboxDir).filter((f) => {
        if (f === "processed") return false;
        if (f.startsWith(".")) return false;
        const ext = path.extname(f).toLowerCase();
        return ext === ".md" || ext === ".txt" || ext === ".markdown" || ext === "";
      });
    } catch { return { skipped: true, reason: "inbox dir unreadable" }; }

    if (files.length === 0) return { processed: 0 };

    let totalCreated = 0;
    let totalCompleted = 0;
    const filesProcessed = [];

    for (const file of files) {
      const fullPath = path.join(this.inboxDir, file);
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (!stat.isFile()) continue;
      // Skip files actively being written to (mtime within 3s).
      if (Date.now() - stat.mtimeMs < 3000) continue;

      let text;
      try { text = fs.readFileSync(fullPath, "utf8"); } catch { continue; }

      const { created, completed } = this.parseFile(file, text);
      totalCreated += created;
      totalCompleted += completed;
      filesProcessed.push(file);

      // Move to processed/ so we don't re-parse next sweep.
      try {
        const destPath = path.join(this.processedDir, `${Date.now()}-${file}`);
        fs.renameSync(fullPath, destPath);
      } catch { /* best effort */ }
    }

    return { processed: filesProcessed.length, created: totalCreated, completed: totalCompleted, files: filesProcessed };
  }

  parseFile(filename, text) {
    const lines = text.split(/\r?\n/);
    let created = 0;
    let completed = 0;

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];
      const parsed = parseTaskLine(line);
      if (!parsed) continue;

      const sourceId = `inbox:${filename}:${lineNo + 1}`;
      const sourceMeta = {
        file: filename,
        line: lineNo + 1,
        rawLine: line.slice(0, 200),
        importedAt: nowIso()
      };

      try {
        const task = this.runtime.tasks.add(
          {
            title: parsed.title,
            status: parsed.completed ? "completed" : "pending",
            bucket: parsed.completed ? "done" : "this_week",
            sourceId,
            sourceMeta
          },
          { source: "inbox", queue: "user" }
        );
        if (parsed.completed && task.status !== "completed") {
          this.runtime.tasks.complete(task.id, "inbox-import");
          completed += 1;
        } else if (parsed.completed) {
          completed += 1;
        } else {
          created += 1;
        }
      } catch { /* skip bad rows */ }
    }
    return { created, completed };
  }
}

// Parse one line into { title, completed } or null if not a task line.
export function parseTaskLine(raw) {
  if (!raw || typeof raw !== "string") return null;
  const line = raw.trim();
  if (!line) return null;

  // GitHub-style checkbox
  let m = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
  if (m) {
    return { completed: m[1].toLowerCase() === "x", title: m[2].trim() };
  }

  // Explicit prefix
  m = line.match(/^(?:TODO|TASK|REMINDER|TO DO):\s*(.+)$/i);
  if (m) {
    return { completed: false, title: m[1].trim() };
  }

  return null;
}

export function registerInboxWatcher(runtime, options = {}) {
  const watcher = options.watcher ?? new InboxWatcher({ runtime, ...options });
  if (runtime.cron?.addJob) {
    runtime.cron.addJob({
      id: "inbox-sweep",
      name: "Inbox folder watcher (drop .md/.txt files for tasks)",
      enabled: true,
      task: "inbox-sweep",
      intervalMs: POLL_INTERVAL_MS
    });
  }
  runtime.inboxWatcher = watcher;
  return { registered: true };
}
