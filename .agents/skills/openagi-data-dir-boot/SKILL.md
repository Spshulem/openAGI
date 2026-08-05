---
name: openagi-data-dir-boot
description: Use when adding or changing openAGI persistent stores, env-file loading, OPENAGI_DATA_DIR handling, src/data-dir.js, src/boot.js loadBootEnv, or tests that mutate the data dir.
---

# openAGI Data Dir and Boot Env Contract

## When to use

Use this skill when work touches `src/data-dir.js`, `src/boot.js`, `src/setup-wizard.js` `saveEnv`, or any store constructor's default storage path; when adding a new persistent store or file-backed subsystem; or for symptoms containing `OPENAGI_DATA_DIR`, `resolveDataDir`, `_resetDataDirCache`, a cwd-relative `.openagi`, or state/keys that "got wiped" after switching launch methods.

## Procedure

1. Default every persistent store's location through `resolveDataDir()` from `src/data-dir.js`. The repo-wide pattern is `this.dir = options.dir ?? path.join(resolveDataDir(), "<subdir>")` (see `src/outcome-store.js`, `src/observation-store.js`, `src/pending-actions.js`, `src/node-registry.js`). Keep the explicit `options.dir` / `options.dataDir` / `options.storePath` override intact; only the fallback after `??` uses the resolver.

2. Never write a cwd-relative `.openagi` fallback. The default must stay the ABSOLUTE `~/.openagi` because the process cwd differs between `npm run serve`, the packaged Mac .app, launchd, and re-clones — cwd-relative state was the cause of the "my keys got wiped" incident. A 29-file refactor (commit `588bdec`, "route all state dirs through resolveDataDir()") removed all 34 such sites; do not reintroduce one.

3. `resolveDataDir()` facts: it memoizes into a module-level `cached`; `OPENAGI_DATA_DIR` is trimmed and `path.resolve()`d when set (Docker sets `/data`, the Mac app sets `~/.openagi`); the default is `path.join(os.homedir(), ".openagi")`. `_resetDataDirCache()` is the test seam that drops the memo.

4. Boot env order is load-bearing (`loadBootEnv()` in `src/boot.js`): peek ONLY `OPENAGI_DATA_DIR` out of the cwd `.env` with `peekEnvVar`, then `_resetDataDirCache()`, then `resolveDataDir()`, then `loadEnvFile(path.join(dataDir, ".env"))` (canonical, authoritative, first-wins), and only then `loadEnvFile(".env")` to fill remaining gaps. Never bulk-load the cwd `.env` first: its blank sample entries (`OPENAI_API_KEY=`, …) would shadow the real values in `<dataDir>/.env` because `loadEnvFile` is first-wins.

5. In tests that touch the data dir: create a temp dir, set `process.env.OPENAGI_DATA_DIR` to it, call `_resetDataDirCache()`, run, then restore the previous value (or delete the key) and call `_resetDataDirCache()` again in cleanup. Copy the exact pattern in `test/env-persistence.test.js` and `test/data-dir.test.js`.

6. Never read personal content under a real `~/.openagi` (or any live `OPENAGI_DATA_DIR`) during reviews or tasks — it holds the user's private keys, messages, and observations. Work against repo code and per-test temp dirs only.

## Failure signatures

- Keys, `.env`, or store state "wiped" after switching between `npm run serve`, the Mac .app, or a fresh clone: some code path fell back to a cwd-relative `.openagi` instead of `resolveDataDir()`.
- An integration configured in `~/.openagi/.env` reads as empty at runtime: the cwd `.env` was loaded before the canonical `<dataDir>/.env`, so its blank sample line (e.g. `OPENAI_API_KEY=`) won first-wins.
- A test sees the wrong data dir after setting `process.env.OPENAGI_DATA_DIR`: `resolveDataDir()` memoizes — call `_resetDataDirCache()` after every env mutation, including cleanup.

## Verification

- `grep -rn 'process.cwd(), ".openagi"' src/` and `grep -rn '?? ".openagi"' src/` both return nothing.
- `node --test test/data-dir.test.js test/env-persistence.test.js` passes.
- After touching store constructors: `node -e "import('./src/abi-runtime.js').then(() => console.log('ok'))"` prints `ok`.
