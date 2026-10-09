import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFleetConfig, runCommand } from "../src/fleet/contracts.js";
import { StorageManager, deleteOption } from "../src/fleet/storage.js";
import { FleetStore } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { GB, gitState, openUnder, readThreadUse, readVolumes, scanStorage, sizeOf, storagePaths } from "../src/fleet/sources/storage.js";

// Git in these fixtures must not read the owner's global config (a global
// excludes file would ignore node_modules everywhere).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

const DAY = 86_400_000;
const UUID = "6A1D4881-CF2D-3CB6-87D8-54B2F28BE65D";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" }).toString();
}

function write(file, text = "x".repeat(4096)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// Every entry under p (itself included) gets this age.
function age(p, ms) {
  const at = new Date(Date.now() - ms);
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) age(path.join(p, name), ms);
  fs.utimesSync(p, at, at);
}

// A clone with an origin; pushed unless told otherwise. Aged idleDays.
function makeWorktree(env, dir, { idleDays = 40, pushed = true, dirty = false, ignore = "node_modules/\n", build = true } = {}) {
  const origin = path.join(env.root, "origins", `${path.basename(dir)}-${Math.random().toString(16).slice(2)}.git`);
  fs.mkdirSync(origin, { recursive: true });
  git(origin, "init", "--bare", "-q", "-b", "main");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  write(path.join(dir, ".gitignore"), ignore);
  write(path.join(dir, "README.md"), "hi");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
  if (!pushed) {
    write(path.join(dir, "more.txt"), "more");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "two");
  }
  if (dirty) write(path.join(dir, "notes.txt"), "draft");
  if (build) write(path.join(dir, "node_modules", "pkg", "index.js"));
  age(dir, idleDays * DAY);
  return dir;
}

function setup(t, { mode = "observe", dataGb = 40, sdGb = 500, sdMounted = true, storage = {}, now = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const sd = path.join(root, "sd");
  const dataDir = path.join(root, "data");
  for (const dir of [home, sd, dataDir, path.join(home, "Downloads"), path.join(home, "Dev", "worktrees")]) fs.mkdirSync(dir, { recursive: true });
  write(path.join(sd, ".codex-xtra-volume-identity"), `volume_uuid=${UUID}\nvolume_name=Xtra\n`);
  const env = {
    root, home, sd, dataDir, mode, open: new Set(), procs: new Set(["launchd", "zsh"]), free: { data: dataGb * GB, sd: sdGb * GB }, total: { data: 2000 * GB, sd: 2000 * GB }, lsofFails: false, statfsFails: false, sdMounted, busy: [], clock: now,
    // Hooks: lsof calls (and a gate to hold them), after each lsof read, each
    // rm (the tree removed), du results by path, and the budget clock.
    lsofCalls: 0, lsofGate: null, afterLsof: null, onRm: null, duFails: new Set(), duKb: new Map(), dittoCalls: [], clockFn: Date.now
  };
  env.config = resolveFleetConfig({}, {
    home, mode, managerRef: "none",
    paths: { conductorDb: path.join(root, "conductor.db"), codexHome: path.join(root, "codex") },
    bins: { lsof: "fake-lsof", ps: "fake-ps", ditto: "fake-ditto", diskutil: "fake-diskutil" },
    storage: { enabled: true, sdMount: sd, dataMount: home, askMinGb: 0, archiveMinBytes: 1, uid: 501, ...storage }
  });
  env.run = async (cmd, args, options) => {
    if (cmd === "fake-lsof") {
      env.lsofCalls += 1;
      if (env.lsofGate) await env.lsofGate;
      const out = env.lsofFails ? { code: 1, stdout: "", stderr: "lsof broke" } : { code: 0, stdout: `p1\nn/\n${[...env.open].map((p) => `n${p}`).join("\n")}\n` };
      env.afterLsof?.();
      return out;
    }
    if (cmd === "fake-ps") return { code: 0, stdout: `${[...env.procs].join("\n")}\n` };
    if (cmd === "fake-ditto") { env.dittoCalls.push({ args, options }); return { code: 0, stdout: "" }; }
    if (cmd.startsWith("fake-")) throw new Error(`unexpected ${cmd}`);
    if (path.basename(cmd) === "du") {
      const target = args.at(-1);
      env.onDu?.(target);
      if (env.duFails.has(target)) return { code: null, timedOut: true, stdout: "" };
      if (env.duKb.has(target)) return { code: 0, stdout: `${env.duKb.get(target)}\t${target}\n` };
    }
    if (path.basename(cmd) === "git") env.onGit?.(args);
    const result = await runCommand(cmd, args, options);
    if (path.basename(cmd) === "rm") env.onRm?.(args.at(-1));
    return result;
  };
  env.deps = {
    run: env.run,
    statfs: async (mount) => {
      if (env.statfsFails) throw new Error("statfs broke");
      return { bsize: 1, blocks: mount === sd ? env.total.sd : env.total.data, bavail: mount === sd ? env.free.sd : env.free.data };
    },
    isMount: async (mount) => (mount === sd ? env.sdMounted : true),
    clock: () => env.clockFn(),
    ...(now ? { now: () => env.clock() } : {})
  };
  env.store = new FleetStore({ dir: path.join(dataDir, "fleet") });
  env.manager = () => new StorageManager({
    config: env.config, dir: path.join(dataDir, "fleet", "storage"), store: env.store, deps: env.deps,
    getMode: () => env.mode, busyCwds: () => env.busy
  });
  return env;
}

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

test("volumes: free space per volume, SD identity recorded once, a swapped or missing card refused", async (t) => {
  const env = setup(t, { dataGb: 40, sdGb: 60 });
  const manager = env.manager();
  const rows = await manager.refreshVolumes();
  assert.equal(rows.find((row) => row.id === "data").freeBytes, 40 * GB);
  assert.equal(manager.sdOk(), true);
  assert.equal(manager.state.identity.uuid, UUID);
  write(path.join(env.sd, ".codex-xtra-volume-identity"), "volume_uuid=11111111-2222-3333-4444-555555555555\n");
  await manager.refreshVolumes();
  assert.equal(manager.sdOk(), false);
  assert.equal(manager.volume("sd").identityDetail, "a different card is mounted");
  env.sdMounted = false;
  const unmounted = await readVolumes(env.config, env.deps, { recordedIdentity: UUID });
  assert.equal(unmounted.find((row) => row.id === "sd").mounted, false);
  assert.equal(unmounted.find((row) => row.id === "sd").identity.ok, false);
  env.statfsFails = true;
  await assert.rejects(manager.refreshVolumes(), /storage read failed|statfs broke/);
  assert.equal(manager.unknown, true);
  assert.equal(manager.volume("data").freeBytes, 40 * GB, "a failed read keeps the last one");
});

test("open-path prefix check matches the path and its children only", () => {
  const open = ["/a/wt-2/x", "/a/wt.old/y", "/a/wt/node_modules/z"].sort();
  assert.equal(openUnder(open, "/a/wt"), true);
  assert.equal(openUnder(open, "/a/wt/node_modules"), true);
  assert.equal(openUnder(open, "/a/w"), false);
  assert.equal(openUnder(["/a/wt"], "/a/wt"), true);
  assert.equal(openUnder(["/a/wt-2/x"], "/a/wt"), false);
  assert.equal(openUnder(null, "/a/wt"), true, "no snapshot counts as open");
});

test("build output: idle, ignored, unused worktrees only; never through a symlink", async (t) => {
  const env = setup(t);
  const roots = path.join(env.home, "Dev", "worktrees");
  const idle = makeWorktree(env, path.join(roots, "idle"), { idleDays: 20 });
  const recent = makeWorktree(env, path.join(roots, "recent"), { idleDays: 20 });
  write(path.join(recent, "src.js"), "new");
  const used = makeWorktree(env, path.join(roots, "used"), { idleDays: 20 });
  env.open.add(path.join(used, "README.md"));
  makeWorktree(env, path.join(roots, "tracked"), { idleDays: 20, ignore: "dist/\n" });
  const cargo = makeWorktree(env, path.join(roots, "cargo"), { idleDays: 20, build: false, ignore: "target/\n" });
  write(path.join(cargo, "Cargo.toml"), "[package]");
  write(path.join(cargo, "target", "debug", "app"));
  write(path.join(cargo, "sub", "target", "x"));
  age(cargo, 20 * DAY);
  const elsewhere = makeWorktree(env, path.join(env.root, "outside"), { idleDays: 20 });
  fs.symlinkSync(elsewhere, path.join(roots, "linked"));
  // "node_modules" (no slash) also matches a symlink: only the symlink
  // guard keeps it out.
  const linkedNm = makeWorktree(env, path.join(roots, "linked-nm"), { idleDays: 20, build: false, ignore: "node_modules\n" });
  fs.symlinkSync(path.join(elsewhere, "node_modules"), path.join(linkedNm, "node_modules"));
  age(linkedNm, 20 * DAY);

  assert.equal(git(linkedNm, "check-ignore", "node_modules").trim(), "node_modules", "git ignores the symlink");
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  const builds = result.candidates.filter((item) => item.rule === "build").map((item) => item.path).sort();
  assert.deepEqual(builds, [path.join(cargo, "target"), path.join(idle, "node_modules")].sort());
  assert.ok(result.candidates.every((item) => !item.path.startsWith(elsewhere)), "never followed a symlink");
});

test("git temp files: older than 2 h and not open", async (t) => {
  const env = setup(t);
  const repo = path.join(env.home, "conductor", "repos", "app");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const pack = path.join(repo, ".git", "objects", "pack");
  const old = write(path.join(pack, "tmp_pack_old"));
  const fresh = write(path.join(pack, "tmp_pack_new"));
  const open = write(path.join(pack, "tmp_idx_open"));
  const obj = write(path.join(repo, ".git", "objects", "ab", "tmp_obj_x"));
  for (const file of [old, open, obj]) age(file, 3 * 60 * 60_000);
  env.open.add(open);
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  assert.deepEqual(result.candidates.filter((item) => item.rule === "git-temp").map((item) => item.path).sort(), [obj, old].sort());
  assert.ok(!result.candidates.some((item) => item.path === fresh));
});

test("Auto safe pass deletes verified safe items and measures freed space by df", async (t) => {
  const env = setup(t, { mode: "auto" });
  const wt = makeWorktree(env, path.join(env.home, "Dev", "worktrees", "old"), { idleDays: 20 });
  const part = write(path.join(env.home, "Downloads", "movie.mp4.crdownload"));
  age(part, 8 * DAY);
  const young = write(path.join(env.home, "Downloads", "new.part"));
  const manager = env.manager();
  // Trees go with /bin/rm in its own process, never fs.promises.rm.
  const realRm = fs.promises.rm;
  t.after(() => { fs.promises.rm = realRm; });
  fs.promises.rm = async () => { throw new Error("in-process rm"); };
  env.onRm = () => { env.free.data += GB; };
  await manager.requestScan();
  assert.equal(exists(path.join(wt, "node_modules")), false);
  assert.equal(exists(part), false);
  assert.equal(exists(young), true, "a recent partial download stays");
  assert.equal(exists(path.join(wt, "README.md")), true, "only the build dir goes");
  assert.equal(manager.state.lastFreed.bytes, 2 * GB);
  const action = env.store.actions(10).find((row) => row.playbook === "storage-safe");
  assert.match(action.reason, /2 removed.*2\.0 GB freed/);
  assert.ok(fs.readFileSync(path.join(env.dataDir, "fleet", "storage", "journal.jsonl"), "utf8").includes("\"op\":\"delete\""));
});

test("observe and propose never delete or move; they record what Auto would do", async (t) => {
  for (const mode of ["observe", "propose"]) {
    const env = setup(t, { mode });
    const wt = makeWorktree(env, path.join(env.home, "Dev", "worktrees", "old"), { idleDays: 20 });
    const part = write(path.join(env.home, "Downloads", "a.part"));
    const big = write(path.join(env.home, "Downloads", "old-video.mov"));
    age(part, 8 * DAY);
    age(big, 40 * DAY);
    env.deps.ditto = async () => { throw new Error(`${mode} copied`); };
    const manager = env.manager();
    await manager.requestScan();
    await manager.requestScan();
    assert.equal(exists(path.join(wt, "node_modules")), true, mode);
    assert.equal(exists(part), true, mode);
    assert.equal(fs.lstatSync(big).isSymbolicLink(), false, mode);
    const planned = env.store.actions(10).filter((row) => row.kind === "storage" && row.status === "planned");
    assert.equal(planned.length, 1, "one planned record per change");
    assert.match(planned[0].reason, /Auto would delete 2 safe items.*move 1 Downloads items/);
  }
});

test("a new planned record replaces the last one instead of piling up", async (t) => {
  const env = setup(t, { mode: "observe" });
  age(write(path.join(env.home, "Downloads", "a.part")), 8 * DAY);
  const manager = env.manager();
  await manager.requestScan();
  age(write(path.join(env.home, "Downloads", "b.part")), 8 * DAY);
  await manager.requestScan();
  age(write(path.join(env.home, "Downloads", "c.part")), 8 * DAY);
  await manager.requestScan();
  const rows = env.store.actions(10).filter((row) => row.playbook === "storage-safe");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.status), ["planned", "stale", "stale"], "only the newest stays planned");
  assert.match(rows[0].reason, /3 safe items/);
});

