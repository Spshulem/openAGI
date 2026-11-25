#!/usr/bin/env node
// Decides whether a pull request needs the iOS UI suites (the long,
// simulator-bound part of the iOS job) or only the build and unit tests.
//
// The UI suites launch the app with --ui-testing, which renders UITestRoot:
// its transport answers every request with synthetic responses and never
// starts the embedded daemon (mobile/ios/Sources/App/UITestSupport.swift).
// So a change to the daemon's JavaScript, which the app embeds and the unit
// tests boot (EmbeddedDaemonIntegrationTests), cannot change a UI suite's
// result. Those changes still get the device build and every unit test.
//
// Anything else, including any path this list does not name, runs the UI
// suites too: an unknown path is never assumed safe.
//
// Usage: changed paths, one per line, on stdin. Prints `ui=true|false` and
// `reason=...` for $GITHUB_OUTPUT.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Paths that cannot reach a UI suite: the embedded daemon's code (exercised
// by the unit tests instead), and files the app never contains.
const UI_UNRELATED = [
  /^src\//,
  /^bin\/mobile-entry\.mjs$/,
  /^examples\/skills\//,
  /^test\//,
  /^docs\//,
  /^[^/]+\.md$/,
  // The same exclusions as the workflow's paths filter: no iOS target
  // bundles the Android app, its workflow, or the mobile docs.
  /^mobile\/android\//,
  /^\.github\/workflows\/mobile-android\.yml$/,
  /^mobile\/(?:[^/]+\/)*[^/]+\.md$/
];

export function iosUiScope(paths) {
  const changed = paths.map((p) => String(p).trim()).filter(Boolean);
  if (changed.length === 0) return { ui: true, reason: "no changed paths known; running every suite" };
  const needsUi = changed.filter((p) => !UI_UNRELATED.some((rule) => rule.test(p)));
  if (needsUi.length) return { ui: true, reason: `UI-relevant change: ${needsUi.slice(0, 3).join(", ")}${needsUi.length > 3 ? ` +${needsUi.length - 3} more` : ""}` };
  return { ui: false, reason: `only changes the UI suites cannot observe: embedded-daemon JavaScript, tests, docs or Android (${changed.length} file${changed.length === 1 ? "" : "s"}); build and unit tests still run` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { ui, reason } = iosUiScope(readFileSync(0, "utf8").split("\n"));
  process.stdout.write(`ui=${ui}\nreason=${reason}\n`);
}
