import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFleetConfig, runCommand } from "../src/fleet/contracts.js";
import { StorageManager } from "../src/fleet/storage.js";
import { FleetStore } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { GB, openUnder, readThreadUse, readVolumes, scanStorage, storagePaths } from "../src/fleet/sources/storage.js";

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
  const env = { root, home, sd, dataDir, mode, open: new Set(), procs: new Set(["launchd", "zsh"]), free: { data: dataGb * GB, sd: sdGb * GB }, lsofFails: false, statfsFails: false, sdMounted, busy: [], clock: now };
  env.config = resolveFleetConfig({}, {
    home, mode, managerRef: "none",
    paths: { conductorDb: path.join(root, "conductor.db"), codexHome: path.join(root, "codex") },
    bins: { lsof: "fake-lsof", ps: "fake-ps", ditto: "fake-ditto", diskutil: "fake-diskutil" },
    storage: { enabled: true, sdMount: sd, dataMount: home, askMinGb: 0, archiveMinBytes: 1, uid: 501, ...storage }
  });
  env.run = async (cmd, args, options) => {
    if (cmd === "fake-lsof") return env.lsofFails ? { code: 1, stdout: "", stderr: "lsof broke" } : { code: 0, stdout: `p1\nn/\n${[...env.open].map((p) => `n${p}`).join("\n")}\n` };
    if (cmd === "fake-ps") return { code: 0, stdout: `${[...env.procs].join("\n")}\n` };
    if (cmd.startsWith("fake-")) throw new Error(`unexpected ${cmd}`);
    return runCommand(cmd, args, options);
  };
  env.deps = {
    run: env.run,
    statfs: async (mount) => {
      if (env.statfsFails) throw new Error("statfs broke");
      return { bsize: 1, blocks: 2000 * GB, bavail: mount === sd ? env.free.sd : env.free.data };
    },
    isMount: async (mount) => (mount === sd ? env.sdMounted : true),
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
  const linkedNm = makeWorktree(env, path.join(roots, "linked-nm"), { idleDays: 20, build: false });
  fs.symlinkSync(path.join(elsewhere, "node_modules"), path.join(linkedNm, "node_modules"));
  age(linkedNm, 20 * DAY);

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
  const realRm = fs.promises.rm;
  t.after(() => { fs.promises.rm = realRm; });
  fs.promises.rm = async (...args) => { env.free.data += GB; return realRm(...args); };
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

test("observe mode never deletes or moves; it records what Auto would do", async (t) => {
  const env = setup(t, { mode: "observe" });
  const wt = makeWorktree(env, path.join(env.home, "Dev", "worktrees", "old"), { idleDays: 20 });
  const part = write(path.join(env.home, "Downloads", "a.part"));
  const big = write(path.join(env.home, "Downloads", "old-video.mov"));
  age(part, 8 * DAY);
  age(big, 40 * DAY);
  const manager = env.manager();
  await manager.requestScan();
  await manager.requestScan();
  assert.equal(exists(path.join(wt, "node_modules")), true);
  assert.equal(exists(part), true);
  assert.equal(fs.lstatSync(big).isSymbolicLink(), false);
  const planned = env.store.actions(10).filter((row) => row.kind === "storage" && row.status === "planned");
  assert.equal(planned.length, 1, "one planned record per change");
  assert.match(planned[0].reason, /Auto would delete 2 safe items.*move 1 Downloads items/);
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
  assert.deepEqual(first.options.slice(1), ["Keep", "Later"]);
  assert.match(first.options[0], /^Delete /);
  assert.ok(first.meta.planId && first.meta.digest);
  assert.ok(first.title.length <= 100 && first.options.every((option) => option.length <= 40));
  await supervisor.tick({ reason: "test" });
  assert.equal(storageQuestions(supervisor)[0].id, first.id);
  installers(env, ["c.iso"]);
  await supervisor.storage.requestScan();
  await supervisor.tick({ reason: "test" });
  const [updated] = storageQuestions(supervisor);
  assert.equal(updated.id, first.id);
  assert.notEqual(updated.meta.planId, first.meta.planId);
  assert.match(updated.title, /^3 old installers/);
  assert.ok(JSON.stringify(supervisor.store.snapshot.storage).length < 1000, "small snapshot payload");
  assert.equal(supervisor.store.snapshot.storage.pendingAsks, 1);
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
  installers(env, ["b.dmg"]);
  await supervisor.storage.requestScan();
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