test("archive: copy to the SD card, check, leave a symlink, write the manifest", async (t) => {
  const env = setup(t, { mode: "auto" });
  const big = write(path.join(env.home, "Downloads", "old-video.mov"), "v".repeat(10_000));
  const dir = path.join(env.home, "Downloads", "photos");
  write(path.join(dir, "a.jpg"), "a".repeat(5000));
  write(path.join(dir, "sub", "b.jpg"), "b".repeat(5000));
  age(big, 40 * DAY);
  age(dir, 40 * DAY);
  env.deps.ditto = async (src, dest) => { fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true }); return { ok: true }; };
  const manager = env.manager();
  await manager.requestScan();
  const archive = path.join(env.sd, "OpenAGI-Archive", "Downloads");
  assert.equal(fs.readlinkSync(big), path.join(archive, "old-video.mov"));
  assert.equal(fs.readFileSync(big, "utf8"), "v".repeat(10_000));
  assert.equal(fs.readlinkSync(dir), path.join(archive, "photos"));
  assert.equal(fs.readFileSync(path.join(dir, "sub", "b.jpg"), "utf8").length, 5000);
  const manifest = fs.readFileSync(path.join(env.dataDir, "fleet", "storage", "archive.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(manifest.map((row) => path.basename(row.from)).sort(), ["old-video.mov", "photos"]);
  assert.equal(manifest.find((row) => row.from === big).bytes, 10_000);
  assert.ok(!fs.readdirSync(path.join(env.home, "Downloads")).some((name) => name.startsWith(".fleet-deleting-")));
});

test("archive: a failed or wrong copy is removed and the original kept", async (t) => {
  const env = setup(t, { mode: "auto" });
  const big = write(path.join(env.home, "Downloads", "a.mov"), "v".repeat(10_000));
  const other = write(path.join(env.home, "Downloads", "b.mov"), "w".repeat(9_000));
  age(big, 40 * DAY);
  age(other, 40 * DAY);
  env.deps.ditto = async (src, dest) => {
    if (src === big) { fs.writeFileSync(dest, "partial"); return { ok: false, detail: "No space left" }; }
    fs.writeFileSync(dest, "short");
    return { ok: true };
  };
  const manager = env.manager();
  await manager.requestScan();
  assert.equal(fs.lstatSync(big).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(big, "utf8").length, 10_000);
  assert.equal(fs.lstatSync(other).isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(path.join(env.sd, "OpenAGI-Archive", "Downloads")), [], "partial copies removed");
  assert.equal(exists(path.join(env.dataDir, "fleet", "storage", "archive.jsonl")), false);
});

