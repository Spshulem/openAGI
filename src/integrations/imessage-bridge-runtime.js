import { IMessageBridge, classifyBridgeError } from "./imessage-bridge.js";
import { createRefreshingNodeClientProvider, readNodeConfig } from "../cli-client.js";
import { resolveDataDir } from "../data-dir.js";

const truthy = (value) => ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
const csv = (value) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

export function imessageBridgeConfig(env = process.env) {
  const allowFrom = csv(env.IMESSAGE_ALLOW || env.IMESSAGE_SELF_HANDLE);
  const allowChats = csv(env.IMESSAGE_ALLOW_CHAT ?? env.IMESSAGE_ALLOW_CHATS);
  const requestedRespond = String(env.IMESSAGE_RESPOND ?? "").trim().toLowerCase();
  const requestedCapture = String(env.IMESSAGE_CAPTURE ?? "").trim().toLowerCase();
  const respond = ["all", "allow", "trigger", "none"].includes(requestedRespond)
    ? requestedRespond
    : (allowFrom.length || allowChats.length ? "trigger" : "none");
  const capture = ["all", "allow", "none"].includes(requestedCapture)
    ? requestedCapture
    : "none";
  const requestedInterval = Number.parseInt(env.IMESSAGE_INTERVAL_MS ?? "10000", 10);
  return {
    enabled: truthy(env.OPENAGI_IMESSAGE_BRIDGE),
    allowFrom,
    allowChats,
    respondMode: respond,
    captureMode: capture,
    trigger: String(env.IMESSAGE_TRIGGER ?? "openagi").trim().slice(0, 80),
    intervalMs: Number.isFinite(requestedInterval)
      ? Math.min(300_000, Math.max(2_000, requestedInterval))
      : 10_000
  };
}

// A paired main needs to distinguish "the Messages database is searchable"
// from "this Mac is actively polling and allowed to reply." Advertise that as
// a status-only capability over the existing authenticated outbound relay.
// No handles, trigger text, message text, paths, or raw errors cross machines.
export function imessageBridgeCapability(status, now = () => Date.now()) {
  const enabled = status?.enabled === true;
  const running = status?.running === true;
  const ready = enabled && running && status?.detailCode === "ready";
  const decision = [
    "trigger-mismatch",
    "not-allowed",
    "responses-disabled",
    "reply-error"
  ].includes(status?.lastDecisionCode)
    ? status.lastDecisionCode
    : null;
  const detail = ready
    ? (decision ? `ready:${decision}` : "ready")
    : String(status?.detailCode ?? (enabled ? "not-started" : "disabled")).slice(0, 80);
  return {
    id: "imessage-bridge",
    ready,
    operations: [],
    detail,
    checkedAt: new Date(now()).toISOString()
  };
}

export function createImessageBridgeRuntime(options = {}) {
  const dataDir = options.dataDir ?? resolveDataDir();
  const env = options.env ?? process.env;
  const config = imessageBridgeConfig(env);
  let bridge = null;
  let lastEvent = null;
  let startupDetail = null;

  const status = () => ({
    enabled: config.enabled,
    mode: config.respondMode,
    capture: config.captureMode,
    ...(bridge?.status?.() ?? {
      running: false,
      startedAt: null,
      lastPollAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      detailCode: startupDetail ?? (config.enabled ? "not-started" : "disabled"),
      totals: { processed: 0, replied: 0, captured: 0, skipped: 0, errors: 0 }
    }),
    lastEvent
  });

  return {
    status,
    start() {
      if (!config.enabled || bridge) return status();
      try {
        const pairing = readNodeConfig(dataDir);
        const rawProvider = options.clientProvider ?? createRefreshingNodeClientProvider({
          dataDir,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs ?? 60_000,
          allowInsecureRemote: options.allowInsecureRemote === true
        });
        // A paired node may not relay private messages with its one-time broad
        // enrollment credential. Until the daemon confirms scoped enrollment,
        // polling remains local and reports a categorical main-unavailable state.
        const clientProvider = () => {
          const current = readNodeConfig(dataDir);
          if ((pairing?.remote || current?.remote) && current?.nodeEnrollmentConfirmed !== true) {
            throw new Error("iMessage bridge main client is unavailable until scoped node enrollment completes");
          }
          return rawProvider();
        };
        bridge = (options.bridgeFactory ?? ((bridgeOptions) => new IMessageBridge(bridgeOptions)))({
          dataDir,
          dbPath: env.IMESSAGE_DB_PATH || undefined,
          allowFrom: config.allowFrom,
          allowChats: config.allowChats,
          respondMode: config.respondMode,
          captureMode: config.captureMode,
          trigger: config.trigger,
          clientProvider,
          onEvent(event) {
            lastEvent = { kind: event.kind, at: event.at ?? new Date().toISOString(), detailCode: event.detailCode ?? null };
          }
        });
        bridge.start({ intervalMs: config.intervalMs });
      } catch (error) {
        startupDetail = classifyBridgeError(error);
        lastEvent = { kind: "startup-error", at: new Date().toISOString(), detailCode: startupDetail };
        bridge = null;
      }
      return status();
    },
    stop() {
      bridge?.stop?.();
      return status();
    }
  };
}
