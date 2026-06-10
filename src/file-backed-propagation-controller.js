import path from "node:path";
import { ensureDir, readJsonFile, safeFilename, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";
import { PropagationController } from "./propagation-controller.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

export class FileBackedPropagationController extends PropagationController {
  constructor(options = {}) {
    super(options);
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "agents", "specialists.json");
    this.workspaceRoot = options.workspaceRoot ?? path.join(path.dirname(this.storePath), "workspaces");
    this.vectorStore = options.vectorStore ?? null;
    ensureDir(path.dirname(this.storePath));
    ensureDir(this.workspaceRoot);
    if (options.autoLoad !== false) this.load();
  }

  bindVectorStore(vs) {
    this.vectorStore = vs;
    // Backfill index for any pre-existing specialists.
    for (const sp of this.list({ includeRetired: false })) {
      this.vectorStore?.upsert("specialist", sp.id, `${sp.name}\n${sp.boundedScope}\n${sp.parentGoal ?? ""}`).catch(() => {});
    }
  }

  load() {
    const store = readJsonFile(this.storePath, { version: 1, specialists: [] });
    this.specialists = new Map();
    for (const specialist of store.specialists ?? []) {
      if (!specialist.signature) continue;
      this.specialists.set(specialist.signature, specialist);
    }
    return this.list();
  }

  propagate(input) {
    const result = super.propagate(input);
    if (result.specialist) {
      this.ensureWorkspace(result.specialist);
      this.save();
      // Index the specialist's bounded scope for semantic routing (D2).
      const sp = result.specialist;
      this.vectorStore?.upsert("specialist", sp.id, `${sp.name}\n${sp.boundedScope}\n${sp.parentGoal ?? ""}`, {
        name: sp.name,
        scope: sp.boundedScope
      }).catch(() => {});
    }
    return result;
  }

  recordOutcomeQuality(id, score) {
    const sp = super.recordOutcomeQuality(id, score);
    if (sp) this.save();
    return sp;
  }

  retire(id, reason) {
    const sp = super.retire(id, reason);
    if (sp) this.save();
    return sp;
  }

  retirementSweep(opts) {
    const retired = super.retirementSweep(opts);
    if (retired.length > 0) this.save();
    return retired;
  }

  save() {
    writeJsonAtomic(this.storePath, {
      version: 1,
      updatedAt: nowIso(),
      specialists: this.list({ includeRetired: true })
    });
  }

  ensureWorkspace(specialist) {
    const workspaceDir = path.join(this.workspaceRoot, safeFilename(specialist.id));
    ensureDir(path.join(workspaceDir, "memory"));
    writeJsonAtomic(path.join(workspaceDir, "specialist.json"), specialist);
    writeTextAtomic(path.join(workspaceDir, "AGENTS.md"), buildSpecialistPrompt(specialist), 0o644);
    specialist.workspaceDir = workspaceDir;
    return workspaceDir;
  }
}

function buildSpecialistPrompt(specialist) {
  return `# ${specialist.name}

You are a propagated ABI specialist.

Parent goal: ${specialist.parentGoal}

Bounded scope: ${specialist.boundedScope}

Success metric: ${specialist.successMetric}

Allowed tools: ${specialist.allowedTools.length > 0 ? specialist.allowedTools.join(", ") : "none registered"}

Rules:
- Stay inside the bounded scope.
- Prefer cited environmental, user, and system evidence.
- Escalate when evidence is missing, conflicting, or high risk.
- Update memory when repeated or novel high-risk patterns appear.
`;
}