test("archive: refused when the SD card is not the known one or would drop below its reserve", async (t) => {
  for (const variant of ["identity", "space", "unmounted"]) {
    const env = setup(t, { mode: "auto", sdGb: variant === "space" ? 30 : 500 });
    const big = write(path.join(env.home, "Downloads", "a.mov"), "v".repeat(10_000));
    age(big, 40 * DAY);
    let copies = 0;
    env.deps.ditto = async (src, dest) => { copies += 1; fs.cpSync(src, dest); return { ok: true }; };
    const manager = env.manager();
    await manager.refreshVolumes();
    if (variant === "identity") write(path.join(env.sd, ".codex-xtra-volume-identity"), "volume_uuid=11111111-2222-3333-4444-555555555555\n");
    if (variant === "unmounted") env.sdMounted = false;
    await manager.requestScan();
    assert.equal(copies, 0, variant);
    assert.equal(fs.lstatSync(big).isSymbolicLink(), false, variant);
  }
});

test("finished worktrees: clean and pushed only; archived Conductor ones even if recent", async (t) => {
  const env = setup(t);
  const roots = path.join(env.home, "Dev", "worktrees");
  const done = makeWorktree(env, path.join(roots, "done"));
  makeWorktree(env, path.join(roots, "dirty"), { dirty: true });
  makeWorktree(env, path.join(roots, "unpushed"), { pushed: false });
  const archived = makeWorktree(env, path.join(roots, "archived"), { idleDays: 1 });
  makeWorktree(env, path.join(roots, "fresh"), { idleDays: 1 });
  const threadUsed = makeWorktree(env, path.join(roots, "codex-used"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(env.root, "conductor.db"));
  db.exec("CREATE TABLE repos (id TEXT, root_path TEXT); CREATE TABLE workspaces (local_id TEXT, repository_id TEXT, directory_name TEXT, workspace_path TEXT, state TEXT)");
  db.prepare("INSERT INTO workspaces VALUES (?, NULL, ?, ?, ?)").run("w1", "archived", archived, "archived");
  db.close();
  fs.mkdirSync(path.join(env.root, "codex"), { recursive: true });
  const codex = new DatabaseSync(path.join(env.root, "codex", "state_5.sqlite"));
  codex.exec("CREATE TABLE threads (id TEXT, cwd TEXT, archived INTEGER)");
  codex.prepare("INSERT INTO threads VALUES (?, ?, 0)").run("t1", path.join(threadUsed, "src"));
  codex.close();
  const use = await readThreadUse(storagePaths(env.config));
  assert.equal(use.ok, true);
  assert.ok(use.archived.has(archived));
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  const offered = result.candidates.filter((item) => item.rule === "worktrees").map((item) => item.path).sort();
  assert.deepEqual(offered, [archived, done].sort());
});

// A supervisor around the storage env: no threads, storage on.
function supervisorFor(t, env, clock) {
  const supervisor = new FleetSupervisor({
    dataDir: env.dataDir,
    config: env.config,
    skip: { bb3: true, github: true },
    deps: {
      now: () => clock.now,
      executor: { deliver: async () => ({ status: "sent" }), inFlight: () => [], whenIdle: async () => {} },
      notifier: { notifyQuestion: async () => ({ outreachId: null, pushed: false }) },
      readLivePeers: () => new Map(),
      listCodexThreads: async () => [], listClaudeThreads: async () => [], listConductorThreads: async () => [],
      readCodexLbErrors: async () => [], findLocalHeavyVerification: async () => [],
      checkLb: async () => ({ healthy: true, detail: "200", watchLine: null }), findManagerSession: () => null,
      storage: { ...env.deps, now: () => clock.now }
    }
  });
  t.after(() => supervisor.stop());
  return supervisor;
}

function installers(env, names) {
  return names.map((name) => {
    const file = write(path.join(env.home, "Downloads", name), "i".repeat(8192));
    age(file, 40 * DAY);
    return file;
  });
}

const storageQuestions = (supervisor) => supervisor.getState().questions.filter((q) => q.kind === "storage");

test("a plan question is asked every tick with a stable key and updates in place", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["a.dmg", "b.pkg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [first] = storageQuestions(supervisor);
  assert.equal(first.dedupeKey, "infra:storage:installers");
  assert.match(first.title, /^2 old installers in Downloads, 1 MB\. Delete\?$/);
  assert.deepEqual(first.options, ["Delete 2 (1 MB)", "Keep", "Later"]);
  assert.ok(first.meta.planId && first.meta.digest);
  assert.ok(first.title.length <= 100 && first.options.every((option) => option.length <= 40));
  await supervisor.tick({ reason: "test" });
  assert.equal(storageQuestions(supervisor)[0].id, first.id);
  assert.ok(JSON.stringify(supervisor.store.snapshot.storage).length < 1000, "small snapshot payload");
  assert.equal(supervisor.store.snapshot.storage.pendingAsks, 1);
});

test("an open question pins its plan: no item added or swapped in, gone ones dropped", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  const [a, b, c] = installers(env, ["a.dmg", "b.dmg", "c.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  // c swapped for d of the same size, and e added: the owner saw neither.
  fs.rmSync(c);
  const [d, e] = installers(env, ["d.dmg", "e.iso"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [pinned] = storageQuestions(supervisor);
  assert.equal(pinned.id, question.id);
  assert.equal(pinned.meta.planId, question.meta.planId, "same plan, only smaller");
  assert.equal(pinned.options[0], "Delete 2 (1 MB)");
  assert.equal(await supervisor.answerQuestion(question.id, question.options[0]), null, "the old card's count no longer matches");
  const result = await supervisor.answerQuestion(pinned.id, pinned.options[0]);
  assert.equal(result.delivery.status, "sent");
  await supervisor.storage.idle();
  assert.equal(exists(a), false);
  assert.equal(exists(b), false);
  assert.equal(exists(d), true, "never shown, never deleted");
  assert.equal(exists(e), true);
});

test("a reopened question with a new plan cannot be answered from the old card", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["a.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  // The disk recovers (the ask closes), the plan grows, the disk fills again.
  env.free.data = 300 * GB;
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.store.question(question.id).status, "resolved");
  installers(env, ["b.dmg"]);
  await supervisor.storage.requestScan();
  env.free.data = 40 * GB;
  await supervisor.tick({ reason: "test" });
  const [reopened] = storageQuestions(supervisor);
  assert.equal(reopened.id, question.id, "same record");
  assert.equal(reopened.options[0], "Delete 2 (1 MB)");
  assert.equal(await supervisor.answerQuestion(question.id, question.options[0]), null);
  const direct = await supervisor.storage.answer({ ...reopened, options: question.options }, question.options[0]);
  assert.equal(direct.status, "blocked", "a label for another list is refused");
  assert.equal(exists(path.join(env.home, "Downloads", "a.dmg")), true);
});

test("Delete re-verifies and deletes only pinned items that still pass", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  const [keep, replaced, opened] = installers(env, ["keep.dmg", "replaced.dmg", "opened.pkg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  // A new file over the old path (a new inode while both exist).
  write(`${replaced}.tmp`, "new content");
  fs.renameSync(`${replaced}.tmp`, replaced);
  age(replaced, 40 * DAY);
  env.open.add(opened);
  const unpinned = installers(env, ["later.dmg"])[0];
  assert.equal(await supervisor.answerQuestion(question.id, "Delete everything"), null, "only offered options");
  const result = await supervisor.answerQuestion(question.id, question.options[0]);
  assert.equal(result.delivery.status, "sent");
  assert.equal(result.question.status, "answered");
  await supervisor.storage.idle();
  assert.equal(exists(keep), false);
  assert.equal(exists(replaced), true, "replaced since the scan");
  assert.equal(exists(opened), true, "in use");
  assert.equal(exists(unpinned), true, "not in the plan");
  const action = supervisor.store.actions(20).find((row) => row.playbook === "storage-installers");
  assert.match(action.reason, /1 deleted, 2 left/);
});

test("a stale plan answer keeps the question open", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["a.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  // Kept from elsewhere (another surface answered first): the plan is gone.
  delete supervisor.storage.state.plans.installers;
  const result = await supervisor.answerQuestion(question.id, question.options[0]);
  assert.equal(result.delivery.status, "blocked");
  assert.equal(supervisor.store.question(question.id).status, "open");
  assert.equal(exists(path.join(env.home, "Downloads", "a.dmg")), true);
});

test("Keep holds the items 30 days; Later asks again after 24 h", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["a.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  let [question] = storageQuestions(supervisor);
  const later = await supervisor.answerQuestion(question.id, "Later");
  assert.equal(later.delivery.status, "sent");
  await supervisor.tick({ reason: "test" });
  assert.equal(storageQuestions(supervisor).length, 0, "quiet after Later");
  clock.now += 25 * 60 * 60_000;
  await supervisor.tick({ reason: "test" });
  [question] = storageQuestions(supervisor);
  assert.ok(question, "asked again after 24 h");
  const kept = await supervisor.answerQuestion(question.id, "Keep");
  assert.match(kept.delivery.detail, /30 days/);
  clock.now += 25 * 60 * 60_000;
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  assert.equal(storageQuestions(supervisor).length, 0, "kept items are not asked about");
  assert.equal(exists(path.join(env.home, "Downloads", "a.dmg")), true);
  clock.now += 31 * DAY;
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  assert.equal(storageQuestions(supervisor).length, 1, "the hold ends after 30 days");
});

test("critical: one ask; Clean safe now runs the safe pass even outside Auto", async (t) => {
  const env = setup(t, { dataGb: 10 });
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  const part = write(path.join(env.home, "Downloads", "x.part"));
  age(part, 8 * DAY);
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  assert.equal(question.title, "Disk almost full: 10 GB left");
  assert.deepEqual(question.options, ["Clean safe now", "Later"]);
  assert.equal(supervisor.mode, "observe");
  const result = await supervisor.answerQuestion(question.id, "Clean safe now");
  assert.equal(result.delivery.status, "sent");
  await supervisor.storage.idle();
  assert.equal(exists(part), false);
});

test("a failed scan or disk read neither deletes nor closes asks", async (t) => {
  const env = setup(t, { mode: "auto" });
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["a.dmg"]);
  const part = write(path.join(env.home, "Downloads", "x.part"));
  age(part, 8 * DAY);
  env.lsofFails = true;
  await supervisor.storage.requestScan();
  assert.equal(supervisor.storage.state.lastScan.ok, false);
  assert.equal(exists(part), true, "no open-file snapshot, no delete");
  env.lsofFails = false;
  env.open.add(part);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  assert.ok(question);
  env.lsofFails = true;
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.store.question(question.id).status, "open", "a failed scan keeps the plan");
  env.statfsFails = true;
  supervisor.storage.state.volumes = null;
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.store.question(question.id).status, "open", "an unknown disk keeps the ask");
  assert.ok(supervisor.store.snapshot.sourceErrors.storage);
  assert.equal(exists(path.join(env.home, "Downloads", "a.dmg")), true);
});

test("storage is on with the supervisor and off with OPENAGI_FLEET_STORAGE=0", () => {
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_SUPERVISOR: "1" }).storage.enabled, true);
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_SUPERVISOR: "1", OPENAGI_FLEET_STORAGE: "0" }).storage.enabled, false);
  assert.equal(resolveFleetConfig({}).storage.enabled, false);
  const config = resolveFleetConfig({ OPENAGI_FLEET_STORAGE_SD: "/Volumes/Card", OPENAGI_FLEET_STORAGE_LOW_GB: "80" });
  assert.equal(config.storage.sdMount, "/Volumes/Card");
  assert.equal(config.storage.lowGb, 80);
  assert.equal(config.storage.criticalGb, 15);
});

