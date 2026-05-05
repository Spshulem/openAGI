# ABI Completion Scope

What it would take to close the gap between the runtime as it stands and the full thesis (`docs/core-abi-concept.md`). Sized in dev-days for one focused engineer; some items can run in parallel.

## Reading order

1. **Foundation** — must come first; unblocks Tier A and B.
2. **Tier A — Propagation becomes actor.** Specialists go from records to routed agents. The single highest-leverage tier.
3. **Tier B — Scrutiny becomes adaptive.** Outcomes feed back into selection pressure.
4. **Tier C — Memory becomes intelligent.** Condensation, intuition, inheritance, specificity.
5. **Tier D — Meta/reflection.** Self-modifying scrutiny, vocabulary curation, structural audit.

---

## Foundation — Outcome feedback layer

**Why first.** Three downstream pieces (specialist retirement, adaptive scrutiny, introspection) all need a record of "did this work?" The runtime has no such record today.

**Shape.**
- `src/outcome-store.js` — append-only JSONL with snapshot.
- Outcome record: `{ id, kind, refId, signalId?, scrutinyAction, resolved, qualityScore?, source, at }`. Kinds: `agent-reply`, `tool-call`, `cron-fire`, `sent-message`, `specialist-action`.
- Hooks: `AgentHost.handleMessage` writes one outcome per turn. `runScheduledPrompt` and `runAutopilot` write cron-fire outcomes. `channels.deliver` writes sent-message outcomes.
- Resolution pass (autopilot job, every 10 min): walks pending outcomes, infers quality from observable signals — was there a user follow-up? Was its tone positive/neutral/negative? Did the cron job fire and produce an action vs. "standing by"? Did the SMS get a reply within X hours?
- New endpoint: `GET /outcomes` for the dashboard.

**Touched.** `agent-host.js`, `abi-runtime.js`, `hosted-interface.js`, plus the new file.

**Effort.** 2–3 days.
**Risk.** Quality scoring is heuristic; LLM-as-judge boosts accuracy but costs. Start heuristic, layer LLM later.
**Validation.** `/outcomes` shows real records with monotonically improving resolution rate.

---

## Tier A — Propagation becomes real

### A1. Specialist routing  *(the linchpin)*

**Why.** Specialists exist but every message still goes to `main`. Without routing, propagation is bookkeeping.

**Shape.**
- `src/specialist-router.js`: given a signal, score every active specialist's bounded scope against the signal text. v1: keyword overlap + tag match (free). v2 (Tier D): embeddings.
- If top score > threshold (start at 0.65; tune from outcomes), route: `AgentHost.handleMessage` swaps in the specialist's `systemPrompt`, restricts tools to `allowedTools`, tags the session with specialist id.
- `main` always remains fallback when nothing matches.
- **Shadow mode** behind `OPENAGI_ROUTING_MODE=shadow` env: run both, record the delta as an outcome, don't actually deliver the specialist's reply. Use the first 1–2 weeks of shadow data to set the threshold before flipping to live.

**Touched.** `agent-host.js`, `propagation-controller.js` (`searchSpecialists()`), `abi-runtime.js`.
**Effort.** 3–5 days (mostly the routing logic + shadow harness).
**Risk.** Cold start (no specialists yet → nothing matches; benign — main handles). False-positive routes where the specialist is worse than main (mitigated by shadow mode + outcome quality).
**Validation.** After 50+ signals, `/sessions` shows specialist-tagged sessions; outcome quality of routed turns ≥ shadow `main` baseline.

### A2. Specialist retirement / lifecycle

**Why.** Specialists are immortal. Old specializations should age out.

**Shape.**
- Per-specialist tracked: `lastActivatedAt`, `activationCount`, rolling `meanOutcomeQuality`.
- Retirement criteria (any one): no activation in 30 days; rolling outcome quality < 0.3 over 10 activations; explicit user retire.
- On retire: archive workspace to `archive/`, condense memory into a legacy principle (depends on C1; standalone simpler version possible), remove from router.
- "Seasonal" exemption: specialists with annual cadence (tax-time, end-of-quarter) flagged at creation skip the 30-day rule.

