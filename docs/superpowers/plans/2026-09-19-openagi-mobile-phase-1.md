# OpenAGI Mobile Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair an iPhone or Android phone as a scoped `mobile` OpenAGI node and put a self-refreshing today/approvals widget on its home screen, with one-tap task completion that survives being offline.

**Architecture:** The daemon gains a `mobile` node platform whose credential is accepted on an explicit route allowlist, plus a single `GET /mobile/summary` endpoint that answers a whole widget refresh in one ETag-able round trip. Each phone app is four layers — transport, protocol models, snapshot store, surfaces — where the store is a JSON file in a shared container that both the app and the widget read, and only the app writes.

**Tech Stack:** Node 20+ ESM and `node --test` (daemon); Swift 6 / SwiftUI / WidgetKit / AppIntents via XcodeGen (iOS); Kotlin / Jetpack Compose / Glance / WorkManager via Gradle (Android).

**Spec:** `docs/superpowers/specs/2026-09-19-openagi-mobile-apps-design.md`

## Global Constraints

- Repo: `/Users/shooby/Dev/openAGI`. Mobile code lives in `mobile/ios/` and `mobile/android/`; shared protocol doc in `mobile/PROTOCOL.md`.
- Daemon tests run with `npm test` (`node --test`), one file per behaviour under `test/`, ESM imports only, no test framework dependencies.
- No new npm runtime dependencies. The daemon's only dependency is `ws`.
- iOS takes **no** third-party dependencies: Foundation, SwiftUI, WidgetKit, AppIntents, Security. Nothing else. No SPM packages, no CocoaPods.
- Android takes AndroidX (Compose, Glance, WorkManager, security-crypto) plus exactly two non-Google libraries — OkHttp and kotlinx-serialization — both declared in `gradle/libs.versions.toml`. Anything beyond that list needs a reason written down first. (The "no new dependencies" rule in the spec is about the *daemon*, whose only dependency stays `ws`.)
- iOS deployment target 18.0. Swift 6 language mode. Xcode is at `/Applications/Xcode-beta.app`; every `xcodebuild`/`xcrun` invocation must be prefixed with `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` because `xcode-select` points at the Command Line Tools.
- Android `minSdk 31`, `compileSdk 36`, `targetSdk 36`, compiling to Java 17 bytecode with Android Studio's JDK 21. There is no JDK and no `gradle` on `PATH`: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` (JDK 21) and `ANDROID_HOME="$HOME/Library/Android/sdk"` must be exported for every Gradle command. Gradle 8.14.3 and AGP 8.13.2 are already in the local caches; the wrapper is pinned to 8.14.3.
- Android Kotlin sources live under `src/main/kotlin/` and `src/test/kotlin/`, registered explicitly in `app/build.gradle.kts`.
- The node platform string is exactly `mobile`. The client-declared form factor (`ios` / `android`) is carried as the node `name`, never as a second platform value.
- Node tokens are 43-character base64url strings (`/^[a-zA-Z0-9_-]{43}$/`), matching the existing G2 contract. Node ids match `/^[a-zA-Z0-9:_-]{1,240}$/`.
- Tokens are never logged, never written to the snapshot file, never placed in `UserDefaults` or `SharedPreferences`.
- Every mobile-originated completion sends `completedVia: "mobile"`.
- Commit after every task. Conventional-commit prefixes (`feat:`, `test:`, `fix:`, `docs:`, `chore:`).

---

## File Structure

**Daemon (Node):**
- Create `src/mobile-node.js` — the `mobile` platform constant, its capability list, and the route allowlist predicate. Pure logic, no I/O, so the allowlist is unit-testable without a server.
- Create `src/mobile-summary.js` — builds the widget summary payload from the runtime and computes its ETag. Pure function of runtime reads.
- Modify `src/hosted-interface.js` — register the platform for enrollment, widen the node-auth gate by the allowlist, mount `GET /mobile/summary`.
- Create `test/mobile-node-scope.test.js`, `test/mobile-enrollment.test.js`, `test/mobile-summary-route.test.js`.
- Modify `bin/openagi.js` — add the `pair-phone` subcommand that issues an enrollment code.
- Create `src/pair-phone.js` — the `openagi://pair` URL builder and the phone-reachability rule.
- Create `test/pair-phone.test.js`.

**Shared:**
- Create `mobile/PROTOCOL.md` — the one written contract both clients implement.
- Create `mobile/fixtures/*.json` — golden responses generated from the real daemon, consumed by both platforms' tests.

**iOS (`mobile/ios/`):**
- `project.yml` — XcodeGen definition: app target, widget extension, unit-test target, shared App Group and Keychain group.
- `Sources/Protocol/` — `TaskItem.swift`, `Summary.swift` (`MobileSummary`, `Counts`, `Brief`, `ProtocolDecoder`), `PairingPayload.swift`. Pure `Codable` models, no I/O.
- `Sources/Transport/` — `HostAllowlist.swift` (the cleartext rule), `DaemonClient.swift` (HTTP + auth headers + typed errors).
- `Sources/Store/` — `SharedContainer.swift` (App Group path), `SnapshotStore.swift` (atomic read/write, `Snapshot`), `OutboundQueue.swift` (`PendingOp`), `Credentials.swift` (Keychain).
- `Sources/App/` — `OpenAGIApp.swift`, `RefreshCoordinator.swift`, `PairingView.swift`, `TodayView.swift`, `SettingsView.swift`.
- `Widget/` — `TodayWidgetBundle.swift`, `TodayTimelineProvider.swift`, `TodayWidget.swift`, `CompleteTaskIntent.swift`, `WidgetViews.swift`.
- `Tests/` — `SummaryDecodingTests.swift`, `HostAllowlistTests.swift`, `DaemonClientTests.swift`, `SnapshotStoreTests.swift`, `OutboundQueueTests.swift`, `RefreshCoordinatorTests.swift`, `WidgetEntryTests.swift`.

**Android (`mobile/android/`):**
- `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/libs.versions.toml`, `gradle/wrapper/`, `app/build.gradle.kts`.
- `app/src/main/kotlin/sh/openagi/mobile/protocol/` — `Models.kt` (`MobileSummary`, `TaskItem`, `Counts`, `Brief`, `PendingActionSummary`, `Enrollment`), `ProtocolJson.kt` (`Json` config + `InstantSerializer`), `PairingPayload.kt`.
- `.../transport/` — `HostAllowlist.kt`, `DaemonClient.kt` (`SummaryResponse`, `DaemonException`).
- `.../store/` — `SnapshotStore.kt` (`Snapshot`), `OutboundQueue.kt` (`PendingOp`), `Credentials.kt` (`EncryptedSharedPreferences`, `MobileNodeIdentity`).
- `.../sync/` — `RefreshCoordinator.kt` (`RefreshOutcome`), `RefreshWorker.kt` (15-minute periodic), `DrainWorker.kt` (one-shot, fired by a widget tap).
- `.../ui/` — `PairingScreen.kt`, `TodayScreen.kt`, `SettingsScreen.kt`; `MainActivity.kt` at the package root.
- `.../widget/` — `WidgetState.kt`, `TodayWidget.kt`, `TodayWidgetReceiver.kt`, `CompleteTaskAction.kt`.
- `app/src/main/res/xml/today_widget_info.xml`, `app/src/main/res/values/strings.xml`.
- `app/src/test/kotlin/sh/openagi/mobile/` — mirror of the iOS unit tests against the same fixtures.

**Docs:**
- Create `mobile/README.md` — how to build and run both apps, and the reachability rule.

---

## Task 1: `mobile` node platform and its route allowlist

The daemon already restricts the G2 wearable credential to a hard-coded list of
routes inside the single auth gate in `hosted-interface.js`. The phone needs a
wider list, but it must be just as explicit. This task builds the allowlist as a
pure module so it can be tested without a server, and wires it into the gate.

**Files:**
- Create: `src/mobile-node.js`
- Create: `test/mobile-node-scope.test.js`
- Modify: `src/hosted-interface.js` (imports near line 59; `nodeEnrollment` construction at line 82; the route gate at lines 689–727)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `MOBILE_PLATFORM: "mobile"`
  - `MOBILE_CAPABILITIES: string[]` — `["mobile-task-client", "mobile-approval-client", "mobile-chat-client"]`
  - `isMobileRouteAllowed(method: string, pathname: string): boolean`
  - `MOBILE_NODE_NAME_MAX = 60`
  - `boundedMobileNodeName(value: unknown): string`

- [ ] **Step 1: Write the failing test**

Create `test/mobile-node-scope.test.js`:

```js
// test/mobile-node-scope.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOBILE_PLATFORM,
  MOBILE_CAPABILITIES,
  isMobileRouteAllowed,
  boundedMobileNodeName
} from "../src/mobile-node.js";

test("the platform string and capabilities are the documented ones", () => {
  assert.equal(MOBILE_PLATFORM, "mobile");
  assert.deepEqual(MOBILE_CAPABILITIES, [
    "mobile-task-client",
    "mobile-approval-client",
    "mobile-chat-client"
  ]);
});

test("every route the phone app needs is allowed", () => {
  const allowed = [
    ["GET", "/mobile/summary"],
    ["GET", "/tasks"],
    ["POST", "/tasks"],
    ["GET", "/tasks/task_abc"],
    ["PATCH", "/tasks/task_abc"],
    ["POST", "/tasks/task_abc/complete"],
    ["DELETE", "/tasks/task_abc"],
    ["GET", "/tasks/clarifications"],
    ["POST", "/tasks/clarifications/clar_1/answer"],
    ["GET", "/pending-actions"],
    ["POST", "/pending-actions/pa_1/approve"],
    ["POST", "/pending-actions/pa_1/deny"],
    ["POST", "/message"],
    ["GET", "/events"],
    ["GET", "/brief/today"],
    ["POST", "/brief/focus/dismiss"],
    ["GET", "/recap/daily"],
    ["GET", "/plan/daily"],
    ["GET", "/outreach/digest"],
    ["POST", "/nodes/heartbeat"],
    ["POST", "/nodes/revoke"],
    ["POST", "/nodes/speech-token"]
  ];
  for (const [method, pathname] of allowed) {
    assert.equal(isMobileRouteAllowed(method, pathname), true, `${method} ${pathname} should be allowed`);
  }
});

test("one representative route from every excluded family is refused", () => {
  const refused = [
    ["POST", "/control/restart"],
    ["POST", "/control/update"],
    ["POST", "/nodes/control/poll"],
    ["POST", "/nodes/control/result"],
    ["POST", "/admin/provider"],
    ["GET", "/setup"],
    ["POST", "/setup/save"],
    ["POST", "/mcp/call"],
    ["POST", "/mcp/register"],
    ["GET", "/skills"],
    ["POST", "/skills/reload"],
    ["GET", "/memory"],
    ["POST", "/memory/remember"],
    ["GET", "/computer-use/log"],
    ["POST", "/computer-use/toggle"],
    ["POST", "/nodes/capture-memory"],
    ["POST", "/nodes/enroll"],
    ["POST", "/nodes/g2/ask"],
    ["GET", "/budget/ledger"],
    ["GET", "/observations"],
    ["GET", "/sessions"],
    ["POST", "/tick"]
  ];
  for (const [method, pathname] of refused) {
    assert.equal(isMobileRouteAllowed(method, pathname), false, `${method} ${pathname} must be refused`);
  }
});

test("the method matters, not just the path", () => {
  assert.equal(isMobileRouteAllowed("DELETE", "/message"), false);
  assert.equal(isMobileRouteAllowed("POST", "/events"), false);
  assert.equal(isMobileRouteAllowed("POST", "/mobile/summary"), false);
});

test("path traversal and lookalike ids cannot widen the scope", () => {
  assert.equal(isMobileRouteAllowed("POST", "/tasks/../control/restart"), false);
  assert.equal(isMobileRouteAllowed("POST", "/tasks/a/b/complete"), false);
  assert.equal(isMobileRouteAllowed("POST", "/tasks//complete"), false);
  assert.equal(isMobileRouteAllowed("POST", "/pending-actions/pa 1/approve"), false);
  assert.equal(isMobileRouteAllowed("GET", "/tasks/clarifications/extra"), false);
});

test("node names are bounded and never empty", () => {
  assert.equal(boundedMobileNodeName("Sean's iPhone"), "Sean's iPhone");
  assert.equal(boundedMobileNodeName(""), "Phone");
  assert.equal(boundedMobileNodeName(null), "Phone");
  assert.equal(boundedMobileNodeName("x".repeat(200)).length, 60);
  assert.equal(boundedMobileNodeName("bad\u0000name"), "badname");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/mobile-node-scope.test.js`
Expected: FAIL — `Cannot find module '../src/mobile-node.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/mobile-node.js`:

```js
// The phone is a full client, so its credential is broader than the G2
// wearable's. Breadth is only safe when it is explicit: this module is the
// single enumerated answer to "what may a phone token do", kept as pure data
// so the gate in hosted-interface.js has nothing to get creative about.
export const MOBILE_PLATFORM = "mobile";

export const MOBILE_CAPABILITIES = [
  "mobile-task-client",
  "mobile-approval-client",
  "mobile-chat-client"
];

export const MOBILE_NODE_NAME_MAX = 60;

// A task/action id as minted by createId(): letters, digits, underscore, dash.
// Deliberately excludes "." and "/" so no id can carry a path segment.
const ID = "[a-zA-Z0-9_-]{1,120}";

const EXACT = new Set([
  "GET /mobile/summary",
  "GET /tasks",
  "POST /tasks",
  "GET /tasks/clarifications",
  "GET /pending-actions",
  "POST /message",
  "GET /events",
  "GET /brief/today",
  "POST /brief/focus/dismiss",
  "GET /recap/daily",
  "GET /plan/daily",
  "GET /outreach/digest",
  "POST /nodes/heartbeat",
  "POST /nodes/revoke",
  "POST /nodes/speech-token"
]);

const PATTERNS = [
  { method: "GET", re: new RegExp(`^/tasks/${ID}$`) },
  { method: "PATCH", re: new RegExp(`^/tasks/${ID}$`) },
  { method: "DELETE", re: new RegExp(`^/tasks/${ID}$`) },
  { method: "POST", re: new RegExp(`^/tasks/${ID}/complete$`) },
  { method: "POST", re: new RegExp(`^/tasks/clarifications/${ID}/answer$`) },
  { method: "POST", re: new RegExp(`^/pending-actions/${ID}/approve$`) },
  { method: "POST", re: new RegExp(`^/pending-actions/${ID}/deny$`) }
];

export function isMobileRouteAllowed(method, pathname) {
  if (typeof method !== "string" || typeof pathname !== "string") return false;
  if (pathname.includes("..") || pathname.includes("//")) return false;
  if (EXACT.has(`${method} ${pathname}`)) return true;
  // "GET /tasks/clarifications" is exact; the ID pattern must not swallow it.
  if (pathname === "/tasks/clarifications") return false;
  return PATTERNS.some((p) => p.method === method && p.re.test(pathname));
}

export function boundedMobileNodeName(value) {
  const raw = typeof value === "string" ? value : "";
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean) return "Phone";
  return clean.slice(0, MOBILE_NODE_NAME_MAX);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/mobile-node-scope.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire the allowlist into the auth gate**

In `src/hosted-interface.js`, add to the import block that currently pulls
`EVEN_G2_PLATFORM` (around line 59) a new import line:

```js
import { MOBILE_PLATFORM, MOBILE_CAPABILITIES, isMobileRouteAllowed, boundedMobileNodeName } from "./mobile-node.js";
```

Change the enrollment-code construction at line 82 from:

```js
    ?? new NodeEnrollmentCodes({ platforms: [EVEN_G2_PLATFORM] });
```

to:

```js
    ?? new NodeEnrollmentCodes({ platforms: [EVEN_G2_PLATFORM, MOBILE_PLATFORM] });
```

In the gate (lines 689–727), immediately after the `g2NodeRouteAllowed`
declaration, add:

```js
      // A mobile credential is accepted on its enumerated allowlist and
      // nowhere else. Same shape as g2NodeRouteAllowed: platforms other than
      // "mobile" are unaffected, so this can only ever narrow a phone token.
      const mobileRouteAllowed = requestEnrollment?.platform !== MOBILE_PLATFORM
        || isMobileRouteAllowed(method, pathname);
      const mobileNodeRoute = requestEnrollment?.platform === MOBILE_PLATFORM
        && isMobileRouteAllowed(method, pathname);
```

Change `nodeScopedAuth` (line 717) from:

```js
      const nodeScopedAuth = (nodeScopedRoute || nodeClientRoute)
        ? g2NodeRouteAllowed && nodeRegistry.authenticate(requestNodeId, scopedBearer)
        : false;
```

to:

```js
      const nodeScopedAuth = (nodeScopedRoute || nodeClientRoute || mobileNodeRoute)
        ? g2NodeRouteAllowed && mobileRouteAllowed && nodeRegistry.authenticate(requestNodeId, scopedBearer)
        : false;
```

And in the auth gate at lines 760–765, change the node branch so a mobile route
authenticates the same way a node-client route does:

```js
        const auth = nodeScopedRoute
          ? { ok: Boolean(requestNodeId && nodeScopedAuth), reason: "missing or invalid scoped node credential" }
          : (nodeClientRoute || mobileNodeRoute) && requestNodeId
            ? { ok: nodeScopedAuth, reason: "missing or invalid scoped node credential" }
            : checkAuth(req, url, getAuthToken());
```

- [ ] **Step 6: Run the whole daemon suite for regressions**

Run: `cd /Users/shooby/Dev/openAGI && npm test 2>&1 | tail -25`
Expected: the same pass/fail counts as before this task — in particular every
`g2`, `node-`, and `auth` test still passes. Investigate any new failure before
continuing; a broken G2 gate here is a security regression, not a flake.

- [ ] **Step 7: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add src/mobile-node.js test/mobile-node-scope.test.js src/hosted-interface.js
git commit -m "feat: add a mobile node platform with an explicit route allowlist"
```

---

## Task 2: Enroll a phone

`POST /nodes/enrollment-code` and `POST /nodes/enroll/exchange` currently accept
only `even_g2` and hard-code G2 capabilities and copy. This task generalises both
to the two-platform world without changing a single byte of the G2 contract.

**Files:**
- Modify: `src/hosted-interface.js:976–991` (`/nodes/enrollment-code`), `src/hosted-interface.js:1034–1094` (`/nodes/enroll/exchange`)
- Create: `test/mobile-enrollment.test.js`

**Interfaces:**
- Consumes: `MOBILE_PLATFORM`, `MOBILE_CAPABILITIES`, `boundedMobileNodeName` from Task 1.
- Produces: an enrolled node whose `platform` is `"mobile"`, reachable by later tasks through `nodeRegistry.authenticate(nodeId, token)`. The exchange response shape is `{ node: { id, name, platform, enrolledAt }, nodeToken, capabilities }`.

- [ ] **Step 1: Write the failing test**

Create `test/mobile-enrollment.test.js`:

```js
// test/mobile-enrollment.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

const token = () => crypto.randomBytes(32).toString("base64url");

async function pairPhone(base, { name = "Sean's iPhone" } = {}) {
  const issued = await fetch(`${base}/nodes/enrollment-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "mobile" })
  });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const nodeId = `mobile:${crypto.randomUUID()}`;
  const nodeToken = token();
  const exchanged = await fetch(`${base}/nodes/enroll/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, platform: "mobile", nodeId, nodeToken, name })
  });
  return { exchanged, nodeId, nodeToken };
}

test("a phone can get a code and exchange it for a mobile-scoped credential", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const { exchanged, nodeId } = await pairPhone(base);
    assert.equal(exchanged.status, 200);
    const json = await exchanged.json();
    assert.equal(json.node.id, nodeId);
    assert.equal(json.node.platform, "mobile");
    assert.equal(json.node.name, "Sean's iPhone");
    assert.ok(json.node.enrolledAt);
    assert.deepEqual(json.capabilities, ["mobile-task-client", "mobile-approval-client", "mobile-chat-client"]);
  } finally { await app.close(); }
});

test("the issued code is single use and platform-bound", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll2-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const issued = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "mobile" })
    });
    const { code } = await issued.json();
    // A G2 client cannot spend a code minted for a phone.
    const wrongPlatform = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "even_g2", nodeId: "g2:1", nodeToken: token() })
    });
    assert.equal(wrongPlatform.status, 401);
    const first = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "mobile", nodeId: `mobile:${crypto.randomUUID()}`, nodeToken: token() })
    });
    assert.equal(first.status, 200);
    const replay = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "mobile", nodeId: `mobile:${crypto.randomUUID()}`, nodeToken: token() })
    });
    assert.equal(replay.status, 401);
  } finally { await app.close(); }
});

test("an unknown platform is still rejected", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll3-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "toaster" })
    });
    assert.equal(res.status, 400);
  } finally { await app.close(); }
});

test("the phone credential opens allowlisted routes and nothing else", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll4-"));
  const runtimeDir = dataDir;
  const runtime = createDurableRuntime({ dataDir: runtimeDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: runtimeDir, authToken: "owner-token"
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    const issued = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer owner-token" },
      body: JSON.stringify({ platform: "mobile" })
    });
    const { code } = await issued.json();
    const nodeId = `mobile:${crypto.randomUUID()}`;
    const nodeToken = token();
    const exchanged = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "mobile", nodeId, nodeToken, name: "Pixel" })
    });
    assert.equal(exchanged.status, 200);

    const asPhone = (pathname, init = {}) => fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${nodeToken}`,
        "x-openagi-node-id": nodeId,
        ...(init.headers ?? {})
      }
    });

    assert.equal((await asPhone("/tasks")).status, 200);
    assert.equal((await asPhone("/pending-actions")).status, 200);
    assert.equal((await asPhone("/brief/today")).status, 200);
    // Refused: outside the allowlist, even with a valid phone credential.
    assert.equal((await asPhone("/memory")).status, 401);
    assert.equal((await asPhone("/skills")).status, 401);
    assert.equal((await asPhone("/computer-use/log")).status, 401);
    assert.equal((await asPhone("/control/restart", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await asPhone("/nodes/g2/ask", { method: "POST", body: "{}" })).status, 401);
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/mobile-enrollment.test.js`
Expected: FAIL — the first test gets `400 platform must be even_g2`.

- [ ] **Step 3: Generalise the two enrollment routes**

In `src/hosted-interface.js`, add these helpers just above the
`/nodes/enrollment-code` handler (line 976):

```js
      const ENROLLABLE_PLATFORMS = new Set([EVEN_G2_PLATFORM, MOBILE_PLATFORM]);
      const capabilitiesForPlatform = (platform) =>
        platform === MOBILE_PLATFORM ? MOBILE_CAPABILITIES : EVEN_G2_CAPABILITIES;
      const nodeNameForPlatform = (platform, value) =>
        platform === MOBILE_PLATFORM ? boundedMobileNodeName(value) : boundedG2NodeName(value);
```

Replace the body of the `/nodes/enrollment-code` handler (lines 977–990) with:

```js
        if (readNodeConfig(dataDir)?.remote) {
          return sendJson(res, 409, { error: "nodes must be enrolled on the main OpenAGI" });
        }
        const body = await readJsonLimited(req, 4 * 1024).catch(() => ({}));
        const platform = body.platform;
        if (!ENROLLABLE_PLATFORMS.has(platform)) {
          return sendJson(res, 400, { error: `platform must be one of ${[...ENROLLABLE_PLATFORMS].join(", ")}` });
        }
        const issued = nodeEnrollment.issue(platform);
        console.log(`[openagi] ${platform} node enrollment code ${issued.code} (valid 30 min, single use)`);
        return sendJson(res, 200, {
          ...issued,
          publicUrl: getPublicUrl(),
          ...(platform === EVEN_G2_PLATFORM
            ? { transcriptionConfigured: channels?.g2?.status?.().transcriptionConfigured === true }
            : {})
        });
```

In the `/nodes/enroll/exchange` handler, replace the hard-coded platform check
at lines 1047–1049 with:

```js
        const platform = body.platform;
        if (!ENROLLABLE_PLATFORMS.has(platform)) {
          return sendG2NodeJson(res, 400, { error: "invalid_platform", message: "This enrollment code is for a different device." });
        }
```

then replace every remaining `EVEN_G2_PLATFORM` and `EVEN_G2_CAPABILITIES`
reference inside that handler (lines 1043, 1058, 1060, 1062, 1068, 1079, 1081,
1088, 1092) with the platform-aware forms — `name` becomes
`nodeNameForPlatform(platform, body.name)`, `capabilities` becomes
`capabilitiesForPlatform(platform)`, the `enrollment?.platform === EVEN_G2_PLATFORM`
recovery check becomes `enrollment?.platform === platform`, and
`nodeEnrollment.consume(code, EVEN_G2_PLATFORM)` becomes
`nodeEnrollment.consume(code, platform)`.

Leave `isG2NodeCorsRoute`, `applyG2NodeCorsHeaders`, and
`authenticatedG2CrossOrigin` exactly as they are. The phone is a native client
with no browser Origin problem, so it gets no CORS relaxation.

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/mobile-enrollment.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the G2 path is untouched**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/*g2*.test.js test/node-*.test.js 2>&1 | tail -15`
Expected: PASS. If any G2 enrollment test fails, the generalisation changed the
wearable's contract — fix it rather than updating the G2 test.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add src/hosted-interface.js test/mobile-enrollment.test.js
git commit -m "feat: enroll phones through the existing node code exchange"
```

---

## Task 3: `GET /mobile/summary`

A widget refresh happens on a tiny system budget. Four sequential requests would
spend it; one ETag-able request does not. This endpoint returns everything the
widget draws and answers `304` when nothing changed.

**Files:**
- Create: `src/mobile-summary.js`
- Create: `test/mobile-summary-route.test.js`
- Modify: `src/hosted-interface.js` (mount the route beside the `/brief/today` handler at line 1445)

**Interfaces:**
- Consumes: `isMobileRouteAllowed` already admits `GET /mobile/summary` (Task 1).
- Produces: `buildMobileSummary(runtime, { now, dataDir, taskLimit }) -> object` and `summaryETag(payload) -> string`. The payload shape is frozen here and is what every client model in Tasks 6 and 11 decodes:

```json
{
  "generatedAt": "2026-09-19T14:02:11.000Z",
  "today": [{ "id": "task_x", "title": "Ship the widget", "bucket": "today",
              "status": "pending", "priority": 60, "dueDate": null, "overdue": false }],
  "counts": { "today": 3, "this_week": 8, "overdue": 1, "pendingActions": 2 },
  "pendingActions": [{ "id": "pa_1", "summary": "Send email to Acme", "createdAt": "..." }],
  "brief": { "headline": "3 things today, 1 overdue" }
}
```

- [ ] **Step 1: Write the failing test**

Create `test/mobile-summary-route.test.js`:

```js
// test/mobile-summary-route.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

test("the summary answers an empty install without throwing", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/mobile/summary`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.today, []);
    assert.equal(json.counts.today, 0);
    assert.equal(json.counts.pendingActions, 0);
    assert.ok(json.generatedAt);
    assert.ok(typeof json.brief.headline === "string");
    assert.ok(res.headers.get("etag"));
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally { await app.close(); }
});

test("today's tasks are returned newest-priority-first with overdue flagged", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum2-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Low", bucket: "today", priority: 10 });
    runtime.tasks.add({ queue: "user", title: "High", bucket: "today", priority: 90 });
    runtime.tasks.add({ queue: "user", title: "Overdue", bucket: "today", priority: 50, dueDate: "2020-01-01T00:00:00.000Z" });
    runtime.tasks.add({ queue: "user", title: "Later", bucket: "this_week", priority: 99 });
    const json = await (await fetch(`${base}/mobile/summary`)).json();
    assert.deepEqual(json.today.map((t) => t.title), ["High", "Overdue", "Low"]);
    assert.equal(json.today.find((t) => t.title === "Overdue").overdue, true);
    assert.equal(json.today.find((t) => t.title === "High").overdue, false);
    assert.equal(json.counts.today, 3);
    assert.equal(json.counts.overdue, 1);
    assert.equal(json.counts.this_week, 1);
  } finally { await app.close(); }
});

test("completed tasks leave the widget payload", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum3-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const task = runtime.tasks.add({ queue: "user", title: "Done soon", bucket: "today" });
    await fetch(`${base}/tasks/${task.id}/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ completedVia: "mobile" })
    });
    const json = await (await fetch(`${base}/mobile/summary`)).json();
    assert.deepEqual(json.today, []);
    assert.equal(json.counts.today, 0);
  } finally { await app.close(); }
});

test("the task limit is bounded so a widget cannot ask for the whole store", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum4-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    for (let i = 0; i < 40; i += 1) runtime.tasks.add({ queue: "user", title: `T${i}`, bucket: "today" });
    const json = await (await fetch(`${base}/mobile/summary?limit=500`)).json();
    assert.equal(json.today.length, 20);
    assert.equal(json.counts.today, 40);
  } finally { await app.close(); }
});

test("an unchanged summary is a 304", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum5-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Stable", bucket: "today" });
    const first = await fetch(`${base}/mobile/summary`);
    const etag = first.headers.get("etag");
    const second = await fetch(`${base}/mobile/summary`, { headers: { "if-none-match": etag } });
    assert.equal(second.status, 304);
    runtime.tasks.add({ queue: "user", title: "New thing", bucket: "today" });
    const third = await fetch(`${base}/mobile/summary`, { headers: { "if-none-match": etag } });
    assert.equal(third.status, 200);
    assert.notEqual(third.headers.get("etag"), etag);
  } finally { await app.close(); }
});

test("the ETag ignores generatedAt so a quiet daemon keeps answering 304", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum6-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Stable", bucket: "today" });
    const a = await fetch(`${base}/mobile/summary`);
    await new Promise((r) => setTimeout(r, 15));
    const b = await fetch(`${base}/mobile/summary`);
    assert.equal(a.headers.get("etag"), b.headers.get("etag"));
    const aJson = await a.json();
    const bJson = await b.json();
    assert.notEqual(aJson.generatedAt, bJson.generatedAt);
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/mobile-summary-route.test.js`
Expected: FAIL — `/mobile/summary` returns 404.

- [ ] **Step 3: Write the payload builder**

Create `src/mobile-summary.js`:

```js
import crypto from "node:crypto";

export const MOBILE_SUMMARY_MAX_TASKS = 20;
export const MOBILE_SUMMARY_MAX_ACTIONS = 5;

// A home-screen widget redraws on a budget measured in single-digit seconds
// per hour. Everything it can render is assembled here, once, so a refresh is
// one request and — when nothing moved — one 304 with no body at all.
export function buildMobileSummary(runtime, { now = new Date(), taskLimit = MOBILE_SUMMARY_MAX_TASKS } = {}) {
  const limit = Math.max(1, Math.min(MOBILE_SUMMARY_MAX_TASKS, Number.isFinite(taskLimit) ? taskLimit : MOBILE_SUMMARY_MAX_TASKS));
  const openStatuses = new Set(["pending", "in_progress", "blocked"]);
  const all = runtime.tasks?.list ? runtime.tasks.list({ queue: "user" }) : [];
  const open = all.filter((t) => openStatuses.has(t.status));
  const today = open.filter((t) => t.bucket === "today");
  const nowMs = now.getTime();
  const isOverdue = (t) => Boolean(t.dueDate) && new Date(t.dueDate).getTime() < nowMs;

  const ordered = [...today].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    || String(a.createdAt).localeCompare(String(b.createdAt)));

  const actions = (runtime.pendingActions?.list?.({ status: "pending" }) ?? []);

  return {
    generatedAt: now.toISOString(),
    today: ordered.slice(0, limit).map((t) => ({
      id: t.id,
      title: t.title,
      bucket: t.bucket,
      status: t.status,
      priority: t.priority ?? 0,
      dueDate: t.dueDate ?? null,
      overdue: isOverdue(t)
    })),
    counts: {
      today: today.length,
      this_week: open.filter((t) => t.bucket === "this_week").length,
      overdue: open.filter(isOverdue).length,
      pendingActions: actions.length
    },
    pendingActions: actions.slice(0, MOBILE_SUMMARY_MAX_ACTIONS).map((a) => ({
      id: a.id,
      summary: typeof a.summary === "string" && a.summary
        ? a.summary
        : [a.tool, a.server].filter(Boolean).join(" · ") || "Pending action",
      createdAt: a.createdAt ?? null
    })),
    brief: { headline: headlineFor(today.length, open.filter(isOverdue).length, actions.length) }
  };
}

function headlineFor(todayCount, overdueCount, actionCount) {
  const parts = [];
  parts.push(todayCount === 1 ? "1 thing today" : `${todayCount} things today`);
  if (overdueCount > 0) parts.push(overdueCount === 1 ? "1 overdue" : `${overdueCount} overdue`);
  if (actionCount > 0) parts.push(actionCount === 1 ? "1 waiting on you" : `${actionCount} waiting on you`);
  return parts.join(", ");
}

// generatedAt is deliberately excluded: a daemon where nothing happened must
// keep answering 304, or the ETag buys the widget nothing.
export function summaryETag(payload) {
  const { generatedAt, ...stable } = payload;
  return `"${crypto.createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 27)}"`;
}
```

- [ ] **Step 4: Mount the route**

In `src/hosted-interface.js`, add the import beside the other `src/` imports:

```js
import { buildMobileSummary, summaryETag } from "./mobile-summary.js";
```

and add this handler immediately before the `GET /brief/today` handler at line 1445:

```js
      if (method === "GET" && pathname === "/mobile/summary") {
        if (!runtime.tasks?.list) return sendJson(res, 503, { error: "no task store" });
        const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        const payload = buildMobileSummary(runtime, {
          now: new Date(),
          taskLimit: Number.isFinite(rawLimit) ? rawLimit : undefined
        });
        const etag = summaryETag(payload);
        res.setHeader("cache-control", "no-store");
        res.setHeader("etag", etag);
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304);
          return res.end();
        }
        return sendJson(res, 200, payload);
      }
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/mobile-summary-route.test.js`
Expected: PASS, 6 tests. If the ordering test fails, check `runtime.tasks.list`
default ordering rather than loosening the assertion — the widget's value is
that the most important thing is on top.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add src/mobile-summary.js test/mobile-summary-route.test.js src/hosted-interface.js
git commit -m "feat: add a single-round-trip mobile summary endpoint"
```

---

## Task 4: `openagi pair-phone`

Typing a tailnet URL, a six-digit code, and a 43-character token into a phone is
the kind of friction that kills a feature. The CLI prints one line the phone can
consume: the daemon origin and the code, in the exact form the app's pairing
screen accepts.

`openagi pair` already exists and means something else entirely (this machine
joining a remote main). The new subcommand is `pair-phone` so neither grows a
confusing flag.

A scannable QR is deliberately **not** in Phase 1. The repo takes no new npm
dependencies, and a hand-rolled QR encoder is several hundred lines of
error-correction maths standing between the user and a working widget. Manual
entry is two short fields, once per phone. Revisit after the widget ships.

**Files:**
- Create: `src/pair-phone.js`
- Create: `test/pair-phone.test.js`
- Modify: `bin/openagi.js` (command switch near line 511; new `cmdPairPhone`; usage text)

**Interfaces:**
- Consumes: `POST /nodes/enrollment-code` with `{ platform: "mobile" }` (Task 2).
- Produces: `buildPairingUrl({ baseUrl, code, platform }) -> string`, `assertPhoneReachable(baseUrl) -> string` (returns the normalized origin, throws with remediation otherwise).

- [ ] **Step 1: Write the failing test**

Create `test/pair-phone.test.js`:

```js
// test/pair-phone.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPairingUrl, assertPhoneReachable } from "../src/pair-phone.js";

test("the pairing url carries exactly what the phone needs", () => {
  const url = buildPairingUrl({ baseUrl: "http://mac.tail1234.ts.net:43210", code: "004221", platform: "ios" });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "openagi:");
  assert.equal(parsed.searchParams.get("url"), "http://mac.tail1234.ts.net:43210");
  assert.equal(parsed.searchParams.get("code"), "004221");
  assert.equal(parsed.searchParams.get("platform"), "ios");
});

test("a trailing slash or path on the daemon url never reaches the phone", () => {
  const url = buildPairingUrl({ baseUrl: "http://mac.ts.net:43210/setup", code: "000001", platform: "android" });
  assert.equal(new URL(url).searchParams.get("url"), "http://mac.ts.net:43210");
});

test("a loopback daemon url is refused with a remediation, not a useless code", () => {
  assert.throws(() => assertPhoneReachable("http://127.0.0.1:43210"), /phone cannot reach 127\.0\.0\.1/);
  assert.throws(() => assertPhoneReachable("http://localhost:43210"), /phone cannot reach/);
  assert.throws(() => assertPhoneReachable("http://[::1]:43210"), /phone cannot reach/);
});

test("tailnet, LAN, and https origins are accepted", () => {
  assert.equal(assertPhoneReachable("http://mac.tail1234.ts.net:43210"), "http://mac.tail1234.ts.net:43210");
  assert.equal(assertPhoneReachable("http://100.101.102.103:43210"), "http://100.101.102.103:43210");
  assert.equal(assertPhoneReachable("http://192.168.1.20:43210"), "http://192.168.1.20:43210");
  assert.equal(assertPhoneReachable("https://openagi.example.com"), "https://openagi.example.com");
});

test("cleartext http to a public host is refused", () => {
  assert.throws(() => assertPhoneReachable("http://openagi.example.com"), /https/);
});

test("the platform must be one the app announces", () => {
  assert.throws(() => buildPairingUrl({ baseUrl: "http://mac.ts.net:43210", code: "000001", platform: "toaster" }),
    /platform must be ios or android/);
});

test("the code must be six digits", () => {
  assert.throws(() => buildPairingUrl({ baseUrl: "http://mac.ts.net:43210", code: "12345", platform: "ios" }),
    /six digits/);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/pair-phone.test.js`
Expected: FAIL — `Cannot find module '../src/pair-phone.js'`.

- [ ] **Step 3: Write the module**

Create `src/pair-phone.js`:

```js
// The same reachability rule the phone apps enforce, enforced here first: the
// CLI must refuse to mint a code the phone could never spend, and say exactly
// what to change. A six-digit code that fails silently on the phone is the
// worst possible first experience.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isTailnetHost(hostname) {
  if (hostname.endsWith(".ts.net")) return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateLanHost(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function assertPhoneReachable(baseUrl) {
  const parsed = new URL(baseUrl);
  const host = parsed.hostname;
  if (LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `a phone cannot reach ${host}. Bind OpenAGI to your tailnet or LAN address and set `
      + "OPENAGI_AUTH_TOKEN, then run this again."
    );
  }
  if (parsed.protocol === "http:" && !isTailnetHost(host) && !isPrivateLanHost(host)) {
    throw new Error(
      `refusing to pair over cleartext http to ${host}: use https, or reach OpenAGI over your tailnet.`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("the daemon url must be http or https");
  }
  return parsed.origin;
}

export function buildPairingUrl({ baseUrl, code, platform }) {
  if (platform !== "ios" && platform !== "android") {
    throw new Error("platform must be ios or android");
  }
  if (!/^\d{6}$/.test(String(code))) throw new Error("the code must be six digits");
  const origin = assertPhoneReachable(baseUrl);
  const url = new URL("openagi://pair");
  url.searchParams.set("url", origin);
  url.searchParams.set("code", String(code));
  url.searchParams.set("platform", platform);
  return url.toString();
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/pair-phone.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the CLI subcommand**

In `bin/openagi.js`, add the import beside the other `src/` imports:

```js
import { buildPairingUrl, assertPhoneReachable } from "../src/pair-phone.js";
```

add to the switch near line 511:

```js
      case "pair-phone": return await cmdPairPhone(flags);