// ─── full clones, Delete-time re-checks ──────────────────────────────────

function commitFile(dir, name, text = "x") {
  write(path.join(dir, name), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", name);
}

function codexThreads(env, cwds) {
  fs.mkdirSync(path.join(env.root, "codex"), { recursive: true });
  return import("node:sqlite").then(({ DatabaseSync }) => {
    const db = new DatabaseSync(path.join(env.root, "codex", "state_5.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT, cwd TEXT, archived INTEGER)");
    for (const cwd of cwds) db.prepare("INSERT INTO threads VALUES (?, ?, 0)").run(Math.random().toString(16).slice(2), cwd);
    db.close();
  });
}

test("a full clone counts as pushed only with every branch pushed, no stash, no linked or nested repo", async (t) => {
  const env = setup(t);
  const roots = path.join(env.home, "Dev", "worktrees");
  const plain = makeWorktree(env, path.join(roots, "plain"));
  const side = makeWorktree(env, path.join(roots, "side"));
  git(side, "checkout", "-q", "-b", "side");
  commitFile(side, "side.txt");
  git(side, "checkout", "-q", "main");
  const stash = makeWorktree(env, path.join(roots, "stash"));
  write(path.join(stash, "README.md"), "changed");
  git(stash, "stash", "-q");
  const host = makeWorktree(env, path.join(roots, "host"));
  git(host, "worktree", "add", "-q", "-b", "wip", path.join(env.root, "linked-wip"));
  const nested = makeWorktree(env, path.join(roots, "nested"), { ignore: "node_modules/\n.claude/\n" });
  const inner = path.join(nested, ".claude", "worktrees", "inner");
  fs.mkdirSync(inner, { recursive: true });
  git(inner, "init", "-q", "-b", "main");
  write(path.join(inner, "wip.txt"), "unsaved work");
  for (const dir of [side, stash, host, nested]) age(dir, 40 * DAY);

  assert.deepEqual(await gitState(side, env.config), { clean: true, pushed: false, detail: "has unpushed branches" });
  assert.equal((await gitState(stash, env.config)).detail, "has a stash");
  assert.equal((await gitState(host, env.config)).detail, "hosts linked worktrees");
  assert.equal((await gitState(nested, env.config)).detail, "has a nested repo");
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  assert.deepEqual(result.candidates.filter((item) => item.rule === "worktrees").map((item) => item.path), [plain]);
});

test("Delete re-checks each worktree: dirty, unpushed, another branch, thread use all stay", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const roots = path.join(env.home, "Dev", "worktrees");
  const names = ["clean", "dirty", "unpushed", "branch", "threaded"];
  const wt = Object.fromEntries(names.map((name) => [name, makeWorktree(env, path.join(roots, name))]));
  await codexThreads(env, []);
  const supervisor = supervisorFor(t, env, clock);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const question = storageQuestions(supervisor).find((q) => q.meta.rule === "worktrees");
  assert.match(question.title, /^5 finished worktrees/);
  // Since the ask: work lands in four of them (aged, so only git can tell).
  write(path.join(wt.dirty, "notes.txt"), "draft");
  commitFile(wt.unpushed, "more.txt");
  git(wt.branch, "checkout", "-q", "-b", "side");
  commitFile(wt.branch, "side.txt");
  git(wt.branch, "checkout", "-q", "main");
  for (const name of ["dirty", "unpushed", "branch"]) age(wt[name], 40 * DAY);
  await codexThreads(env, [path.join(wt.threaded, "src")]);
  // A worktree is not measured again at Delete time (SD du can time out).
  env.duFails.add(wt.clean);
  const result = await supervisor.answerQuestion(question.id, question.options[0]);
  assert.equal(result.delivery.status, "sent");
  await supervisor.storage.idle();
  assert.equal(exists(wt.clean), false);
  for (const name of ["dirty", "unpushed", "branch", "threaded"]) assert.equal(exists(wt[name]), true, name);
  const journal = fs.readFileSync(path.join(env.dataDir, "fleet", "storage", "journal.jsonl"), "utf8");
  for (const reason of ["has uncommitted changes", "has unpushed commits", "has unpushed branches", "a thread uses it"]) assert.ok(journal.includes(reason), reason);
  const action = supervisor.store.actions(20).find((row) => row.playbook === "storage-worktrees");
  assert.match(action.reason, /1 deleted, 4 left/);
});

test("a thread cwd through a symlink (~/.codex/worktrees into the SD card) marks the worktree used", async (t) => {
  const env = setup(t);
  const wt = makeWorktree(env, path.join(env.sd, "codex-worktrees", "ab12", "repo"));
  const unused = makeWorktree(env, path.join(env.sd, "codex-worktrees", "cd34", "repo"));
  fs.mkdirSync(path.join(env.home, ".codex", "worktrees"), { recursive: true });
  fs.symlinkSync(path.join(env.sd, "codex-worktrees", "ab12"), path.join(env.home, ".codex", "worktrees", "ab12"));
  const cwd = path.join(env.home, ".codex", "worktrees", "ab12", "repo");
  // Thousands of threads share a few cwds: resolved once each.
  await codexThreads(env, Array.from({ length: 300 }, () => cwd));
  const use = await readThreadUse(storagePaths(env.config));
  assert.ok(use.paths.length <= 2, `deduped: ${use.paths.length}`);
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  assert.deepEqual(result.candidates.filter((item) => item.rule === "worktrees").map((item) => item.path), [unused]);
  assert.ok(!result.candidates.some((item) => item.path === wt));
});

test("in-use checks are read again right before acting", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  const [a, b] = installers(env, ["a.dmg", "b.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  // Each read of the clock is 31 s later; a.dmg opens right after the
  // pass's first open-file snapshot.
  let fake = Date.now();
  env.clockFn = () => (fake += 31_000);
  let calls = 0;
  env.afterLsof = () => { calls += 1; if (calls === 1) env.open.add(a); };
  await supervisor.answerQuestion(question.id, question.options[0]);
  await supervisor.storage.idle();
  assert.equal(exists(a), true, "opened after the snapshot");
  assert.equal(exists(b), false);
});

test("Delete leaves an item swapped for a symlink, and the link's target", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  const [a] = installers(env, ["a.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  const target = write(path.join(env.root, "elsewhere", "precious.dmg"), "mine");
  fs.renameSync(a, path.join(env.root, "moved.dmg"));
  fs.symlinkSync(target, a);
  await supervisor.answerQuestion(question.id, question.options[0]);
  await supervisor.storage.idle();
  assert.equal(fs.lstatSync(a).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, "utf8"), "mine");
});

// ─── wording, dismiss, SD unknown, owner results ─────────────────────────

test("zips are not installers and SD trash is not called old", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["taxes-2024.zip"]);
  write(path.join(env.sd, ".Trashes", "501", "fresh.mov"));
  env.free.sd = 40 * GB;
  await supervisor.tick({ reason: "test" });
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const questions = storageQuestions(supervisor);
  assert.ok(!questions.some((q) => q.meta.rule === "installers"), "a zip is not asked about as an installer");
  const trash = questions.find((q) => q.meta.rule === "trash");
  assert.match(trash.title, /^Trash: 1 items/);
});

