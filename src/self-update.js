import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Self-update: the daemon can check for and apply updates to its own git
// checkout OR portable Linux release-archive install, then exit(0) so the
// service manager (systemd Restart=always / launchd KeepAlive) respawns it
// with the new code. Exposed three ways:
//   - `openagi update` CLI → POST /control/update
//   - POST /control/update endpoint (dashboard / CLI)
//   - opt-in daemon cron job (OPENAGI_AUTO_UPDATE=1) that applies on a schedule
//
// Git checkouts: fast-forward only (never clobbers local changes).
// Release archives (no `.git`, e.g. `OpenAGI-Linux-arm64.tar.gz` on Linux SBCs):
// checks GitHub Releases `releases/latest`, verifies the `.sha256` checksum,
// extracts into a staging folder, and replaces distributable runtime files
// without touching `.openagi` or user state.

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_API_URL = "https://api.github.com/repos/Spshulem/openAGI/releases/latest";
const PORTABLE_SYNC_ENTRIES = [
  "bin",
  "src",
  "examples",
  "scripts",
  "assets",
  "docs",
  "node_modules",
  "package.json",
  "package-lock.json",
  "runtime-manifest.json",
  "LICENSE",
  "README.md",
  "START_HERE.txt",
  "start-openagi.sh"
];

async function gitRun(args, cwd = REPO_ROOT) {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 120000 });
  return stdout.trim();
}

async function defaultInstallDeps(cwd = REPO_ROOT) {
  await execFileAsync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd, timeout: 300000 });
}

function parseSemver(raw) {
  const clean = String(raw ?? "").trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(clean);
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  return String(pa.prerelease ?? "").localeCompare(String(pb.prerelease ?? ""));
}

function portableLinuxAssetName(platform = process.platform, arch = process.arch) {
  if (platform !== "linux") return null;
  if (arch === "arm64") return "OpenAGI-Linux-arm64.tar.gz";
  if (arch === "x64") return "OpenAGI-Linux-x64.tar.gz";
  return null;
}

async function checkReleaseArchiveUpdate({
  rootDir = REPO_ROOT,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  releaseApiUrl = process.env.OPENAGI_RELEASE_API_URL || RELEASE_API_URL
} = {}) {
  const assetName = portableLinuxAssetName(platform, arch);
  if (!assetName) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const currentSemver = parseSemver(pkg?.version);
  if (!currentSemver || typeof fetchImpl !== "function") return null;

  let response;
  try {
    response = await fetchImpl(releaseApiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `openagi-self-update/${currentSemver.version}`
      },
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    return {
      ok: false,
      mode: "release-archive",
      current: `v${currentSemver.version}`,
      updateAvailable: false,
      reason: `release check failed: ${error.message}`
    };
  }
  if (!response?.ok) {
    return {
      ok: false,
      mode: "release-archive",
      current: `v${currentSemver.version}`,
      updateAvailable: false,
      reason: `release check returned HTTP ${response?.status ?? "error"}`
    };
  }
  const release = await response.json();
  const latestSemver = parseSemver(release?.tag_name);
  if (!latestSemver) {
    return {
      ok: false,
      mode: "release-archive",
      current: `v${currentSemver.version}`,
      updateAvailable: false,
      reason: "latest release has no semver tag"
    };
  }
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const archiveAsset = assets.find((a) => a?.name === assetName);
  const checksumAsset = assets.find((a) => a?.name === `${assetName}.sha256`);
  const updateAvailable = compareSemver(latestSemver.version, currentSemver.version) > 0;
  if (updateAvailable && (!archiveAsset?.browser_download_url || !checksumAsset?.browser_download_url)) {
    return {
      ok: false,
      mode: "release-archive",
      branch: "release",
      current: `v${currentSemver.version}`,
      latest: `v${latestSemver.version}`,
      updateAvailable: false,
      reason: `release v${latestSemver.version} is missing ${assetName} or its .sha256 checksum`
    };
  }
  return {
    ok: true,
    mode: "release-archive",
    branch: "release",
    current: `v${currentSemver.version}`,
    latest: `v${latestSemver.version}`,
    behind: updateAvailable ? 1 : 0,
    ahead: 0,
    updateAvailable,
    canFastForward: updateAvailable,
    assetName,
    archiveUrl: archiveAsset?.browser_download_url ?? null,
    checksumUrl: checksumAsset?.browser_download_url ?? null
  };
}

