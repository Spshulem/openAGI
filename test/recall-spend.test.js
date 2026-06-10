// test/recall-spend.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { CreditLedger } from "../src/credit-ledger.js";

test("recall_spend summarizes the ledger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });
  ledger.record({ usd: 0.10, channel: "autopilot", model: "claude-opus-4-7", tools: ["web_search"] });
  ledger.record({ usd: 0.02, channel: "chat", model: "gpt-5", tools: [] });
  const registry = new ToolRegistry();
  registerCoreTools(registry, { budget: { ledger } });
  const { result } = await registry.invoke("recall_spend", { days: 30 });
  assert.ok(result.totalUsd >= 0.12 - 1e-9);
  assert.equal(result.byActivity[0].activity, "autopilot");
  assert.ok(Array.isArray(result.top));
  assert.equal(result.top[0].activity, "autopilot"); // costliest first
});