test("dismissing a storage ask counts as Later: it comes back after 24 h", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["a.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  await supervisor.answerQuestion(question.id, "dismiss");
  for (let i = 0; i < 6; i += 1) {
    clock.now += 4 * 60 * 60_000;
    await supervisor.tick({ reason: "test" });
  }
  assert.equal(storageQuestions(supervisor).length, 1, "asked again after a day, not muted for good");
});

test("an SD card mounted but unreadable keeps its asks open and is not touched", async (t) => {
  const env = setup(t, { sdGb: 40 });
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  const item = write(path.join(env.sd, ".Trashes", "501", "old.mov"));
  await supervisor.tick({ reason: "test" });
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  assert.equal(question.meta.rule, "trash");
  // No marker and no diskutil answer: unknown, not "not low".
  fs.rmSync(path.join(env.sd, ".codex-xtra-volume-identity"));
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.storage.sdUnknown, true);
  assert.equal(supervisor.store.question(question.id).status, "open");
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [still] = storageQuestions(supervisor);
  assert.equal(still.id, question.id);
  await supervisor.answerQuestion(still.id, still.options[0]);
  await supervisor.storage.idle();
  assert.equal(exists(item), true, "nothing on an unverified card is deleted");
});

test("Clean safe now always leaves a Doing line, and asks again when it could not run", async (t) => {
  const env = setup(t, { dataGb: 10 });
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  await supervisor.tick({ reason: "test" });
  let [question] = storageQuestions(supervisor);
  env.lsofFails = true;
  await supervisor.answerQuestion(question.id, "Clean safe now");
  await supervisor.storage.idle();
  await new Promise((resolve) => setImmediate(resolve));
  let action = supervisor.store.actions(10).find((row) => row.playbook === "storage-safe");
  assert.equal(action.status, "failed");
  assert.match(action.reason, /not done, scan failed/);
  assert.equal(supervisor.store.question(question.id).status, "open", "asked again");
  env.lsofFails = false;
  [question] = storageQuestions(supervisor);
  await supervisor.answerQuestion(question.id, "Clean safe now");
  await supervisor.storage.idle();
  action = supervisor.store.actions(10).find((row) => row.playbook === "storage-safe");
  assert.equal(action.status, "done");
  assert.match(action.reason, /nothing safe to delete/);
});

test("a Delete queued as the supervisor stops is recorded and asked again", async (t) => {
  const env = setup(t);
  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  installers(env, ["a.dmg"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [question] = storageQuestions(supervisor);
  let release;
  supervisor.storage.enqueue(() => new Promise((resolve) => { release = resolve; }));
  await supervisor.answerQuestion(question.id, question.options[0]);
  supervisor.storage.stop();
  release();
  await supervisor.storage.idle();
  await new Promise((resolve) => setImmediate(resolve));
  const action = supervisor.store.actions(10).find((row) => row.kind === "storage");
  assert.match(action.reason, /not done, the supervisor stopped first/);
  assert.equal(supervisor.store.question(question.id).status, "open");
  assert.equal(exists(path.join(env.home, "Downloads", "a.dmg")), true);
});

test("the page's disk tone follows the configured thresholds", async (t) => {
  const env = setup(t, { dataGb: 150, storage: { lowGb: 200 } });
  const manager = env.manager();
  await manager.refreshVolumes();
  const data = manager.summary().volumes.find((row) => row.id === "data");
  assert.equal(data.low, true, "150 GB is low when lowGb is 200");
  assert.equal(data.critical, false);
});

// ─── scan cost: du failures, budget, backoff ─────────────────────────────

test("a worktree du that times out keeps its build output and does not fail the task", async (t) => {
  const env = setup(t);
  const wt = makeWorktree(env, path.join(env.home, "Dev", "worktrees", "big"));
  env.duFails.add(wt);
  const cache = { cursor: 0, tasks: {} };
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000, cache });
  assert.deepEqual(result.candidates.filter((item) => item.rule === "build").map((item) => item.path), [path.join(wt, "node_modules")]);
  assert.ok(!result.candidates.some((item) => item.rule === "worktrees"));
  assert.ok(cache.tasks[`wt:${wt}`], "cached: not measured again every lap");
  let du = 0;
  env.onDu = () => { du += 1; };
  await scanStorage(env.config, env.deps, { budgetMs: 60_000, cache });
  assert.equal(du, 0, "nothing measured again inside the TTL");
});

test("past the budget no du or git starts; the cut task goes first next scan; cheap tasks run every scan", async (t) => {
  const env = setup(t);
  const roots = path.join(env.home, "Dev", "worktrees");
  const wt = makeWorktree(env, path.join(roots, "two"), { idleDays: 20, ignore: "node_modules/\n.next/\n" });
  write(path.join(wt, ".next", "cache", "x"));
  age(wt, 20 * DAY);
  let fake = 0;
  env.clockFn = () => fake;
  env.onGit = () => { fake += 100_000; };
  env.onDu = () => { fake += 100_000; };
  const cache = { cursor: 0, tasks: {} };
  const first = await scanStorage(env.config, env.deps, { budgetMs: 120_000, cache });
  assert.ok(first.errors.some((error) => error.startsWith(`wt:${wt}: out of time`)), first.errors.join("; "));
  assert.equal(cache.tasks[`wt:${wt}`], undefined, "a cut task keeps no result");
  assert.ok(first.durationMs <= 300_000, `bounded: ${first.durationMs}`);
  // Next scan: the cheap tasks run, and the cut worktree goes first with a full budget.
  age(write(path.join(env.home, "Downloads", "late.part")), 8 * DAY);
  fake = 0;
  const second = await scanStorage(env.config, env.deps, { budgetMs: 120_000, cache });
  assert.ok(second.candidates.some((item) => item.rule === "partial"), "downloads are scanned every time");
  assert.equal(second.candidates.filter((item) => item.rule === "build").length, 2);
});

