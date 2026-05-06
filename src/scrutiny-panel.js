import { DirectionalAdaptiveScrutiny } from "./directional-adaptive-scrutiny.js";

// Three judges with different priors. Aggregator returns the consensus action,
// or forces 'ask' when they disagree completely. This is the "diverse + extreme +
// conflicting" scrutiny the thesis describes.

const JUDGE_CONFIGS = {
  cautious: {
    style: "cautious",
    weights: { environment: 0.18, company: 0.22, evidence: 0.32, memory: 0.13, uncertainty: 0.15 },
    thresholds: { act: 0.78, ask: 0.40, propagate: 0.78, watch: 0.30 }
  },
  pragmatic: {
    style: "pragmatic",
    weights: { environment: 0.28, company: 0.26, evidence: 0.24, memory: 0.12, uncertainty: 0.10 },
    thresholds: { act: 0.68, ask: 0.45, propagate: 0.72, watch: 0.28 }
  },
  aggressive: {
    style: "aggressive",
    weights: { environment: 0.34, company: 0.22, evidence: 0.18, memory: 0.16, uncertainty: 0.10 },
    thresholds: { act: 0.58, ask: 0.50, propagate: 0.62, watch: 0.25 }
  }
};

export class ScrutinyPanel {
  constructor(options = {}) {
    this.judges = {
      cautious: new DirectionalAdaptiveScrutiny(options.cautious ?? JUDGE_CONFIGS.cautious),
      pragmatic: new DirectionalAdaptiveScrutiny(options.pragmatic ?? JUDGE_CONFIGS.pragmatic),
      aggressive: new DirectionalAdaptiveScrutiny(options.aggressive ?? JUDGE_CONFIGS.aggressive)
    };
  }

  getJudge(name) {
    return this.judges[name];
  }

  /**
   * Run all three judges and aggregate. Returns a scrutiny-shaped result with extras:
   * { action, score, dimensions, reasons, judges, agreement, dissent }.
   */
  evaluate(args) {
    const verdicts = {};
    for (const [name, judge] of Object.entries(this.judges)) {
      verdicts[name] = judge.evaluate(args);
    }

    const actions = Object.values(verdicts).map((v) => v.action);
    const tally = {};
    for (const a of actions) tally[a] = (tally[a] || 0) + 1;

    let consensus;
    let agreement;
    if (Object.values(tally).some((c) => c === 3)) {
      consensus = actions[0];
      agreement = "unanimous";
    } else if (Object.values(tally).some((c) => c === 2)) {
      consensus = Object.entries(tally).find(([, c]) => c === 2)[0];
      agreement = "majority";
    } else {
      consensus = "ask";
      agreement = "split";
    }

    // Aggregate score: mean across judges, lightly penalised for disagreement.
    const meanScore = (verdicts.cautious.score + verdicts.pragmatic.score + verdicts.aggressive.score) / 3;
    const disagreementPenalty = agreement === "unanimous" ? 0 : agreement === "majority" ? 0.05 : 0.15;
    const score = Math.max(0, meanScore - disagreementPenalty);

    // Take dimensions from pragmatic (it's the calibrated baseline).
    const dimensions = verdicts.pragmatic.dimensions;
    const propagationPressure = Math.max(...Object.values(verdicts).map((v) => v.propagationPressure));

    const reasons = [
      `Panel selected '${consensus}' (${agreement}).`,
      `Cautious=${verdicts.cautious.action}@${verdicts.cautious.score.toFixed(2)}, Pragmatic=${verdicts.pragmatic.action}@${verdicts.pragmatic.score.toFixed(2)}, Aggressive=${verdicts.aggressive.action}@${verdicts.aggressive.score.toFixed(2)}.`
    ];
    if (agreement === "split") reasons.push("Judges disagreed completely — defaulting to 'ask' for human input.");
    if (agreement === "majority") {
      const dissenter = Object.entries(verdicts).find(([, v]) => v.action !== consensus);
      if (dissenter) reasons.push(`Dissent: ${dissenter[0]} judge picked '${dissenter[1].action}' — ${dissenter[1].reasons.slice(-1)[0] ?? ""}`.trim());
    }

    return {
      action: consensus,
      score,
      propagationPressure,
      dimensions,
      reasons,
      judges: verdicts,
      agreement
    };
  }
}
