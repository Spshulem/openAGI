import assert from "node:assert/strict";
import test from "node:test";
import { editSimilarity } from "../src/learning/edit-similarity.js";

test("word-level edit similarity", () => {
  assert.equal(editSimilarity("a b c d", "a b c d"), 1);
  assert.equal(editSimilarity("a b c d", "a b x d"), 0.75);
  assert.equal(editSimilarity("", "a b"), 0);
  assert.equal(editSimilarity("", ""), 1);
  const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
  const sameStart = long.split(" ").slice(0, 2000).concat(Array.from({ length: 1000 }, () => "zz")).join(" ");
  assert.equal(editSimilarity(long, sameStart), 1);
});
