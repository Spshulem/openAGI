# Stable Config / Data Location — Design

**Date:** 2026-06-02
**Status:** Approved (brainstorming decisions) — pending user spec review → implementation plan
**Problem:** API keys and setup state don't survive updates / relaunches in dev / bare-source /
launchd installs.

## Root cause

Config and state paths default to the **cwd-relative** string `".openagi"`:

- `envFilePath()` (`src/setup-wizard.js:44`): `path.join(process.env.OPENAGI_DATA_DIR ?? ".openagi", ".env")`
- ~35 other call sites independently use `path.join(process.cwd(), ".openagi", …)` for
  observations, channels, cron, agents, pending-actions, outcomes, etc.

There is **no single source of truth** for the data directory, and the default is resolved
against the current working directory. Consequences by launch mode:

| Launch mode | `OPENAGI_DATA_DIR` | `.env` location | Stable? |
|---|---|---|---|
| Mac `.app` | `~/Library/Application Support/OpenAGI` | stable | yes |
| Docker | `/data` (+ volume) | stable | yes |
| `npm run serve` / bare source / launchd | **unset** → `.openagi` | `<cwd>/.openagi/.env` (inside the checkout) | **no** |

The `saveEnv()` merge logic itself is correct (read-merge-write, `0600`, preserves untouched
keys). Nothing deletes the file maliciously — the daemon simply reads a *different cwd-relative
folder* than the one written to when launched from a different directory, re-cloned, or when the
`.app` "adopts" a terminal daemon (`DaemonController.swift:48`) so the source of truth flip-flops.

## Decisions (from brainstorming)

1. **Default location:** `~/.openagi` on every OS (single predictable path).
2. **Scope:** unify ALL state through one resolver, not just `.env`.
3. **Migration:** none — start fresh at the new location; user re-runs `/setup` once.

## Design

### 1. Single resolver — `src/data-dir.js`

```js
import os from "node:os";
import path from "node:path";

let cached = null;

export function resolveDataDir() {
  if (cached) return cached;
  const override = process.env.OPENAGI_DATA_DIR;
  cached = override ? path.resolve(override) : path.join(os.homedir(), ".openagi");
  return cached;
}

// Test seam: clear the memoized value (used by unit tests that mutate env).
export function _resetDataDirCache() { cached = null; }
```

- Honors `OPENAGI_DATA_DIR` (Docker `/data`, Mac app, power users) — absolute via `path.resolve`.
- Default is an **absolute** `~/.openagi`, independent of cwd → survives updates, re-clones,
  launch-dir changes.

### 2. Route everything through it

Replace the cwd-relative fallbacks. Each store keeps its explicit `options.dir` override; only
the *default* changes. Examples:

- `envFilePath(dataDir)` → `path.join(dataDir ?? resolveDataDir(), ".env")`
- `observation-store.js`: `options.dir ?? path.join(resolveDataDir(), "observations")`
- channels / cron / agents / pending-actions / outcomes / scrutiny / clarifications /
  session-miner / proactive-observer / mcp-oauth / tunnel-watcher / suggestion-feed / etc.

**Layout side effect (intended):** today the Mac app writes `.env` at `<dataDir>/.env` but
observations at `<cwd>/.openagi/observations` (a nested `.openagi`). After the refactor every
store sits directly under the resolved dir — one clean tree:

```
~/.openagi/
  .env
  observations/
  channels/
  cron/
  agents/
  ...
```

### 3. Boot loader — `examples/hosted-server.js`

Replace:
```js
const dataDir = process.env.OPENAGI_DATA_DIR ?? ".openagi";
loadEnvFile(path.join(dataDir, ".env"));
loadEnvFile(".env");
loadEnvFile(".openagi/.env");
```
with:
```js
const dataDir = resolveDataDir();
loadEnvFile(path.join(dataDir, ".env"));   // canonical (first-wins via loadEnvFile)
loadEnvFile(".env");                         // optional local-dev override in cwd
```
`loadEnvFile` only sets a key when it's absent (`if (!(key in process.env))`), so the canonical
file wins and a stray cwd `.env` can only fill gaps.

### 4. Mac app (Swift)

Update `AppState.dataDir()` (`mac/Sources/OpenAGI/AppState.swift:98`) to return
`~/.openagi` so the `.app` and the CLI/terminal daemon share one directory:

```swift
nonisolated static func dataDir() -> URL {
  let home = FileManager.default.homeDirectoryForCurrentUser
  let dir = home.appendingPathComponent(".openagi", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}
```

`DaemonController` continues to set `OPENAGI_DATA_DIR = dataDir.path` and cwd, so the JS resolver
agrees.

> ⚠️ **Risk to confirm at review:** with no migration, existing `.app` users' state currently in
> `~/Library/Application Support/OpenAGI` is *not* moved — they re-run `/setup` once after the
> update. Alternative: leave the Mac app on Application Support (already stable) and accept that
> "everywhere `~/.openagi`" applies to non-app installs only. **Default in this spec: change the
> app to `~/.openagi` for true unification.**

### 5. Docs / scripts / UX

- README, setup-wizard copy, dashboard hints: `.openagi/.env` → `~/.openagi/.env`.
- `/setup` shows the **resolved absolute path** (`resolveDataDir()`) so the location is never a
  mystery.
- `install-launchd.sh` / `install-systemd.sh`: WorkingDirectory no longer matters for state, but
  set `OPENAGI_DATA_DIR=~/.openagi` (or `$HOME/.openagi`) explicitly in the unit for clarity.
- `.gitignore`: the repo-local `.openagi/*` ignore can stay (harmless); state no longer lands
  there by default.

## Testing

- `resolveDataDir()`: returns `~/.openagi` when env unset; returns resolved absolute of
  `OPENAGI_DATA_DIR` when set; memoization + `_resetDataDirCache()`.
- A representative store (e.g. ObservationStore) writes under `resolveDataDir()` when no
  `options.dir` is passed, and under the override when env is set.
- `saveEnv` / `loadEnvFile` round-trip against a temp `OPENAGI_DATA_DIR`.

## Out of scope (YAGNI)

- No automatic migration/copy from the old location (explicitly declined).
- No split of secrets vs state into separate dirs (single tree is enough for now).
- No encryption-at-rest of `.env` beyond the existing `0600` perms.

## Build sequencing (for the plan)

1. `src/data-dir.js` + tests.
2. Repoint `envFilePath()` + boot loader; verify `/setup` save→reload round-trips to `~/.openagi`.
3. Sweep the remaining ~34 cwd-relative `.openagi` call sites through `resolveDataDir()`.
4. Swift `AppState.dataDir()` change (gated on review decision).
5. Docs / install scripts / UX copy.
