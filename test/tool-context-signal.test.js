import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, DeterministicModelProvider } from "../src/index.js";

class ProbeProvider extends DeterministicModelProvider {
  async generate({ toolRegistry, context }) {
    const result = await toolRegistry.invoke("probe_context", {}, context);
    return { provider: "probe", model: "probe", text: "done", toolCalls: [{ name: "probe_context", ok: Boolean(result?.ok) }] };
  }
}

test("tool handlers receive the turn's signal id and scrutiny result", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-tool-signal-"));
  const runtime = createDurableRuntime({
    dataDir, modelProvider: new ProbeProvider(), registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false
  });
  let seen = null;
  runtime.tools.register({
    name: "probe_context",
    description: "Test probe that records the context it was called with.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    sideEffects: false,
    handler: async (_args, context) => { seen = context; return { ok: true }; }
  });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "please look over my notes for the launch" });
  assert.ok(seen, "probe tool was called");
  const outcome = runtime.outcomes.recent(10).find((o) => o.kind === "agent-reply");
  assert.ok(outcome, "turn recorded an outcome");
  assert.equal(seen.__signal.id, outcome.signalId);
  assert.equal(seen.__signal.scrutinyAction, outcome.scrutinyAction);
  assert.equal(typeof seen.__signal.scrutinyScore, "number");
  assert.deepEqual(Object.keys(seen.__signal.scrutinyDimensions).sort(),
    ["company", "environment", "evidence", "memory", "novelty", "repetition", "risk", "uncertainty"]);
  assert.equal(seen.__signal.specialistId, null);
});
