// The Needs You decision contract: every card carries a decisionView with
// goal, status, decision and recommendation, and its buttons and replies
// agree with it. Fixtures are synthetic; the first mirrors a live card
// (two flag PRs, admin-merge question) that printed a raw table, showed
// internal routing in its goal, offered "merge both" as the primary button
// while recommending waiting, and prefilled a bypass reply.

import assert from "node:assert/strict";
import test from "node:test";
import { buildSupervisorCard } from "../src/fleet/cards.js";
import { buildDecisionView, cleanDecisionProse, isAdminBypassOption, matchRecommendedOption } from "../src/fleet/decision-view.js";

const NOW = Date.parse("2026-11-26T16:00:00Z");
const TABLE_SUMMARY = [
  "Both flag PRs are now merge-ready, apart from the required review:",
  "",
  "| PR | Certificate | Conflicts | Threads | Blocker |",
  "|---|---|---|---|---|",
  "| **#1201** reports flag consolidation | ✅ passed | none | 0 | 1 approving review |",
  "| **#1202** integrations flag consolidation | ✅ passed | none | 5/5 resolved | 1 approving review |",
  "",
  "GitHub shows no other failing checks on either. The post-merge verification on main is still pending.",
  "",
  "Decision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?"
].join("\n");

function regressionQuestion() {
  return {
    id: "fq_regression",
    dedupeKey: "ask:paseo:srv_test.0000:abc",
    threadKey: "paseo:srv_test.00000000-0000-0000-0000-000000000001",
    kind: "agent-ask",
    mergeAsk: true,
    status: "open",
    title: "example #1201/#1202: merge or wait?",
    body: "Decision needed: should I merge #1201 and #1202 over the required review with your admin rights, or leave them for a teammate's review?",
    options: ["merge both", "wait for teammate review"],
    askContext: TABLE_SUMMARY,
    reviewedAt: "2026-11-26T15:55:00Z",
    reviewBrief: {
      context: "[1. Agent Goal] Merge the reports and integrations flag-consolidation PRs after verification, while respecting the required independent approval.",
      summary: "[2. Where It Is & 3. What to Know] #1201 and #1202 are green, conflict-free, and have no failing checks. Both still require one approving review.",
      decision: "[3. Decision] Choose whether to use admin rights to merge both without the required teammate approval, or wait for an independent review.",
      recommendation: "Recommend: Wait for teammate review on both PRs, then merge.",
      suggestedReplies: ["Wait for teammate review on #1201 and #1202", "Merge both with admin rights now"]
    },
    contextSnapshot: {
      threadTitle: "Sales v1 PR review",
      paseoCwd: "/home/dev/.paseo/imported-history",
      agentSummary: TABLE_SUMMARY,
      recentMessages: [
        { role: "user", text: "Finish the Sales flag consolidation PRs and get them merged once verified" },
        { role: "assistant", text: TABLE_SUMMARY, at: "2026-11-26T15:50:27Z" }
      ]
    }
  };
}

const userFacing = (card) => JSON.stringify({
  view: card.decisionView,
  brief: card.brief,
  recommendation: card.recommendation,
  actions: [card.primaryAction, card.secondaryAction, ...(card.extraActions ?? [])],
  replies: card.suggestedReplies
});

