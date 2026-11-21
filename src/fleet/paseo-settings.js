// Owner-controlled, per-agent Paseo settings. This module deliberately keeps
// settings separate from permission-card answers: changing a setting never
// resolves, clears, or approves a pending request.
import { clampText, parsePaseoThreadKey } from "./contracts.js";
import { hostApi, withPaseo } from "./sources/paseo.js";

const SETTING_NAMES = new Set(["model", "reasoningEffort", "permissions"]);
const PERMISSION_WORDS = /permission|approval|sandbox|tool.?policy/i;
const BUSY_STATUSES = new Set(["running", "initializing"]);

function clean(value, max = 160) {
  const text = String(value ?? "").trim();
  return text ? clampText(text, max) : null;
}

function choice(id, label, extra = {}) {
  const value = clean(id, 160);
  if (!value) return null;
  return { id: value, label: clean(label, 160) || value, ...extra };
}

function providerFamily(provider) {
  const raw = String(provider ?? "");
  return raw.includes("/") ? raw.slice(0, raw.indexOf("/")) : raw;
}

function providerModelCatalog(snapshot, provider) {
  const family = providerFamily(provider).toLowerCase();
  const entry = (snapshot?.entries ?? []).find((item) => String(item?.provider ?? "").toLowerCase() === family);
  return Array.isArray(entry?.models) ? entry.models : [];
}

function findPermissionFeature(agent) {
  const controls = Array.isArray(agent?.controls) ? agent.controls : [];
  const optionControl = controls.find((item) => item?.type === "select" && PERMISSION_WORDS.test(`${item.key} ${item.label}`));
  if (optionControl) return {
    id: clean(optionControl.key),
    label: clean(optionControl.label),
    value: clean(agent?.options?.[optionControl.key]),
    options: (optionControl.choices ?? []).map((item) => choice(item?.value, item?.label, item?.description ? { description: clean(item.description, 240) } : {})).filter(Boolean),
    write: "options"
  };
  const features = Array.isArray(agent?.features) ? agent.features : [];
  const feature = features.find((item) => item?.type === "select" && PERMISSION_WORDS.test(`${item.id} ${item.label}`));
  if (feature) return {
    id: clean(feature.id),
    label: clean(feature.label),
    value: clean(feature.value),
    options: (feature.options ?? []).map((item) => choice(item?.id, item?.label, item?.description ? { description: clean(item.description, 240) } : {})).filter(Boolean),
    write: "feature"
  };
  return null;
}

function settingsFingerprint(agent) {
  return [
    agent?.id,
    agent?.updatedAt,
    agent?.status,
    agent?.activeTurn?.turnId ?? null,
    agent?.model ?? null,
    agent?.effectiveThinkingOptionId ?? agent?.thinkingOptionId ?? null,
    agent?.features ?? agent?.controls ?? null,
    agent?.options ?? null
  ].map((value) => JSON.stringify(value)).join("|");
}

function providerChoices(snapshot, agent) {
  const models = providerModelCatalog(snapshot, agent?.provider);
  const current = clean(agent?.model);
  const modelChoices = models.map((item) => choice(item?.id, item?.label, {
    ...(item?.isSelectable === false ? { selectable: false } : {})
  })).filter(Boolean);
  if (current && !modelChoices.some((item) => item.id === current)) modelChoices.unshift(choice(current, current, { selectable: false }));
  const selected = models.find((item) => String(item?.id) === current) ?? null;
  const effortOptions = (selected?.thinkingOptions ?? []).map((item) => choice(item?.id, item?.label, item?.description ? { description: clean(item.description, 240) } : {})).filter(Boolean);
  const currentEffort = clean(agent?.effectiveThinkingOptionId ?? agent?.thinkingOptionId);
  if (currentEffort && !effortOptions.some((item) => item.id === currentEffort)) effortOptions.unshift(choice(currentEffort, currentEffort, { selectable: false }));
  return { modelChoices, effortOptions };
}