```

and the command itself, next to `cmdPair`:

```js
async function cmdPairPhone(flags) {
  const platform = flags.platform ?? "ios";
  if (platform !== "ios" && platform !== "android") {
    console.error(c(RED, "usage: openagi pair-phone --platform ios|android [--url https://host:port]"));
    return 1;
  }
  const local = normalizeBase(flags.url ?? process.env.OPENAGI_URL ?? "http://127.0.0.1:43210");
  const headers = { "content-type": "application/json" };
  const ownerToken = process.env.OPENAGI_AUTH_TOKEN ?? null;
  if (ownerToken) headers.authorization = `Bearer ${ownerToken}`;
  let issued;
  try {
    const res = await fetch(`${local}/nodes/enrollment-code`, {
      method: "POST", headers, body: JSON.stringify({ platform: "mobile" })
    });
    if (!res.ok) {
      console.error(c(RED, `x the daemon refused to issue a code (${res.status})`));
      if (res.status === 401) console.error(c(DIM, "  set OPENAGI_AUTH_TOKEN in this shell and try again."));
      return 1;
    }
    issued = await res.json();
  } catch (error) {
    console.error(c(RED, `x could not reach OpenAGI at ${local}: ${error.message}`));
    return 1;
  }
  // The phone must be told an address IT can reach, which is rarely the one
  // the CLI just used. OPENAGI_PUBLIC_URL is that address when it is set.
  const reachableCandidate = issued.publicUrl || flags.url || local;
  let origin;
  try {
    origin = assertPhoneReachable(reachableCandidate);
    buildPairingUrl({ baseUrl: origin, code: issued.code, platform });
  } catch (error) {
    console.error(c(RED, `x ${error.message}`));
    console.error(c(DIM, "  pass the phone-reachable address explicitly: openagi pair-phone --url http://<tailnet-host>:43210"));
    return 1;
  }
  console.log("");
  console.log(`  In the OpenAGI app on your ${platform === "ios" ? "iPhone" : "Android phone"}, tap Pair and enter:`);
  console.log("");
  console.log(`    server: ${c(GREEN, origin)}`);
  console.log(`    code:   ${c(GREEN, issued.code)}`);
  console.log("");
  console.log(c(DIM, `  single use, expires ${issued.expiresAt}`));
  return 0;
}
```

Add `pair-phone --platform ios|android   pair a phone as a mobile node` to the
usage text next to the existing `pair` entry.

- [ ] **Step 6: Exercise the command end to end**

Against a loopback-bound daemon:

```bash
cd /Users/shooby/Dev/openAGI
OPENAGI_URL=http://127.0.0.1:43210 node bin/openagi.js pair-phone --platform ios
```

Expected: the remediation message and exit 1 — a code the phone cannot spend is
worse than no code. Then, against a tailnet-bound daemon (or by passing
`--url http://<tailnet-host>:43210`), expected: a server line and a six-digit
code, and `POST /nodes/enroll/exchange` with that code succeeds from another
machine on the tailnet.

- [ ] **Step 7: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add src/pair-phone.js test/pair-phone.test.js bin/openagi.js
git commit -m "feat: add openagi pair-phone for mobile node enrollment"
```

---

## Task 5: The written protocol and shared fixtures

Two native codebases implementing the same client will drift unless there is one
written contract and one set of golden responses they are both tested against.
This task produces both, generated from the real daemon rather than from
imagination.

**Files:**
- Create: `mobile/PROTOCOL.md`
- Create: `mobile/fixtures/summary-populated.json`, `mobile/fixtures/summary-empty.json`, `mobile/fixtures/tasks-list.json`, `mobile/fixtures/pending-actions.json`, `mobile/fixtures/enroll-exchange.json`
- Create: `scripts/generate-mobile-fixtures.mjs`
- Create: `test/mobile-fixtures-current.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: fixture JSON files consumed by `SummaryDecodingTests.swift` (Task 8) and `ModelsTest.kt` (Task 12).

- [ ] **Step 1: Write the fixture generator**

Create `scripts/generate-mobile-fixtures.mjs`:

```js
// Fixtures are generated from a real daemon, never hand-written: a client
// tested against an imagined response is a client that fails on first contact.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "fixtures");
fs.mkdirSync(outDir, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fixtures-"));
const runtime = createDurableRuntime({ dataDir });
const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
const listened = await app.listen();
const base = listened.url ?? `http://127.0.0.1:${listened.port}`;

const write = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + "\n");

write("summary-empty.json", await (await fetch(`${base}/mobile/summary`)).json());

runtime.tasks.add({ queue: "user", title: "Ship the widget", bucket: "today", priority: 80 });
runtime.tasks.add({ queue: "user", title: "Renew the domain", bucket: "today", priority: 40, dueDate: "2020-01-01T00:00:00.000Z" });
runtime.tasks.add({ queue: "user", title: "Read the whitepaper", bucket: "this_week", priority: 20 });

write("summary-populated.json", await (await fetch(`${base}/mobile/summary`)).json());
write("tasks-list.json", await (await fetch(`${base}/tasks?queue=user`)).json());
write("pending-actions.json", await (await fetch(`${base}/pending-actions`)).json());

const { code } = await (await fetch(`${base}/nodes/enrollment-code`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform: "mobile" })
})).json();
write("enroll-exchange.json", await (await fetch(`${base}/nodes/enroll/exchange`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    code, platform: "mobile",
    nodeId: "mobile:fixture-node",
    nodeToken: crypto.randomBytes(32).toString("base64url"),
    name: "Fixture Phone"
  })
})).json());

await app.close();
console.log(`wrote fixtures to ${outDir}`);
```

- [ ] **Step 2: Generate the fixtures**

Run: `cd /Users/shooby/Dev/openAGI && node scripts/generate-mobile-fixtures.mjs`
Expected: five files under `mobile/fixtures/`. Open
`mobile/fixtures/summary-populated.json` and confirm `today` has two entries with
`"Ship the widget"` first and `overdue: true` on `"Renew the domain"`.

- [ ] **Step 3: Write the drift test**

Create `test/mobile-fixtures-current.test.js`:

```js
// test/mobile-fixtures-current.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "fixtures");
const keys = (value) => Object.keys(value).sort();

