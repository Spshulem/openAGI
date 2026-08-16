import assert from "node:assert/strict";
import test from "node:test";
import {
  IMESSAGE_SEARCH_CAPABILITY,
  createImessageNodeCapability,
  normalizeImessageSearchArgs
} from "../src/integrations/imessage-node-capability.js";

const enabledEnv = () => ({ OPENAGI_IMESSAGE_SEARCH: "1", IMESSAGE_DB_PATH: "/not/read/in/tests/chat.db" });

test("iMessage node search is explicitly opt-in and disabled state does no I/O", async () => {
  let probes = 0;
  let searches = 0;
  const provider = createImessageNodeCapability({
    env: {},
    readinessProbe: async () => { probes += 1; },
    search: async () => { searches += 1; return []; },
    now: () => Date.parse("2026-08-14T12:00:00.000Z")
  });

  const health = await provider.health();
  assert.equal(provider.id, IMESSAGE_SEARCH_CAPABILITY);
  assert.equal(health.ok, false);
  assert.deepEqual(health.capability, {
    id: "imessage-search",
    ready: false,
    operations: [],
    detail: "disabled",
    checkedAt: "2026-08-14T12:00:00.000Z"
  });
  await assert.rejects(() => provider.invoke("search", {}), /imessage-search-disabled/);
  assert.equal(probes, 0);
  assert.equal(searches, 0);
});

test("readiness is categorical and never returns paths or raw errors", async () => {
  const cases = [
    [Object.assign(new Error("private path was denied"), { code: "EACCES" }), "full-disk-access-required"],
    [Object.assign(new Error("missing"), { code: "ENOENT" }), "database-unavailable"],
    [Object.assign(new Error("No such built-in module: node:sqlite"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" }), "sqlite-unavailable"],
    [new Error("secret raw database failure at /Users/example/Library/Messages/chat.db"), "database-unavailable"]
  ];

  for (const [failure, expected] of cases) {
    const provider = createImessageNodeCapability({
      env: enabledEnv(),
      readinessProbe: async () => { throw failure; }
    });
    const health = await provider.health();
    assert.equal(health.capability.ready, false);
    assert.deepEqual(health.capability.operations, []);
    assert.equal(health.capability.detail, expected);
    assert.equal(JSON.stringify(health).includes(failure.message), false);
    assert.equal(JSON.stringify(health).includes("/Users/"), false);
  }

  const ready = createImessageNodeCapability({ env: enabledEnv(), readinessProbe: async () => {} });
  const health = await ready.health();
  assert.equal(health.ok, true);
  assert.equal(health.capability.ready, true);
  assert.deepEqual(health.capability.operations, ["search"]);
  assert.equal(health.capability.detail, "ready");
});

test("search request validation is strict, bounded, and maps person to the read-only primitive", async () => {
  const calls = [];
  const provider = createImessageNodeCapability({
    env: enabledEnv(),
    readinessProbe: async () => {},
    search: async (dbPath, args) => { calls.push({ dbPath, args }); return []; }
  });

  const result = await provider.invoke("search", { query: "dinner", person: "sarah@example.com", days: 7, limit: 12 });
  assert.deepEqual(result, { count: 0, results: [], truncated: false });
  assert.deepEqual(calls, [{
    dbPath: "/not/read/in/tests/chat.db",
    args: { query: "dinner", handle: "sarah@example.com", days: 7, limit: 12 }
  }]);

  const invalid = [
    null,
    [],
    { query: 42 },
    { person: {} },
    { query: "x", handle: "not-part-of-the-contract" },
    { query: "x", extra: true },
    { query: "x".repeat(2049) },
    { person: "p".repeat(321) },
    { days: 0 },
    { days: 1.5 },
    { days: 3651 },
    { limit: 0 },
    { limit: 1.5 },
    { limit: 101 }
  ];
  for (const payload of invalid) {
    await assert.rejects(() => provider.invoke("search", payload), /invalid-search-request/);
  }
  assert.throws(() => normalizeImessageSearchArgs(JSON.parse('{"__proto__":"x"}')), /unsupported field/);
});

test("only the exact capability operation can execute", async () => {
  let searches = 0;
  const provider = createImessageNodeCapability({
    env: enabledEnv(),
    readinessProbe: async () => {},
    search: async () => { searches += 1; return []; }
  });

  for (const operation of ["SEARCH", "search.messages", "computer-use", "__proto__", ""]) {
    await assert.rejects(() => provider.invoke(operation, {}), /unsupported-node-operation/);
  }
  assert.equal(searches, 0);
  await provider.invoke("search", {});
  assert.equal(searches, 1);
});

test("results are field-filtered, per-message clipped, and bounded to about one MiB", async () => {
  const huge = "🙂private\u0000".repeat(2000);
  const rows = Array.from({ length: 100 }, (_, index) => ({
    rowid: index + 1,
    handle: `person-${index}@example.com`,
    fromMe: index % 2 === 0,
    date: "2026-08-14T12:00:00.000Z",
    text: huge,
    internal: "must-not-cross-the-node-boundary"
  }));
  const provider = createImessageNodeCapability({
    env: enabledEnv(),
    readinessProbe: async () => {},
    search: async () => rows,
    maxResultBytes: 8 * 1024,
    maxMessageTextBytes: 2 * 1024
  });

  const result = await provider.invoke("search", { limit: 100 });
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 8 * 1024);
  assert.equal(result.truncated, true);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.length < rows.length);
  assert.ok(result.results.every((row) => Buffer.byteLength(row.text, "utf8") <= 2 * 1024));
  assert.ok(result.results.every((row) => Object.keys(row).sort().join(",") === "date,fromMe,handle,text"));
  assert.equal(serialized.includes("rowid"), false);
  assert.equal(serialized.includes("internal"), false);
  assert.equal(serialized.includes("must-not-cross"), false);

  const defaultBound = createImessageNodeCapability({
    env: enabledEnv(),
    readinessProbe: async () => {},
    search: async () => rows
  });
  const defaultResult = await defaultBound.invoke("search", { limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(defaultResult), "utf8") <= 1024 * 1024);
  assert.equal(defaultResult.truncated, true);
});

test("search failures cross the node boundary only as categorical errors", async () => {
  const provider = createImessageNodeCapability({
    env: enabledEnv(),
    readinessProbe: async () => {},
    search: async () => { throw new Error("raw secret path /Users/example/Library/Messages/chat.db"); }
  });

  await assert.rejects(
    () => provider.invoke("search", { query: "x" }),
    (error) => error.code === "database-unavailable" && !error.message.includes("/Users/")
  );
});
