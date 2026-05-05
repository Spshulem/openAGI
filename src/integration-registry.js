import { createId, nowIso, summarizeText } from "./utils.js";

export class IntegrationRegistry {
  constructor() {
    this.integrations = new Map();
  }

  register(integration) {
    if (!integration?.name) throw new Error("Integration requires a name.");
    if (typeof integration.toSignals !== "function") throw new Error("Integration requires toSignals(payload).");
    this.integrations.set(integration.name, integration);
    return integration;
  }

  ingest(name, payload) {
    const integration = this.integrations.get(name);
    if (!integration) throw new Error(`Unknown integration: ${name}`);
    const signals = integration.toSignals(payload).map((signal) => normalizeSignal(signal, name));
    return signals;
  }

  list() {
    return [...this.integrations.values()].map((integration) => ({
      name: integration.name,
      description: integration.description ?? ""
    }));
  }
}

export function normalizeSignal(signal, source) {
  const impact = signal.impact ?? 0.4;
  const externalPressure = signal.externalPressure ?? signal.environmentalPressure ?? 0.4;
  const internalPressure = signal.internalPressure ?? signal.teamPressure ?? 0.4;

  return {
    id: signal.id ?? createId("sig"),
    source: signal.source ?? source,
    type: signal.type ?? "abi-signal",
    domain: signal.domain ?? "general",
    taskType: signal.taskType ?? signal.type ?? "analysis",
    summary: summarizeText(signal.summary ?? signal.content ?? JSON.stringify(signal), 500),
    content: signal.content ?? signal.summary ?? JSON.stringify(signal),
    citations: signal.citations ?? [],
    tags: signal.tags ?? [],
    urgency: signal.urgency ?? 0.3,
    impact,
    externalPressure,
    internalPressure,
    novelty: signal.novelty ?? 0.3,
    repetition: signal.repetition ?? 0.2,
    risk: signal.risk ?? 0.3,
    ambiguity: signal.ambiguity ?? 0.35,
    confidence: signal.confidence ?? 0.5,
    specificity: signal.specificity ?? 0.45,
    conflict: signal.conflict ?? 0,
    goalAlignment: signal.goalAlignment ?? 0.5,
    strategicFit: signal.strategicFit ?? 0.5,
    policyFit: signal.policyFit ?? 0.7,
    requiresSpecialist: signal.requiresSpecialist ?? false,
    receivedAt: signal.receivedAt ?? nowIso(),
    metadata: signal.metadata ?? {}
  };
}

export function createAbiIntegration(options = {}) {
  return {
    name: options.name ?? "abi",
    description: options.description ?? "Normalizes external and internal evidence into ABI signals.",
    toSignals(payload) {
      const records = Array.isArray(payload.records) ? payload.records : [payload];
      return records.map((record) => ({
        source: record.source ?? options.name ?? "abi",
        type: record.type ?? "abi-signal",
        domain: record.domain ?? "general",
        taskType: record.taskType ?? "analysis",
        summary: record.summary ?? record.title ?? record.content,
        content: record.content ?? record.summary ?? record.title,
        citations: record.citations ?? record.receipts ?? [],
        tags: record.tags ?? ["abi"],
        urgency: record.urgency ?? 0.45,
        impact: record.impact ?? 0.65,
        externalPressure: record.externalPressure ?? record.environmentalPressure ?? 0.55,
        internalPressure: record.internalPressure ?? record.teamPressure ?? 0.45,
        novelty: record.novelty ?? 0.5,
        repetition: record.repetition ?? 0.4,
        risk: record.risk ?? 0.45,
        confidence: record.confidence ?? 0.68,
        specificity: record.specificity ?? 0.72,
        conflict: record.conflict ?? 0.2,
        goalAlignment: record.goalAlignment ?? 0.8,
        strategicFit: record.strategicFit ?? 0.78,
        requiresSpecialist: record.requiresSpecialist ?? false,
        metadata: record.metadata ?? {}
      }));
    }
  };
}