// The phone clients decode these files in their own test suites. If the daemon
// changes shape, that must fail here in seconds rather than on a phone weeks
// later.
test("the summary fixture still matches what the daemon produces", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fixdrift-"));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    runtime.tasks.add({ queue: "user", title: "Ship the widget", bucket: "today", priority: 80 });
    const live = await (await fetch(`${base}/mobile/summary`)).json();
    const stored = JSON.parse(fs.readFileSync(path.join(fixtures, "summary-populated.json"), "utf8"));
    assert.deepEqual(keys(live), keys(stored));
    assert.deepEqual(keys(live.counts), keys(stored.counts));
    assert.deepEqual(keys(live.today[0]), keys(stored.today[0]));
    assert.deepEqual(keys(live.brief), keys(stored.brief));
  } finally { await app.close(); }
});
```

- [ ] **Step 4: Run it**

Run: `cd /Users/shooby/Dev/openAGI && node --test test/mobile-fixtures-current.test.js`
Expected: PASS. If it fails, regenerate the fixtures (Step 2) and re-run both
platforms' client tests — a shape change is a client-breaking change.

- [ ] **Step 5: Write `mobile/PROTOCOL.md`**

Document, with a request/response example for each: the pairing flow
(`openagi://pair` URL, `POST /nodes/enroll/exchange`, what to store where), the
required headers on every authenticated call (`Authorization: Bearer <nodeToken>`
and `X-OpenAGI-Node-ID: <nodeId>`), the allowlisted routes from
`src/mobile-node.js`, the `GET /mobile/summary` payload with its ETag semantics,
the completion call (`POST /tasks/:id/complete` with `{"completedVia":"mobile"}`),
the approval calls, the SSE event names the client reacts to
(`task-updated`, `task-reminder`, `task-auto-changed`, `pending-action`,
`pending-action-resolved`, `clarification-created`), the heartbeat
(`POST /nodes/heartbeat` with `{"nodeId":"...","role":"node"}` every 30s while
foregrounded — `role` is required and must be exactly `"node"`),
revocation, and the host allowlist rule (cleartext `http://` only for `*.ts.net`,
`100.64.0.0/10`, and RFC1918; `https://` otherwise). State explicitly that both
clients implement this document and that `mobile/fixtures/` is the machine-checked
half of it.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/PROTOCOL.md mobile/fixtures scripts/generate-mobile-fixtures.mjs test/mobile-fixtures-current.test.js
git commit -m "docs: write the mobile client protocol and generate shared fixtures"
```

---
## Task 6: iOS project skeleton that decodes the real fixtures

The first iOS task produces a buildable, testable project and proves the
protocol models decode the fixtures generated in Task 5. No UI yet — a project
that cannot run a test is not a project.

**Files:**
- Create: `mobile/ios/project.yml`
- Create: `mobile/ios/Sources/Protocol/Summary.swift`, `mobile/ios/Sources/Protocol/TaskItem.swift`, `mobile/ios/Sources/Protocol/PairingPayload.swift`
- Create: `mobile/ios/Sources/App/OpenAGIApp.swift` (placeholder root view so the app target links)
- Create: `mobile/ios/Tests/SummaryDecodingTests.swift`
- Create: `mobile/ios/.gitignore`

**Interfaces:**
- Consumes: `mobile/fixtures/*.json` from Task 5.
- Produces:
  - `struct MobileSummary: Codable, Sendable` with `generatedAt: Date`, `today: [TaskItem]`, `counts: Counts`, `pendingActions: [PendingActionSummary]`, `brief: Brief`
  - `struct TaskItem: Codable, Sendable, Identifiable` with `id, title, bucket, status, priority, dueDate: Date?, overdue: Bool`
  - `struct Counts: Codable, Sendable` with `today, thisWeek, overdue, pendingActions: Int`
  - `struct PairingPayload: Sendable` with `serverURL: URL`, `code: String`
  - `enum ProtocolDecoder { static let json: JSONDecoder }`

- [ ] **Step 1: Write the XcodeGen project definition**

Create `mobile/ios/project.yml`:

```yaml
name: OpenAGI
options:
  bundleIdPrefix: sh.openagi
  deploymentTarget:
    iOS: "18.0"
  createIntermediateGroups: true
settings:
  base:
    SWIFT_VERSION: "6.0"
    DEVELOPMENT_TEAM: ""
    CODE_SIGNING_ALLOWED: "NO"
    ENABLE_USER_SCRIPT_SANDBOXING: "NO"
targets:
  OpenAGI:
    type: application
    platform: iOS
    sources:
      - path: Sources
    info:
      path: Sources/Info.plist
      properties:
        CFBundleDisplayName: OpenAGI
        UILaunchScreen: {}
        CFBundleURLTypes:
          - CFBundleURLName: sh.openagi.pair
            CFBundleURLSchemes: [openagi]
        NSAppTransportSecurity:
          NSAllowsLocalNetworking: true
          NSExceptionDomains:
            ts.net:
              NSIncludesSubdomains: true
              NSExceptionAllowsInsecureHTTPLoads: true
        NSLocalNetworkUsageDescription: OpenAGI talks to the daemon on your own machine.
        BGTaskSchedulerPermittedIdentifiers: [sh.openagi.refresh]
        UIBackgroundModes: [fetch]
  OpenAGITests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - path: Tests
    dependencies:
      - target: OpenAGI
    settings:
      base:
        BUNDLE_LOADER: $(TEST_HOST)
    info:
      path: Tests/Info.plist
schemes:
  OpenAGI:
    build:
      targets:
        OpenAGI: all
    test:
      targets: [OpenAGITests]
```

Create `mobile/ios/.gitignore`:

```gitignore
OpenAGI.xcodeproj/
*.xcworkspace/
DerivedData/
build/
```

- [ ] **Step 2: Write the failing test**

Create `mobile/ios/Tests/SummaryDecodingTests.swift`:

```swift
import XCTest
@testable import OpenAGI

final class SummaryDecodingTests: XCTestCase {
    // The fixtures are generated from a running daemon by
    // scripts/generate-mobile-fixtures.mjs. Decoding them here is what stops
    // this client from drifting away from the server it talks to.
    private func fixture(_ name: String) throws -> Data {
        let here = URL(filePath: #filePath)
        let root = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appending(path: "fixtures/\(name).json"))
    }

    func testDecodesPopulatedSummary() throws {
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: fixture("summary-populated"))
        XCTAssertEqual(summary.today.count, 2)
        XCTAssertEqual(summary.today.first?.title, "Ship the widget")
        XCTAssertEqual(summary.counts.today, 2)
        XCTAssertEqual(summary.counts.overdue, 1)
        XCTAssertTrue(summary.today.contains { $0.overdue })
        XCTAssertFalse(summary.brief.headline.isEmpty)
    }

    func testDecodesEmptySummary() throws {
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: fixture("summary-empty"))
        XCTAssertTrue(summary.today.isEmpty)
        XCTAssertEqual(summary.counts.pendingActions, 0)
    }

    func testDatesDecodeAsRealDates() throws {
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: fixture("summary-populated"))
        XCTAssertTrue(summary.generatedAt.timeIntervalSince1970 > 1_600_000_000)
        let overdue = try XCTUnwrap(summary.today.first { $0.overdue })
        XCTAssertNotNil(overdue.dueDate)
    }

    func testUnknownFieldsDoNotBreakDecoding() throws {
        // A daemon that grows a field must not brick every installed phone.
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try fixture("summary-populated")) as? [String: Any]
        )
        object["somethingNew"] = ["nested": true]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertNoThrow(try ProtocolDecoder.json.decode(MobileSummary.self, from: data))
    }

    func testPairingURLParses() throws {
        let payload = try XCTUnwrap(
            PairingPayload(url: URL(string: "openagi://pair?url=http://mac.ts.net:43210&code=004221&platform=ios")!)
        )
        XCTAssertEqual(payload.serverURL.absoluteString, "http://mac.ts.net:43210")
        XCTAssertEqual(payload.code, "004221")
    }
}
```

- [ ] **Step 3: Generate the project and watch the test fail**

```bash
cd /Users/shooby/Dev/openAGI/mobile/ios
xcodegen generate
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild test \
  -project OpenAGI.xcodeproj -scheme OpenAGI \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' 2>&1 | tail -20
```

Expected: FAIL — `cannot find 'MobileSummary' in scope`.

- [ ] **Step 4: Write the protocol models**

Create `mobile/ios/Sources/Protocol/TaskItem.swift`:

```swift
import Foundation

public struct TaskItem: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let bucket: String
    public let status: String
    public let priority: Int
    public let dueDate: Date?
    public let overdue: Bool
}
```

Create `mobile/ios/Sources/Protocol/Summary.swift`:

```swift
import Foundation

public struct MobileSummary: Codable, Sendable, Equatable {
    public struct Counts: Codable, Sendable, Equatable {
        public let today: Int
        public let thisWeek: Int
        public let overdue: Int
        public let pendingActions: Int

        private enum CodingKeys: String, CodingKey {
            case today
            case thisWeek = "this_week"
            case overdue
            case pendingActions
        }
    }

    public struct PendingActionSummary: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public let summary: String
        public let createdAt: Date?
    }

    public struct Brief: Codable, Sendable, Equatable {
        public let headline: String
    }

    public let generatedAt: Date
    public let today: [TaskItem]
    public let counts: Counts
    public let pendingActions: [PendingActionSummary]
    public let brief: Brief
}

public enum ProtocolDecoder {
    // The daemon speaks ISO-8601 with fractional seconds everywhere.
    public static let json: JSONDecoder = {
        let decoder = JSONDecoder()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = formatter.date(from: raw) ?? plain.date(from: raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "unsupported date: \(raw)")
            )
        }
        return decoder
    }()

    public static let jsonEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}
```

Create `mobile/ios/Sources/Protocol/PairingPayload.swift`:

```swift
import Foundation

public struct PairingPayload: Sendable, Equatable {
    public let serverURL: URL
    public let code: String

    public init?(url: URL) {
        guard url.scheme == "openagi", url.host == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let rawServer = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let server = URL(string: rawServer),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value,
              code.count == 6, code.allSatisfy(\.isNumber)
        else { return nil }
        self.serverURL = server
        self.code = code
    }

    public init(serverURL: URL, code: String) {
        self.serverURL = serverURL
        self.code = code
    }
}
```

Create `mobile/ios/Sources/App/OpenAGIApp.swift`:

```swift
import SwiftUI

@main
struct OpenAGIApp: App {
    var body: some Scene {
        WindowGroup {
            Text("OpenAGI")
        }
    }
}
```

Create empty `mobile/ios/Sources/Info.plist` and `mobile/ios/Tests/Info.plist` with
the standard XML plist skeleton (`<dict/>` body); XcodeGen fills the rest.

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd /Users/shooby/Dev/openAGI/mobile/ios && xcodegen generate
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild test \
  -project OpenAGI.xcodeproj -scheme OpenAGI \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' 2>&1 | tail -20
```

Expected: `** TEST SUCCEEDED **`, 5 tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/ios
git commit -m "feat(ios): add the project skeleton and fixture-backed protocol models"
```

---

## Task 7: iOS transport — host allowlist and daemon client

**Files:**
- Create: `mobile/ios/Sources/Transport/HostAllowlist.swift`, `mobile/ios/Sources/Transport/DaemonClient.swift`
- Create: `mobile/ios/Tests/HostAllowlistTests.swift`, `mobile/ios/Tests/DaemonClientTests.swift`

**Interfaces:**
- Consumes: `MobileSummary`, `ProtocolDecoder` (Task 6).
- Produces:
  - `enum HostAllowlist { static func validate(_ url: URL) throws -> URL }`
  - `actor DaemonClient` with `init(server: URL, nodeID: String, token: String, session: URLSession = .shared)`, `func summary(ifNoneMatch: String?) async throws -> SummaryResponse`, `func complete(taskID: String) async throws`, `func heartbeat() async throws`, `func enroll(code: String, name: String) async throws -> Enrollment` (static, unauthenticated)
  - `enum SummaryResponse { case unchanged; case fresh(MobileSummary, etag: String?) }`
  - `enum DaemonError: Error { case unreachableHost(String), unauthorized, notFound, conflict, server(Int), transport(Error) }`

- [ ] **Step 1: Write the failing tests**

Create `mobile/ios/Tests/HostAllowlistTests.swift`:

```swift
import XCTest
@testable import OpenAGI

final class HostAllowlistTests: XCTestCase {
    func testTailnetAndLanCleartextAreAllowed() throws {
        for raw in ["http://mac.tail1234.ts.net:43210",
                    "http://100.101.102.103:43210",
                    "http://192.168.1.20:43210",
                    "http://10.0.0.5:43210",
                    "http://172.16.4.4:43210"] {
            XCTAssertNoThrow(try HostAllowlist.validate(URL(string: raw)!), raw)
        }
    }

    func testPublicCleartextIsRefused() {
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://openagi.example.com")!))
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://8.8.8.8:43210")!))
        // 172.32 is outside the private range even though it looks close.
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "http://172.32.0.1:43210")!))
    }

    func testHTTPSIsAlwaysAllowed() {
        XCTAssertNoThrow(try HostAllowlist.validate(URL(string: "https://openagi.example.com")!))
    }

    func testNonHTTPSchemesAreRefused() {
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "ftp://mac.ts.net")!))
        XCTAssertThrowsError(try HostAllowlist.validate(URL(string: "file:///etc/passwd")!))
    }
}
```

Create `mobile/ios/Tests/DaemonClientTests.swift`:

```swift
import XCTest
@testable import OpenAGI

// A URLProtocol stub keeps these tests hermetic: no daemon, no network, but the
// exact request the daemon would receive is asserted.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var lastRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        let (response, data) = Self.handler!(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class DaemonClientTests: XCTestCase {
    private func makeClient() -> DaemonClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return DaemonClient(
            server: URL(string: "http://mac.tail1234.ts.net:43210")!,
            nodeID: "mobile:abc",
            token: String(repeating: "a", count: 43),
            session: URLSession(configuration: config)
        )
    }

    func testSummarySendsCredentialsAndDecodes() async throws {
        let fixture = try Data(contentsOf: URL(filePath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "fixtures/summary-populated.json"))
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                             headerFields: ["ETag": "\"abc\""])!, fixture)
        }
        let result = try await makeClient().summary(ifNoneMatch: nil)
        guard case let .fresh(summary, etag) = result else { return XCTFail("expected fresh") }
        XCTAssertEqual(summary.today.first?.title, "Ship the widget")
        XCTAssertEqual(etag, "\"abc\"")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/mobile/summary")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(String(repeating: "a", count: 43))")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-OpenAGI-Node-ID"), "mobile:abc")
    }

    func testNotModifiedIsNotAnError() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 304, httpVersion: nil, headerFields: nil)!, Data())
        }
        let result = try await makeClient().summary(ifNoneMatch: "\"abc\"")
        guard case .unchanged = result else { return XCTFail("expected unchanged") }
        XCTAssertEqual(StubProtocol.lastRequest?.value(forHTTPHeaderField: "If-None-Match"), "\"abc\"")
    }

    func testCompleteSendsCompletedViaMobile() async throws {
        StubProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        try await makeClient().complete(taskID: "task_abc")
        let request = try XCTUnwrap(StubProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/tasks/task_abc/complete")
        let body = try XCTUnwrap(request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        })
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"completedVia":"mobile"}"#)
    }

    func testStatusCodesMapToTypedErrors() async {
        for (code, expected) in [(401, DaemonError.unauthorized), (404, .notFound), (409, .conflict)] {
            StubProtocol.handler = { request in
                (HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!, Data())
            }
            do {
                try await makeClient().complete(taskID: "task_abc")
                XCTFail("expected a throw for \(code)")
            } catch let error as DaemonError {
                XCTAssertEqual(error, expected)
            } catch { XCTFail("unexpected \(error)") }
        }
    }

    func testAnUnreachableHostIsRefusedBeforeAnyRequest() async {
        let client = DaemonClient(server: URL(string: "http://evil.example.com")!,
                                  nodeID: "mobile:abc", token: String(repeating: "a", count: 43))
        do {
            _ = try await client.summary(ifNoneMatch: nil)
            XCTFail("expected a refusal")
        } catch let error as DaemonError {
            guard case .unreachableHost = error else { return XCTFail("wrong error \(error)") }
        } catch { XCTFail("unexpected \(error)") }
    }
}
```

- [ ] **Step 2: Run and watch both fail**

```bash
cd /Users/shooby/Dev/openAGI/mobile/ios && xcodegen generate
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild test \
  -project OpenAGI.xcodeproj -scheme OpenAGI \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' 2>&1 | tail -20
```

Expected: FAIL — `cannot find 'HostAllowlist' in scope`.

- [ ] **Step 3: Write `HostAllowlist.swift`**

```swift
import Foundation

public enum HostAllowlist {
    // Cleartext is fine over WireGuard and on a home LAN, and nowhere else.
    // This is the whole reason the app can ship without TLS setup, so it is
    // enforced in one place and tested directly.
    public static func validate(_ url: URL) throws -> URL {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
            throw DaemonError.unreachableHost(url.absoluteString)
        }
        if scheme == "https" { return url }
        guard scheme == "http" else { throw DaemonError.unreachableHost(url.absoluteString) }
        if host.hasSuffix(".ts.net") { return url }
        if isPrivateOrTailscale(host) { return url }
        throw DaemonError.unreachableHost(host)
    }

    private static func isPrivateOrTailscale(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        switch (parts[0], parts[1]) {
        case (10, _): return true
        case (192, 168): return true
        case (172, 16...31): return true
        case (100, 64...127): return true   // Tailscale CGNAT range
        default: return false
        }
    }
}
```

- [ ] **Step 4: Write `DaemonClient.swift`**

```swift
import Foundation

public enum DaemonError: Error, Equatable {
    case unreachableHost(String)
    case unauthorized
    case notFound
    case conflict
    case server(Int)
    case malformedResponse
}

public enum SummaryResponse: Sendable {
    case unchanged
    case fresh(MobileSummary, etag: String?)
}

public struct Enrollment: Codable, Sendable {
    public struct Node: Codable, Sendable { public let id: String; public let name: String; public let platform: String }
    public let node: Node
    public let nodeToken: String
}

public actor DaemonClient {
    private let server: URL
    private let nodeID: String
    private let token: String
    private let session: URLSession

    public init(server: URL, nodeID: String, token: String, session: URLSession = .shared) {
        self.server = server
        self.nodeID = nodeID
        self.token = token
        self.session = session
    }

    public func summary(ifNoneMatch etag: String?) async throws -> SummaryResponse {
        var request = try authorizedRequest(path: "/mobile/summary", method: "GET")
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await session.data(for: request)
        let http = try validate(response)
        if http.statusCode == 304 { return .unchanged }
        let summary = try ProtocolDecoder.json.decode(MobileSummary.self, from: data)
        return .fresh(summary, etag: http.value(forHTTPHeaderField: "ETag"))
    }

    public func complete(taskID: String) async throws {
        var request = try authorizedRequest(path: "/tasks/\(taskID)/complete", method: "POST")
        request.httpBody = Data(#"{"completedVia":"mobile"}"#.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try validate(try await session.data(for: request).1)
    }

    public func heartbeat() async throws {
        var request = try authorizedRequest(path: "/nodes/heartbeat", method: "POST")
        // role is required and must be exactly "node". The name is deliberately
        // omitted: the daemon stores the name this node enrolled with and ignores
        // anything the wire claims, so sending one could only ever disagree.
        request.httpBody = try ProtocolDecoder.jsonEncoder.encode(["nodeId": nodeID, "role": "node"])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try validate(try await session.data(for: request).1)
    }

    public func revoke() async throws {
        var request = try authorizedRequest(path: "/nodes/revoke", method: "POST")
        request.httpBody = try ProtocolDecoder.jsonEncoder.encode(["nodeId": nodeID])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try validate(try await session.data(for: request).1)
    }

    // Enrollment happens before any credential exists, so it is static and
    // carries only the one-time code.
    public static func enroll(server: URL, code: String, nodeID: String, nodeToken: String,
                              name: String, session: URLSession = .shared) async throws -> Enrollment {
        let validated = try HostAllowlist.validate(server)
        var request = URLRequest(url: validated.appending(path: "/nodes/enroll/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code, "platform": "mobile", "nodeId": nodeID, "nodeToken": nodeToken, "name": name
        ])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        switch http.statusCode {
        case 200: return try ProtocolDecoder.json.decode(Enrollment.self, from: data)
        case 401, 429: throw DaemonError.unauthorized
        case 409: throw DaemonError.conflict
        default: throw DaemonError.server(http.statusCode)
        }
    }

    private func authorizedRequest(path: String, method: String) throws -> URLRequest {
        let base = try HostAllowlist.validate(server)
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(nodeID, forHTTPHeaderField: "X-OpenAGI-Node-ID")
        request.timeoutInterval = 12
        return request
    }

    @discardableResult
    private func validate(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw DaemonError.malformedResponse }
        switch http.statusCode {
        case 200...299, 304: return http
        case 401, 403: throw DaemonError.unauthorized
        case 404: throw DaemonError.notFound
        case 409: throw DaemonError.conflict
        default: throw DaemonError.server(http.statusCode)
        }
    }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Same `xcodebuild test` command as Step 2. Expected: `** TEST SUCCEEDED **`, 14 tests total.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/ios
git commit -m "feat(ios): add the daemon client and its cleartext host allowlist"
```

---

## Task 8: iOS store — shared snapshot and outbound queue

This is the layer the widget reads. It lives in the App Group container so the
widget extension, the app, and the AppIntent all see one truth.

**Files:**
- Create: `mobile/ios/Sources/Store/SharedContainer.swift`, `mobile/ios/Sources/Store/SnapshotStore.swift`, `mobile/ios/Sources/Store/OutboundQueue.swift`
- Create: `mobile/ios/Tests/SnapshotStoreTests.swift`, `mobile/ios/Tests/OutboundQueueTests.swift`
- Modify: `mobile/ios/project.yml` (add the App Group entitlement to the app and widget targets)

**Interfaces:**
- Consumes: `MobileSummary` (Task 6).
- Produces:
  - `struct Snapshot: Codable, Sendable` — `summary: MobileSummary`, `fetchedAt: Date`, `etag: String?`, `locallyCompleted: Set<String>`
  - `struct SnapshotStore: Sendable` — `init(directory: URL)`, `func load() -> Snapshot?`, `func save(_:) throws`, `func applyOptimisticCompletion(taskID: String) throws -> Snapshot?`, `var visibleTasks: [TaskItem]` via `Snapshot.visibleToday`
  - `struct PendingOp: Codable, Sendable, Equatable` — `id: UUID`, `kind: Kind` (`.completeTask(String)`), `createdAt: Date`, `attempts: Int`
  - `struct OutboundQueue: Sendable` — `init(directory: URL)`, `func enqueue(_:) throws`, `func all() -> [PendingOp]`, `func remove(id: UUID) throws`, `func recordAttempt(id: UUID) throws`

- [ ] **Step 1: Write the failing tests**

Create `mobile/ios/Tests/SnapshotStoreTests.swift`:

```swift
import XCTest
@testable import OpenAGI

final class SnapshotStoreTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(filePath: NSTemporaryDirectory()).appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func summary(titles: [String]) throws -> MobileSummary {
        let today = titles.enumerated().map { index, title in
            TaskItem(id: "task_\(index)", title: title, bucket: "today", status: "pending",
                     priority: 50, dueDate: nil, overdue: false)
        }
        return MobileSummary(
            generatedAt: Date(),
            today: today,
            counts: .init(today: today.count, thisWeek: 0, overdue: 0, pendingActions: 0),
            pendingActions: [],
            brief: .init(headline: "\(today.count) things today")
        )
    }

    func testRoundTrips() throws {
        let store = SnapshotStore(directory: dir)
        XCTAssertNil(store.load())
        let snapshot = Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: "\"x\"", locallyCompleted: [])
        try store.save(snapshot)
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.summary.today.map(\.title), ["A", "B"])
        XCTAssertEqual(loaded.etag, "\"x\"")
    }

    func testOptimisticCompletionHidesTheTaskImmediately() throws {
        let store = SnapshotStore(directory: dir)
        try store.save(Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: nil, locallyCompleted: []))
        let updated = try XCTUnwrap(try store.applyOptimisticCompletion(taskID: "task_0"))
        XCTAssertEqual(updated.visibleToday.map(\.title), ["B"])
        XCTAssertEqual(updated.visibleCounts.today, 1)
        // And it survives a reload, because the widget process may be different.
        XCTAssertEqual(try XCTUnwrap(store.load()).visibleToday.map(\.title), ["B"])
    }

    func testServerStateWinsOnTheNextFetch() throws {
        let store = SnapshotStore(directory: dir)
        try store.save(Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: nil, locallyCompleted: []))
        _ = try store.applyOptimisticCompletion(taskID: "task_0")
        // The server still reports task_0 as open — a refresh must not resurrect
        // the optimistic hide forever, but it also must not flicker it back
        // while the completion is still queued. The rule: a fresh fetch clears
        // only the optimistic ids the server no longer lists.
        try store.save(Snapshot(summary: try summary(titles: ["A", "B"]), fetchedAt: Date(), etag: nil,
                                locallyCompleted: ["task_0"]))
        XCTAssertEqual(try XCTUnwrap(store.load()).visibleToday.map(\.title), ["B"])
        try store.save(Snapshot(summary: try summary(titles: ["B"]), fetchedAt: Date(), etag: nil,
                                locallyCompleted: []))
        XCTAssertEqual(try XCTUnwrap(store.load()).visibleToday.map(\.title), ["B"])
    }

    func testCorruptFileIsTreatedAsNoSnapshotRatherThanCrashing() throws {
        let store = SnapshotStore(directory: dir)
        try Data("not json".utf8).write(to: dir.appending(path: "snapshot.json"))
        XCTAssertNil(store.load())
    }

    func testStalenessIsComputable() throws {
        let store = SnapshotStore(directory: dir)
        let old = Date().addingTimeInterval(-900)
        try store.save(Snapshot(summary: try summary(titles: ["A"]), fetchedAt: old, etag: nil, locallyCompleted: []))
        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.ageInMinutes(now: old.addingTimeInterval(900)), 15)
    }
}
```

Create `mobile/ios/Tests/OutboundQueueTests.swift`:

```swift
import XCTest
@testable import OpenAGI

final class OutboundQueueTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = URL(filePath: NSTemporaryDirectory()).appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    func testEnqueueAndDrain() throws {
        let queue = OutboundQueue(directory: dir)
        XCTAssertTrue(queue.all().isEmpty)
        let op = PendingOp(kind: .completeTask("task_1"))
        try queue.enqueue(op)
        XCTAssertEqual(queue.all().map(\.kind), [.completeTask("task_1")])
        try queue.remove(id: op.id)
        XCTAssertTrue(queue.all().isEmpty)
    }

    func testOpsSurviveAFreshProcess() throws {
        try OutboundQueue(directory: dir).enqueue(PendingOp(kind: .completeTask("task_2")))
        XCTAssertEqual(OutboundQueue(directory: dir).all().count, 1)
    }

    func testDuplicateCompletionsCollapse() throws {
        // Two taps on the same widget row must not produce two queued POSTs.
        let queue = OutboundQueue(directory: dir)
        try queue.enqueue(PendingOp(kind: .completeTask("task_3")))
        try queue.enqueue(PendingOp(kind: .completeTask("task_3")))
        XCTAssertEqual(queue.all().count, 1)
    }

    func testAttemptsAreCountedAndCapped() throws {
        let queue = OutboundQueue(directory: dir)
        let op = PendingOp(kind: .completeTask("task_4"))
        try queue.enqueue(op)
        for _ in 0..<OutboundQueue.maxAttempts { try queue.recordAttempt(id: op.id) }
        XCTAssertTrue(queue.all().isEmpty, "an op that keeps failing must eventually be dropped")
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Same `xcodebuild test` command. Expected: FAIL — `cannot find 'SnapshotStore' in scope`.

- [ ] **Step 3: Write the store**

Create `mobile/ios/Sources/Store/SharedContainer.swift`:

```swift
import Foundation

public enum SharedContainer {
    public static let appGroup = "group.sh.openagi.mobile"

    // The widget extension is a different process with a different sandbox.
    // The App Group container is the only place both can see.
    public static var url: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? URL(filePath: NSTemporaryDirectory())
    }
}
```

Create `mobile/ios/Sources/Store/SnapshotStore.swift`:

```swift
import Foundation

public struct Snapshot: Codable, Sendable, Equatable {
    public var summary: MobileSummary
    public var fetchedAt: Date
    public var etag: String?
    public var locallyCompleted: Set<String>

    public init(summary: MobileSummary, fetchedAt: Date, etag: String?, locallyCompleted: Set<String>) {
        self.summary = summary
        self.fetchedAt = fetchedAt
        self.etag = etag
        self.locallyCompleted = locallyCompleted
    }

    // What the UI and widget actually draw: the server's list minus anything
    // completed here that the server has not caught up with yet.
    public var visibleToday: [TaskItem] {
        summary.today.filter { !locallyCompleted.contains($0.id) }
    }

    public var visibleCounts: MobileSummary.Counts {
        let hidden = summary.today.filter { locallyCompleted.contains($0.id) }
        return .init(
            today: max(0, summary.counts.today - hidden.count),
            thisWeek: summary.counts.thisWeek,
            overdue: max(0, summary.counts.overdue - hidden.filter(\.overdue).count),
            pendingActions: summary.counts.pendingActions
        )
    }

    public func ageInMinutes(now: Date = Date()) -> Int {
        max(0, Int(now.timeIntervalSince(fetchedAt) / 60))
    }
}

public struct SnapshotStore: Sendable {
    private let file: URL

    public init(directory: URL = SharedContainer.url) {
        self.file = directory.appending(path: "snapshot.json")
    }

    public func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? ProtocolDecoder.json.decode(Snapshot.self, from: data)
    }

    public func save(_ snapshot: Snapshot) throws {
        let data = try ProtocolDecoder.jsonEncoder.encode(snapshot)
        // Atomic: a widget reading mid-write must never see half a file.
        try data.write(to: file, options: .atomic)
    }

    @discardableResult
    public func applyOptimisticCompletion(taskID: String) throws -> Snapshot? {
        guard var snapshot = load() else { return nil }
        snapshot.locallyCompleted.insert(taskID)
        try save(snapshot)
        return snapshot
    }

    // Called after a successful fetch: keep only the optimistic ids the server
    // still lists as open, so the set cannot grow forever.
    public func storeFresh(summary: MobileSummary, etag: String?, now: Date = Date()) throws -> Snapshot {
        let previous = load()?.locallyCompleted ?? []
        let stillOpen = Set(summary.today.map(\.id))
        let snapshot = Snapshot(summary: summary, fetchedAt: now, etag: etag,
                                locallyCompleted: previous.intersection(stillOpen))
        try save(snapshot)
        return snapshot
    }
}
```

Create `mobile/ios/Sources/Store/OutboundQueue.swift`:

```swift
import Foundation

public struct PendingOp: Codable, Sendable, Equatable, Identifiable {
    public enum Kind: Codable, Sendable, Equatable {
        case completeTask(String)
    }

    public let id: UUID
    public let kind: Kind
    public let createdAt: Date
    public var attempts: Int

    public init(id: UUID = UUID(), kind: Kind, createdAt: Date = Date(), attempts: Int = 0) {
        self.id = id
        self.kind = kind
        self.createdAt = createdAt
        self.attempts = attempts
    }
}

public struct OutboundQueue: Sendable {
    public static let maxAttempts = 5
    private let file: URL

    public init(directory: URL = SharedContainer.url) {
        self.file = directory.appending(path: "outbox.json")
    }

    public func all() -> [PendingOp] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? ProtocolDecoder.json.decode([PendingOp].self, from: data)) ?? []
    }

    public func enqueue(_ op: PendingOp) throws {
        var ops = all()
        // Tapping the same row twice is one intent, not two.
        guard !ops.contains(where: { $0.kind == op.kind }) else { return }
        ops.append(op)
        try write(ops)
    }

    public func remove(id: UUID) throws {
        try write(all().filter { $0.id != id })
    }

    public func recordAttempt(id: UUID) throws {
        var ops = all()
        guard let index = ops.firstIndex(where: { $0.id == id }) else { return }
        ops[index].attempts += 1
        // An op that has failed this many times is not going to start working.
        // Dropping it is better than a queue that retries forever on every
        // background wake.
        if ops[index].attempts >= Self.maxAttempts { ops.remove(at: index) }
        try write(ops)
    }

    private func write(_ ops: [PendingOp]) throws {
        try ProtocolDecoder.jsonEncoder.encode(ops).write(to: file, options: .atomic)
    }
}
```

- [ ] **Step 4: Add the App Group entitlement**

In `mobile/ios/project.yml`, add to the `OpenAGI` target:

```yaml
    entitlements:
      path: Sources/OpenAGI.entitlements
      properties:
        com.apple.security.application-groups: [group.sh.openagi.mobile]
        keychain-access-groups: [$(AppIdentifierPrefix)sh.openagi.mobile]
```

- [ ] **Step 5: Run the tests and watch them pass**

Same `xcodebuild test` command. Expected: `** TEST SUCCEEDED **`, 23 tests total.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/ios
git commit -m "feat(ios): add the shared snapshot store and offline outbound queue"
```

---

## Task 9: iOS pairing, credentials, and refresh

The app shell: pair, store the credential in the Keychain, fetch, write the
snapshot, drain the queue, and schedule background refreshes.

**Files:**
- Create: `mobile/ios/Sources/Store/Credentials.swift`
- Create: `mobile/ios/Sources/App/RefreshCoordinator.swift`, `mobile/ios/Sources/App/PairingView.swift`, `mobile/ios/Sources/App/TodayView.swift`, `mobile/ios/Sources/App/SettingsView.swift`
- Modify: `mobile/ios/Sources/App/OpenAGIApp.swift`
- Create: `mobile/ios/Tests/RefreshCoordinatorTests.swift`

**Interfaces:**
- Consumes: `DaemonClient` (Task 7), `SnapshotStore`, `OutboundQueue` (Task 8).
- Produces:
  - `struct Credentials: Sendable` — `static func load() -> Credentials?`, `func save() throws`, `static func clear()`, fields `server: URL`, `nodeID: String`, `token: String`
  - `actor RefreshCoordinator` — `init(client: DaemonClient, store: SnapshotStore, queue: OutboundQueue)`, `func refresh() async -> RefreshOutcome`, `func drainQueue() async`
  - `enum RefreshOutcome { case updated(Snapshot), unchanged, unauthorized, offline }`

- [ ] **Step 1: Write the failing test**

Create `mobile/ios/Tests/RefreshCoordinatorTests.swift` covering, with the
`StubProtocol` from Task 7:

1. `testRefreshWritesTheSnapshotAndReturnsUpdated` — 200 with the populated
   fixture leaves `store.load()?.summary.today.count == 2` and returns
   `.updated`.
2. `testUnchangedLeavesTheExistingSnapshotAlone` — seed a snapshot, respond 304,
   assert the stored `fetchedAt` is refreshed but `today` is untouched and the
   outcome is `.unchanged`.
3. `testDrainSendsQueuedCompletionsAndClearsThem` — enqueue
   `.completeTask("task_0")`, respond 200, assert the queue is empty and the
   request path was `/tasks/task_0/complete`.
4. `testA404DuringDrainRetiresTheOpRatherThanRetrying` — respond 404, assert the
   queue is empty (the task is gone server-side; replaying forever is pointless).
5. `testAnUnauthorizedRefreshReportsUnauthorizedAndKeepsTheSnapshot` — respond
   401, assert `.unauthorized` and that the cached snapshot still loads, so the
   user sees their tasks while they re-pair.

Write these as real XCTest methods following the shape of `DaemonClientTests`.

- [ ] **Step 2: Run and watch them fail**

Same `xcodebuild test` command. Expected: FAIL — `cannot find 'RefreshCoordinator' in scope`.

- [ ] **Step 3: Write `Credentials.swift`**

```swift
import Foundation
import Security

// The node token is the whole security boundary of this app. It goes in the
// Keychain, in an access group the widget extension shares, and it is never
// written next to the snapshot.
public struct Credentials: Sendable, Equatable {
    public let server: URL
    public let nodeID: String
    public let token: String

    private static let service = "sh.openagi.mobile.node"
    private static let account = "primary"
    private static let accessGroup = "sh.openagi.mobile"

    public init(server: URL, nodeID: String, token: String) {
        self.server = server
        self.nodeID = nodeID
        self.token = token
    }

    public func save() throws {
        let payload = try JSONSerialization.data(withJSONObject: [
            "server": server.absoluteString, "nodeID": nodeID, "token": token
        ])
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = payload
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw DaemonError.server(Int(status)) }
    }

    public static func load() -> Credentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let rawServer = object["server"], let server = URL(string: rawServer),
              let nodeID = object["nodeID"], let token = object["token"]
        else { return nil }
        return Credentials(server: server, nodeID: nodeID, token: token)
    }

    public static func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}
```

- [ ] **Step 4: Write `RefreshCoordinator.swift`**

```swift
import Foundation
import WidgetKit

public enum RefreshOutcome: Sendable, Equatable {
    case updated(Snapshot)
    case unchanged
    case unauthorized
    case offline
}

public actor RefreshCoordinator {
    private let client: DaemonClient
    private let store: SnapshotStore
    private let queue: OutboundQueue

    public init(client: DaemonClient, store: SnapshotStore = SnapshotStore(), queue: OutboundQueue = OutboundQueue()) {
        self.client = client
        self.store = store
        self.queue = queue
    }

    // Order matters: send what the user already did before asking what is true,
    // or a refresh will hand back the state their tap was meant to change.
    public func refresh() async -> RefreshOutcome {
        await drainQueue()
        do {
            switch try await client.summary(ifNoneMatch: store.load()?.etag) {
            case .unchanged:
                if var snapshot = store.load() {
                    snapshot.fetchedAt = Date()
                    try? store.save(snapshot)
                }
                reloadWidgets()
                return .unchanged
            case let .fresh(summary, etag):
                let snapshot = try store.storeFresh(summary: summary, etag: etag)
                reloadWidgets()
                return .updated(snapshot)
            }
        } catch DaemonError.unauthorized {
            return .unauthorized
        } catch {
            return .offline
        }
    }

    public func drainQueue() async {
        for op in queue.all() {
            switch op.kind {
            case let .completeTask(taskID):
                do {
                    try await client.complete(taskID: taskID)
                    try? queue.remove(id: op.id)
                } catch DaemonError.notFound, DaemonError.conflict {
                    // The server has already moved on. Replaying cannot help.
                    try? queue.remove(id: op.id)
                } catch {
                    try? queue.recordAttempt(id: op.id)
                }
            }
        }
    }

    private func reloadWidgets() {
        WidgetCenter.shared.reloadTimelines(ofKind: "TodayWidget")
    }
}
```

- [ ] **Step 5: Write the three views and the app entry point**

`PairingView` takes a server URL and a six-digit code (prefilled when the app is
opened from an `openagi://pair` URL), generates a node id
(`"mobile:" + UUID().uuidString`) and a 43-character base64url token
(`Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()`
converted to base64url and trimmed of padding), calls `DaemonClient.enroll`,
saves `Credentials`, and triggers the first refresh.

`TodayView` renders `store.load()?.visibleToday` with a completion button per
row that calls `store.applyOptimisticCompletion`, enqueues the op, and kicks
`RefreshCoordinator.drainQueue`. It shows the staleness line
("updated 14m ago" / "can't reach OpenAGI") from `Snapshot.ageInMinutes`.

`SettingsView` shows the paired server and node id, a Refresh button, and a
Revoke button that calls `client.revoke()`, `Credentials.clear()`, and deletes
the snapshot.

`OpenAGIApp` chooses `PairingView` or `TodayView` based on
`Credentials.load()`, handles `onOpenURL` by parsing `PairingPayload`, registers
the `sh.openagi.refresh` `BGAppRefreshTask` which calls
`RefreshCoordinator.refresh()` and reschedules itself, and refreshes on
`scenePhase == .active`.

- [ ] **Step 6: Run the tests and watch them pass**

Same `xcodebuild test` command. Expected: `** TEST SUCCEEDED **`, 28 tests total.

- [ ] **Step 7: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/ios
git commit -m "feat(ios): pair, store credentials in the keychain, and refresh"
```

---

## Task 10: The iOS widget

**Files:**
- Create: `mobile/ios/Sources/Store/WidgetState.swift` (in `Sources/`, not `Widget/`, so both the app and the widget extension compile it and the test target can reach it)
- Create: `mobile/ios/Widget/TodayWidgetBundle.swift`, `mobile/ios/Widget/TodayTimelineProvider.swift`, `mobile/ios/Widget/TodayWidget.swift`, `mobile/ios/Widget/CompleteTaskIntent.swift`, `mobile/ios/Widget/WidgetViews.swift`, `mobile/ios/Widget/Info.plist`, `mobile/ios/Widget/OpenAGIWidget.entitlements`
- Modify: `mobile/ios/project.yml` (widget extension target and its dependency on the app)
- Create: `mobile/ios/Tests/WidgetEntryTests.swift`

**Interfaces:**
- Consumes: `Snapshot`, `SnapshotStore`, `OutboundQueue` (Task 8), `Credentials` (Task 9).
- Produces:
  - `enum WidgetState: Equatable { case unpaired; case empty(headline: String); case tasks([TaskItem], counts: MobileSummary.Counts, ageMinutes: Int); case stale(Int) }`
  - `static func from(snapshot: Snapshot?, paired: Bool, now: Date = Date()) -> WidgetState` and `static let staleAfterMinutes = 60` on `WidgetState`
  - `struct TodayEntry: TimelineEntry` — `date: Date`, `state: WidgetState`

- [ ] **Step 1: Write the failing test**

`WidgetState.from` is a pure function taking `paired: Bool` — deliberately not
reading the Keychain itself, because a unit-test bundle cannot arrange Keychain
state, and because this makes it the literal twin of Android's
`WidgetState.from` in Task 15. The timeline provider is what supplies
`paired: Credentials.load() != nil`.

It must match Android's rules exactly: not paired → `.unpaired`; no snapshot →
`.empty`; age > `staleAfterMinutes` (60) → `.stale(age)`; no visible tasks →
`.empty` with the brief headline; otherwise `.tasks(visibleToday, visibleCounts, age)`.

Create `mobile/ios/Tests/WidgetEntryTests.swift` with these five cases as real
XCTest methods, following the shape of `SnapshotStoreTests` (a private helper
that builds a `Snapshot` from titles and an age in minutes, and a fixed `now`):

1. `paired: false` → `.unpaired`, whatever the snapshot holds.
2. `paired: true`, `snapshot: nil` → `.empty` with a non-empty headline.
3. Snapshot with two visible tasks, fetched 3 minutes ago → `.tasks` with both
   titles and `ageMinutes == 3`.
4. Snapshot fetched 61 minutes ago → `.stale(61)` — past an hour the widget
   must say so rather than present old rows as current.
5. Snapshot whose only task was optimistically completed → `.empty`.

- [ ] **Step 2: Run and watch it fail**

Same `xcodebuild test` command. Expected: FAIL — `cannot find 'TodayEntry' in scope`.

- [ ] **Step 3: Add the widget target to `project.yml`**

```yaml
  OpenAGIWidget:
    type: app-extension
    platform: iOS
    sources:
      - path: Widget
      - path: Sources/Protocol
      - path: Sources/Store
    info:
      path: Widget/Info.plist
      properties:
        NSExtension:
          NSExtensionPointIdentifier: com.apple.widgetkit-extension
    entitlements:
      path: Widget/OpenAGIWidget.entitlements
      properties:
        com.apple.security.application-groups: [group.sh.openagi.mobile]
        keychain-access-groups: [$(AppIdentifierPrefix)sh.openagi.mobile]
```

and add to the `OpenAGI` target:

```yaml
    dependencies:
      - target: OpenAGIWidget
        embed: true
```

- [ ] **Step 4: Write the widget**

`TodayTimelineProvider` reads `SnapshotStore().load()` and `Credentials.load()`,
maps them to `WidgetState` with the rules from Step 1, and returns a timeline
with one entry now plus a refresh policy of `.after(15 minutes)`. It never
performs network I/O: the app owns refresh, the widget owns rendering.

`CompleteTaskIntent` is an `AppIntent` with `@Parameter var taskID: String` whose
`perform()` calls `SnapshotStore().applyOptimisticCompletion(taskID:)`, enqueues
`PendingOp(kind: .completeTask(taskID))`, and returns `.result()`. Mark it
`static var openAppWhenRun = false` so a tap completes in place.

`WidgetViews` renders each state: small shows the count and the top task, medium
shows up to three rows with a completion button each, large adds the brief
headline and the pending-approval count. Every non-`.unpaired` state renders the
age line; `.stale` renders it in the warning colour.

- [ ] **Step 5: Run the tests and watch them pass**

Same `xcodebuild test` command. Expected: `** TEST SUCCEEDED **`, 33 tests total.

- [ ] **Step 6: Verify on a simulator by hand**

```bash
cd /Users/shooby/Dev/openAGI/mobile/ios && xcodegen generate
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild build \
  -project OpenAGI.xcodeproj -scheme OpenAGI \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' 2>&1 | tail -5
```

Then install and launch it in the simulator, add the widget to the home screen,
and confirm: unpaired state renders; after pairing against a real tailnet-bound
daemon the today rows appear; tapping a row's button removes it immediately and
the task shows `completed` in `openagi` on the desktop.

- [ ] **Step 7: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/ios
git commit -m "feat(ios): add the today widget with in-place task completion"
```

---

## Task 11: Android project skeleton that decodes the real fixtures

The Android mirror of Task 6. Same rule: a project that cannot run a test is not
a project, and the first thing proven is that the Kotlin models decode the same
`mobile/fixtures/*.json` the Swift models decode.

Toolchain facts for this machine, so nobody has to discover them: there is no
`gradle` and no JDK on `PATH`. Android Studio ships a JDK 21 at
`/Applications/Android Studio.app/Contents/jbr/Contents/Home`, the SDK is at
`~/Library/Android/sdk` with platforms 34/35/36 installed, and Gradle 8.14.3 is
already in `~/.gradle/wrapper/dists`. Everything below uses exactly those.

**Files:**
- Create: `mobile/android/settings.gradle.kts`, `mobile/android/build.gradle.kts`, `mobile/android/gradle.properties`, `mobile/android/gradle/libs.versions.toml`, `mobile/android/.gitignore`
- Create: `mobile/android/app/build.gradle.kts`, `mobile/android/app/src/main/AndroidManifest.xml`
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/protocol/Models.kt`, `.../protocol/ProtocolJson.kt`, `.../protocol/PairingPayload.kt`
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/MainActivity.kt` (placeholder so the app target links)
- Create: `mobile/android/app/src/test/kotlin/sh/openagi/mobile/protocol/SummaryDecodingTest.kt`

**Interfaces:**
- Consumes: `mobile/fixtures/*.json` from Task 5.
- Produces:
  - `data class MobileSummary(val generatedAt: Instant, val today: List<TaskItem>, val counts: Counts, val pendingActions: List<PendingActionSummary>, val brief: Brief)`
  - `data class TaskItem(val id: String, val title: String, val bucket: String, val status: String, val priority: Int, val dueDate: Instant?, val overdue: Boolean)`
  - `data class Counts(val today: Int, val thisWeek: Int, val overdue: Int, val pendingActions: Int)`
  - `data class PairingPayload(val serverUrl: String, val code: String)` with `companion object { fun from(uri: Uri): PairingPayload? }`
  - `object ProtocolJson { val json: Json }`

- [ ] **Step 1: Bootstrap the Gradle wrapper**

There is no `gradle` on `PATH`, so run the cached distribution once to generate
the wrapper, then never touch it again:

```bash
mkdir -p /Users/shooby/Dev/openAGI/mobile/android
cd /Users/shooby/Dev/openAGI/mobile/android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ~/.gradle/wrapper/dists/gradle-8.14.3-bin/*/gradle-8.14.3/bin/gradle \
  wrapper --gradle-version 8.14.3 --distribution-type bin