async function applyReleaseArchiveUpdate(status, {
  rootDir = REPO_ROOT,
  fetchImpl = globalThis.fetch,
  extractArchive = null,
  // systemd sets INVOCATION_ID for every unit it starts (scripts/install-systemd.sh
  // uses Restart=always). The portable launcher (start-openagi.sh) execs
  // `openagi serve` with no respawn loop, so exiting there would take the
  // agent offline for good.
  supervised = Boolean(process.env.INVOCATION_ID)
} = {}) {
  if (!status.archiveUrl || !status.checksumUrl) {
    return { updated: false, ...status, ok: false, reason: "missing release download URL" };
  }
  const stageBase = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-release-update-"));
  try {
    const [archiveRes, checksumRes] = await Promise.all([
      fetchImpl(status.archiveUrl, {
        headers: { "User-Agent": `openagi-self-update/${status.current}` },
        signal: AbortSignal.timeout(180000)
      }),
      fetchImpl(status.checksumUrl, {
        headers: { "User-Agent": `openagi-self-update/${status.current}` },
        signal: AbortSignal.timeout(30000)
      })
    ]);
    if (!archiveRes?.ok) {
      return { updated: false, ...status, ok: false, reason: `archive download failed (HTTP ${archiveRes?.status ?? "error"})` };
    }
    if (!checksumRes?.ok) {
      return { updated: false, ...status, ok: false, reason: `checksum download failed (HTTP ${checksumRes?.status ?? "error"})` };
    }
    const archiveBytes = Buffer.from(await archiveRes.arrayBuffer());
    const checksumText = (await checksumRes.text()).trim();
    const expectedHash = (/^([a-fA-F0-9]{64})\b/.exec(checksumText)?.[1] ?? "").toLowerCase();
    if (!expectedHash) {
      return { updated: false, ...status, ok: false, reason: "invalid .sha256 checksum file in release" };
    }
    const actualHash = createHash("sha256").update(archiveBytes).digest("hex").toLowerCase();
    if (actualHash !== expectedHash) {
      return { updated: false, ...status, ok: false, reason: `SHA-256 mismatch for ${status.assetName}` };
    }

    const archivePath = path.join(stageBase, status.assetName);
    const extractDir = path.join(stageBase, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(archivePath, archiveBytes, { mode: 0o600 });

    if (typeof extractArchive === "function") {
      await extractArchive(archivePath, extractDir);
    } else {
      await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], { timeout: 120000 });
    }

    const bundleRoot = fs.existsSync(path.join(extractDir, "OpenAGI", "package.json"))
      ? path.join(extractDir, "OpenAGI")
      : extractDir;
    const bundlePkgPath = path.join(bundleRoot, "package.json");
    const bundleEntryPath = path.join(bundleRoot, "src", "index.js");
    if (!fs.existsSync(bundlePkgPath) || !fs.existsSync(bundleEntryPath)) {
      return { updated: false, ...status, ok: false, reason: "extracted release archive did not contain OpenAGI runtime" };
    }
    const bundlePkg = JSON.parse(fs.readFileSync(bundlePkgPath, "utf8"));
    const entriesToSync = [...PORTABLE_SYNC_ENTRIES];
    if (fs.existsSync(path.join(rootDir, "node")) && fs.existsSync(path.join(bundleRoot, "node"))) {
      entriesToSync.push("node");
    }

    for (const rel of entriesToSync) {
      const srcPath = path.join(bundleRoot, rel);
      if (!fs.existsSync(srcPath)) continue;
      const destPath = path.join(rootDir, rel);
      const tmpDest = `${destPath}.updating-${process.pid}`;
      const bakDest = `${destPath}.prev-${process.pid}`;
      fs.rmSync(tmpDest, { recursive: true, force: true });
      fs.rmSync(bakDest, { recursive: true, force: true });
      fs.cpSync(srcPath, tmpDest, { recursive: true, dereference: false, verbatimSymlinks: true });
      if (fs.existsSync(destPath)) {
        fs.renameSync(destPath, bakDest);
      }
      try {
        fs.renameSync(tmpDest, destPath);
        fs.rmSync(bakDest, { recursive: true, force: true });
      } catch (swapErr) {
        if (!fs.existsSync(destPath) && fs.existsSync(bakDest)) {
          try { fs.renameSync(bakDest, destPath); } catch { /* best-effort rollback */ }
        }
        throw swapErr;
      }
    }

    return {
      updated: true,
      mode: "release-archive",
      from: status.current,
      to: `v${String(bundlePkg.version ?? status.latest).replace(/^v/i, "")}`,
      branch: "release",
      depsChanged: true,
      depsInstalled: true,
      // Without a supervisor, callers must keep serving (old code) and ask the
      // owner to restart rather than exit(0) into nothing.
      restartRequired: !supervised
    };
  } catch (error) {
    return { updated: false, ...status, ok: false, reason: `release update failed: ${error.message}` };
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
}

// Inspect the checkout vs its upstream. Pure read (a `git fetch` + rev compares,
// or a GitHub Releases check on portable non-git Linux installs).
export async function checkForUpdate({ run = gitRun, release = null } = {}) {
  let branch, current;
  try {
    branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
    current = await run(["rev-parse", "--short", "HEAD"]);
  } catch (error) {
    if (run === gitRun || release) {
      const archiveStatus = await checkReleaseArchiveUpdate(release ?? {});
      if (archiveStatus) return archiveStatus;
    }
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
export async function applyUpdate({ run = gitRun, installDeps = defaultInstallDeps, release = null } = {}) {
  const status = await checkForUpdate({ run, release });
  if (!status.ok) return { updated: false, ...status };
  if (!status.updateAvailable) return { updated: false, reason: "already up to date", ...status };
  if (status.mode === "release-archive") {
    return applyReleaseArchiveUpdate(status, release ?? {});
  }
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