test("a failed archive copy waits before it is tried again; the copy timeout counts files", async (t) => {
  const env = setup(t, { mode: "auto" });
  const big = write(path.join(env.home, "Downloads", "a.mov"), "v".repeat(10_000));
  age(big, 40 * DAY);
  let copies = 0;
  env.deps.ditto = async (src, dest) => { copies += 1; fs.writeFileSync(dest, "partial"); return { ok: false, detail: "timed out" }; };
  const manager = env.manager();
  await manager.requestScan();
  await manager.requestScan();
  assert.equal(copies, 1, "not copied again every pass");
  assert.equal(fs.lstatSync(big).isSymbolicLink(), false);
  delete env.deps.ditto;
  await manager.copy(big, path.join(env.sd, "x"), 4 * GB, 157_000);
  assert.ok(env.dittoCalls[0].options.timeoutMs >= 785_000, `timeout ${env.dittoCalls[0].options.timeoutMs}`);
});

test("the safe pass stops a rule whose deletes free next to nothing", async (t) => {
  const env = setup(t, { mode: "auto", storage: { yieldMinBytes: 0 } });
  const parts = Array.from({ length: 7 }, (_, i) => write(path.join(env.home, "Downloads", `f${i}.part`)));
  for (const file of parts) age(file, 8 * DAY);
  const manager = env.manager();
  await manager.requestScan();
  assert.equal(parts.filter(exists).length, 2, "stopped after five deletes that freed nothing");
  assert.ok(manager.ruleHeld("partial", "data"));
  assert.match(env.store.actions(5).find((row) => row.playbook === "storage-safe").reason, /stopped partial: frees little/);
});

test("an archive copy cut off by a restart is removed; one already linked is kept", async (t) => {
  const env = setup(t);
  const archive = path.join(env.sd, "OpenAGI-Archive", "Downloads");
  const orphan = write(path.join(archive, "a.mov"), "half");
  const original = write(path.join(env.home, "Downloads", "a.mov"), "whole");
  const linkedCopy = write(path.join(archive, "b.mov"), "b");
  const link = path.join(env.home, "Downloads", "b.mov");
  fs.symlinkSync(linkedCopy, link);
  const manager = env.manager();
  manager.state.copying = [{ from: original, to: orphan, at: "x" }, { from: link, to: linkedCopy, at: "y" }];
  await manager.refreshVolumes();
  await manager.cleanTombstones();
  assert.equal(exists(orphan), false);
  assert.equal(fs.readFileSync(original, "utf8"), "whole");
  assert.equal(exists(linkedCopy), true);
  assert.deepEqual(manager.state.copying, []);
  assert.ok(fs.readFileSync(path.join(env.dataDir, "fleet", "storage", "archive.jsonl"), "utf8").includes(linkedCopy));
});

test("archive: a source changed during the copy is kept and the copy removed", async (t) => {
  for (const change of ["new file", "same-size edit"]) {
    const env = setup(t, { mode: "auto" });
    const dir = path.join(env.home, "Downloads", "photos");
    write(path.join(dir, "a.jpg"), "a".repeat(5000));
    write(path.join(dir, "sub", "b.jpg"), "b".repeat(5000));
    age(dir, 40 * DAY);
    env.deps.ditto = async (src, dest) => {
      fs.cpSync(src, dest, { recursive: true });
      if (change === "new file") fs.writeFileSync(path.join(src, "sub", "c.jpg"), "c");
      else fs.writeFileSync(path.join(src, "sub", "b.jpg"), "B".repeat(5000));
      return { ok: true };
    };
    const manager = env.manager();
    await manager.requestScan();
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), false, change);
    assert.deepEqual(fs.readdirSync(path.join(env.sd, "OpenAGI-Archive", "Downloads")), [], change);
  }
});

// ─── gates: lowGb, target, live mode, running agents ─────────────────────

test("Auto does nothing above lowGb and stops at targetFreeGb", async (t) => {
  const roomy = setup(t, { mode: "auto", dataGb: 200 });
  const part = write(path.join(roomy.home, "Downloads", "a.part"));
  const big = write(path.join(roomy.home, "Downloads", "old.mov"), "v".repeat(10_000));
  age(part, 8 * DAY);
  age(big, 40 * DAY);
  roomy.deps.ditto = async () => { throw new Error("moved above lowGb"); };
  await roomy.manager().requestScan();
  assert.equal(exists(part), true);
  assert.equal(fs.lstatSync(big).isSymbolicLink(), false);

  const env = setup(t, { mode: "auto" });
  const parts = ["a.part", "b.part"].map((name) => write(path.join(env.home, "Downloads", name)));
  for (const file of parts) age(file, 8 * DAY);
  const movies = ["x.mov", "y.mov"].map((name) => write(path.join(env.home, "Downloads", name), "v".repeat(10_000)));
  for (const file of movies) age(file, 40 * DAY);
  env.deps.ditto = async (src, dest) => { fs.cpSync(src, dest); return { ok: true }; };
  // The first delete reaches the target; nothing else goes.
  env.onRm = () => { env.free.data = 200 * GB; };
  await env.manager().requestScan();
  assert.equal(parts.filter(exists).length, 1, "one partial removed");
  assert.equal(movies.filter((file) => fs.lstatSync(file).isSymbolicLink()).length, 0, "no move once the target is reached");

  const moves = setup(t, { mode: "auto" });
  const films = ["x.mov", "y.mov"].map((name) => write(path.join(moves.home, "Downloads", name), "v".repeat(10_000)));
  for (const file of films) age(file, 40 * DAY);
  moves.deps.ditto = async (src, dest) => { fs.cpSync(src, dest); return { ok: true }; };
  moves.onRm = () => { moves.free.data = 200 * GB; };
  await moves.manager().requestScan();
  assert.equal(films.filter((file) => fs.lstatSync(file).isSymbolicLink()).length, 1, "archive stops at the target");
});

test("leaving Auto mid-pass stops deletes and moves", async (t) => {
  const env = setup(t, { mode: "auto" });
  const parts = ["a.part", "b.part", "c.part"].map((name) => write(path.join(env.home, "Downloads", name)));
  for (const file of parts) age(file, 8 * DAY);
  env.onRm = () => { env.mode = "observe"; };
  await env.manager().requestScan();
  assert.equal(parts.filter(exists).length, 2, "only the first went");

  const moves = setup(t, { mode: "auto" });
  const film = write(path.join(moves.home, "Downloads", "x.mov"), "v".repeat(10_000));
  age(film, 40 * DAY);
  moves.deps.ditto = async (src, dest) => { fs.cpSync(src, dest); moves.mode = "propose"; return { ok: true }; };
  await moves.manager().requestScan();
  assert.equal(fs.lstatSync(film).isSymbolicLink(), false, "the copy is dropped, the original kept");
  assert.deepEqual(fs.readdirSync(path.join(moves.sd, "OpenAGI-Archive", "Downloads")), []);
});

