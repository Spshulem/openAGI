import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Self-update: the daemon can check for and apply updates to its own git
// checkout, then exit(0) so the service manager (systemd Restart=always /
// launchd KeepAlive) respawns it with the new code. Exposed three ways:
//   - `openagi update` CLI → POST /control/update
//   - POST /control/update endpoint (dashboard / CLI)
//   - opt-in daemon cron job (OPENAGI_AUTO_UPDATE=1) that applies on a schedule
//
// Fast-forward only: never clobbers local changes. No-op (with a clear reason)
// when there's no upstream, the checkout has diverged, or it's already current.

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function gitRun(args, cwd = REPO_ROOT) {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 120000 });
  return stdout.trim();
}

async function defaultInstallDeps() {
  await execFileAsync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: REPO_ROOT, timeout: 300000 });
}

// Inspect the checkout vs its upstream. Pure read (a `git fetch` + rev compares).
export async function checkForUpdate({ run = gitRun } = {}) {
  let branch, current;
  try {
    branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
    current = await run(["rev-parse", "--short", "HEAD"]);
  } catch (error) {
    return { ok: false, reason: `not a git checkout: ${error.message}`, updateAvailable: false };
  }
  let upstream = null;
  try { upstream = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); }
  catch { return { ok: true, branch, current, upstream: null, behind: 0, ahead: 0, updateAvailable: false, reason: "no upstream tracking branch" }; }

  try { await run(["fetch", "--quiet"]); }
  catch (error) { return { ok: false, branch, current, upstream, updateAvailable: false, reason: `fetch failed: ${error.message}` }; }

  const behind = Number.parseInt(await run(["rev-list", "--count", `HEAD..${upstream}`]), 10) || 0;
  const ahead = Number.parseInt(await run(["rev-list", "--count", `${upstream}..HEAD`]), 10) || 0;
  const latest = await run(["rev-parse", "--short", upstream]);
  // "unrelated": HEAD and upstream share NO common ancestor — the upstream
  // history was rewritten (e.g. a filter-repo purge / force-push). Distinct from
  // ordinary divergence (local commits), which always shares a merge-base. We
  // use this to safely auto-recover without ever discarding real local commits.
  let unrelated = false;
  if (behind > 0 && ahead > 0) {
    try { await run(["merge-base", "HEAD", upstream]); }
    catch { unrelated = true; }
  }
  return {
    ok: true, branch, current, upstream, latest, behind, ahead, unrelated,
    updateAvailable: behind > 0,
    canFastForward: behind > 0 && ahead === 0
  };
}

// Apply an available update (fast-forward), reinstalling deps if package.json
// changed. Returns { updated, ... }. Does NOT restart — the caller decides
// (the endpoint/cron schedule a process exit so the supervisor respawns).
export async function applyUpdate({ run = gitRun, installDeps = defaultInstallDeps } = {}) {
  const status = await checkForUpdate({ run });
  if (!status.ok) return { updated: false, ...status };
  if (!status.updateAvailable) return { updated: false, reason: "already up to date", ...status };
  if (!status.canFastForward) {
    // Recover from an upstream history rewrite: when the histories are unrelated
    // (no shared ancestor) AND the working tree is clean, hard-reset onto
    // upstream. Gated on `unrelated` so real local commits (which share a
    // merge-base) are never discarded, and on a clean tree so no uncommitted
    // edits are lost. This auto-heals installs whose ff-update broke after a
    // history purge — without it they'd silently stop updating.
    if (status.unrelated) {
      const dirty = (await run(["status", "--porcelain"]).catch(() => "dirty")).length > 0;
      if (dirty) {
        return { updated: false, reason: "upstream history was rewritten but the working tree is dirty — resolve manually with `git reset --hard <upstream>`", ...status };
      }
      await run(["reset", "--hard", status.upstream]);
      try { await installDeps(); }
      catch (error) { return { updated: true, recovered: true, from: status.current, to: status.latest, depsInstalled: false, depsError: error.message, branch: status.branch }; }
      const to = await run(["rev-parse", "--short", "HEAD"]);
      return { updated: true, recovered: true, reason: "recovered from upstream history rewrite (hard reset onto a clean checkout)", from: status.current, to, branch: status.branch };
    }
    return { updated: false, reason: `local commits / divergence (ahead ${status.ahead}) — not fast-forwardable; resolve manually`, ...status };
  }

  // Which files change — decide whether deps need reinstalling.
  const changedFiles = await run(["diff", "--name-only", "HEAD", status.upstream]).catch(() => "");
  const depsChanged = /(^|\n)(package\.json|package-lock\.json)\b/.test(changedFiles);

  await run(["merge", "--ff-only", status.upstream]);
  if (depsChanged) {
    try { await installDeps(); }
    catch (error) { return { updated: true, from: status.current, to: status.latest, depsChanged: true, depsInstalled: false, depsError: error.message, branch: status.branch, behind: status.behind }; }
  }
  const to = await run(["rev-parse", "--short", "HEAD"]);
  return { updated: true, from: status.current, to, behind: status.behind, depsChanged, depsInstalled: depsChanged ? true : undefined, branch: status.branch };
}