```

Expected: `gradlew`, `gradlew.bat`, and `gradle/wrapper/` appear. Verify with
`./gradlew --version` (same `JAVA_HOME` prefix) — it must print Gradle 8.14.3.

- [ ] **Step 2: Write the build files**

Create `mobile/android/gradle/libs.versions.toml`:

```toml
[versions]
agp = "8.13.2"
kotlin = "2.3.21"
coreKtx = "1.15.0"
composeBom = "2025.01.00"
activityCompose = "1.9.3"
lifecycle = "2.8.7"
glance = "1.1.1"
work = "2.10.0"
securityCrypto = "1.1.0-alpha06"
okhttp = "4.12.0"
serialization = "1.7.3"
junit = "4.13.2"

[libraries]
androidx-core-ktx = { module = "androidx.core:core-ktx", version.ref = "coreKtx" }
androidx-activity-compose = { module = "androidx.activity:activity-compose", version.ref = "activityCompose" }
androidx-lifecycle-runtime-ktx = { module = "androidx.lifecycle:lifecycle-runtime-ktx", version.ref = "lifecycle" }
androidx-compose-bom = { module = "androidx.compose:compose-bom", version.ref = "composeBom" }
androidx-compose-material3 = { module = "androidx.compose.material3:material3" }
androidx-compose-ui = { module = "androidx.compose.ui:ui" }
androidx-compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
androidx-glance-appwidget = { module = "androidx.glance:glance-appwidget", version.ref = "glance" }
androidx-glance-material3 = { module = "androidx.glance:glance-material3", version.ref = "glance" }
androidx-work-runtime-ktx = { module = "androidx.work:work-runtime-ktx", version.ref = "work" }
androidx-security-crypto = { module = "androidx.security:security-crypto", version.ref = "securityCrypto" }
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
okhttp-mockwebserver = { module = "com.squareup.okhttp3:mockwebserver", version.ref = "okhttp" }
kotlinx-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "serialization" }
junit = { module = "junit:junit", version.ref = "junit" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
```

Create `mobile/android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "OpenAGI"
include(":app")
```

Create `mobile/android/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
```

Create `mobile/android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8
org.gradle.parallel=true
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
```

Create `mobile/android/app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "sh.openagi.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "sh.openagi.mobile"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    // Compile to Java 17 bytecode using whatever JDK Gradle is running on
    // (Android Studio's JDK 21). Do not set a jvmToolchain: there is no
    // standalone JDK 17 on this machine and auto-provisioning would download one.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    sourceSets {
        getByName("main").kotlin.srcDir("src/main/kotlin")
        getByName("test").kotlin.srcDir("src/test/kotlin")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

// `kotlinOptions { jvmTarget = "17" }` is a HARD COMPILE ERROR under Kotlin
// 2.3.21's Gradle plugin: "Using 'jvmTarget: String' is an error. Please
// migrate to the compilerOptions DSL." This is the equivalent form — same
// Java 17 bytecode, and still no jvmToolchain() call, so nothing tries to
// auto-provision a JDK that does not exist on this machine.
// Requires `import org.jetbrains.kotlin.gradle.dsl.JvmTarget` at the top.
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
}
```

Create `mobile/android/.gitignore`:

```gitignore
.gradle/
build/
local.properties
*.iml
.idea/
```

Create `mobile/android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <application
        android:allowBackup="false"
        android:label="OpenAGI"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.DeviceDefault.DayNight"
        android:usesCleartextTraffic="true">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="openagi" android:host="pair" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