test("a running agent turn in a worktree keeps its build output, at scan and at delete", async (t) => {
  const env = setup(t, { mode: "auto" });
  const wt = makeWorktree(env, path.join(env.home, "Dev", "worktrees", "busy"), { idleDays: 20 });
  env.busy = [path.join(wt, "src")];
  const scanned = await scanStorage(env.config, env.deps, { budgetMs: 60_000, busyCwds: env.busy });
  assert.ok(!scanned.candidates.some((item) => item.rule === "build"), "not a candidate while busy");
  env.busy = [];
  const manager = env.manager();
  assert.equal(await manager.scanOnce(), true);
  assert.ok(manager.candidates.some((item) => item.rule === "build"));
  env.busy = [wt];
  await manager.autoPasses();
  assert.equal(exists(path.join(wt, "node_modules")), true, "an agent started there after the scan");

  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  env.mode = "auto";
  supervisor.forceMode = "auto";
  await supervisor.storage.scanOnce();
  supervisor.lastThreads.set("codex:x", { key: "codex:x", agentStatus: "running", cwd: wt });
  await supervisor.storage.autoPasses();
  assert.equal(exists(path.join(wt, "node_modules")), true, "a running thread from the tick blocks it");
});

// ─── tool temp and Trash ─────────────────────────────────────────────────

test("tool temp and Trash: ages and running tools", async (t) => {
  let offset = 20 * DAY;
  const env = setup(t, { now: () => Date.now() + offset });
  const tmp = write(path.join(env.home, ".rustup", "tmp", "x.partial"));
  const derived = path.join(env.home, "Library", "Developer", "Xcode", "DerivedData");
  const idle = path.join(derived, "Old-abc");
  write(path.join(idle, "Build", "x.o"));
  const recent = path.join(derived, "New-def");
  write(path.join(recent, "Build", "y.o"));
  // Used 5 days before the test clock (20 days ahead).
  age(recent, -15 * DAY);
  const trashed = write(path.join(env.home, ".Trash", "old.txt"));
  const sdTrashed = write(path.join(env.sd, ".Trashes", "501", "x.mov"));
  const scan = async () => (await scanStorage(env.config, env.deps, { budgetMs: 60_000 })).candidates.map((item) => item.path);

  let paths = await scan();
  assert.ok(paths.includes(tmp));
  assert.ok(paths.includes(idle), "DerivedData idle 20 days");
  assert.ok(!paths.includes(recent), "DerivedData used recently");
  assert.ok(!paths.includes(trashed), "Trash: trashed 20 days ago is not old");
  assert.ok(paths.includes(sdTrashed), "SD trash at any age");
  env.procs.add("cargo");
  env.procs.add("xcodebuild");
  paths = await scan();
  assert.ok(!paths.includes(tmp), "cargo running");
  assert.ok(!paths.includes(idle), "xcodebuild running");
  offset = 40 * DAY;
  env.procs.delete("cargo");
  paths = await scan();
  assert.ok(paths.includes(trashed), "Trash: 40 days");
  assert.ok(paths.includes(tmp));
});

// ─── verify: one item at a time ──────────────────────────────────────────

test("verify refuses items outside the roots, on an unverified card, grown, or recently opened", async (t) => {
  const env = setup(t, { storage: { archiveMinBytes: undefined } });
  const manager = env.manager();
  await manager.refreshVolumes();
  const ctx = () => ({ open: [], procs: new Set(), at: Date.now(), idle: new Map(), use: null, useAt: 0 });
  const itemFor = (rule, p, extra = {}) => {
    const st = fs.lstatSync(p);
    return { rule, path: p, bytes: 4096, volume: p.startsWith(env.sd) ? "sd" : "data", dev: st.dev, ino: st.ino, seenAt: Date.now(), ...extra };
  };
  const outside = write(path.join(env.root, "elsewhere", "x.dmg"));
  age(outside, 40 * DAY);
  assert.equal((await manager.verify(itemFor("installers", outside), ctx())).reason, "outside the cleanup roots");
  const sdItem = write(path.join(env.sd, ".Trashes", "501", "y.mov"));
  env.sdMounted = false;
  await manager.refreshVolumes();
  assert.equal((await manager.verify(itemFor("trash", sdItem), ctx())).reason, "SD card not verified");
  env.sdMounted = true;
  await manager.refreshVolumes();
  const grown = path.join(env.home, "Downloads", "big.part");
  write(path.join(grown, "x"));
  age(grown, 8 * DAY);
  env.duKb.set(grown, 3 * 1024 * 1024);
  assert.equal((await manager.verify(itemFor("partial", grown), ctx())).reason, "grew since the scan");
  const read = write(path.join(env.home, "Downloads", "read.mov"));
  const old = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(read, new Date(), old);
  assert.equal((await manager.verify(itemFor("archive", read), ctx())).reason, "opened recently");
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  assert.ok(!result.candidates.some((item) => item.path === read), "a recently read file is not archived");
});

test("archive skips small entries and installers, and a failed symlink restores the original", async (t) => {
  const small = setup(t, { mode: "auto", storage: { archiveMinBytes: undefined } });
  const tiny = write(path.join(small.home, "Downloads", "small.mov"));
  age(tiny, 40 * DAY);
  small.deps.ditto = async () => { throw new Error("copied a small file"); };
  await small.manager().requestScan();
  assert.equal(fs.lstatSync(tiny).isSymbolicLink(), false);

  const env = setup(t, { mode: "auto" });
  const [dmg] = installers(env, ["tool.dmg"]);
  const film = write(path.join(env.home, "Downloads", "film.mov"), "v".repeat(10_000));
  age(film, 40 * DAY);
  env.deps.ditto = async (src, dest) => { fs.cpSync(src, dest); return { ok: true }; };
  const realSymlink = fs.promises.symlink;
  t.after(() => { fs.promises.symlink = realSymlink; });
  fs.promises.symlink = async () => { throw new Error("EPERM"); };
  await env.manager().requestScan();
  assert.equal(fs.lstatSync(dmg).isSymbolicLink(), false, "an installer is asked about, not moved");
  assert.equal(fs.readFileSync(film, "utf8").length, 10_000, "original back in place");
  assert.deepEqual(fs.readdirSync(path.join(env.sd, "OpenAGI-Archive", "Downloads")), []);
});

// ─── cadence ─────────────────────────────────────────────────────────────

test("scans are due hourly, every 15 min while low; one at a time; the tick never waits", async (t) => {
  const env = setup(t, { dataGb: 200 });
  const manager = env.manager();
  await manager.refreshVolumes();
  const now = Date.now();
  manager.state.lastScan = { at: new Date(now - 20 * 60_000).toISOString(), ok: true };
  assert.equal(manager.scanDue(now), false, "not low: hourly");
  manager.state.lastScan.at = new Date(now - 61 * 60_000).toISOString();
  assert.equal(manager.scanDue(now), true);
  env.free.data = 40 * GB;
  await manager.refreshVolumes();
  manager.state.lastScan.at = new Date(now - 16 * 60_000).toISOString();
  assert.equal(manager.scanDue(now), true, "low: every 15 min");

  env.lsofCalls = 0;
  const both = await Promise.all([manager.requestScan(), manager.requestScan()]);
  assert.equal(both.length, 2);
  assert.equal(env.lsofCalls, 1, "two requests, one scan");

  const clock = { now: Date.now() };
  const supervisor = supervisorFor(t, env, clock);
  let release;
  env.lsofGate = new Promise((resolve) => { release = resolve; });
  const scan = supervisor.storage.requestScan();
  const ticked = await Promise.race([supervisor.tick({ reason: "test" }).then(() => "tick"), new Promise((resolve) => setTimeout(() => resolve("stuck"), 5000))]);
  assert.equal(ticked, "tick");
  assert.equal(supervisor.store.snapshot.storage.scanning, true);
  env.lsofGate = null;
  release();
  await scan;
});

test("deleteOption names the count and size", () => {
  assert.equal(deleteOption({ items: [{}, {}], bytes: 46.3 * GB }), "Delete 2 (46 GB)");
});

// ─── review fixes: swap recovery, budgets, idleness, caps ────────────────

