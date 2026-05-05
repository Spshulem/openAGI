export class WorkflowRegistry {
  constructor() {
    this.workflows = new Map();
  }

  register(workflow) {
    if (!workflow?.id) throw new Error("Workflow requires an id.");
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  select(signal) {
    const exact = this.workflows.get(signal.workflowId);
    if (exact) return exact;

    const candidates = [...this.workflows.values()]
      .map((workflow) => {
        if (workflow.domain && workflow.domain !== signal.domain) return null;
        if (workflow.taskType && workflow.taskType !== signal.taskType) return null;
        const specificity = Number(Boolean(workflow.domain)) + Number(Boolean(workflow.taskType));
        return { workflow, specificity };
      })
      .filter(Boolean)
      .sort((a, b) => b.specificity - a.specificity);

    return candidates[0]?.workflow ?? this.workflows.get("default");
  }

  list() {
    return [...this.workflows.values()];
  }
}

export function registerDefaultWorkflows(registry) {
  registry.register({
    id: "default",
    name: "Default ABI Signal Handling",
    domain: null,
    taskType: null,
    goal: "Turn environmental evidence into an action, question, memory update, or specialist.",
    goalAlignment: 0.6,
    strategicFit: 0.6,
    successMetric: "Useful output is produced with cited reasons and updated memory."
  });

  registry.register({
    id: "adaptive-review",
    name: "Adaptive Review",
    domain: "general",
    taskType: "adaptation-review",
    goal: "Review recent pressure, memory candidates, and propagation opportunities.",
    goalAlignment: 0.9,
    strategicFit: 0.86,
    successMetric: "Review includes evidence, tension, memory decision, and propagation decision."
  });

  registry.register({
    id: "specialization-candidate",
    name: "Specialization Candidate",
    domain: "general",
    taskType: "specialization-candidate",
    goal: "Decide whether a repeated or high-risk novel task should become a specialist.",
    goalAlignment: 0.86,
    strategicFit: 0.78,
    successMetric: "Specialist is created only when its bounded scope reduces generalized burden."
  });

  return registry;
}
