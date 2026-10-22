import { saveEnv } from "./setup-wizard.js";
import { registerLinearTaskSource } from "./integrations/linear-tasks.js";
import { registerBuildBetterTaskSource } from "./integrations/buildbetter-tasks.js";

const SOURCES = Object.freeze({
  linear: { name: "Linear", key: "LINEAR_API_KEY", source: "linearTaskSource", job: "linear-task-sync", register: registerLinearTaskSource },
  buildbetter: { name: "BuildBetter", key: "BUILDBETTER_API_KEY", source: "buildBetterTaskSource", job: "buildbetter-task-sync", register: registerBuildBetterTaskSource }
});

// A fixed catalog of direct task sources, not arbitrary environment edits or
// MCP process registration. Keys are write-only, as in model settings.
export function taskIntegrationSettings(runtime) {
  return Object.entries(SOURCES).map(([id, spec]) => ({
    id, name: spec.name,
    available: Boolean(runtime[spec.source]),
    configured: Boolean(runtime[spec.source]?.isConfigured()),
    apiKeySaved: Boolean(process.env[spec.key]),
    lastSyncedAt: runtime[spec.source]?.lastSyncedAt ?? null
  }));
}

export function updateTaskIntegration(runtime, dataDir, id, apiKey) {
  const spec = SOURCES[id];
  if (!spec || !runtime[spec.source]) return false;
  if (apiKey !== null && (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512 || /\s/.test(apiKey))) {
    throw Object.assign(new Error("invalid_key"), { status: 400 });
  }
  saveEnv({ dataDir, values: apiKey === null ? {} : { [spec.key]: apiKey.trim() }, clear: apiKey === null ? [spec.key] : [] });
  // The phone profile skips unconfigured integration jobs at boot. Install
  // this one after explicit configuration, without needing to restart Node.
  if (runtime[spec.source].isConfigured() && !runtime.cron.jobs.has(spec.job)) {
    spec.register(runtime, { source: runtime[spec.source] });
  } else if (runtime.cron.jobs.has(spec.job)) {
    runtime.cron.enableJob(spec.job, runtime[spec.source].isConfigured());
  }
  return true;
}

export async function syncTaskIntegration(runtime, id) {
  const spec = SOURCES[id];
  const source = spec && runtime[spec.source];
  if (!source?.isConfigured()) return { ok: false, message: "Add an API key or finish connecting this service first." };
  try {
    const result = await source.sync();
    const parts = id === "buildbetter" ? [result.signals, result.transcripts].filter(Boolean) : [result];
    if (!parts.length || parts.some((part) => part.skipped || Number(part.failed) > 0)) {
      return { ok: false, message: "The service couldn't finish syncing. Some items may have imported. Check your API key, account access and connection, then try again." };
    }
    const counts = Object.fromEntries(["created", "updated", "completed"].map((key) =>
      [key, parts.reduce((total, part) => total + (Number(part[key]) || 0), 0)]));
    return { ok: true, ...counts };
  } catch {
    return { ok: false, message: "The service couldn't sync. Check your API key, account access and connection, then try again." };
  }
}
