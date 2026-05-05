import { createDefaultRuntime } from "../src/index.js";

const runtime = createDefaultRuntime({
  context: {
    name: "OpenAGI ABI Demo",
    goalAlignment: 0.88,
    strategicFit: 0.82,
    environmentalPressure: 0.65,
    internalPressure: 0.58
  }
});

const [output] = runtime.processIntegrationEvent("abi", {
  records: [
    {
      type: "abi-signal",
      domain: "general",
      taskType: "adaptation-review",
      title: "Repeated high-risk task should be evaluated for specialization",
      content:
        "A recurring task keeps requiring the same reasoning, context gathering, and error checks. It is not fully routine yet, but the cost of re-solving it every time is increasing.",
      citations: ["event:demo:1", "memory:demo:2", "feedback:demo:3"],
      tags: ["scrutiny", "memory", "propagation"],
      urgency: 0.62,
      impact: 0.86,
      externalPressure: 0.72,
      internalPressure: 0.64,
      novelty: 0.68,
      repetition: 0.82,
      risk: 0.66,
      confidence: 0.78,
      specificity: 0.84,
      conflict: 0.35,
      requiresSpecialist: true,
      successMetric: "A bounded specialist reduces repeated parent reasoning without creating unbounded complexity."
    }
  ]
});

console.log(
  JSON.stringify(
    {
      action: output.action,
      scrutinyScore: output.scrutiny.score,
      memoryTier: output.memory.tier,
      propagated: output.propagation.reason,
      specialist: output.propagation.specialist?.name,
      reasons: output.scrutiny.reasons,
      status: runtime.status()
    },
    null,
    2
  )
);