export function summarizePaseoSettings(agent, { serverId, providerSnapshot = null, mutation = null } = {}) {
  const permission = findPermissionFeature(agent);
  const { modelChoices, effortOptions } = providerChoices(providerSnapshot, agent);
  const busy = Boolean(agent?.activeTurn) || BUSY_STATUSES.has(agent?.status);
  const pending = Array.isArray(agent?.pendingPermissions) && agent.pendingPermissions.length > 0;
  const supported = {
    model: modelChoices,
    reasoningEffort: effortOptions,
    permissions: permission?.options ?? []
  };
  const current = {
    model: clean(agent?.model),
    reasoningEffort: clean(agent?.effectiveThinkingOptionId ?? agent?.thinkingOptionId),
    permissions: permission?.value ?? null
  };
  const unavailable = {};
  if (!modelChoices.length) unavailable.model = "The Paseo host did not expose selectable models for this provider.";
  if (!effortOptions.length) unavailable.reasoningEffort = "This provider/model did not expose reasoning-effort choices.";
  if (!permission) unavailable.permissions = "This provider did not expose a per-session permission control.";
  if (mutation) {
    if (!mutation.model) unavailable.model ??= "This Paseo host does not expose a safe per-session model mutation API.";
    if (!mutation.reasoningEffort) unavailable.reasoningEffort ??= "This Paseo host does not expose a safe per-session reasoning-effort mutation API.";
    if (!mutation.permissions) unavailable.permissions ??= "This Paseo host does not expose a safe per-session permission mutation API.";
  }
  return {
    status: pending ? "pending" : busy ? "busy" : "ready",
    provider: clean(agent?.provider),
    serverId: clean(serverId),
    agentId: clean(agent?.id),
    updatedAt: agent?.updatedAt ?? null,
    targetFingerprint: settingsFingerprint(agent),
    authoritative: true,
    current,
    supported,
    unavailable,
    pendingPermissionCount: Array.isArray(agent?.pendingPermissions) ? agent.pendingPermissions.length : 0,
    activeTurn: agent?.activeTurn ? { turnId: clean(agent.activeTurn.turnId), startedAt: agent.activeTurn.startedAt ?? null } : null,
    takesEffect: busy ? "Changes are available after the active turn finishes; no restart is performed." : "The next turn uses the confirmed settings."
  };
}

function requestedPatch(body) {
  const patch = {};
  if (!body || typeof body !== "object") return patch;
  for (const name of SETTING_NAMES) {
    if (Object.prototype.hasOwnProperty.call(body, name)) patch[name] = typeof body[name] === "string" ? body[name].trim() : body[name];
  }
  return patch;
}

function validatePatch(patch, settings) {
  const errors = [];
  for (const [name, value] of Object.entries(patch)) {
    if (typeof value !== "string" || !value) { errors.push(`${name} must be a non-empty supported choice.`); continue; }
    const choices = settings.supported?.[name] ?? [];
    if (!choices.some((item) => item.id === value && item.selectable !== false)) errors.push(`${name} is not supported by this Paseo host/provider.`);
  }
  return errors;
}

async function refreshedTarget(api, agentId) {
  const ref = api?.agents?.ref?.(agentId);
  if (!ref || typeof ref.refresh !== "function") return { ref, agent: ref?.current?.() ?? null };
  const result = await ref.refresh();
  return { ref, agent: result?.agent ?? ref.current?.() ?? null };
}

async function readWithApi(api, serverId, agentId) {
  const { ref, agent } = await refreshedTarget(api, agentId);
  if (!agent || String(agent.id) !== String(agentId)) return { ok: false, status: "wrong-target", detail: "Paseo returned a different session than requested." };
  let providerSnapshot = null;
  try {
    providerSnapshot = await api?.providers?.snapshot?.({ cwd: agent.cwd });
    if ((!providerSnapshot || !Array.isArray(providerSnapshot.entries) || providerSnapshot.entries.length === 0)
      && typeof api?.providers?.waitForReady === "function") providerSnapshot = await api.providers.waitForReady({ cwd: agent.cwd, timeoutMs: 8000 });
    if ((!providerSnapshot || !Array.isArray(providerSnapshot.entries) || providerSnapshot.entries.length === 0)
      && typeof api?.providers?.listModels === "function") {
      const models = await api.providers.listModels(providerFamily(agent.provider), { cwd: agent.cwd });
      providerSnapshot = { entries: [{ provider: providerFamily(agent.provider), models: models?.models ?? models?.entries ?? [] }] };
    }
  } catch { /* choices remain explicitly unavailable */ }
  const atomic = typeof ref?.applyConfig === "function"
    || typeof api?.agents?.applyConfig === "function"
    || typeof api?.applyAgentConfig === "function";
  const mutation = {
    model: atomic || typeof ref?.setModel === "function" || typeof api?.agents?.setModel === "function" || typeof api?.setAgentModel === "function",
    reasoningEffort: atomic || typeof ref?.setThinkingOption === "function" || typeof api?.agents?.setThinkingOption === "function" || typeof api?.setAgentThinkingOption === "function",
    permissions: atomic || typeof ref?.setFeature === "function" || typeof api?.agents?.setFeature === "function" || typeof api?.setAgentFeature === "function" || typeof ref?.setOptions === "function"
  };
  return { ok: true, ref, agent, settings: summarizePaseoSettings(agent, { serverId, providerSnapshot, mutation }) };
}

export async function readPaseoSessionSettings(config, { serverId, agentId, factory } = {}) {
  if (!config?.paseo?.enabled) return { ok: false, status: "unavailable", detail: "Paseo is not configured." };
  if (!serverId || !agentId) return { ok: false, status: "wrong-target", detail: "Choose one exact Paseo session." };
  return withPaseo(config, async (client) => {
    const api = await hostApi(client, serverId);
    return readWithApi(api, serverId, agentId);
  }, factory);
}

