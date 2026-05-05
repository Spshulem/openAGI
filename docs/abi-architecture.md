# ABI Architecture

## Runtime Loop

The runtime treats ABI as a closed feedback loop:

1. Integrations collect environmental input: user requests, tool events, feedback, observations, files, messages, APIs, and system state.
2. Signals normalize raw events into evidence with urgency, novelty, risk, repetition, impact, and pressure.
3. Workflows decide what kind of outcome is being pursued.
4. Directional adaptive scrutiny scores the signal against environmental pressure, company scrutiny, goals, policies, and uncertainty.
5. The agent layer retrieves memory and chooses whether to act, ask, watch, or propagate.
6. Memory stores the result in short, medium, or long-term tiers with different fidelity and decay.
7. Propagation creates a bounded specialist only for repeated tasks or novel high-risk work.
8. Outputs are emitted back to the relevant surface.
9. Feedback loops back into integrations as new evidence.

## Directional Adaptive Scrutiny

Scrutiny is intentionally directional but not outcome-locked. It gives the system a way to say:

- what pressure exists in the environment;
- what the company currently values;
- where customer evidence conflicts with team assumptions;
- how risky or novel the task is;
- whether the system has enough context to act.

This is deterministic in the scaffold so behavior can be tested. Later, the scoring reasons can become prompt inputs for an LLM or evaluator ensemble.

## Memory Tiers

Short-term memory is high-fidelity working context. It decays quickly.

Medium-term memory is recurring operational context, such as daily customer themes, active workflows, and current product bets.

Long-term memory, called Lava, is compressed intuition. It should preserve critical specifics, especially safety, customer commitments, and product truths, but forget noisy detail.

The memory manager promotes or compresses records based on novelty, risk, repetition, and reinforcement.

## Propagation

Propagation is division, not multiplication. A specialist requires:

- a bounded scope;
- a parent goal;
- a success metric;
- allowed tools;
- a propagation reason tied to repetition or high risk.

The parent runtime owns specialist lifecycle and can retire specialists when their memory becomes stale or their task no longer repeats.

## ABI Mapping

| Concept | Runtime Component |
| --- | --- |
| Integrations | `IntegrationRegistry` |
| Signals | normalized `Signal` records |
| Workflows | `WorkflowRegistry` |
| Directional Adaptive Scrutiny | `DirectionalAdaptiveScrutiny` |
| Agent layer | `AbiRuntime.processSignal` |
| Multi-tiered memory | `MemorySystem` |
| Custom context | memory retrieval + workflow context |
| Propagation | `PropagationController` |
| Outputs | output records and hosted API |
| Feedback loop | memory updates and re-ingestion |