**Touched.** `propagation-controller.js`, `file-backed-propagation-controller.js`.
**Effort.** 1–2 days (standalone) / 1 day (after C1).
**Validation.** Force-retire test creates archive; routing no longer surfaces retired specialist.

### A3. Per-specialist memory

**Why.** Today a specialist's memory is the runtime's memory. Local context (the things this specialist learned) bleeds into every recall.

**Shape.**
- Memory items get a `scope: "main" | "specialist:<id>"` field.
- Each specialist's recall is filtered to its scope ∪ main's long-tier (Lava is shared cultural knowledge).
- Per-specialist memory dir under `.openagi/agents/workspaces/<id>/memory/`.

**Touched.** `memory-system.js`, `file-backed-memory-system.js`, `agent-host.js`.
**Effort.** 2 days.
**Validation.** A specialist's recall doesn't return another specialist's notes.

**Tier A total: 6–9 days.**

---

## Tier B — Scrutiny becomes adaptive

### B1. Polarized scrutiny panel

**Why.** Thesis explicitly calls for diverse, conflicting, polarized scrutiny. Today there's one judge.

**Shape.**
- Three scrutinizers run in parallel on every signal:
  - **Cautious** — high uncertainty weight, low risk tolerance, biased toward `watch`/`ask`.
  - **Pragmatic** — current weights, biased toward `act`.
  - **Aggressive** — low uncertainty, high impact, biased toward `act`/`propagate`.
- Aggregator: 3/3 agreement → that action with full confidence; 2/3 → that action with reduced score; 0/3 agreement → force `ask`.
- Cheap, no API cost, big thesis payoff.

**Touched.** `directional-adaptive-scrutiny.js` refactor for configurable weights, new `scrutiny-panel.js`.
**Effort.** 1–2 days.
**Validation.** Disagreement test fixtures consistently produce `ask`.

### B2. Outcome → scrutiny weight fitter

**Why.** "Directional adaptive" means weights move based on what works. Today they're frozen.

**Shape.**
- Weekly cron job: read last week's outcomes, fit weights against quality.
- Approach: simple gradient nudge — for each weight `w_i`, compute correlation between dimension `i` and outcome quality, nudge in correlation direction, capped at ±5% per cycle.
- Only nudge if sample size ≥ 50 outcomes.
- Each panel scrutinizer fits its own weights independently.
- All proposed weight updates land in `pending-changes/` for human review for the first 4 weeks; after that, auto-apply with audit log.

**Touched.** `directional-adaptive-scrutiny.js`, new `scrutiny-fitter.js`, autopilot integration.
**Effort.** 4–6 days.
**Risk.** Insufficient data → overfitting. Drift in user behavior breaking past learnings (e.g., user changes job, old patterns no longer apply). Mitigation: rolling-window fit (only last 8 weeks of outcomes), per-month snapshot of weights for rollback.
**Validation.** After 4+ weeks of data, scrutiny weights have shifted measurably; outcome quality on next 4 weeks ≥ baseline.

### B3. Cyclical harsh review pulse

**Why.** Thesis stresses cyclical extreme scrutiny (predictable + diverse + extreme), not constant pressure. Equator-vs-temperate analogy.

**Shape.**
- Built-in autopilot job: weekly Sunday 8pm.
- Prompt: skeptically re-review last week's outcomes, specialists, scheduled jobs, memory tier saturation. Recommends retirements, schedule trims, principles to consolidate.
- Runs scrutiny with elevated thresholds (`act` from 0.68 → 0.85 for this turn) so only the highest-confidence calls pass.

**Effort.** 1–2 days.
**Validation.** Weekly review produces actionable structural recommendations.

**Tier B total: 6–10 days.**

---

## Tier C — Memory becomes intelligent

### C1. Memory condensation pass

**Why.** Today memory is excerpts. Thesis says we condense to 3 things — principles, not transcripts.

