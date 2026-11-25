import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { iosUiScope } from "../scripts/ios-ui-scope.mjs";

test("a change only to the embedded daemon's JavaScript, tests or docs skips the UI suites", () => {
  for (const paths of [
    ["src/fleet/supervisor.js", "test/fleet-supervisor.test.js"],
    ["src/fleet/github-throttle.js", "src/fleet/tools.js", "docs/RELEASE.md"],
    ["bin/mobile-entry.mjs"],
    ["examples/skills/reminders/SKILL.md", "README.md"],
    // The workflow's own exclusions, when they come with a daemon change.
    ["src/fleet/supervisor.js", "mobile/android/app/build.gradle", ".github/workflows/mobile-android.yml", "mobile/ios/README.md"]
  ]) {
    const scope = iosUiScope(paths);
    assert.equal(scope.ui, false, paths.join(","));
    assert.match(scope.reason, /build and unit tests still run/);
  }
});

test("any iOS, shared-package, relay, workflow or unknown path runs every UI suite", () => {
  for (const extra of [
    "mobile/ios/Sources/App/ChatView.swift",
    "mobile/ios/UITests/NativeNavigationTests.swift",
    "mobile/ios/project.yml",
    "mobile/ios/scripts/embed-daemon.sh",
    "shared/SupervisorChannelsKit/Sources/Channel.swift",
    "package.json",
    "package-lock.json",
    "relay/src/relay.js",
    ".github/workflows/mobile-ios.yml",
    "scripts/ios-ui-scope.mjs",
    "Dockerfile"
  ]) {
    const scope = iosUiScope(["src/fleet/supervisor.js", extra]);
    assert.equal(scope.ui, true, extra);
    assert.match(scope.reason, new RegExp(extra.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("an empty or unreadable diff runs every suite", () => {
  assert.equal(iosUiScope([]).ui, true);
  assert.equal(iosUiScope(["", "  "]).ui, true);
});

test("the iOS workflow gates only the UI suites on the scope, never the build or unit tests", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/mobile-ios.yml", import.meta.url), "utf8");
  const step = (name) => {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, name);
    const next = workflow.indexOf("\n      - ", start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };
  assert.match(step("Decide which iOS suites this change needs"), /node scripts\/ios-ui-scope\.mjs/);
  assert.match(step("Test expanded workspace navigation"), /if: steps\.scope\.outputs\.ui == 'true'/);
  assert.match(step("Test native iPhone navigation and controls"), /if: steps\.scope\.outputs\.ui == 'true'/);
  for (const always of ["Build device app for local signing and QA", "Build and test iOS app", "Verify simulator runtime was bundled"]) {
    assert.doesNotMatch(step(always), /^\s*if: steps\.scope/m, always);
  }
  // Inside the combined step the unit tests run unconditionally; only the
  // two UI invocations sit behind UI_SUITES.
  const combined = step("Build and test iOS app");
  const unit = combined.indexOf("-only-testing:OpenAGITests");
  assert.notEqual(unit, -1);
  const before = combined.slice(0, unit);
  const lastUiBlock = before.lastIndexOf('if [ "$UI_SUITES" = "true" ]; then');
  assert.notEqual(lastUiBlock, -1);
  assert.notEqual(before.indexOf("\n          fi\n", lastUiBlock), -1, "the unit tests are not inside a UI_SUITES block");
  assert.equal((combined.match(/if \[ "\$UI_SUITES" = "true" \]; then/g) ?? []).length, 2);
  // A manual run never skips.
  assert.match(step("Decide which iOS suites this change needs"), /not a pull request merge; running every suite/);
});
