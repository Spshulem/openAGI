import test from "node:test";
import assert from "node:assert/strict";
import { applyPaseoSessionSettings, readPaseoSessionSettings, summarizePaseoSettings } from "../src/fleet/paseo-settings.js";
import { createFleetRoute } from "../src/fleet/routes.js";

const CONFIG = { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } };

function makeFactory({ status = "idle", pendingPermissions = [], mutate = true, wrongId = false, mutationApi = true } = {}) {
  const state = {
    id: "agent-1",
    provider: "codex",
    cwd: "/workspace/project",
    model: "gpt-6-sol",
    thinkingOptionId: "medium",
    effectiveThinkingOptionId: "medium",
    status,
    activeTurn: status === "running" ? { turnId: "turn-1", startedAt: "2026-11-21T01:00:00Z" } : null,
    pendingPermissions,
    updatedAt: "2026-11-21T01:00:00Z",
    features: [{ type: "select", id: "permission_mode", label: "Permission mode", value: "ask", options: [
      { id: "ask", label: "Ask before tools" },
      { id: "full", label: "Full access" }
    ] }]
  };
  const calls = [];
  const ref = {
    current: () => state,
    refresh: async () => ({ agent: wrongId ? { ...state, id: "agent-other" } : state }),
    applyConfig: undefined
  };
  const api = {
    hosts: { list: async () => ({ self: { serverId: "host-1" }, hosts: [] }) },
    providers: {
      snapshot: async () => ({ entries: [{ provider: "codex", status: "ready", models: [{
        id: "gpt-6-sol", label: "GPT-6 Sol", thinkingOptions: [
          { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }
        ]
      }, { id: "gpt-6-luna", label: "GPT-6 Luna", thinkingOptions: [{ id: "low", label: "Low" }] }] }] })
    },
    agents: {
      ref: () => ref,
      ...(mutationApi ? { applyConfig: async (_agentId, patch) => {
        calls.push(["applyConfig", patch]);
        if (!mutate) return;
        if (patch.modelId) state.model = patch.modelId;
        if (patch.thinkingOptionId) state.effectiveThinkingOptionId = state.thinkingOptionId = patch.thinkingOptionId;
        const permission = patch.featureValues?.permission_mode;
        if (permission) state.features[0].value = permission;
        state.updatedAt = "2026-11-21T01:01:00Z";
      } } : {})
    },
    connect: async () => {},
    close: async () => {}
  };
  return { factory: () => api, calls, state };
}

async function readSettings(fake) {
  return readPaseoSessionSettings(CONFIG, { serverId: "host-1", agentId: "agent-1", factory: fake.factory });
}

test("Paseo settings read exposes authoritative values and supported provider choices", async () => {
  const fake = makeFactory();
  const result = await readSettings(fake);
  assert.equal(result.ok, true);
  assert.equal(result.settings.current.model, "gpt-6-sol");
  assert.equal(result.settings.current.reasoningEffort, "medium");
  assert.equal(result.settings.current.permissions, "ask");
  assert.deepEqual(result.settings.supported.model.map((item) => item.id), ["gpt-6-sol", "gpt-6-luna"]);
  assert.deepEqual(result.settings.supported.reasoningEffort.map((item) => item.id), ["low", "medium", "high"]);
  assert.equal(result.settings.status, "ready");
});

test("settings require an explicit owner confirmation", async () => {
  const fake = makeFactory();
  const result = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1", body: { model: "gpt-6-luna" }, factory: fake.factory
  });
  assert.equal(result.status, "unauthorized");
  assert.deepEqual(fake.calls, []);
});

test("unsupported choices are rejected from the fresh host catalog", async () => {
  const fake = makeFactory();
  const result = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1", body: { confirmed: true, model: "gpt-9" }, factory: fake.factory
  });
  assert.equal(result.status, "unsupported");
  assert.deepEqual(fake.calls, []);
});

test("busy and pending sessions refuse settings without touching permission cards", async () => {
  const busy = makeFactory({ status: "running" });
  const busyResult = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1", body: { confirmed: true, model: "gpt-6-luna" }, factory: busy.factory
  });
  assert.equal(busyResult.status, "busy");
  assert.deepEqual(busy.calls, []);

  const pending = makeFactory({ pendingPermissions: [{ id: "perm-1", kind: "tool" }] });
  const pendingResult = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1", body: { confirmed: true, permissions: "full" }, factory: pending.factory
  });
  assert.equal(pendingResult.status, "pending");
  assert.match(pendingResult.detail, /cannot clear or approve/i);
  assert.deepEqual(pending.calls, []);
});

test("wrong and stale targets are rejected before mutation", async () => {
  const wrong = makeFactory({ wrongId: true });
  const wrongResult = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1", body: { confirmed: true, model: "gpt-6-luna" }, factory: wrong.factory
  });
  assert.equal(wrongResult.status, "wrong-target");
  assert.deepEqual(wrong.calls, []);

  const stale = makeFactory();
  const read = await readSettings(stale);
  stale.state.updatedAt = "2026-11-21T01:02:00Z";
  const staleResult = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1",
    body: { confirmed: true, targetFingerprint: read.settings.targetFingerprint, model: "gpt-6-luna" },
    factory: stale.factory
  });
  assert.equal(staleResult.status, "stale-target");
  assert.deepEqual(stale.calls, []);
});