Note the `android:usesCleartextTraffic="true"` attribute above, and the absence
of a `network-security-config`. That is deliberate. Android blocks cleartext by
default from API 28 on, and a `network-security-config` is the usual way to
re-permit it per host — but that file cannot express `100.64.0.0/10` or the
RFC1918 ranges, only literal domains. A config whose `base-config` denies
cleartext would therefore block every Tailscale-IP and LAN-IP origin this app
exists to reach, and it silently overrides `usesCleartextTraffic` on API 28+.

So the platform gate is opened wide and the real check is `HostAllowlist` in
Task 12: a pure, unit-tested function with an explicit table of the three host
families that may be reached over `http`. One enforcing check that is tested
beats two where the outer one cannot express the policy.

- [ ] **Step 3: Write the failing test**

Create `mobile/android/app/src/test/kotlin/sh/openagi/mobile/protocol/SummaryDecodingTest.kt`:

```kotlin
package sh.openagi.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SummaryDecodingTest {
    // Unit tests run with the module directory as the working directory, so the
    // shared fixtures are two levels up. Decoding the same bytes the Swift tests
    // decode is what keeps the two clients honest.
    private fun fixture(name: String): String =
        File("../../fixtures/$name.json").readText()

    @Test
    fun decodesPopulatedSummary() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        assertEquals(2, summary.today.size)
        assertEquals("Ship the widget", summary.today.first().title)
        assertEquals(2, summary.counts.today)
        assertEquals(1, summary.counts.overdue)
        assertTrue(summary.today.any { it.overdue })
        assertFalse(summary.brief.headline.isEmpty())
    }

    @Test
    fun decodesEmptySummary() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-empty"))
        assertTrue(summary.today.isEmpty())
        assertEquals(0, summary.counts.pendingActions)
    }

    @Test
    fun snakeCaseCountKeyMapsToThisWeek() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        assertTrue(summary.counts.thisWeek >= 0)
    }

    @Test
    fun datesDecodeAsRealInstants() {
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), fixture("summary-populated"))
        assertTrue(summary.generatedAt.epochSecond > 1_600_000_000L)
        assertNotNull(summary.today.first { it.overdue }.dueDate)
    }

    @Test
    fun unknownFieldsDoNotBreakDecoding() {
        // A daemon that grows a field must not brick every installed phone.
        val withExtra = fixture("summary-populated").trimEnd().removeSuffix("}") + ""","somethingNew":{"nested":true}}"""
        val summary = ProtocolJson.json.decodeFromString(MobileSummary.serializer(), withExtra)
        assertEquals(2, summary.today.size)
    }
}
```

- [ ] **Step 4: Run the test and watch it fail**

```bash
cd /Users/shooby/Dev/openAGI/mobile/android
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :app:testDebugUnitTest 2>&1 | tail -30
```

Expected: FAIL — `Unresolved reference: MobileSummary`.

- [ ] **Step 5: Write the protocol models**

Create `mobile/android/app/src/main/kotlin/sh/openagi/mobile/protocol/Models.kt`:

```kotlin
package sh.openagi.mobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable
data class TaskItem(
    val id: String,
    val title: String,
    val bucket: String,
    val status: String,
    val priority: Int = 50,
    @Serializable(with = InstantSerializer::class) val dueDate: Instant? = null,
    val overdue: Boolean = false,
)

@Serializable
data class Counts(
    val today: Int = 0,
    @SerialName("this_week") val thisWeek: Int = 0,
    val overdue: Int = 0,
    val pendingActions: Int = 0,
)

@Serializable
data class PendingActionSummary(
    val id: String,
    val summary: String,
    @Serializable(with = InstantSerializer::class) val createdAt: Instant? = null,
)

@Serializable
data class Brief(val headline: String = "")

@Serializable
data class MobileSummary(
    @Serializable(with = InstantSerializer::class) val generatedAt: Instant,
    val today: List<TaskItem> = emptyList(),
    val counts: Counts = Counts(),
    val pendingActions: List<PendingActionSummary> = emptyList(),
    val brief: Brief = Brief(),
)

@Serializable
data class Enrollment(
    val node: Node,
    val nodeToken: String,
) {
    @Serializable
    data class Node(val id: String, val name: String, val platform: String)
}
```

Create `mobile/android/app/src/main/kotlin/sh/openagi/mobile/protocol/ProtocolJson.kt`:

```kotlin
package sh.openagi.mobile.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import java.time.Instant

// The daemon speaks ISO-8601 with a Z, sometimes with fractional seconds.
// java.time.Instant.parse handles both, and minSdk 31 means it is always there.
object InstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("java.time.Instant", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())

    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

object ProtocolJson {
    val json: Json = Json {
        // A daemon that grows a field must not brick every installed phone.
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
}
```

Create `mobile/android/app/src/main/kotlin/sh/openagi/mobile/protocol/PairingPayload.kt`:

```kotlin
package sh.openagi.mobile.protocol

import android.net.Uri

data class PairingPayload(val serverUrl: String, val code: String) {
    companion object {
        fun from(uri: Uri): PairingPayload? {
            if (uri.scheme != "openagi" || uri.host != "pair") return null
            val server = uri.getQueryParameter("url") ?: return null
            val code = uri.getQueryParameter("code") ?: return null
            if (code.length != 6 || !code.all { it.isDigit() }) return null
            return PairingPayload(server, code)
        }
    }
}
```

Create `mobile/android/app/src/main/kotlin/sh/openagi/mobile/MainActivity.kt`:

```kotlin
package sh.openagi.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { Text("OpenAGI") } }
    }
}
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
cd /Users/shooby/Dev/openAGI/mobile/android
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :app:testDebugUnitTest 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`, 5 tests.

- [ ] **Step 7: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/android
git commit -m "feat(android): add the gradle skeleton and fixture-backed protocol models"
```

---

## Task 12: Android transport — host allowlist and daemon client

The Kotlin twin of Task 7. The two allowlists must agree exactly; a host one
platform trusts and the other refuses is a bug in whichever is wrong, and the
test tables here are deliberately identical to the Swift ones.

**Files:**
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/transport/HostAllowlist.kt`, `.../transport/DaemonClient.kt`
- Create: `mobile/android/app/src/test/kotlin/sh/openagi/mobile/transport/HostAllowlistTest.kt`, `.../transport/DaemonClientTest.kt`

**Interfaces:**
- Consumes: `MobileSummary`, `Enrollment`, `ProtocolJson` (Task 11).
- Produces:
  - `object HostAllowlist { fun validate(raw: String): HttpUrl }` — throws `DaemonException.UnreachableHost`
  - `class DaemonClient(server: String, nodeId: String, token: String, client: OkHttpClient = defaultClient)` with `suspend fun summary(ifNoneMatch: String?): SummaryResponse`, `suspend fun complete(taskId: String)`, `suspend fun heartbeat()`, `suspend fun revoke()`, and `companion object { suspend fun enroll(server: String, code: String, nodeId: String, nodeToken: String, name: String, client: OkHttpClient = defaultClient): Enrollment }`
  - `sealed class SummaryResponse { object Unchanged; data class Fresh(val summary: MobileSummary, val etag: String?) }`
  - `sealed class DaemonException(message: String) : Exception(message)` with subclasses `UnreachableHost(host: String)`, `Unauthorized()`, `NotFound()`, `Conflict()`, `Server(val code: Int)`, `Malformed()`, `Transport(val cause: java.io.IOException)` — all classes, so each carries a message and can be caught by type. `Transport` exists because an OkHttp `IOException` would otherwise escape past `DaemonException` entirely, which is the single most common failure on a phone.

- [ ] **Step 1: Write the failing tests**

Create `mobile/android/app/src/test/kotlin/sh/openagi/mobile/transport/HostAllowlistTest.kt`:

```kotlin
package sh.openagi.mobile.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class HostAllowlistTest {
    @Test
    fun tailnetAndLanCleartextAreAllowed() {
        listOf(
            "http://mac.tail1234.ts.net:43210",
            "http://100.101.102.103:43210",
            "http://192.168.1.20:43210",
            "http://10.0.0.5:43210",
            "http://172.16.4.4:43210",
        ).forEach { raw ->
            HostAllowlist.validate(raw) // must not throw
        }
    }

    @Test
    fun publicCleartextIsRefused() {
        listOf(
            "http://openagi.example.com",
            "http://8.8.8.8:43210",
            // 172.32 is outside the private range even though it looks close.
            "http://172.32.0.1:43210",
        ).forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }

    @Test
    fun httpsIsAlwaysAllowed() {
        assertEquals("openagi.example.com", HostAllowlist.validate("https://openagi.example.com").host)
    }

    @Test
    fun nonHttpSchemesAreRefused() {
        listOf("ftp://mac.ts.net", "file:///etc/passwd", "not a url").forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }

    @Test
    fun trailingPathsAreDroppedSoRequestPathsAreNotDoubled() {
        assertEquals(
            "http://mac.ts.net:43210/",
            HostAllowlist.validate("http://mac.ts.net:43210/setup").toString()
        )
    }

    @Test
    fun loopbackIsRefusedWhateverTheScheme() {
        // https must be refused too. A loopback address is the daemon's own
        // default bind, so it is the single likeliest thing to be pasted into
        // pairing by mistake, and a phone can never reach it.
        listOf(
            "http://127.0.0.1:43210",
            "https://127.0.0.1:43210",
            "http://localhost:43210",
            "https://localhost:43210",
        ).forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }

    @Test
    fun cidrBoundaryNearMissesAreRefused() {
        // Each of these is one octet away from a permitted range. They exist so a
        // sloppy `a == 172` or `a == 100` check cannot pass this suite.
        listOf(
            "http://172.15.0.1:43210",
            "http://172.32.0.1:43210",
            "http://100.63.0.1:43210",
            "http://100.128.0.1:43210",
            "http://192.167.1.1:43210",
            "http://192.169.1.1:43210",
        ).forEach { raw ->
            try {
                HostAllowlist.validate(raw)
                fail("expected a refusal for $raw")
            } catch (expected: DaemonException.UnreachableHost) {
            }
        }
    }
}
```

Create `mobile/android/app/src/test/kotlin/sh/openagi/mobile/transport/DaemonClientTest.kt`:

```kotlin
package sh.openagi.mobile.transport

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

class DaemonClientTest {
    private lateinit var server: MockWebServer
    private val token = "a".repeat(43)

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    // MockWebServer binds 127.0.0.1, which the allowlist refuses on purpose.
    // Tests opt out of the allowlist explicitly rather than weakening it.
    private fun client() = DaemonClient(
        server = server.url("/").toString(),
        nodeId = "mobile:abc",
        token = token,
        enforceAllowlist = false,
    )

    private fun fixture(name: String) = File("../../fixtures/$name.json").readText()

    @Test
    fun summarySendsCredentialsAndDecodes() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"abc\"").setBody(fixture("summary-populated")))
        val result = client().summary(ifNoneMatch = null)
        val fresh = result as SummaryResponse.Fresh
        assertEquals("Ship the widget", fresh.summary.today.first().title)
        assertEquals("\"abc\"", fresh.etag)
        val request = server.takeRequest()
        assertEquals("/mobile/summary", request.path)
        assertEquals("Bearer $token", request.getHeader("Authorization"))
        assertEquals("mobile:abc", request.getHeader("X-OpenAGI-Node-ID"))
    }

    @Test
    fun notModifiedIsNotAnError() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(304))
        assertTrue(client().summary(ifNoneMatch = "\"abc\"") is SummaryResponse.Unchanged)
        assertEquals("\"abc\"", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test
    fun completeSendsCompletedViaMobile() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client().complete("task_abc")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/tasks/task_abc/complete", request.path)
        assertEquals("""{"completedVia":"mobile"}""", request.body.readUtf8())
    }

    @Test
    fun heartbeatSendsRoleNode() = runBlocking {
        // The daemon rejects a heartbeat whose role is not exactly "node" with a
        // 400. Nothing else in this suite would notice if role were dropped or
        // misspelled, and the plan's own first draft omitted it — so assert the
        // body bytes, not merely that the call succeeded.
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client().heartbeat()
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/nodes/heartbeat", request.path)
        assertEquals("""{"nodeId":"mobile:abc","role":"node"}""", request.body.readUtf8())
    }

    @Test
    fun aTransportFailureArrivesAsDaemonException() = runBlocking {
        // A dropped connection must not escape as a bare IOException, or every
        // caller that catches DaemonException misses the commonest failure there
        // is on a phone.
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START))
        try {
            client().heartbeat()
            fail("expected a transport failure")
        } catch (expected: DaemonException.Transport) {
        }
        Unit
    }

    @Test
    fun statusCodesMapToTypedErrors() = runBlocking {
        val cases = listOf(401 to DaemonException.Unauthorized::class, 404 to DaemonException.NotFound::class, 409 to DaemonException.Conflict::class)
        cases.forEach { (code, type) ->
            server.enqueue(MockResponse().setResponseCode(code))
            try {
                client().complete("task_abc")
                fail("expected a throw for $code")
            } catch (error: DaemonException) {
                assertEquals(type, error::class)
            }
        }
    }

    @Test
    fun anUnreachableHostIsRefusedBeforeAnyRequest() = runBlocking {
        val hostile = DaemonClient(server = "http://evil.example.com", nodeId = "mobile:abc", token = token)
        try {
            hostile.summary(null)
            fail("expected a refusal")
        } catch (expected: DaemonException.UnreachableHost) {
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun enrollPostsThePlatformAndCode() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("enroll-exchange")))
        val enrollment = DaemonClient.enroll(
            server = server.url("/").toString(),
            code = "004221",
            nodeId = "mobile:abc",
            nodeToken = "b".repeat(43),
            name = "iPhone",
            enforceAllowlist = false,
        )
        assertTrue(enrollment.nodeToken.isNotEmpty())
        val request = server.takeRequest()
        assertEquals("/nodes/enroll/exchange", request.path)
        assertTrue(request.body.readUtf8().contains("\"platform\":\"mobile\""))
    }
}
```

Add the coroutines test dependency to `mobile/android/app/build.gradle.kts`:

```kotlin
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Users/shooby/Dev/openAGI/mobile/android
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :app:testDebugUnitTest 2>&1 | tail -30
```

Expected: FAIL — `Unresolved reference: HostAllowlist`.

- [ ] **Step 3: Write `HostAllowlist.kt`**

```kotlin
package sh.openagi.mobile.transport

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// Cleartext is fine over WireGuard and on a home LAN, and nowhere else.
// This is the whole reason the app can ship without TLS setup, so it is
// enforced in one place and tested directly. Keep this table byte-for-byte
// in agreement with mobile/ios/Sources/Transport/HostAllowlist.swift.
object HostAllowlist {
    fun validate(raw: String): HttpUrl {
        val url = raw.toHttpUrlOrNull() ?: throw DaemonException.UnreachableHost(raw)
        // Drop any path so callers can append their own without doubling it.
        val origin = HttpUrl.Builder()
            .scheme(url.scheme)
            .host(url.host)
            .port(url.port)
            .build()
        // Loopback is refused whatever the scheme, per PROTOCOL.md §10: a phone
        // cannot reach its own loopback, so accepting one turns a pairing typo
        // into a silent hang instead of an immediate, legible refusal. This check
        // precedes the scheme branch deliberately — putting it after would let
        // https://127.0.0.1 through, which is the gap iOS shipped and had to fix.
        if (url.host.lowercase() in setOf("127.0.0.1", "localhost", "::1")) {
            throw DaemonException.UnreachableHost(url.host)
        }
        if (url.scheme == "https") return origin
        if (url.scheme != "http") throw DaemonException.UnreachableHost(raw)
        val host = url.host.lowercase()
        if (host.endsWith(".ts.net")) return origin
        if (isPrivateOrTailscale(host)) return origin
        throw DaemonException.UnreachableHost(host)
    }

    private fun isPrivateOrTailscale(host: String): Boolean {
        val parts = host.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it !in 0..255 }) return false
        val (a, b) = parts
        return when {
            a == 10 -> true
            a == 192 && b == 168 -> true
            a == 172 && b in 16..31 -> true
            a == 100 && b in 64..127 -> true // Tailscale CGNAT range
            else -> false
        }
    }
}
```

- [ ] **Step 4: Write `DaemonClient.kt`**

```kotlin
package sh.openagi.mobile.transport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import sh.openagi.mobile.protocol.Enrollment
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.ProtocolJson
import java.util.concurrent.TimeUnit

sealed class DaemonException(message: String) : Exception(message) {
    class UnreachableHost(host: String) : DaemonException("a phone cannot reach $host")
    class Unauthorized : DaemonException("the node credential was refused")
    class NotFound : DaemonException("the daemon does not know that id")
    class Conflict : DaemonException("the daemon has already moved on")
    class Server(val code: Int) : DaemonException("the daemon returned $code")
    class Malformed : DaemonException("the daemon returned something unreadable")
    // The network itself failed: no connection, a timeout, DNS, TLS. Carries the
    // cause for diagnosis, and never the token — DaemonException's message is
    // built from the host and status only.
    class Transport(val cause: java.io.IOException) : DaemonException("the daemon could not be reached: ${cause.message}")
}

sealed class SummaryResponse {
    object Unchanged : SummaryResponse()
    data class Fresh(val summary: MobileSummary, val etag: String?) : SummaryResponse()
}

class DaemonClient(
    private val server: String,
    private val nodeId: String,
    private val token: String,
    private val client: OkHttpClient = defaultClient,
    private val enforceAllowlist: Boolean = true,
) {
    suspend fun summary(ifNoneMatch: String?): SummaryResponse = withContext(Dispatchers.IO) {
        val builder = authorized("/mobile/summary").get()
        if (ifNoneMatch != null) builder.header("If-None-Match", ifNoneMatch)
        client.newCall(builder.build()).execute().use { response ->
            ensureOk(response)
            if (response.code == 304) return@withContext SummaryResponse.Unchanged
            val body = response.body?.string() ?: throw DaemonException.Malformed()
            val summary = try {
                ProtocolJson.json.decodeFromString(MobileSummary.serializer(), body)
            } catch (error: Exception) {
                throw DaemonException.Malformed()
            }
            SummaryResponse.Fresh(summary, response.header("ETag"))
        }
    }

    suspend fun complete(taskId: String) = post("/tasks/$taskId/complete", """{"completedVia":"mobile"}""")

    // role is required and must be exactly "node". The name is deliberately
    // omitted: the daemon stores the name this node enrolled with and ignores
    // anything the wire claims, so sending one could only ever disagree.
    suspend fun heartbeat() = post("/nodes/heartbeat", """{"nodeId":"$nodeId","role":"node"}""")

    suspend fun revoke() = post("/nodes/revoke", """{"nodeId":"$nodeId"}""")

    private suspend fun post(path: String, json: String) = withContext(Dispatchers.IO) {
        val request = authorized(path).post(json.toRequestBody(JSON)).build()
        // An IOException here is a dropped connection, a timeout, a DNS failure —
        // on a phone, the most likely failure of all. It must arrive as a
        // DaemonException like every other, or callers that catch DaemonException
        // miss precisely the case that happens most. iOS shipped this gap first
        // and had to add a transport case for the same reason.
        try {
            client.newCall(request).execute().use { ensureOk(it) }
        } catch (io: java.io.IOException) {
            throw DaemonException.Transport(io)
        }
        Unit
    }

    private fun authorized(path: String): Request.Builder =
        Request.Builder()
            .url(origin().newBuilder().encodedPath(path).build())
            .header("Authorization", "Bearer $token")
            .header("X-OpenAGI-Node-ID", nodeId)

    private fun origin(): HttpUrl =
        if (enforceAllowlist) HostAllowlist.validate(server)
        else server.toHttpUrlOrNull() ?: throw DaemonException.UnreachableHost(server)

    companion object {
        private val JSON = "application/json".toMediaType()

        val defaultClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .build()

        // Enrollment happens before any credential exists, so it is a companion
        // function and carries only the one-time code.
        suspend fun enroll(
            server: String,
            code: String,
            nodeId: String,
            nodeToken: String,
            name: String,
            client: OkHttpClient = defaultClient,
            enforceAllowlist: Boolean = true,
        ): Enrollment = withContext(Dispatchers.IO) {
            val origin = if (enforceAllowlist) HostAllowlist.validate(server)
            else server.toHttpUrlOrNull() ?: throw DaemonException.UnreachableHost(server)
            val body = """{"code":"$code","platform":"mobile","nodeId":"$nodeId","nodeToken":"$nodeToken","name":"$name"}"""
            val request = Request.Builder()
                .url(origin.newBuilder().encodedPath("/nodes/enroll/exchange").build())
                .post(body.toRequestBody(JSON))
                .build()
            client.newCall(request).execute().use { response ->
                when (response.code) {
                    200 -> ProtocolJson.json.decodeFromString(
                        Enrollment.serializer(),
                        response.body?.string() ?: throw DaemonException.Malformed()
                    )
                    401, 403, 429 -> throw DaemonException.Unauthorized()
                    409 -> throw DaemonException.Conflict()
                    else -> throw DaemonException.Server(response.code)
                }
            }
        }

        // Named ensureOk, not check: kotlin.check already means something else,
        // and a shadowed stdlib name is a bug waiting to be misread.
        internal fun ensureOk(response: Response) {
            when (response.code) {
                in 200..299, 304 -> Unit
                401, 403 -> throw DaemonException.Unauthorized()
                404 -> throw DaemonException.NotFound()
                409 -> throw DaemonException.Conflict()
                else -> throw DaemonException.Server(response.code)
            }
        }
    }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Same `./gradlew :app:testDebugUnitTest` command. Expected: `BUILD SUCCESSFUL`,
16 tests total.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/android
git commit -m "feat(android): add the daemon client and its cleartext host allowlist"
```

