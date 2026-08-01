import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Consent copy has to match the code. These three files are what a user reads
// BEFORE granting Screen Recording, so a claim here that the runtime doesn't
// keep isn't a doc bug — it's consent obtained on a false statement.
//
// The facts these assertions encode (verified against the code):
//   - CaptureSettings.isExcluded(bundleId:windowTitle:) matches an app bundle
//     id list and a window-title regex list. It takes no URL. There is no
//     domain/"banking site" concept anywhere in the codebase.
//   - Window titles come from AXUIElementCopyAttributeValue behind
//     AXIsProcessTrusted() (ScreenCapturer.frontmostWindowTitle), so every
//     title-based rule silently no-ops without Accessibility.
//   - Raw frames/thumbnails never leave the Mac: CaptureBridge.unpushedBatch
//     pushes app/window/OCR text only, no image bytes.
//   - OCR text + window titles DO reach the configured model provider:
//     agent-host.js turnContextForAgent splices up to 6 snippets (with window
//     titles) into every non-cron chat turn, and proactive-observer.js /
//     pattern-miner.js do the same unattended on a cron.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = "README.md";
const PANEL = "mac/Sources/OpenAGI/PrivacyPanel.swift";
const SCOPE = "docs/scope/ambient-capture.md";
const CONSENT_FILES = [README, PANEL, SCOPE];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// A "banking site" cannot be excluded — isExcluded never sees a URL. Any line
// that mentions banking must be saying so, not promising the opposite.
const NEGATION = /\bnot\b|\bno\b|\bnever\b|isn'?t|aren'?t|cannot|can'?t|doesn'?t/i;

test("consent copy never claims URL- or domain-aware capture exclusion", () => {
  for (const rel of CONSENT_FILES) {
    const lines = read(rel).split("\n");
    lines.forEach((line, i) => {
      if (!/banking/i.test(line)) return;
      assert.ok(
        NEGATION.test(line),
        `${rel}:${i + 1} promises banking-site exclusion, but CaptureSettings.isExcluded ` +
          `takes only (bundleId, windowTitle) — there is no URL or domain concept in the code:\n  ${line.trim()}`
      );
    });
  }
});

test("consent copy carries no falsified locality guarantee", () => {
  const forbidden = [
    [README, "banking sites, 2FA screens, and private windows are never read"],
    [README, "No cloud sync — capture stays local"],
    [README, "Your data never leaves"],
    [PANEL, "Everything stays on this Mac"],
    [PANEL, "Excluded apps are never captured"],
    [SCOPE, "Capture data NEVER leaves the machine without explicit user opt-in"],
    [SCOPE, "All capture stays local on disk"]
  ];
  for (const [rel, phrase] of forbidden) {
    assert.ok(
      !read(rel).includes(phrase),
      `${rel} still claims "${phrase}" — OCR text and window titles are sent to the ` +
        `configured model provider (src/agent-host.js, src/proactive-observer.js).`
    );
  }
});

test("consent copy discloses that OCR text and window titles reach the model provider", () => {
  for (const rel of CONSENT_FILES) {
    const body = read(rel);
    assert.match(
      body,
      /model provider/i,
      `${rel} never tells the user their OCR text goes to a model provider, but ` +
        `src/agent-host.js splices OCR snippets + window titles into chat turns.`
    );
    assert.match(
      body,
      /window title/i,
      `${rel} must say window titles travel with the OCR text — turnContextForAgent ` +
        `formats each snippet as "app · window".`
    );
  }
});

test("consent copy distinguishes frames from text", () => {
  // The whole misunderstanding: images stay, text travels. Both halves must be
  // stated, or "on-device OCR" reads as "nothing leaves".
  const framesStayHome =
    /(raw frames|frames and thumbnails|frames, thumbnails|screenshots themselves)[^.\n]*\b(never|not|aren't)\b[^.\n]*\b(sent|uploaded|leave|leaves|travel)\b/i;
  for (const rel of CONSENT_FILES) {
    assert.match(
      read(rel),
      framesStayHome,
      `${rel} must state that the images themselves stay on the Mac, distinctly from ` +
        `the OCR text that does not (CaptureBridge pushes app/window/text only).`
    );
  }
});

test("consent copy describes the exclusion list as bundle ids + window titles", () => {
  for (const rel of CONSENT_FILES) {
    const body = read(rel);
    assert.match(
      body,
      /bundle[ -]id/i,
      `${rel} must describe the exclusion list the user can actually inspect and edit: ` +
        `excludedBundleIds + excludedWindowPatterns in CaptureSettings.swift.`
    );
  }
  // Title rules run through AXIsProcessTrusted(); without Accessibility the
  // window title is nil and every title pattern silently misses.
  for (const rel of [README, PANEL]) {
    assert.match(
      read(rel),
      /Accessibility/,
      `${rel} must say window-title rules need Accessibility — ScreenCapturer.frontmostWindowTitle ` +
        `returns nil without it, so the patterns never match.`
    );
  }
});
