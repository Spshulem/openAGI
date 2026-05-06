// D3 — LLM-as-judge that periodically reviews recent scrutiny decisions vs.
// their outcomes and proposes per-dimension weight nudges. The proposals
// feed into ScrutinyFitter.addJudgeSignal() and are merged with the
// correlation-based fitter signal in the next fit cycle.

const DIMENSIONS = ["environment", "company", "evidence", "memory", "uncertainty"];

export class ScrutinyJudge {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.sampleSize = options.sampleSize ?? 25;
    this.minSamples = options.minSamples ?? 10;
  }

  async judge() {
    const provider = this.runtime?.agentHost?.modelProvider;
    if (!provider?.isConfigured?.() || provider.constructor.name === "DeterministicModelProvider") {
      return { skipped: true, reason: "no LLM provider configured" };
    }
    if (!this.runtime?.scrutiny?.judges) {
      return { skipped: true, reason: "scrutiny is not a panel" };
    }
    const outcomes = this.runtime.outcomes
      .recent(2000)
      .filter((o) => o.resolved && typeof o.qualityScore === "number" && o.scrutinyDimensions && o.scrutinyAction)
      .slice(0, this.sampleSize);

    if (outcomes.length < this.minSamples) {
      return { skipped: true, reason: `${outcomes.length} resolved outcomes, need ${this.minSamples}` };
    }

    const sample = outcomes.map((o) => ({
      action: o.scrutinyAction,
      quality: o.qualityScore,
      dimensions: o.scrutinyDimensions,
      tools: (o.toolCalls ?? []).map((t) => t.name)
    }));

    const prompt = buildJudgePrompt(sample);
    const result = await provider.generate({
      input: prompt,
      agent: { id: "scrutiny-judge", name: "scrutiny-judge" },
      memoryHits: [],
      messages: [],
      tools: [],
      toolRegistry: null,
      instructions: judgeSystemPrompt(),
      context: {}
    });

    const parsed = parseJudgeOutput(result.text);
    if (!parsed) {
      return { skipped: true, reason: "judge output could not be parsed" };
    }
    if (this.runtime.scrutinyFitter) {
      for (const [judgeName, deltas] of Object.entries(parsed.perJudge)) {
        this.runtime.scrutinyFitter.addJudgeSignal({
          judge: judgeName,
          deltas,
          note: parsed.summary,
          source: "llm-judge"
        });
      }
    }
    return { sampled: outcomes.length, summary: parsed.summary, perJudge: parsed.perJudge };
  }
}

function judgeSystemPrompt() {
  return `You are a scrutiny calibration judge. You audit a sample of recent scrutiny
decisions (action chosen, dimension scores, tool calls, observed outcome
quality 0..1) and recommend per-dimension weight nudges for each judge in a
three-judge panel (cautious, pragmatic, aggressive). Output strictly the
JSON form below — no preamble, no explanation outside the JSON.

Schema:
{
  "summary": "1-2 sentence assessment of recent calibration",
  "perJudge": {
    "cautious":   { "environment": -0.05..0.05, "company": -0.05..0.05, "evidence": ..., "memory": ..., "uncertainty": ... },
    "pragmatic":  { ... },
    "aggressive": { ... }
  }
}

Conventions:
- Positive delta = increase that dimension's weight.
- Keep |delta| <= 0.05.
- If a judge looks well-calibrated, emit zeros.`;
}

function buildJudgePrompt(sample) {
  return `Sample of ${sample.length} recent scrutiny decisions:\n\n` +
    sample.map((s, i) => `(${i + 1}) action=${s.action} quality=${s.quality.toFixed(2)} dims=${JSON.stringify(s.dimensions)} tools=${s.tools.join(",") || "none"}`).join("\n");
}

function parseJudgeOutput(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj.perJudge) return null;
  for (const judge of ["cautious", "pragmatic", "aggressive"]) {
    if (!obj.perJudge[judge]) obj.perJudge[judge] = {};
    for (const dim of DIMENSIONS) {
      const v = obj.perJudge[judge][dim];
      obj.perJudge[judge][dim] = typeof v === "number" ? Math.max(-0.05, Math.min(0.05, v)) : 0;
    }
  }
  return { summary: obj.summary ?? "", perJudge: obj.perJudge };
}