---

## Task 13: Android store — snapshot and outbound queue

The Android twin of Task 8, with one structural difference worth stating: a
Glance widget runs in the app's own process and sandbox, so there is no App
Group to arrange. `context.filesDir` is shared by construction. The store still
takes its directory as a constructor parameter, because that is what makes it a
plain JVM unit test instead of an instrumentation test.

**Files:**
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/store/SnapshotStore.kt`, `.../store/OutboundQueue.kt`
- Create: `mobile/android/app/src/test/kotlin/sh/openagi/mobile/store/SnapshotStoreTest.kt`, `.../store/OutboundQueueTest.kt`

**Interfaces:**
- Consumes: `MobileSummary`, `TaskItem`, `Counts`, `ProtocolJson` (Task 11).
- Produces:
  - `data class Snapshot(val summary: MobileSummary, val fetchedAt: Instant, val etag: String?, val locallyCompleted: Set<String>)` with `val visibleToday: List<TaskItem>`, `val visibleCounts: Counts`, `fun ageInMinutes(now: Instant = Instant.now()): Int`
  - `class SnapshotStore(directory: File)` — `fun load(): Snapshot?`, `fun save(snapshot: Snapshot)`, `fun applyOptimisticCompletion(taskId: String): Snapshot?`, `fun storeFresh(summary: MobileSummary, etag: String?, now: Instant = Instant.now()): Snapshot`
  - `data class PendingOp(val id: String, val kind: Kind, val createdAt: Instant, val attempts: Int)` with `sealed class Kind { data class CompleteTask(val taskId: String) : Kind() }`
  - `class OutboundQueue(directory: File)` — `fun all(): List<PendingOp>`, `fun enqueue(op: PendingOp)`, `fun remove(id: String)`, `fun recordAttempt(id: String)`, `companion object { const val MAX_ATTEMPTS = 5 }`

- [ ] **Step 1: Write the failing tests**

Create `mobile/android/app/src/test/kotlin/sh/openagi/mobile/store/SnapshotStoreTest.kt`:

```kotlin
package sh.openagi.mobile.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sh.openagi.mobile.protocol.Brief
import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.TaskItem
import java.io.File
import java.time.Instant

class SnapshotStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private fun summary(vararg titles: String): MobileSummary {
        val today = titles.mapIndexed { index, title ->
            TaskItem(id = "task_$index", title = title, bucket = "today", status = "pending",
                     priority = 50, dueDate = null, overdue = false)
        }
        return MobileSummary(
            generatedAt = Instant.now(),
            today = today,
            counts = Counts(today = today.size, thisWeek = 0, overdue = 0, pendingActions = 0),
            pendingActions = emptyList(),
            brief = Brief("${today.size} things today"),
        )
    }

    private fun store(): SnapshotStore = SnapshotStore(folder.root)

    @Test
    fun roundTrips() {
        assertNull(store().load())
        store().save(Snapshot(summary("A", "B"), Instant.now(), "\"x\"", emptySet()))
        val loaded = store().load()
        assertNotNull(loaded)
        assertEquals(listOf("A", "B"), loaded!!.summary.today.map { it.title })
        assertEquals("\"x\"", loaded.etag)
    }

    @Test
    fun optimisticCompletionHidesTheTaskImmediately() {
        store().save(Snapshot(summary("A", "B"), Instant.now(), null, emptySet()))
        val updated = store().applyOptimisticCompletion("task_0")!!
        assertEquals(listOf("B"), updated.visibleToday.map { it.title })
        assertEquals(1, updated.visibleCounts.today)
        // And it survives a reload, because the widget may read from a cold start.
        assertEquals(listOf("B"), store().load()!!.visibleToday.map { it.title })
    }

    @Test
    fun aFreshFetchDropsOptimisticIdsTheServerNoLongerLists() {
        store().save(Snapshot(summary("A", "B"), Instant.now(), null, emptySet()))
        store().applyOptimisticCompletion("task_0")
        // Server still lists task_0: keep hiding it, the completion is in flight.
        store().storeFresh(summary("A", "B"), null)
        assertEquals(listOf("B"), store().load()!!.visibleToday.map { it.title })
        assertEquals(setOf("task_0"), store().load()!!.locallyCompleted)
        // Server has caught up: the optimistic set must not grow forever.
        store().storeFresh(summary("B"), null)
        assertEquals(emptySet<String>(), store().load()!!.locallyCompleted)
    }

    @Test
    fun corruptFileIsTreatedAsNoSnapshotRatherThanCrashing() {
        File(folder.root, "snapshot.json").writeText("not json")
        assertNull(store().load())
    }

    @Test
    fun stalenessIsComputable() {
        val old = Instant.now().minusSeconds(900)
        store().save(Snapshot(summary("A"), old, null, emptySet()))
        assertEquals(15, store().load()!!.ageInMinutes(now = old.plusSeconds(900)))
    }
}
```

Create `mobile/android/app/src/test/kotlin/sh/openagi/mobile/store/OutboundQueueTest.kt`:

```kotlin
package sh.openagi.mobile.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OutboundQueueTest {
    @get:Rule val folder = TemporaryFolder()

    @Test
    fun enqueueAndDrain() {
        val queue = OutboundQueue(folder.root)
        assertTrue(queue.all().isEmpty())
        val op = PendingOp.completeTask("task_1")
        queue.enqueue(op)
        assertEquals(listOf(PendingOp.Kind.CompleteTask("task_1")), queue.all().map { it.kind })
        queue.remove(op.id)
        assertTrue(queue.all().isEmpty())
    }

    @Test
    fun opsSurviveAFreshProcess() {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_2"))
        assertEquals(1, OutboundQueue(folder.root).all().size)
    }

    @Test
    fun duplicateCompletionsCollapse() {
        // Two taps on the same widget row must not produce two queued POSTs.
        val queue = OutboundQueue(folder.root)
        queue.enqueue(PendingOp.completeTask("task_3"))
        queue.enqueue(PendingOp.completeTask("task_3"))
        assertEquals(1, queue.all().size)
    }

    @Test
    fun attemptsAreCountedAndCapped() {
        val queue = OutboundQueue(folder.root)
        val op = PendingOp.completeTask("task_4")
        queue.enqueue(op)
        repeat(OutboundQueue.MAX_ATTEMPTS) { queue.recordAttempt(op.id) }
        assertTrue("an op that keeps failing must eventually be dropped", queue.all().isEmpty())
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Same `./gradlew :app:testDebugUnitTest` command. Expected: FAIL —
`Unresolved reference: SnapshotStore`.

- [ ] **Step 3: Write `SnapshotStore.kt`**

```kotlin
package sh.openagi.mobile.store

import kotlinx.serialization.Serializable
import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.InstantSerializer
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.ProtocolJson
import sh.openagi.mobile.protocol.TaskItem
import java.io.File
import java.time.Instant
import kotlin.math.max

@Serializable
data class Snapshot(
    val summary: MobileSummary,
    @Serializable(with = InstantSerializer::class) val fetchedAt: Instant,
    val etag: String? = null,
    val locallyCompleted: Set<String> = emptySet(),
) {
    // What the UI and widget actually draw: the server's list minus anything
    // completed here that the server has not caught up with yet.
    val visibleToday: List<TaskItem>
        get() = summary.today.filter { it.id !in locallyCompleted }

    val visibleCounts: Counts
        get() {
            val hidden = summary.today.filter { it.id in locallyCompleted }
            return Counts(
                today = max(0, summary.counts.today - hidden.size),
                thisWeek = summary.counts.thisWeek,
                overdue = max(0, summary.counts.overdue - hidden.count { it.overdue }),
                pendingActions = summary.counts.pendingActions,
            )
        }

    fun ageInMinutes(now: Instant = Instant.now()): Int =
        max(0, ((now.epochSecond - fetchedAt.epochSecond) / 60).toInt())
}

class SnapshotStore(directory: File) {
    private val file = File(directory, "snapshot.json")

    fun load(): Snapshot? {
        if (!file.exists()) return null
        return try {
            ProtocolJson.json.decodeFromString(Snapshot.serializer(), file.readText())
        } catch (error: Exception) {
            // A half-written or stale-format file is not worth crashing a widget over.
            null
        }
    }

    fun save(snapshot: Snapshot) {
        val encoded = ProtocolJson.json.encodeToString(Snapshot.serializer(), snapshot)
        // Atomic: a widget reading mid-write must never see half a file.
        val temp = File(file.parentFile, "snapshot.json.tmp")
        temp.writeText(encoded)
        temp.renameTo(file)
    }

    fun applyOptimisticCompletion(taskId: String): Snapshot? {
        val current = load() ?: return null
        val updated = current.copy(locallyCompleted = current.locallyCompleted + taskId)
        save(updated)
        return updated
    }

    // Called after a successful fetch: keep only the optimistic ids the server
    // still lists as open, so the set cannot grow forever.
    fun storeFresh(summary: MobileSummary, etag: String?, now: Instant = Instant.now()): Snapshot {
        val previous = load()?.locallyCompleted ?: emptySet()
        val stillOpen = summary.today.map { it.id }.toSet()
        val snapshot = Snapshot(summary, now, etag, previous.intersect(stillOpen))
        save(snapshot)
        return snapshot
    }
}
```

- [ ] **Step 4: Write `OutboundQueue.kt`**

```kotlin
package sh.openagi.mobile.store

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import sh.openagi.mobile.protocol.InstantSerializer
import sh.openagi.mobile.protocol.ProtocolJson
import java.io.File
import java.time.Instant
import java.util.UUID

@Serializable
data class PendingOp(
    val id: String,
    val kind: Kind,
    @Serializable(with = InstantSerializer::class) val createdAt: Instant,
    val attempts: Int = 0,
) {
    @Serializable
    sealed class Kind {
        @Serializable
        data class CompleteTask(val taskId: String) : Kind()
    }

    companion object {
        fun completeTask(taskId: String): PendingOp =
            PendingOp(UUID.randomUUID().toString(), Kind.CompleteTask(taskId), Instant.now())
    }
}

class OutboundQueue(directory: File) {
    private val file = File(directory, "outbox.json")

    fun all(): List<PendingOp> {
        if (!file.exists()) return emptyList()
        return try {
            ProtocolJson.json.decodeFromString(ListSerializer(PendingOp.serializer()), file.readText())
        } catch (error: Exception) {
            emptyList()
        }
    }

    fun enqueue(op: PendingOp) {
        val ops = all()
        // Tapping the same row twice is one intent, not two.
        if (ops.any { it.kind == op.kind }) return
        write(ops + op)
    }

    fun remove(id: String) = write(all().filterNot { it.id == id })

    fun recordAttempt(id: String) {
        val ops = all().toMutableList()
        val index = ops.indexOfFirst { it.id == id }
        if (index < 0) return
        val bumped = ops[index].copy(attempts = ops[index].attempts + 1)
        // An op that has failed this many times is not going to start working.
        // Dropping it is better than a queue that retries forever on every
        // background wake.
        if (bumped.attempts >= MAX_ATTEMPTS) ops.removeAt(index) else ops[index] = bumped
        write(ops)
    }

    private fun write(ops: List<PendingOp>) {
        val encoded = ProtocolJson.json.encodeToString(ListSerializer(PendingOp.serializer()), ops)
        val temp = File(file.parentFile, "outbox.json.tmp")
        temp.writeText(encoded)
        temp.renameTo(file)
    }

    companion object {
        const val MAX_ATTEMPTS = 5
    }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Same `./gradlew :app:testDebugUnitTest` command. Expected: `BUILD SUCCESSFUL`,
25 tests total.

- [ ] **Step 6: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/android
git commit -m "feat(android): add the snapshot store and offline outbound queue"
```

---

## Task 14: Android pairing, credentials, and refresh

The Android twin of Task 9. The credential goes in `EncryptedSharedPreferences`
(AES-256-GCM under a Keystore master key), the refresh loop is a
`CoroutineWorker` on a 15-minute `PeriodicWorkRequest` — WorkManager's floor, and
the honest ceiling on widget freshness without push.

**Files:**
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/store/Credentials.kt`
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/sync/RefreshCoordinator.kt`, `.../sync/RefreshWorker.kt`
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/ui/PairingScreen.kt`, `.../ui/TodayScreen.kt`, `.../ui/SettingsScreen.kt`
- Modify: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/MainActivity.kt`
- Modify: `mobile/android/app/build.gradle.kts` (WorkManager, security-crypto, Glance-free for now)
- Create: `mobile/android/app/src/test/kotlin/sh/openagi/mobile/sync/RefreshCoordinatorTest.kt`

**Interfaces:**
- Consumes: `DaemonClient`, `SummaryResponse`, `DaemonException` (Task 12); `SnapshotStore`, `OutboundQueue`, `PendingOp` (Task 13).
- Produces:
  - `class Credentials(val server: String, val nodeId: String, val token: String)` with `companion object { fun load(context: Context): Credentials?; fun save(context: Context, credentials: Credentials); fun clear(context: Context) }`
  - `class RefreshCoordinator(client: DaemonClient, store: SnapshotStore, queue: OutboundQueue)` — `suspend fun refresh(): RefreshOutcome`, `suspend fun drainQueue()`
  - `sealed class RefreshOutcome { data class Updated(val snapshot: Snapshot); object Unchanged; object Unauthorized; object Offline }`
  - `object MobileNodeIdentity { fun newNodeId(): String; fun newToken(): String }`

- [ ] **Step 1: Write the failing test**

Create `mobile/android/app/src/test/kotlin/sh/openagi/mobile/sync/RefreshCoordinatorTest.kt`,
with `MockWebServer` from Task 12 and `TemporaryFolder` from Task 13, covering:

```kotlin
package sh.openagi.mobile.sync

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import java.io.File

class RefreshCoordinatorTest {
    @get:Rule val folder = TemporaryFolder()
    private lateinit var server: MockWebServer

    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { server.shutdown() }

    private fun fixture(name: String) = File("../../fixtures/$name.json").readText()

    private fun coordinator(): RefreshCoordinator {
        val client = DaemonClient(server.url("/").toString(), "mobile:abc", "a".repeat(43), enforceAllowlist = false)
        return RefreshCoordinator(client, SnapshotStore(folder.root), OutboundQueue(folder.root))
    }

    @Test
    fun refreshWritesTheSnapshotAndReturnsUpdated() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"e1\"").setBody(fixture("summary-populated")))
        val outcome = coordinator().refresh()
        assertTrue(outcome is RefreshOutcome.Updated)
        assertEquals(2, SnapshotStore(folder.root).load()!!.summary.today.size)
        assertEquals("\"e1\"", SnapshotStore(folder.root).load()!!.etag)
    }

    @Test
    fun unchangedLeavesTheExistingSnapshotAlone() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("ETag", "\"e1\"").setBody(fixture("summary-populated")))
        coordinator().refresh()
        server.enqueue(MockResponse().setResponseCode(304))
        assertTrue(coordinator().refresh() is RefreshOutcome.Unchanged)
        val snapshot = SnapshotStore(folder.root).load()!!
        assertEquals(2, snapshot.summary.today.size)
        // The conditional request must have carried the stored ETag.
        server.takeRequest()
        assertEquals("\"e1\"", server.takeRequest().getHeader("If-None-Match"))
    }

    @Test
    fun drainSendsQueuedCompletionsBeforeFetching() = runBlocking {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_0"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        coordinator().refresh()
        assertTrue(OutboundQueue(folder.root).all().isEmpty())
        // Order matters: send what the user already did, then ask what is true.
        assertEquals("/tasks/task_0/complete", server.takeRequest().path)
        assertEquals("/mobile/summary", server.takeRequest().path)
    }

    @Test
    fun a404DuringDrainRetiresTheOpRatherThanRetrying() = runBlocking {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_gone"))
        server.enqueue(MockResponse().setResponseCode(404))
        coordinator().drainQueue()
        assertTrue(OutboundQueue(folder.root).all().isEmpty())
    }

    @Test
    fun aTransportFailureDuringDrainKeepsTheOpAndCountsAnAttempt() = runBlocking {
        OutboundQueue(folder.root).enqueue(PendingOp.completeTask("task_1"))
        server.enqueue(MockResponse().setResponseCode(500))
        coordinator().drainQueue()
        assertEquals(1, OutboundQueue(folder.root).all().single().attempts)
    }

    @Test
    fun anUnauthorizedRefreshKeepsTheCachedSnapshot() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture("summary-populated")))
        coordinator().refresh()
        server.enqueue(MockResponse().setResponseCode(401))
        assertTrue(coordinator().refresh() is RefreshOutcome.Unauthorized)
        // The user must still see their tasks while they re-pair.
        assertNotNull(SnapshotStore(folder.root).load())
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Same `./gradlew :app:testDebugUnitTest` command. Expected: FAIL —
`Unresolved reference: RefreshCoordinator`.

- [ ] **Step 3: Add the remaining dependencies**

In `mobile/android/app/build.gradle.kts` add:

```kotlin
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)
```

- [ ] **Step 4: Write `Credentials.kt`**

```kotlin
package sh.openagi.mobile.store

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

// The node token is the whole security boundary of this app. It lives in
// EncryptedSharedPreferences under a Keystore-held master key, never in the
// snapshot file, and never in logs.
data class Credentials(val server: String, val nodeId: String, val token: String) {
    companion object {
        private const val FILE = "sh.openagi.mobile.credentials"

        private fun prefs(context: Context) = EncryptedSharedPreferences.create(
            context,
            FILE,
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

        fun load(context: Context): Credentials? {
            val store = prefs(context)
            val server = store.getString("server", null) ?: return null
            val nodeId = store.getString("nodeId", null) ?: return null
            val token = store.getString("token", null) ?: return null
            return Credentials(server, nodeId, token)
        }

        fun save(context: Context, credentials: Credentials) {
            prefs(context).edit()
                .putString("server", credentials.server)
                .putString("nodeId", credentials.nodeId)
                .putString("token", credentials.token)
                .apply()
        }

        fun clear(context: Context) {
            prefs(context).edit().clear().apply()
        }
    }
}

object MobileNodeIdentity {
    fun newNodeId(): String = "mobile:" + UUID.randomUUID().toString()

    // 32 random bytes, base64url, unpadded — 43 characters, matching the token
    // shape the daemon's NodeRegistry issues and hashes.
    fun newToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
```

- [ ] **Step 5: Write `RefreshCoordinator.kt`**

```kotlin
package sh.openagi.mobile.sync

import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.Snapshot
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import sh.openagi.mobile.transport.DaemonException
import sh.openagi.mobile.transport.SummaryResponse
import java.time.Instant

sealed class RefreshOutcome {
    data class Updated(val snapshot: Snapshot) : RefreshOutcome()
    object Unchanged : RefreshOutcome()
    object Unauthorized : RefreshOutcome()
    object Offline : RefreshOutcome()
}

class RefreshCoordinator(
    private val client: DaemonClient,
    private val store: SnapshotStore,
    private val queue: OutboundQueue,
) {
    // Order matters: send what the user already did before asking what is true,
    // or a refresh will hand back the state their tap was meant to change.
    suspend fun refresh(): RefreshOutcome {
        drainQueue()
        return try {
            when (val response = client.summary(store.load()?.etag)) {
                is SummaryResponse.Unchanged -> {
                    store.load()?.let { store.save(it.copy(fetchedAt = Instant.now())) }
                    RefreshOutcome.Unchanged
                }
                is SummaryResponse.Fresh ->
                    RefreshOutcome.Updated(store.storeFresh(response.summary, response.etag))
            }
        } catch (error: DaemonException.Unauthorized) {
            RefreshOutcome.Unauthorized
        } catch (error: Exception) {
            RefreshOutcome.Offline
        }
    }

    suspend fun drainQueue() {
        queue.all().forEach { op ->
            when (val kind = op.kind) {
                is PendingOp.Kind.CompleteTask -> try {
                    client.complete(kind.taskId)
                    queue.remove(op.id)
                } catch (error: DaemonException.NotFound) {
                    // The server has already moved on. Replaying cannot help.
                    queue.remove(op.id)
                } catch (error: DaemonException.Conflict) {
                    queue.remove(op.id)
                } catch (error: Exception) {
                    queue.recordAttempt(op.id)
                }
            }
        }
    }
}
```

- [ ] **Step 6: Write `RefreshWorker.kt`**

```kotlin
package sh.openagi.mobile.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import sh.openagi.mobile.store.Credentials
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.transport.DaemonClient
import java.util.concurrent.TimeUnit

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val credentials = Credentials.load(applicationContext) ?: return Result.success()
        val coordinator = RefreshCoordinator(
            DaemonClient(credentials.server, credentials.nodeId, credentials.token),
            SnapshotStore(applicationContext.filesDir),
            OutboundQueue(applicationContext.filesDir),
        )
        coordinator.refresh()
        // Task 15 adds the TodayWidget().updateAll(applicationContext) call here,
        // once the widget and the Glance dependency exist. There is nothing to
        // repaint until then, and a forward reference would not compile.
        // An offline phone is the normal case off the tailnet, not a failure
        // worth exponential backoff on a 15-minute schedule, so every outcome
        // is success.
        return Result.success()
    }

    companion object {
        private const val NAME = "openagi-refresh"

        // 15 minutes is WorkManager's floor. Without a push channel this is the
        // honest ceiling on widget freshness, and the widget says so on screen.
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
        }
    }
}
```

- [ ] **Step 7: Write the three screens and wire up `MainActivity`**

`PairingScreen` takes a server URL and a six-digit code (prefilled from the
`openagi://pair` intent when the app was launched that way), calls
`MobileNodeIdentity.newNodeId()` and `newToken()`, calls `DaemonClient.enroll`,
saves `Credentials`, calls `RefreshWorker.schedule`, and triggers the first
refresh. Failures render the `DaemonException` message verbatim — the host
allowlist's message already tells the user exactly what to change.

