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
