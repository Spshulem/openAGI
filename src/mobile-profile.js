// Mobile profile (OPENAGI_PROFILE=mobile): the daemon running inside the
// iOS/Android app via nodejs-mobile. A phone has no screen capture, no
// desktop apps, no git checkout to update and cannot spawn processes, so this
// module names what is switched off there. Every caller gates on
// isMobileProfile(); with the profile unset, desktop behavior is unchanged.
// See docs/superpowers/specs/2026-10-15-openagi-phone-only-design.md, section 3.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

export function isMobileProfile(env = process.env) {
  return String(env?.OPENAGI_PROFILE ?? "").trim().toLowerCase() === "mobile";
}

function readonlySet(values) {
  const set = new Set(values);
  for (const method of ["add", "delete", "clear"]) {
    Object.defineProperty(set, method, {
      value: () => { throw new TypeError("MOBILE profile sets are read-only"); }
    });
  }
  return Object.freeze(set);
}

// Jobs that read screen activity, the filesystem or desktop apps, or that
// update code. Always off under the mobile profile.
export const MOBILE_DISABLED_CRON_JOBS = readonlySet([
  "inbox-sweep",
  "imessage-extract",
  "task-activity-scan",
  "hourly-pattern-mine",
  "nightly-pattern-mine",
  "ambient-digest",
  "proactive-observer",
  "weekly-project-scan",
  "observation-retention",
  "self-update"
]);

// Integration sync jobs stay off until the user adds that integration. The
// env keys are the ones each source's isConfigured() reads
// (src/integrations/linear-tasks.js, src/integrations/buildbetter-tasks.js).
export const MOBILE_INTEGRATION_CRON_JOBS = Object.freeze({
  "linear-task-sync": Object.freeze(["LINEAR_API_KEY"]),
  "buildbetter-task-sync": Object.freeze(["BUILDBETTER_API_KEY"])
});

// The full disabled set for an env: the fixed list plus every integration job
// whose keys are not configured.
export function mobileDisabledCronJobs(env = process.env) {
  const ids = [...MOBILE_DISABLED_CRON_JOBS];
  for (const [id, keys] of Object.entries(MOBILE_INTEGRATION_CRON_JOBS)) {
    if (!keys.some((key) => String(env?.[key] ?? "").trim())) ids.push(id);
  }
  return readonlySet(ids);
}

// The tools a small on-device model sees per turn.
export const MOBILE_MODEL_TOOLS = Object.freeze([
  "remember",
  "recall",
  "add_task",
  "list_tasks",
  "complete_task",
  "move_task",
  "schedule_message"
]);

// Wrap cron.addJob while default jobs register: disabled ids are not added,
// and a row already persisted (e.g. a data dir moved from a Mac) is turned
// off. Integration jobs only get skipped, never force-disabled, so a key added
// later takes effect on the next boot. Returns a restore function.
export function installMobileCronFilter(cron, env = process.env) {
  if (!cron || typeof cron.addJob !== "function") return () => {};
  const disabled = mobileDisabledCronJobs(env);
  const hadOwn = Object.prototype.hasOwnProperty.call(cron, "addJob");
  const original = cron.addJob;
  cron.addJob = function mobileFilteredAddJob(job) {
    if (!job?.id || !disabled.has(job.id)) return original.call(this, job);
    const existing = this.jobs?.get?.(job.id) ?? null;
    if (existing?.enabled && MOBILE_DISABLED_CRON_JOBS.has(job.id)) this.enableJob?.(job.id, false);
    return existing;
  };
  return () => {
    if (hadOwn) cron.addJob = original;
    else delete cron.addJob;
  };
}

export const NOT_AVAILABLE_ON_PHONE = "not_available_on_phone";

const REFUSED_ROUTE_PREFIXES = Object.freeze([
  ["/computer-use", "Computer use"],
  ["/coding-agents", "The coding supervisor"],
  ["/control/update", "Self-update"]
]);

// HTTP routes that do not exist on a phone. Returns the 409 body, or null.
export function mobileRouteRefusal(pathname) {
  for (const [prefix, label] of REFUSED_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { error: NOT_AVAILABLE_ON_PHONE, message: `${label} is not available on phone.` };
    }
  }
  return null;
}

// WebSocket upgrade entries (the shape attachG2SpeechRelay's `upgrades`
// takes) that refuse the voice relay and the G2 speech relay with 404.
export const MOBILE_REFUSED_UPGRADE_PATHS = Object.freeze(["/nodes/voice", "/nodes/g2/speech"]);
export function mobileRefusedUpgrades() {
  return MOBILE_REFUSED_UPGRADE_PATHS.map((path) => ({
    path,
    upgrade: (req, socket) => socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
    close() {}
  }));
}

export class MobileSpawnRefusedError extends Error {
  constructor(what) {
    super(`${what} is not available on phone: OpenAGI cannot start other programs there.`);
    this.name = "MobileSpawnRefusedError";
    this.code = "OPENAGI_MOBILE_NO_SPAWN";
  }
}

export function assertCanSpawn(what = "Starting a process", env = process.env) {
  if (isMobileProfile(env)) throw new MobileSpawnRefusedError(what);
}

const SPAWN_FUNCTIONS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
let spawnGuardInstalled = false;

// Process-wide chokepoint: replace every child_process launcher with one that
// throws MobileSpawnRefusedError, and push that into ESM named imports
// (`import { spawn } from "node:child_process"`) via syncBuiltinESMExports.
// Called once at boot under the mobile profile; never on desktop.
export function installMobileSpawnGuard() {
  if (spawnGuardInstalled) return false;
  for (const name of SPAWN_FUNCTIONS) {
    if (typeof childProcess[name] !== "function") continue;
    childProcess[name] = function refusedOnPhone() {
      throw new MobileSpawnRefusedError(`child_process.${name}`);
    };
  }
  syncBuiltinESMExports();
  spawnGuardInstalled = true;
  return true;
}
