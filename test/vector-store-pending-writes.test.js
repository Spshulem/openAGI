import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../src/vector-store.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-vector-writes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const vectors = new VectorStore({ dir, embedder: { embed: () => new Promise((resolve, reject) => {
    requests.push({ resolve, reject });
  }) } });
  return { vectors, requests };
}

test("a deleted pending write cannot overwrite an explicit replacement or another namespace", async t => {
  const { vectors, requests } = fixture(t);
  const old = vectors.upsert("principle", "note", "Obsolete advice");
  const peer = vectors.upsert("specialist", "note", "Unrelated scope");
  assert.equal(vectors.delete("principle", "note"), false);
  const fresh = vectors.upsert("principle", "note", "Current advice");
  requests[2].resolve([1, 0]);
  await fresh;
  requests[0].resolve([0, 1]);
  assert.equal(await old, null);
  requests[1].resolve([1, 1]);
  await peer;
  assert.equal(vectors.list("principle")[0].text, "Current advice");
  assert.equal(vectors.list("specialist")[0].text, "Unrelated scope");
  assert.equal(vectors.pendingWrites.size, 0);
});

test("overlapping embeddings preserve the newest write and release completed tracking", async t => {
  const { vectors, requests } = fixture(t);
  const old = vectors.upsert("principle", "note", "Old");
  const fresh = vectors.upsert("principle", "note", "New");
  requests[0].resolve([0, 1]);
  assert.equal(await old, null);
  assert.equal(vectors.pendingWrites.size, 1, "old completion cannot cancel its successor");
  requests[1].resolve([1, 0]);
  await fresh;
  assert.equal(vectors.list("principle")[0].text, "New");
  assert.equal(vectors.pendingWrites.size, 0);
  const failed = vectors.upsert("principle", "error", "Unavailable embedding");
  requests[2].reject(new Error("Embedding unavailable"));
  assert.deepEqual(await failed, { error: "Embedding unavailable" });
  assert.equal(vectors.pendingWrites.size, 0);
  assert.equal(vectors.list("principle").length, 1);
});
