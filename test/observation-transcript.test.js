// test/observation-transcript.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../src/observation-store.js";

test("records and searches a transcript observation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-tx-"));
  const store = new ObservationStore({ dir });
  await store.record({
    kind: "transcript",
    at: "2026-06-01T10:00:00.000Z",
    app: "BuildBetter",
    window: "Acme <> Us — Discovery",
    text: "We agreed to send the security questionnaire by Friday.",
    ref: "buildbetter:call:42"
  });
  const results = await store.search({ query: "security questionnaire", limit: 5 });
  assert.equal(results.length, 1);
  assert.match(results[0].text ?? results[0].snippet ?? "", /security questionnaire/);

  // Durable dedup lookup used by the BuildBetter transcript sync.
  assert.equal(await store.existsRef("buildbetter:call:42"), true);
  assert.equal(await store.existsRef("buildbetter:call:999"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("search caps long transcript text but keeps the match snippet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cap-"));
  const store = new ObservationStore({ dir });
  const longText = "intro. " + "alpha ".repeat(400) + "the secret passphrase is xyzzy. " + "omega ".repeat(400);
  await store.record({
    kind: "transcript", at: "2026-06-01T10:00:00.000Z", app: "BuildBetter",
    window: "Long call", text: longText, ref: "buildbetter:call:77"
  });
  const results = await store.search({ query: "passphrase", limit: 5 });
  assert.equal(results.length, 1);
  // text is capped (not the full multi-KB transcript) and marked truncated
  assert.ok(results[0].text.length <= 1001, `expected capped text, got ${results[0].text.length}`);
  assert.ok(results[0].text.endsWith("…"), "capped text should end with an ellipsis");
  fs.rmSync(dir, { recursive: true, force: true });
});
