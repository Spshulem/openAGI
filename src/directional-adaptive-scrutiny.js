import { clamp } from "./utils.js";

export class DirectionalAdaptiveScrutiny {
  constructor(options = {}) {
    this.style = options.style ?? "pragmatic"; // cautious | pragmatic | aggressive
    this.weights = {
      environment: 0.28,
      company: 0.26,
      evidence: 0.24,
      memory: 0.12,
      uncertainty: 0.1,
      ...(options.weights ?? {})
    };
    this.thresholds = {
      act: 0.68,
      ask: 0.45,
      propagate: 0.72,
      watch: 0.28,
      ...(options.thresholds ?? {})
    };
  }

  evaluate({ signal, workflow, memories = [], context = {} }) {
    const environmentScore = this.environmentPressure(signal, context);
    const companyScore = this.companyScrutiny(signal, workflow, context);
    const evidenceScore = this.evidenceQuality(signal);
    const memoryScore = this.memoryReadiness(memories);
    const uncertaintyScore = 1 - this.uncertainty(signal, memories);
    const risk = clamp(signal.risk ?? 0);
    const novelty = clamp(signal.novelty ?? 0);
    const repetition = clamp(signal.repetition ?? 0);

    const score = clamp(
      environmentScore * this.weights.environment +
        companyScore * this.weights.company +
        evidenceScore * this.weights.evidence +
        memoryScore * this.weights.memory +
        uncertaintyScore * this.weights.uncertainty
    );

    const propagationPressure = clamp(Math.max(repetition, risk * novelty, signal.requiresSpecialist ? 0.9 : 0));
    const action = this.selectAction({ score, risk, novelty, propagationPressure, memories, signal });

    return {
      action,
      score,
      propagationPressure,
      dimensions: {
        environment: environmentScore,
        company: companyScore,
        evidence: evidenceScore,
        memory: memoryScore,
        uncertainty: 1 - uncertaintyScore,
        risk,
        novelty,
        repetition
      },
      reasons: this.reasons({ signal, workflow, context, score, action, propagationPressure, memories })
    };
  }

  environmentPressure(signal, context) {
    const impact = signal.impact ?? 0;
    const externalPressure = signal.externalPressure ?? 0;
    const environmentalPressure = signal.environmentalPressure ?? context.environmentalPressure ?? 0;
    return clamp(
      (signal.urgency ?? 0) * 0.3 +
        impact * 0.35 +
        environmentalPressure * 0.2 +
        externalPressure * 0.15
    );
  }

  companyScrutiny(signal, workflow, context) {
    const goalAlignment = clamp(signal.goalAlignment ?? workflow?.goalAlignment ?? context.goalAlignment ?? 0.5);
    const policyFit = clamp(signal.policyFit ?? context.policyFit ?? 0.7);
    const teamPressure = clamp(signal.internalPressure ?? signal.teamPressure ?? context.internalPressure ?? context.teamPressure ?? 0.4);
    const strategicFit = clamp(signal.strategicFit ?? workflow?.strategicFit ?? context.strategicFit ?? 0.5);
    return clamp(goalAlignment * 0.35 + policyFit * 0.2 + teamPressure * 0.2 + strategicFit * 0.25);
  }

  evidenceQuality(signal) {
    const citations = Array.isArray(signal.citations) ? signal.citations.length : 0;
    const citationScore = clamp(citations / 4);
    const specificity = clamp(signal.specificity ?? 0.45);
    const confidence = clamp(signal.confidence ?? 0.5);
    const conflictPenalty = clamp(signal.conflict ?? 0) * 0.18;
    return clamp(citationScore * 0.3 + specificity * 0.35 + confidence * 0.35 - conflictPenalty);
  }

  memoryReadiness(memories) {
    if (memories.length === 0) return 0.2;
    const score = memories.reduce((sum, entry) => sum + entry.score, 0) / memories.length;
    return clamp(score + Math.min(memories.length, 5) * 0.08);
  }

  uncertainty(signal, memories) {
    const lowEvidence = 1 - this.evidenceQuality(signal);
    const lowMemory = 1 - this.memoryReadiness(memories);
    const ambiguity = clamp(signal.ambiguity ?? 0.3);
    return clamp(lowEvidence * 0.45 + lowMemory * 0.25 + ambiguity * 0.3);
  }

  selectAction({ score, risk, novelty, propagationPressure, memories, signal }) {
    if (propagationPressure >= this.thresholds.propagate && score >= this.thresholds.ask) return "propagate";
    if (score >= this.thresholds.act && risk < 0.8) return "act";
    if (risk >= 0.8 && memories.length === 0) return "ask";
    if (novelty >= 0.75 && score >= this.thresholds.ask) return "ask";
    if (score >= this.thresholds.ask) {
      // Style-differentiated fallback when score is between ask and act:
      // cautious hedges ('ask'), aggressive presses ahead ('act'), pragmatic uses signal default.
      if (this.style === "cautious") return "ask";
      if (this.style === "aggressive") return "act";
      return signal.defaultAction ?? "act";
    }
    if (score >= this.thresholds.watch) return "watch";
    return "ignore";
  }

  reasons({ signal, workflow, context, score, action, propagationPressure, memories }) {
    const reasons = [
      `Selected ${action} at scrutiny score ${score.toFixed(2)}.`,
      `Workflow: ${workflow?.name ?? "unassigned"}.`,
      `Runtime context: ${context.name ?? "default"}.`
    ];

    if ((signal.impact ?? 0) >= 0.7) reasons.push("High impact increased environmental pressure.");
    if ((signal.externalPressure ?? 0) >= 0.7) reasons.push("External evidence is applying strong selection pressure.");
    if (signal.conflict >= 0.5) reasons.push("Conflicting evidence requires extra scrutiny.");
    if (memories.length === 0) reasons.push("No strong memory match was found.");
    if (propagationPressure >= this.thresholds.propagate) reasons.push("Repetition or high-risk novelty supports specialist propagation.");

    return reasons;
  }
}
