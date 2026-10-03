import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAllSuggestions, resolveSuggestion } from "../src/suggestion-feed.js";

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "suggestion-cache-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, extra = {}) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, status: "pending", title: id, proposedAt: "2026-10-03T00:00:00.000Z", ...extra }));
  return { runtime: { dataDir }, dir, write };
}

test("listing suggestions reads each unchanged file once, then only what changed", (t) => {
  const { runtime, dir, write } = setup(t);
  for (let i = 0; i < 20; i += 1) write(`sug_${i}`);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => { if (String(args[0]).startsWith(dir)) reads += 1; return read(...args); };
  t.after(() => { fs.readFileSync = read; });
  assert.equal(listAllSuggestions(runtime).length, 20);
  const first = reads;
  assert.ok(first >= 20);
  assert.equal(listAllSuggestions(runtime).length, 20);
  assert.equal(reads, first, "nothing read again");
  // A resolved suggestion is re-read and leaves the pending list.
  resolveSuggestion(runtime, "sug_3", "dismissed");
  const pending = listAllSuggestions(runtime);
  assert.equal(pending.length, 19);
  assert.equal(pending.some((s) => s.id === "sug_3"), false);
  // A removed file leaves; a new one appears.
  fs.rmSync(path.join(dir, "sug_4.json"));
  write("sug_new");
  const ids = listAllSuggestions(runtime).map((s) => s.id);
  assert.equal(ids.includes("sug_4"), false);
  assert.equal(ids.includes("sug_new"), true);
  // What callers get back is theirs to change, nested fields included.
  write("sug_nested", { sequence: { steps: ["a"] } });
  const mine = listAllSuggestions(runtime).find((s) => s.id === "sug_nested");
  const title = mine.title;
  mine.title = "changed";
  mine.sequence.steps.push("b");
  const again = listAllSuggestions(runtime).find((s) => s.id === "sug_nested");
  assert.equal(again.title, title);
  assert.deepEqual(again.sequence.steps, ["a"]);
});

test("a filesystem fault while listing is raised, not shown as no suggestions", (t) => {
  const { runtime, write } = setup(t);
  write("sug_1");
  const stat = fs.statSync;
  fs.statSync = (file, ...rest) => {
    if (String(file).endsWith("sug_1.json")) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    return stat(file, ...rest);
  };
  t.after(() => { fs.statSync = stat; });
  assert.throws(() => listAllSuggestions(runtime), /too many open files/);
});