`TodayScreen` renders `SnapshotStore(filesDir).load()?.visibleToday` with a
completion button per row that calls `applyOptimisticCompletion`, enqueues
`PendingOp.completeTask(id)`, and kicks `RefreshCoordinator.drainQueue()`. (Task
15 adds the widget repaint here too; the widget does not exist yet.) It shows
the staleness line
("updated 14m ago" / "can't reach OpenAGI") from `Snapshot.ageInMinutes()`.

`SettingsScreen` shows the paired server and node id, a Refresh button, and a
Revoke button that calls `client.revoke()`, `Credentials.clear(context)`,
`RefreshWorker.cancel(context)`, and deletes the snapshot file.

`MainActivity` chooses `PairingScreen` or `TodayScreen` based on
`Credentials.load(this)`, reads `intent?.data` through `PairingPayload.from` to
prefill pairing, and refreshes in `onResume`.

- [ ] **Step 8: Run the tests and watch them pass**

Same `./gradlew :app:testDebugUnitTest` command. Expected: `BUILD SUCCESSFUL`,
31 tests total.

- [ ] **Step 9: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/android
git commit -m "feat(android): pair, store credentials encrypted, and refresh on a worker"
```

---

## Task 15: The Android widget

The Glance twin of Task 10. Same division of labour: the worker owns refresh,
the widget owns rendering, and the widget never performs network I/O.

**Files:**
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/widget/TodayWidget.kt`, `.../widget/TodayWidgetReceiver.kt`, `.../widget/WidgetState.kt`, `.../widget/CompleteTaskAction.kt`
- Create: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/sync/DrainWorker.kt`
- Create: `mobile/android/app/src/main/res/xml/today_widget_info.xml`, `mobile/android/app/src/main/res/values/strings.xml`
- Modify: `mobile/android/app/src/main/AndroidManifest.xml` (the receiver)
- Modify: `mobile/android/app/build.gradle.kts` (Glance)
- Modify: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/sync/RefreshWorker.kt` (add the `TodayWidget().updateAll(applicationContext)` call Task 14 deliberately left out)
- Modify: `mobile/android/app/src/main/kotlin/sh/openagi/mobile/ui/TodayScreen.kt` (repaint the widget after an optimistic completion)
- Create: `mobile/android/app/src/test/kotlin/sh/openagi/mobile/widget/WidgetStateTest.kt`

**Interfaces:**
- Consumes: `SnapshotStore`, `OutboundQueue` (Task 13), `Credentials` (Task 14).
- Produces: `sealed class WidgetState { object Unpaired; data class Empty(val headline: String); data class Tasks(val items: List<TaskItem>, val counts: Counts, val ageMinutes: Int); data class Stale(val ageMinutes: Int) }` and `object WidgetState.Companion { fun from(snapshot: Snapshot?, paired: Boolean, now: Instant): WidgetState }`.

- [ ] **Step 1: Write the failing test**

Create `mobile/android/app/src/test/kotlin/sh/openagi/mobile/widget/WidgetStateTest.kt`.
This is the part worth testing, because it is where a stale widget silently lies:

```kotlin
package sh.openagi.mobile.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.Brief
import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.MobileSummary
import sh.openagi.mobile.protocol.TaskItem
import sh.openagi.mobile.store.Snapshot
import java.time.Instant

class WidgetStateTest {
    private val now: Instant = Instant.parse("2026-09-19T12:00:00Z")

    private fun snapshot(titles: List<String>, minutesAgo: Long, completed: Set<String> = emptySet()): Snapshot {
        val today = titles.mapIndexed { index, title ->
            TaskItem("task_$index", title, "today", "pending", 50, null, false)
        }
        return Snapshot(
            summary = MobileSummary(
                generatedAt = now.minusSeconds(minutesAgo * 60),
                today = today,
                counts = Counts(today.size, 0, 0, 0),
                pendingActions = emptyList(),
                brief = Brief("${today.size} things today"),
            ),
            fetchedAt = now.minusSeconds(minutesAgo * 60),
            etag = null,
            locallyCompleted = completed,
        )
    }

    @Test
    fun noCredentialsMeansUnpaired() {
        assertEquals(WidgetState.Unpaired, WidgetState.from(snapshot(listOf("A"), 1), paired = false, now = now))
    }

    @Test
    fun pairedWithNoSnapshotMeansEmpty() {
        val state = WidgetState.from(null, paired = true, now = now)
        assertTrue(state is WidgetState.Empty)
        assertTrue((state as WidgetState.Empty).headline.isNotEmpty())
    }

    @Test
    fun freshSnapshotRendersTasksWithTheirAge() {
        val state = WidgetState.from(snapshot(listOf("A", "B"), 3), paired = true, now = now) as WidgetState.Tasks
        assertEquals(listOf("A", "B"), state.items.map { it.title })
        assertEquals(3, state.ageMinutes)
    }

    @Test
    fun pastAnHourTheWidgetSaysItIsStaleRatherThanLying() {
        // Past an hour the widget must say so rather than present old rows as current.
        val state = WidgetState.from(snapshot(listOf("A", "B"), 61), paired = true, now = now)
        assertEquals(WidgetState.Stale(61), state)
    }

    @Test
    fun anOptimisticallyCompletedOnlyTaskLeavesTheWidgetEmpty() {
        val state = WidgetState.from(snapshot(listOf("A"), 2, completed = setOf("task_0")), paired = true, now = now)
        assertTrue(state is WidgetState.Empty)
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Same `./gradlew :app:testDebugUnitTest` command. Expected: FAIL —
`Unresolved reference: WidgetState`.

- [ ] **Step 3: Add Glance and the receiver**

In `mobile/android/app/build.gradle.kts`:

```kotlin
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)
```

Create `mobile/android/app/src/main/res/xml/today_widget_info.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="180dp"
    android:minHeight="110dp"
    android:targetCellWidth="4"
    android:targetCellHeight="2"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen"
    android:updatePeriodMillis="0"
    android:description="@string/widget_description" />
```

Add to `mobile/android/app/src/main/res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">OpenAGI</string>
    <string name="widget_description">Today from OpenAGI, with one-tap completion.</string>
</resources>
```

Add the receiver inside `<application>` in the manifest:

```xml
        <receiver
            android:name=".widget.TodayWidgetReceiver"
            android:exported="false">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="android.appwidget.provider"
                android:resource="@xml/today_widget_info" />
        </receiver>
```

- [ ] **Step 4: Write `WidgetState.kt`**

```kotlin
package sh.openagi.mobile.widget

import sh.openagi.mobile.protocol.Counts
import sh.openagi.mobile.protocol.TaskItem
import sh.openagi.mobile.store.Snapshot
import java.time.Instant

sealed class WidgetState {
    object Unpaired : WidgetState()
    data class Empty(val headline: String) : WidgetState()
    data class Tasks(val items: List<TaskItem>, val counts: Counts, val ageMinutes: Int) : WidgetState()
    data class Stale(val ageMinutes: Int) : WidgetState()

    companion object {
        // Past this, old rows stop being information and start being a lie.
        const val STALE_AFTER_MINUTES = 60

        fun from(snapshot: Snapshot?, paired: Boolean, now: Instant = Instant.now()): WidgetState {
            if (!paired) return Unpaired
            if (snapshot == null) return Empty("Open OpenAGI to sync")
            val age = snapshot.ageInMinutes(now)
            if (age > STALE_AFTER_MINUTES) return Stale(age)
            val visible = snapshot.visibleToday
            if (visible.isEmpty()) return Empty(snapshot.summary.brief.headline.ifEmpty { "Nothing due today" })
            return Tasks(visible, snapshot.visibleCounts, age)
        }
    }
}
```

- [ ] **Step 5: Write the widget, receiver, and action**

`TodayWidget` is a `GlanceAppWidget` whose `provideGlance` reads
`SnapshotStore(context.filesDir).load()` and `Credentials.load(context) != null`,
builds a `WidgetState`, and renders it. It performs no network I/O. Each state:

- `Unpaired` — one line, "Pair this phone", tapping opens `MainActivity`.
- `Empty` — the headline and the age line.
- `Tasks` — up to three rows, each a title plus a check button whose
  `actionRunCallback<CompleteTaskAction>` carries the task id in
  `actionParametersOf(CompleteTaskAction.taskIdKey to item.id)`; below them the
  count line ("2 today, 1 overdue") and the age line.
- `Stale` — "Last synced Nm ago — tap to refresh", in the warning colour.

`TodayWidgetReceiver` is `class TodayWidgetReceiver : GlanceAppWidgetReceiver() { override val glanceAppWidget = TodayWidget() }`.

`CompleteTaskAction` is:

```kotlin
package sh.openagi.mobile.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import sh.openagi.mobile.store.OutboundQueue
import sh.openagi.mobile.store.PendingOp
import sh.openagi.mobile.store.SnapshotStore
import sh.openagi.mobile.sync.DrainWorker

class CompleteTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val taskId = parameters[taskIdKey] ?: return
        // Hide it now, send it when we can. A tap that visibly does nothing for
        // fifteen minutes is worse than no widget at all.
        SnapshotStore(context.filesDir).applyOptimisticCompletion(taskId)
        OutboundQueue(context.filesDir).enqueue(PendingOp.completeTask(taskId))
        TodayWidget().updateAll(context)
        WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<DrainWorker>().build())
    }

    companion object {
        val taskIdKey = ActionParameters.Key<String>("taskId")
    }
}
```

Create `mobile/android/app/src/main/kotlin/sh/openagi/mobile/sync/DrainWorker.kt` —
a `CoroutineWorker` that builds a `RefreshCoordinator` exactly as `RefreshWorker`
does, calls only `drainQueue()`, calls `TodayWidget().updateAll`, and returns
`Result.success()`.

- [ ] **Step 6: Run the tests and watch them pass**

Same `./gradlew :app:testDebugUnitTest` command. Expected: `BUILD SUCCESSFUL`,
36 tests total.

- [ ] **Step 7: Build the APK and check it by hand**

```bash
cd /Users/shooby/Dev/openAGI/mobile/android
ANDROID_HOME="$HOME/Library/Android/sdk" \
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ./gradlew :app:assembleDebug 2>&1 | tail -10
```

Then, with an emulator or device running, install and confirm: the unpaired
widget renders; after pairing against a real tailnet-bound daemon the today rows
appear; tapping a row's check removes it immediately and `openagi tasks` on the
desktop shows it `completed`.

- [ ] **Step 8: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/android
git commit -m "feat(android): add the glance today widget with in-place completion"
```

---

## Task 16: End-to-end pass and documentation

Phase 1 is done when a real phone, over a real tailnet, completes a real task
from the home screen and the desktop agrees. Everything up to here was
individually tested; this task is the one that proves the pieces meet.

**Files:**
- Create: `mobile/README.md`
- Modify: `docs/superpowers/specs/2026-09-19-openagi-mobile-apps-design.md` (mark Phase 1 shipped, record what changed from the design)
- Modify: `README.md` (one line pointing at `mobile/`)

**Interfaces:**
- Consumes: everything from Tasks 1–15.
- Produces: no code. A written record of how to run it, and a verified claim.

- [ ] **Step 1: Bind the daemon somewhere a phone can reach it**

```bash
cd /Users/shooby/Dev/openAGI
export OPENAGI_AUTH_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
echo "token: $OPENAGI_AUTH_TOKEN"
OPENAGI_BIND=0.0.0.0 node bin/openagi.js start
```

Find the tailnet address with `tailscale ip -4` or the MagicDNS name with
`tailscale status --json | node -e '…'`. The bind-safety check in
`src/boot.js:136` refuses a non-loopback bind without a token — that is the
check working, not a bug to route around.

- [ ] **Step 2: Run the whole Node test suite**

```bash
cd /Users/shooby/Dev/openAGI && npm test 2>&1 | tail -20
```

Expected: PASS, including the five new files from Tasks 1–5 and no regressions
in the existing 141.

- [ ] **Step 3: Pair the iPhone and complete a task from the home screen**

```bash
cd /Users/shooby/Dev/openAGI
node bin/openagi.js pair-phone --platform ios --url http://<tailnet-host>:43210
```

Enter the server and code in the app. Add the widget. Then, on the desktop:

```bash
node bin/openagi.js task add "Widget end-to-end check" --bucket today
```

Within one refresh (or immediately, by opening the app) the row appears on the
phone. Tap its check. Confirm on the desktop:

```bash
node bin/openagi.js tasks --bucket done | head
```

Expected: the task is `completed`, and its `completedVia` is `mobile`.

- [ ] **Step 4: Repeat Step 3 for Android**

```bash
node bin/openagi.js pair-phone --platform android --url http://<tailnet-host>:43210
```

Same assertions. Both phones now appear in `node bin/openagi.js nodes` with
platform `mobile` and a recent heartbeat.

- [ ] **Step 5: Prove the authority boundary on real hardware**

With the phone's node token (readable from the daemon side via
`~/.openagi/nodes.json` only as a hash — instead, capture the token printed at
enrollment, or re-pair a throwaway node):

```bash
NODE_TOKEN=<token> NODE_ID=<id> bash -c '
for path in /memory /skills /computer-use/log; do
  printf "%s -> " "$path"
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer $NODE_TOKEN" \
    -H "X-OpenAGI-Node-ID: $NODE_ID" \
    "http://<tailnet-host>:43210$path"
done'
```

Expected: `401` for all three. A phone credential that can read memory is a
Phase 1 failure, not a Phase 2 improvement.

- [ ] **Step 6: Prove the offline path**

Turn Tailscale off on the phone. Tap a task's check in the widget. Expected: the
row disappears immediately. Turn Tailscale back on, open the app. Expected: the
completion lands and the desktop agrees. This is the queue from Tasks 8 and 13
doing its only job.

- [ ] **Step 7: Write `mobile/README.md`**

It must contain, in this order: what Phase 1 ships; the exact
`openagi pair-phone` command; the reachability rule in one sentence with the
three allowed host families; the iOS build command (`xcodegen generate` plus the
`DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild` line);
the Android build command (the `ANDROID_HOME`/`JAVA_HOME` `./gradlew` line); the
15-minute refresh floor stated plainly as a limitation; and a pointer to
`mobile/PROTOCOL.md` and `mobile/fixtures/` as the contract between the two
clients.

- [ ] **Step 8: Update the spec and the root README**

In the design spec, mark Phase 1 shipped and record the one deliberate
divergence: the QR code was dropped from `pair-phone` in favour of manual entry
of a server and a six-digit code, because a hand-rolled QR encoder was not worth
several hundred lines against a two-field, once-per-phone flow.

In the root `README.md`, add one line under the existing feature list pointing at
`mobile/README.md`.

- [ ] **Step 9: Commit**

```bash
cd /Users/shooby/Dev/openAGI
git add mobile/README.md README.md docs/superpowers/specs/2026-09-19-openagi-mobile-apps-design.md
git commit -m "docs: record the phase 1 mobile end-to-end pass and how to run it"
```

---