test("a restart mid-swap puts the original back before its copy is removed", async (t) => {
  const env = setup(t, { mode: "auto" });
  const big = write(path.join(env.home, "Downloads", "a.mov"), "v".repeat(10_000));
  age(big, 40 * DAY);
  env.deps.ditto = async (src, dest) => { fs.cpSync(src, dest); return { ok: true }; };
  const realSymlink = fs.promises.symlink;
  t.after(() => { fs.promises.symlink = realSymlink; });
  let reached;
  const swapped = new Promise((resolve) => { reached = resolve; });
  // The process "exits" between the rename and the symlink: it never returns.
  fs.promises.symlink = () => { reached(); return new Promise(() => {}); };
  const first = env.manager();
  first.requestScan();
  await swapped;
  fs.promises.symlink = realSymlink;
  first.stop();
  const copy = path.join(env.sd, "OpenAGI-Archive", "Downloads", "a.mov");
  assert.equal(exists(big), false, "the original is moved aside");
  assert.equal(exists(copy), true);
  const restarted = env.manager();
  await restarted.cleanTombstones();
  assert.equal(fs.lstatSync(big).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(big, "utf8"), "v".repeat(10_000), "the original is back");
  assert.equal(exists(copy), false);
  assert.deepEqual(restarted.state.copying, []);
  assert.ok(!fs.readdirSync(path.join(env.home, "Downloads")).some((name) => name.startsWith(".fleet-deleting-")));

  // Linked before the restart, original still moved aside: it is removed.
  const linkedCopy = write(path.join(env.sd, "OpenAGI-Archive", "Downloads", "b.mov"), "b");
  const link = path.join(env.home, "Downloads", "b.mov");
  fs.symlinkSync(linkedCopy, link);
  const tomb = write(path.join(env.home, "Downloads", ".fleet-deleting-0000beef"), "b");
  restarted.state.copying = [{ from: link, to: linkedCopy, at: "y", tomb }];
  await restarted.cleanTombstones();
  assert.equal(exists(tomb), false);
  assert.equal(fs.readlinkSync(link), linkedCopy);
  assert.deepEqual(restarted.state.tombstones, []);
});

test("recovery reads the card again: a different card at the same path is not touched", async (t) => {
  const env = setup(t);
  const first = env.manager();
  await first.refreshVolumes();
  // While the supervisor was down the card was swapped.
  write(path.join(env.sd, ".codex-xtra-volume-identity"), "volume_uuid=11111111-2222-3333-4444-555555555555\n");
  const theirs = write(path.join(env.sd, "OpenAGI-Archive", "Downloads", "a.mov"), "theirs");
  const original = write(path.join(env.home, "Downloads", "a.mov"), "whole");
  const sdTomb = write(path.join(env.sd, ".Trashes", "501", ".fleet-deleting-abcd1234"), "x");
  first.state.copying = [{ from: original, to: theirs, at: "x" }];
  first.state.tombstones = [sdTomb];
  first.save();
  const restarted = env.manager();
  assert.equal(restarted.sdOk(), true, "state.json still trusts the old card");
  await restarted.autoPasses();
  assert.equal(fs.readFileSync(theirs, "utf8"), "theirs");
  assert.equal(exists(sdTomb), true);
  assert.equal(restarted.state.copying.length, 1, "kept for when the known card is back");
});

test("the cheap tasks keep to the scan budget: no du starts past it", async (t) => {
  const env = setup(t);
  // SD Trash: a du per folder, no walk (its deadline would stop it anyway).
  for (const name of ["a", "b", "c", "d", "e"]) write(path.join(env.sd, ".Trashes", "501", name, "x.mov"));
  let fake = 0;
  let du = 0;
  env.clockFn = () => fake;
  env.onDu = () => { du += 1; fake += 100_000; };
  const cache = { cursor: 0, tasks: {} };
  const first = await scanStorage(env.config, env.deps, { budgetMs: 120_000, cache });
  assert.equal(du, 2, "stopped once past the budget");
  assert.ok(first.errors.some((error) => error.startsWith("sd-trash: out of time")), first.errors.join("; "));
  // Sizes measured so far are kept: each scan goes further.
  fake = 0;
  await scanStorage(env.config, env.deps, { budgetMs: 120_000, cache });
  assert.equal(du, 4);
  fake = 0;
  const third = await scanStorage(env.config, env.deps, { budgetMs: 120_000, cache });
  assert.equal(du, 5);
  assert.equal(third.candidates.filter((item) => item.rule === "trash").length, 5);
});

test("a fresh install or build in an idle worktree keeps its output, at scan and at delete", async (t) => {
  const env = setup(t, { mode: "auto" });
  const wt = makeWorktree(env, path.join(env.home, "Dev", "worktrees", "rebuilt"), { idleDays: 20 });
  const nm = path.join(wt, "node_modules");
  const manager = env.manager();
  assert.equal(await manager.scanOnce(), true);
  assert.ok(manager.candidates.some((item) => item.path === nm), "idle: a candidate");
  // A build rewrites a file in place: only that file's mtime moves.
  fs.writeFileSync(path.join(nm, "pkg", "index.js"), "rebuilt");
  await manager.autoPasses();
  assert.equal(exists(nm), true, "not deleted right after the build");
  const scanned = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  assert.ok(!scanned.candidates.some((item) => item.rule === "build"), "not a candidate");
});

test("an installer the owner kept is not moved to the SD card", async (t) => {
  const env = setup(t, { mode: "auto" });
  const [dmg] = installers(env, ["tool.dmg"]);
  let copies = 0;
  env.deps.ditto = async (src, dest) => { copies += 1; fs.cpSync(src, dest); return { ok: true }; };
  const manager = env.manager();
  manager.state.holds = { [dmg]: Date.now() + 30 * DAY };
  await manager.requestScan();
  assert.equal(copies, 0);
  assert.equal(fs.lstatSync(dmg).isSymbolicLink(), false);
});

test("a volume smaller than its target is cleaned to half its size, not emptied", async (t) => {
  const env = setup(t, { mode: "auto" });
  env.total.data = 128 * GB;
  const parts = ["a", "b", "c"].map((name) => write(path.join(env.home, "Downloads", `${name}.part`)));
  for (const file of parts) age(file, 8 * DAY);
  env.onRm = () => { env.free.data += 20 * GB; };
  await env.manager().requestScan();
  assert.equal(parts.filter(exists).length, 1, "stopped at 64 GB free (target 150 GB)");

  const sd = setup(t, { mode: "auto", dataGb: 200, sdGb: 15 });
  sd.total.sd = 40 * GB;
  const sdParts = ["a", "b", "c"].map((name) => write(path.join(sd.sd, "Downloads", `${name}.part`)));
  for (const file of sdParts) age(file, 8 * DAY);
  sd.onRm = () => { sd.free.sd += 5 * GB; };
  await sd.manager().requestScan();
  assert.equal(sdParts.filter(exists).length, 2, "stopped at 20 GB free (sdLowGb 50)");
});

test("a Downloads folder with a file read recently is not archived", async (t) => {
  const env = setup(t);
  const dir = path.join(env.home, "Downloads", "photos");
  const file = write(path.join(dir, "a.jpg"), "a".repeat(5000));
  age(dir, 40 * DAY);
  fs.utimesSync(file, new Date(), new Date(Date.now() - 40 * DAY));
  const result = await scanStorage(env.config, env.deps, { budgetMs: 60_000 });
  assert.ok(!result.candidates.some((item) => item.path === dir), "not a candidate");
  const manager = env.manager();
  await manager.refreshVolumes();
  const st = fs.lstatSync(dir);
  const ctx = { open: [], procs: new Set(), at: Date.now(), idle: new Map(), use: null, useAt: 0 };
  const check = await manager.verify({ rule: "archive", path: dir, bytes: 8192, volume: "data", dev: st.dev, ino: st.ino }, ctx);
  assert.equal(check.reason, "changed or opened recently");
});

test("a du that exits nonzero is not a size, even with a total printed", async (t) => {
  const env = setup(t);
  const dir = path.join(env.home, "Downloads", "d");
  write(path.join(dir, "x"));
  const partial = async () => ({ code: 1, stdout: `8\t${dir}\n`, stderr: "du: x: Permission denied", timedOut: false, error: null });
  await assert.rejects(sizeOf(dir, env.config, partial), /du failed/);
  assert.equal(await sizeOf(dir, env.config, async () => ({ code: 0, stdout: `8\t${dir}\n` })), 8192);
});