test("regression: the flag-PR admin-merge card follows the decision contract", () => {
  const card = buildSupervisorCard(regressionQuestion(), {
    now: NOW,
    activeGoalResolver: () => ({ goal: "Finish the remaining Sales call-type admission work. Route to the existing Sales v1 PR review owner if viable (imported from paseo session 6755d49b)." })
  });
  const view = card.decisionView;
  assert.equal(view.version, 1);

  // No raw Markdown tables, internal routing or IDs anywhere the owner reads.
  const text = userFacing(card);
  assert.doesNotMatch(text, /\|\s*---|\|\s*PR\s*\||---\s*---/, "no table pipes");
  assert.doesNotMatch(text, /\[\d\.\s/, "no review-template labels");
  assert.doesNotMatch(text, /paseo|srv_|wks_|imported-history|6755d49b|if viable/i, "no internal routing");
  assert.doesNotMatch(view.goal.text ?? "", /route|owner/i);

  // Status: per-PR facts from the table, blockers, and what is unverified.
  assert.deepEqual(view.status.prs.map((p) => p.ref), ["#1201", "#1202"]);
  assert.ok(view.status.prs[1].facts.includes("Threads: 5/5 resolved"));
  assert.ok(view.status.prs[0].facts.includes("Blocker: 1 approving review"));
  assert.ok(view.status.blocked.some((s) => /approval/.test(s)));
  const statusLines = [...view.status.done, ...view.status.blocked, ...view.status.unverified];
  assert.ok(statusLines.every((s) => !/^#120[12] .*Certificate/.test(s)), "a PR's table row is shown once, as its facts");
  assert.doesNotMatch(JSON.stringify(view), /✅/);
  assert.ok(view.status.unverified.some((s) => /still pending/.test(s)));

  // Decision and recommendation agree with the buttons.
  const merge = view.decision.options.find((o) => o.value === "merge both");
  const wait = view.decision.options.find((o) => o.value === "wait for teammate review");
  assert.equal(merge.adminBypass, true);
  assert.match(merge.consequence, /Admin bypass: merges without the required review/);
  assert.equal(wait.recommended, true);
  assert.equal(merge.recommended, false);
  assert.equal(view.recommendation.option, "wait for teammate review");
  assert.equal(card.primaryAction.value, "wait for teammate review", "primary button is the recommended option");
  assert.equal(card.primaryAction.recommended, true);
  assert.equal(card.decisionAction.value, "wait for teammate review");
  assert.match(card.secondaryAction.label, /admin bypass/i, "bypass is labelled plainly");

  // No duplicated action rows, no prefilled bypass reply.
  const labels = [card.primaryAction, card.secondaryAction, ...card.extraActions].map((a) => a.label.toLowerCase());
  assert.equal(new Set(labels).size, labels.length, `duplicate actions: ${labels.join(", ")}`);
  assert.ok(card.suggestedReplies.every((r) => !/admin|bypass|merge both/i.test(r)), `replies: ${card.suggestedReplies.join(" / ")}`);
});

test("a sparse card states every unknown instead of inventing it", () => {
  const card = buildSupervisorCard({ id: "fq_sparse", kind: "agent-ask", status: "open", title: "Needs your decision", options: [] }, { now: NOW });
  const view = card.decisionView;
  assert.equal(view.goal.unknown, true);
  assert.equal(view.decision.unknown, true);
  assert.equal(view.recommendation.unknown, true);
  assert.equal(view.recommendation.option, null);
  for (const part of ["Goal", "Decision", "Recommendation"]) {
    assert.ok(view.unknowns.some((u) => u.startsWith(part)), `${part} labelled unknown: ${view.unknowns.join(" | ")}`);
  }
});

test("an older card without a recommendation never defaults to the admin bypass", () => {
  const card = buildSupervisorCard({
    id: "fq_old", kind: "agent-ask", status: "open", threadKey: "paseo:s.old",
    title: "Merge #77 over the required review?",
    body: "Should I merge #77 over the required review with your admin rights, or wait for review?",
    options: ["merge now", "wait for review"],
    contextSnapshot: { recentMessages: [{ role: "user", text: "Ship the release notes fix" }, { role: "assistant", text: "CI is green on #77. Should I merge #77 over the required review with your admin rights, or wait for review?" }] }
  }, { now: NOW });
  assert.equal(card.decisionView.recommendation.option, null);
  assert.equal(card.primaryAction.value, "wait for review", "a bypass is never the default without a recommendation");
  assert.equal(card.primaryAction.recommended, undefined, "nothing is styled as recommended");
  assert.match(card.secondaryAction.label, /admin bypass/i);
  assert.ok(card.suggestedReplies.every((r) => !/recommended/i.test(r)), "no reply points at a recommendation that isn't there");
  assert.ok(card.suggestedReplies.every((r) => !/^approved/i.test(r)), `no blanket approval next to a bypass option: ${card.suggestedReplies.join(" / ")}`);
});

test("helpers: table rows become facts, recommendation ties name no option, bypass needs a merge", () => {
  assert.equal(cleanDecisionProse("| A | B |\n|---|---|\n| #5 x | ok |"), "#5 x — B: ok");
  assert.equal(cleanDecisionProse("[1. Agent Goal] Ship it. Route to the existing review owner if viable."), "Ship it.");
  assert.equal(matchRecommendedOption("Recommend: wait for teammate review, then merge", [{ label: "Merge both" }, { label: "Wait for teammate review" }]).label, "Wait for teammate review");
  assert.equal(matchRecommendedOption("Recommend: do both", [{ label: "Option A" }, { label: "Option B" }]), null);
  assert.equal(isAdminBypassOption("merge both", "merge over the required review with admin rights"), true);
  assert.equal(isAdminBypassOption("wait for teammate review", "merge over the required review with admin rights"), false);
  assert.equal(isAdminBypassOption("deploy now", "merge over the required review with admin rights"), false);
  const view = buildDecisionView({ ctx: null, options: ["yes", "no"] });
  assert.equal(view.decision.options.length, 2);
  assert.ok(view.unknowns.includes("Consequences: not stated for any option"));
});
