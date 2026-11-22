// Self-update: check + apply against a fake git, covering up-to-date,
// fast-forwardable, diverged, no-upstream, and deps-changed paths.
import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdate, applyUpdate } from "../src/self-update.js";

// Build a fake `git` runner from a scripted command→output map. Records the
// commands so we can assert what ran (e.g. that a merge happened or didn't).
function fakeGit(responses) {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    for (const [pattern, val] of Object.entries(responses)) {
      if (key.startsWith(pattern)) {
        if (val instanceof Error) throw val;
        return typeof val === "function" ? val() : val;
      }
    }
    throw new Error(`unexpected git: ${key}`);
  };
  return { run, calls };
}

test("checkForUpdate reports behind/available when upstream is ahead", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "3",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "bbbbbbb"
  });
  const r = await checkForUpdate({ run });
  assert.equal(r.updateAvailable, true);
  assert.equal(r.behind, 3);
  assert.equal(r.canFastForward, true);
  assert.equal(r.latest, "bbbbbbb");
});

test("checkForUpdate: up to date", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "0",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "aaaaaaa"
  });
  const r = await checkForUpdate({ run });
  assert.equal(r.updateAvailable, false);
});

test("checkForUpdate: no upstream → not available, clear reason", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": new Error("no upstream")
  });
  const r = await checkForUpdate({ run });
  assert.equal(r.updateAvailable, false);
  assert.match(r.reason, /no upstream/);
});

test("applyUpdate fast-forwards and signals what changed (no deps)", async () => {
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": () => calls.includes("merge --ff-only origin/main") ? "bbbbbbb" : "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "2",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "bbbbbbb",
    "diff --name-only HEAD origin/main": "src/foo.js\nREADME.md",
    "merge --ff-only origin/main": ""
  });
  let installed = false;
  const r = await applyUpdate({ run, installDeps: async () => { installed = true; } });
  assert.equal(r.updated, true);
  assert.equal(r.to, "bbbbbbb");
  assert.equal(r.depsChanged, false);
  assert.equal(installed, false, "no npm install when package.json didn't change");
  assert.ok(calls.includes("merge --ff-only origin/main"));
});

test("applyUpdate reinstalls deps when package.json changed", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "ccccccc",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "1",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "ddddddd",
    "diff --name-only HEAD origin/main": "package.json\npackage-lock.json\nsrc/x.js",
    "merge --ff-only origin/main": ""
  });
  let installed = false;
  const r = await applyUpdate({ run, installDeps: async () => { installed = true; } });
  assert.equal(r.updated, true);
  assert.equal(r.depsChanged, true);
  assert.equal(installed, true);
});

test("applyUpdate refuses to update a diverged checkout (won't clobber local commits)", async () => {
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "2",
    "rev-list --count origin/main..HEAD": "1",   // local is ahead → diverged
    "merge-base HEAD origin/main": "c0mm0n",      // shared ancestor → real local commits
    "rev-parse --short origin/main": "bbbbbbb"
  });
  const r = await applyUpdate({ run, installDeps: async () => {} });
  assert.equal(r.updated, false);
  assert.match(r.reason, /diverg|fast-forward/i);
  assert.ok(!calls.includes("merge --ff-only origin/main"), "must not merge a diverged checkout");
  assert.ok(!calls.some((c) => c.startsWith("reset --hard")), "must not hard-reset a checkout with real local commits");
});

test("applyUpdate recovers from an upstream history rewrite (unrelated + clean tree → hard reset)", async () => {
  let resetTo = null, installed = false;
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "0ldhash",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "300",  // looks fully behind...
    "rev-list --count origin/main..HEAD": "295",  // ...AND ahead (unrelated histories)
    "merge-base HEAD origin/main": new Error("no merge base"), // ← no shared ancestor
    "rev-parse --short origin/main": "newhash",
    "status --porcelain": "",                      // clean working tree
    "reset --hard origin/main": () => { resetTo = "origin/main"; return ""; }
  });
  const r = await applyUpdate({ run, installDeps: async () => { installed = true; } });
  assert.equal(r.updated, true);
  assert.equal(r.recovered, true, "flagged as a rewrite recovery");
  assert.equal(resetTo, "origin/main", "hard-reset onto upstream");
  assert.ok(installed, "deps reinstalled after recovery");
  assert.ok(!calls.includes("merge --ff-only origin/main"), "recovers via reset, not merge");
});

test("applyUpdate will NOT hard-reset a rewrite if the tree is dirty (protects local edits)", async () => {
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "0ldhash",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "300",
    "rev-list --count origin/main..HEAD": "295",
    "merge-base HEAD origin/main": new Error("no merge base"),
    "rev-parse --short origin/main": "newhash",
    "status --porcelain": " M src/foo.js"           // uncommitted local change
  });
  const r = await applyUpdate({ run, installDeps: async () => {} });
  assert.equal(r.updated, false);
  assert.match(r.reason, /dirty|resolve manually/i);
  assert.ok(!calls.some((c) => c.startsWith("reset --hard")), "never hard-reset a dirty tree");
});

test("applyUpdate: already up to date is a clean no-op", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "0",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "aaaaaaa"
  });
  const r = await applyUpdate({ run, installDeps: async () => {} });
  assert.equal(r.updated, false);
  assert.match(r.reason, /up to date/i);
});