**Shape.**
- Daily autopilot job: read medium tier, group by tag overlap (and embedding similarity if C2 done), ask LLM to distill each group into a 200–400 char *principle*.
- Principle metadata: `kind: "principle"`, `sources: [memId...]`, `confidence`, `quarantineUntil` (7 days).
- After 7 days quarantine without contradicting evidence, principle promotes to long tier; sources free to decay.
- Contradictions during quarantine → principle discarded, sources retained.

**Touched.** New `memory-condenser.js`, `abi-runtime.js` (cron registration).
**Effort.** 3–4 days.
**Risk.** Bad distillations pollute long tier. Mitigation: confidence threshold + quarantine + audit trail.
**Validation.** After 2 weeks, long tier contains principles with traceable sources; recall hits return principles, not raw items, when relevant.

### C2. Lava intuition channel

**Why.** Long-term memory should feel intuitive, not querulous. Thesis: "we reason long-term memory from a place of feeling, not reason."

**Shape.**
- Embedding store separate from keyword retrieval, computed on principles only (not raw items).
- Implicit lookup on every signal: top-3 nearest principles inserted into context as `intuitions:`, not formal `recall()` results.
- Cost: embeddings — Voyage AI or OpenAI, ~$0.02 per 1M tokens. Add to budget guard.

**Touched.** New `memory-vector-store.js`, `agent-host.js`.
**Effort.** 4–7 days (depends on local vs API embeddings).
**Validation.** Agent references inherited intuitions without explicit `recall()` calls.

### C3. Cross-generation inheritance

**Why.** When a specialist retires, what it learned should outlive it.

**Shape.**
- A2's retirement step distills the specialist's memory into a *legacy principle* tagged `origin: <specialist-id>`.
- Legacy principles join main's long tier and are recallable by any future agent.

**Effort.** 1 day after C1 + A2.
**Validation.** A retired specialist's learnings appear in subsequent agent replies.

### C4. Specificity-aware fidelity

**Why.** Thesis: "spiders are bad" is too general; "hourglass on a spider will kill you" is the recallable form.

**Shape.**
- Memory items get a `dangerLevel` (0–1) computed from risk + specificity.
- High danger + high specificity items resist compression even at long tier.
- Recall ranking: when incoming signal matches any tag of a high-danger item, that item ranks first regardless of recency/strength.

**Touched.** `memory-system.js`.
**Effort.** 1 day.
**Validation.** Risky-tag recall consistently surfaces specific-and-dangerous items.

**Tier C total: 9–13 days.**

---

## Tier D — Meta / reflection

### D1. Specialist self-propagation (fractal)

**Why.** Thesis describes a meta-neural-net where specialists themselves create sub-specialists. Today only `main` propagates.

**Shape.**
- Specialists can invoke `runtime.propagation.propagate()`.
- Cycle detection: max depth 3, max breadth per parent 5.
- Specialist's own outcome quality affects whether sub-propagation is allowed (struggling specialists shouldn't spawn more).

**Effort.** 1–2 days.
**Validation.** A repetitive sub-task within a specialist creates a sub-specialist; routing reaches it.

### D2. Semantic specialist retrieval

**Why.** Tier A1 ships with keyword routing. Embeddings make routing far more accurate.

**Shape.**
- Embed each specialist's `boundedScope + parentGoal` once at creation.
- Routing uses cosine sim, not keyword overlap.
- Reuses C2's embedding infrastructure.

**Effort.** 2 days after A1 + C2.
**Validation.** Routing accuracy on outcome quality measurably improves over keyword baseline.

### D3. Self-scrutinizing scrutinizer

**Why.** Thesis: chicken/egg loop where the scrutinizer itself improves.

**Shape.**
- Weekly: LLM-as-judge looks at last week's scrutiny outputs vs. their outcomes. Rates each as over-cautious / well-calibrated / reckless. Suggests panel weight adjustments.
- Feeds into B2's fitter as a second input alongside heuristic outcome quality.

**Effort.** 2 days.
**Risk.** LLM judge bias. Use it as one signal among several, not authoritative.

### D4. Vocabulary curation