async function invokeMutation(api, ref, agentId, patch, permissionFeatureId) {
  // Prefer one host-supported atomic operation. There is deliberately no
  // prompt, reload, approval-card click, or other compatibility workaround.
  const config = {
    ...(patch.model !== undefined ? { modelId: patch.model } : {}),
    ...(patch.reasoningEffort !== undefined ? { thinkingOptionId: patch.reasoningEffort } : {}),
    ...(patch.permissions !== undefined ? { featureValues: { [permissionFeatureId]: patch.permissions } } : {})
  };
  const atomic = ref?.applyConfig ?? api?.agents?.applyConfig ?? api?.applyAgentConfig;
  if (typeof atomic === "function") {
    if (ref?.applyConfig === atomic) await atomic.call(ref, config);
    else await atomic.call(api?.agents?.applyConfig === atomic ? api.agents : api, agentId, config);
    return;
  }
  // Paseo 0.16+ exposes provider controls through the handle's options API.
  // It cannot change the session model or reasoning level, so refuse a mixed
  // patch instead of partially applying it and claiming success.
  if (typeof ref?.setOptions === "function") {
    if (patch.model !== undefined || patch.reasoningEffort !== undefined) {
      throw new Error("This Paseo client exposes provider controls only; model and reasoning changes are unavailable for this host.");
    }
    if (patch.permissions !== undefined && permissionFeatureId) {
      await ref.setOptions({ [permissionFeatureId]: patch.permissions });
      return;
    }
  }
  const operations = [];
  const add = (refFn, apiFn, rootFn, refArgs, apiArgs, rootArgs) => {
    if (typeof refFn === "function") operations.push([ref, refFn, refArgs]);
    else if (typeof apiFn === "function") operations.push([api.agents, apiFn, apiArgs]);
    else if (typeof rootFn === "function") operations.push([api, rootFn, rootArgs]);
    else operations.push([null, null, []]);
  };
  if (patch.model !== undefined) add(ref?.setModel, api?.agents?.setModel, api?.setAgentModel,
    [patch.model], [agentId, patch.model], [agentId, patch.model]);
  if (patch.reasoningEffort !== undefined) add(ref?.setThinkingOption, api?.agents?.setThinkingOption, api?.setAgentThinkingOption,
    [patch.reasoningEffort], [agentId, patch.reasoningEffort], [agentId, patch.reasoningEffort]);
  if (patch.permissions !== undefined) add(ref?.setFeature, api?.agents?.setFeature, api?.setAgentFeature,
    [permissionFeatureId, patch.permissions], [agentId, permissionFeatureId, patch.permissions], [agentId, permissionFeatureId, patch.permissions]);
  if (operations.some(([owner, fn]) => !owner || typeof fn !== "function")) throw new Error("This Paseo host does not expose a safe per-session settings mutation API.");
  for (const [owner, fn, args] of operations) await fn.apply(owner, args);
}

export async function applyPaseoSessionSettings(config, { serverId, agentId, body, factory } = {}) {
  if (body?.confirmed !== true) return { ok: false, status: "unauthorized", detail: "An explicit owner confirmation is required." };
  if (!config?.paseo?.enabled) return { ok: false, status: "unavailable", detail: "Paseo is not configured." };
  const patch = requestedPatch(body);
  if (!Object.keys(patch).length) return { ok: false, status: "invalid", detail: "Choose a model, reasoning effort, or permission setting." };
  return withPaseo(config, async (client) => {
    const api = await hostApi(client, serverId);
    const before = await readWithApi(api, serverId, agentId);
    if (!before.ok) return before;
    if (body.targetFingerprint && body.targetFingerprint !== before.settings.targetFingerprint) return { ok: false, status: "stale-target", detail: "The session changed since it was read. Refresh before changing settings." };
    if (before.settings.status === "pending") return { ok: false, status: "pending", settings: before.settings, detail: "A pending permission request must be answered in its card; settings cannot clear or approve it." };
    if (before.settings.status === "busy") return { ok: false, status: "busy", settings: before.settings, detail: "The session has an active turn. Settings take effect after it finishes; no restart was performed." };
    const errors = validatePatch(patch, before.settings);
    if (errors.length) return { ok: false, status: "unsupported", settings: before.settings, detail: errors.join(" ") };
    const permission = findPermissionFeature(before.agent);
    try {
      await invokeMutation(api, before.ref, agentId, patch, permission?.id);
    } catch (error) {
      return { ok: false, status: "failed", settings: before.settings, detail: clampText(String(error?.message ?? "Paseo rejected the settings change."), 240) };
    }
    const after = await readWithApi(api, serverId, agentId);
    if (!after.ok) return { ok: false, status: "unconfirmed", detail: "Paseo accepted a settings request but the target could not be read back." };
    const mismatch = Object.entries(patch).find(([name, value]) => after.settings.current?.[name] !== value);
    if (mismatch) return { ok: false, status: "unconfirmed", settings: after.settings, detail: `Paseo did not confirm the requested ${mismatch[0]} setting.` };
    return { ok: true, status: "applied", settings: after.settings, detail: after.settings.takesEffect };
  }, factory);
}

export function parsePaseoSettingsTarget(threadKey) {
  return parsePaseoThreadKey(threadKey);
}