test("portable Linux release-archive self-update verifies SHA-256 and updates runtime while preserving .openagi", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-portable-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, ".openagi"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "openagi", version: "0.0.83" }));
  fs.writeFileSync(path.join(rootDir, "src", "index.js"), "export const v = '0.0.83';\n");
  fs.writeFileSync(path.join(rootDir, ".openagi", "secret.txt"), "keep-me-intact");

  const fakeArchiveBytes = Buffer.from("fake-tarball-payload-0.0.84");
  const goodSha = createHash("sha256").update(fakeArchiveBytes).digest("hex");
  const notGitRun = async () => { throw new Error("fatal: not a git repository"); };

  const makeReleaseFetch = (shaText) => async (url) => {
    if (String(url).endsWith("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.0.84",
          assets: [
            { name: "OpenAGI-Linux-arm64.tar.gz", browser_download_url: "https://example.test/OpenAGI-Linux-arm64.tar.gz" },
            { name: "OpenAGI-Linux-arm64.tar.gz.sha256", browser_download_url: "https://example.test/OpenAGI-Linux-arm64.tar.gz.sha256" }
          ]
        })
      };
    }
    if (String(url).endsWith(".tar.gz")) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeArchiveBytes.buffer.slice(fakeArchiveBytes.byteOffset, fakeArchiveBytes.byteOffset + fakeArchiveBytes.byteLength)
      };
    }
    if (String(url).endsWith(".sha256")) {
      return {
        ok: true,
        status: 200,
        text: async () => `${shaText}  OpenAGI-Linux-arm64.tar.gz\n`
      };
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const check = await checkForUpdate({
    run: notGitRun,
    release: { rootDir, platform: "linux", arch: "arm64", fetchImpl: makeReleaseFetch(goodSha) }
  });
  assert.equal(check.ok, true);
  assert.equal(check.mode, "release-archive");
  assert.equal(check.current, "v0.0.83");
  assert.equal(check.latest, "v0.0.84");
  assert.equal(check.updateAvailable, true);

  // Mismatched checksum fails closed before extracting
  const badRes = await applyUpdate({
    run: notGitRun,
    release: {
      rootDir,
      platform: "linux",
      arch: "arm64",
      fetchImpl: makeReleaseFetch("0".repeat(64)),
      extractArchive: async () => { throw new Error("must not extract when sha mismatches"); }
    }
  });
  assert.equal(badRes.updated, false);
  assert.match(badRes.reason, /SHA-256 mismatch/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version, "0.0.83");

  // Valid checksum extracts and swaps runtime entries while preserving `.openagi`
  const goodRes = await applyUpdate({
    run: notGitRun,
    release: {
      rootDir,
      platform: "linux",
      arch: "arm64",
      fetchImpl: makeReleaseFetch(goodSha),
      extractArchive: async (_archivePath, extractDir) => {
        const bundle = path.join(extractDir, "OpenAGI");
        fs.mkdirSync(path.join(bundle, "src"), { recursive: true });
        fs.writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ name: "openagi", version: "0.0.84" }));
        fs.writeFileSync(path.join(bundle, "src", "index.js"), "export const v = '0.0.84';\n");
      }
    }
  });
  assert.equal(goodRes.updated, true);
  assert.equal(goodRes.from, "v0.0.83");
  assert.equal(goodRes.to, "v0.0.84");
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version, "0.0.84");
  assert.match(fs.readFileSync(path.join(rootDir, "src", "index.js"), "utf8"), /0\.0\.84/);
  assert.equal(fs.readFileSync(path.join(rootDir, ".openagi", "secret.txt"), "utf8"), "keep-me-intact");
});

test("portable release-archive update without a supervisor reports restartRequired instead of relying on a respawn", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const archiveBytes = Buffer.from("fake-tarball-payload-0.0.84");
  const sha = createHash("sha256").update(archiveBytes).digest("hex");
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.0.84",
          assets: [
            { name: "OpenAGI-Linux-x64.tar.gz", browser_download_url: "https://example.test/OpenAGI-Linux-x64.tar.gz" },
            { name: "OpenAGI-Linux-x64.tar.gz.sha256", browser_download_url: "https://example.test/OpenAGI-Linux-x64.tar.gz.sha256" }
          ]
        })
      };
    }
    if (u.endsWith(".tar.gz")) return { ok: true, status: 200, arrayBuffer: async () => archiveBytes };
    if (u.endsWith(".sha256")) return { ok: true, status: 200, text: async () => `${sha}  OpenAGI-Linux-x64.tar.gz\n` };
    throw new Error(`unexpected url: ${url}`);
  };
  const runUpdate = async (supervised) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-portable-restart-"));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name: "openagi", version: "0.0.83" }));
    fs.writeFileSync(path.join(rootDir, "src", "index.js"), "export const v = '0.0.83';\n");
    return applyUpdate({
      run: async () => { throw new Error("fatal: not a git repository"); },
      release: {
        rootDir,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        supervised,
        extractArchive: async (_archivePath, extractDir) => {
          const bundle = path.join(extractDir, "OpenAGI");
          fs.mkdirSync(path.join(bundle, "src"), { recursive: true });
          fs.writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ name: "openagi", version: "0.0.84" }));
          fs.writeFileSync(path.join(bundle, "src", "index.js"), "export const v = '0.0.84';\n");
        }
      }
    });
  };

  // start-openagi.sh execs `openagi serve` directly: nothing respawns it.
  const unmanaged = await runUpdate(false);
  assert.equal(unmanaged.updated, true);
  assert.equal(unmanaged.restartRequired, true);

  // Under systemd (Restart=always) the normal exit-and-respawn path applies.
  const managed = await runUpdate(true);
  assert.equal(managed.updated, true);
  assert.equal(managed.restartRequired, false);
});