**Why.** Thesis: "language is a filter for the world." The system's vocabulary should evolve.

**Shape.**
- Track tag frequency, co-occurrence, and synonym candidates over time.
- Auto-merge tags with >0.85 cosine similarity used >50 times.
- Auto-deprecate tags unused for 60 days.

**Effort.** 2–3 days.
**Validation.** Tag count doesn't grow unboundedly; queries return consistent results across synonym variants.

### D5. Introspection pass

**Why.** "Are my specialists actually helping or am I creating cancer?" — no audit pass today.

**Shape.**
- Weekly autopilot: structural audit. Specialist tree health, memory tier saturation, schedule load, budget burn rate, channel response health.
- Surfaced in a new "Health" tab in the dashboard.

**Effort.** 2 days.
**Validation.** Tab shows actionable structural recommendations.

**Tier D total: 9–13 days.**

---

## Cuts and minimum-viable-thesis variants

### Minimum thesis-faithful (15–20 days)

Foundation + A1 + A2 + B1 + B3 + C1 + C4. Specialists actually route. Scrutiny is polarized. Memory condenses. Specific knowledge resists generalization. Skips embeddings and self-modifying scrutiny.

### Recommended sequence (parallelizable)

1. **Foundation (2–3d)** — gates everything.
2. **A1 + B1 (parallel, 4–7d total)** — routing turns the runtime divisional; panel is cheap parallel work.
3. **C1 + C4 (parallel, 4–5d)** — condensation and specificity together make memory feel like memory.
4. **A2 + A3 + B3 (parallel, 4–6d)** — closes propagation lifecycle, scrutiny becomes cyclical.
5. **C2 + D2 (parallel, 6–9d)** — embeddings unlock intuition + better routing.
6. **B2 + D3 (parallel, 6–8d)** — scrutiny adapts from outcomes + LLM judge.
7. **C3 + D1 + D4 + D5 (parallel, 5–7d)** — inheritance, fractal, vocabulary, introspection.

### Realistic totals

| Path | Dev-days | Weeks (1 person) |
|---|---|---|
| Minimum thesis-faithful | 15–20 | 3–4 |
| Full Tier A + B | 24–32 | 5–6 |
| Full A+B+C | 33–45 | 7–9 |
| Everything | 42–58 | 8–12 |

---

## Risks and unknowns spanning the whole scope

- **Outcome quality scoring** is the load-bearing assumption everywhere downstream. If we can't infer it accurately enough, B2/A2/D3 don't work. Mitigation: start heuristic, add LLM judge later, expose explicit `/feedback` endpoint so the user can rate turns.
- **Cold start**. With <50 outcomes, B2 can't fit; with no specialists, A1 routes to nothing. The runtime needs ~2 weeks of real use before adaptation kicks in. Bake this in: ship adaptation behind a "fitting" flag that flips at 50 outcomes.
- **Budget pressure**. Embeddings (C2/D2) and LLM-as-judge (D3) add ongoing cost. Budget guard handles the cap; user needs to choose where to spend. Local embeddings (e.g., ollama-bge) sidestep this.
- **Drift**. User goals change; old learnings poison new behavior. Mitigation: rolling window in B2, retirement in A2, decay in memory.
- **Open-source distribution**. Anything that requires API keys (embeddings, judge) needs clean fallbacks for OSS users. All adaptive features should run in degraded-but-functional mode without paid services.

## What this doesn't include

This scope covers the thesis. It does **not** cover:

- **Tunneling / production deployment** (handled separately by Tier A1 in your D→B→A plan).
- **More integrations** (Gmail, Calendar, GitHub via MCP — each <1 day, not thesis work).
- **Mobile UI** — current dashboard is desktop-only.
- **Multi-user / team mode** — single-user assumption is baked in.

---

## Bottom line

To go from "scaffold of the thesis" to "the thesis": **42–58 dev-days** for everything, **15–20 dev-days** for the minimum that's still recognizably faithful to the essay. The single most valuable item is **A1 specialist routing**; without it, the propagation pillar is not real.