test("a supported owner change is read back on the exact session", async () => {
  const fake = makeFactory();
  const read = await readSettings(fake);
  const result = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1",
    body: { confirmed: true, targetFingerprint: read.settings.targetFingerprint, model: "gpt-6-luna", reasoningEffort: "low", permissions: "full" },
    factory: fake.factory
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  assert.equal(result.settings.current.model, "gpt-6-luna");
  assert.equal(result.settings.current.reasoningEffort, "low");
  assert.equal(result.settings.current.permissions, "full");
  assert.equal(fake.calls.length, 1);
});

test("readback mismatch never reports optimistic success", async () => {
  const fake = makeFactory({ mutate: false });
  const read = await readSettings(fake);
  const result = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1",
    body: { confirmed: true, targetFingerprint: read.settings.targetFingerprint, model: "gpt-6-luna" },
    factory: fake.factory
  });
  assert.equal(result.status, "unconfirmed");
});

test("a host without a safe mutation API reports unavailable instead of using a prompt or reload", async () => {
  const fake = makeFactory({ mutationApi: false });
  const read = await readSettings(fake);
  const result = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1",
    body: { confirmed: true, targetFingerprint: read.settings.targetFingerprint, model: "gpt-6-luna" },
    factory: fake.factory
  });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /safe per-session settings mutation API/i);
  assert.deepEqual(fake.calls, []);
});

test("new Paseo provider controls use exact option readback for permissions", async () => {
  const state = {
    id: "agent-1", provider: "codex", cwd: "/workspace/project", model: "gpt-6-sol",
    thinkingOptionId: "medium", effectiveThinkingOptionId: "medium", status: "idle",
    pendingPermissions: [], updatedAt: "2026-11-21T01:00:00Z",
    options: { approval_mode: "ask" },
    controls: [{ type: "select", key: "approval_mode", label: "Permission mode", choices: [
      { value: "ask", label: "Ask before tools" }, { value: "full", label: "Full access" }
    ] }]
  };
  const calls = [];
  const ref = {
    current: () => state,
    refresh: async () => ({ agent: state }),
    setOptions: async (patch) => { calls.push(patch); Object.assign(state.options, patch); }
  };
  const factory = () => ({
    hosts: { list: async () => ({ self: { serverId: "host-1" }, hosts: [] }) },
    providers: { snapshot: async () => ({ entries: [] }) },
    agents: { ref: () => ref }, connect: async () => {}, close: async () => {}
  });
  const read = await readPaseoSessionSettings(CONFIG, { serverId: "host-1", agentId: "agent-1", factory });
  assert.equal(read.settings.current.permissions, "ask");
  assert.equal(read.settings.unavailable.model, "This Paseo host does not expose a safe per-session model mutation API.");
  const result = await applyPaseoSessionSettings(CONFIG, {
    serverId: "host-1", agentId: "agent-1",
    body: { confirmed: true, targetFingerprint: read.settings.targetFingerprint, permissions: "full" }, factory
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ approval_mode: "full" }]);
  assert.equal(result.settings.current.permissions, "full");
});

test("fleet route exposes GET and owner-confirmed POST settings without approval routes", async () => {
  const calls = [];
  const supervisor = {
    paseoSessionSettings: async () => ({ ok: true, settings: { current: { model: "x" } } }),
    updatePaseoSessionSettings: async (_key, body) => { calls.push(body); return { ok: true, settings: { current: { model: body.model } }, detail: "next turn" }; },
    getState: () => ({})
  };
  const route = createFleetRoute({ supervisor });
  const read = await route("GET", "/fleet/api/threads/paseo%3Ahost-1.agent-1/settings", new URL("http://localhost"), async () => ({}));
  assert.equal(read.status, 200);
  const denied = await route("POST", "/fleet/api/threads/paseo%3Ahost-1.agent-1/settings", new URL("http://localhost"), async () => ({ model: "x" }));
  assert.equal(denied.status, 403);
  const applied = await route("POST", "/fleet/api/threads/paseo%3Ahost-1.agent-1/settings", new URL("http://localhost"), async () => ({ confirmed: true, model: "x" }));
  assert.equal(applied.status, 200);
  assert.equal(calls.length, 1);
});

test("summarizePaseoSettings marks provider controls unavailable instead of inventing choices", () => {
  const settings = summarizePaseoSettings({ id: "a", provider: "unknown", model: null, status: "idle", pendingPermissions: [], updatedAt: "x" }, { serverId: "h" });
  assert.equal(settings.status, "ready");
  assert.match(settings.unavailable.model, /did not expose/i);
  assert.match(settings.unavailable.permissions, /did not expose/i);
});
