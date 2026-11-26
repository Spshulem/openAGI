#if DEBUG
// Synthetic Needs You data for `--ui-needs-you-fixture`: long and noisy
// titles, three projects plus #general, risky and failing items, and FYIs /
// completions (needsYou: false) mixed into the same payload. Keep in sync
// with mac/Tests/OpenAGITests/NeedsYouFixture.swift.
enum UITestNeedsYouFixture {
    static let stateJSON = #"""
{
 "mode": "propose",
 "enabled": true,
 "running": false,
 "lastTickAt": "2026-11-23T11:54:00.000Z",
 "snapshot": {
  "at": "2026-11-23T11:54:00.000Z",
  "threads": [
   {
    "key": "codex:ny-deploy",
    "title": "Merge PR #412 and deploy the checkout redesign to production",
    "workspace": "atlas",
    "repo": "acme/atlas",
    "project": "atlas",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T11:36:00.000Z",
    "lastAgentText": "I finished the checkout redesign in PR #412. CI is green and staging looks right. Should I merge and deploy to production now?",
    "subchannel": "atlas/Checkout"
   },
   {
    "key": "codex:ny-ci",
    "title": "Checks failing on PR #418 (search indexing): fix forward or ",
    "workspace": "atlas",
    "repo": "acme/atlas",
    "project": "atlas",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T10:48:00.000Z",
    "lastAgentText": "search.archived and search.pagination time out after my indexer change. I can add the missing index or revert.",
    "subchannel": "atlas/Search"
   },
   {
    "key": "codex:ny-region",
    "title": "Which region should the staging cluster move to: us-east-2 o",
    "workspace": "harbor",
    "repo": "acme/harbor",
    "project": "harbor",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T09:30:00.000Z",
    "lastAgentText": "Both target regions are ready. Which one should staging move to?",
    "subchannel": "harbor/Clusters"
   },
   {
    "key": "codex:ny-key",
    "title": "Approve rotating the CI deploy key (expires in 3 days)",
    "workspace": "harbor",
    "repo": "acme/harbor",
    "project": "harbor",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T09:00:00.000Z",
    "lastAgentText": null,
    "subchannel": "harbor/CI"
   },
   {
    "key": "codex:ny-refund",
    "title": "Refund policy edge case: partial refunds on annual plans",
    "workspace": "ledger",
    "repo": "acme/ledger",
    "project": "ledger",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T08:00:00.000Z",
    "lastAgentText": null,
    "subchannel": "ledger/Refunds"
   },
   {
    "key": "codex:ny-pr77",
    "title": "PR #77 ready: invoice PDF footer fix",
    "workspace": "ledger",
    "repo": "acme/ledger",
    "project": "ledger",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T07:00:00.000Z",
    "lastAgentText": null,
    "subchannel": null
   },
   {
    "key": "codex:ny-name",
    "title": "Pick the name for the new onboarding checklist",
    "workspace": "general",
    "repo": "acme/general",
    "project": "general",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T06:00:00.000Z",
    "lastAgentText": null,
    "subchannel": null
   },
   {
    "key": "codex:ny-v1",
    "title": "Keep the legacy /v1 search endpoint for 30 more days?",
    "workspace": "atlas",
    "repo": "acme/atlas",
    "project": "atlas",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T05:00:00.000Z",
    "lastAgentText": null,
    "subchannel": "atlas/Search"
   },
   {
    "key": "codex:ny-tf",
    "title": "codex:7f3a91 asked: proceed with `terraform apply` on 14 res",
    "workspace": "harbor",
    "repo": "acme/harbor",
    "project": "harbor",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T04:00:00.000Z",
    "lastAgentText": "Plan: 12 to change, 2 to destroy. Proceed with terraform apply?",
    "subchannel": "harbor/Networking"
   },
   {
    "key": "codex:ny-net30",
    "title": "Clarify: does \"net 30\" start at the invoice date or the deli",
    "workspace": "ledger",
    "repo": "acme/ledger",
    "project": "ledger",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T02:00:00.000Z",
    "lastAgentText": null,
    "subchannel": null
   },
   {
    "key": "codex:ny-a11y",
    "title": "Review the accessibility audit findings before the agent fil",
    "workspace": "atlas",
    "repo": "acme/atlas",
    "project": "atlas",
    "state": "needs-human",
    "lastActivityAt": "2026-11-22T16:00:00.000Z",
    "lastAgentText": null,
    "subchannel": "atlas/Accessibility"
   },
   {
    "key": "codex:ny-idle",
    "title": "Session idle 3h — keep it, archive it, or hand it to another",
    "workspace": "general",
    "repo": "acme/general",
    "project": "general",
    "state": "needs-human",
    "lastActivityAt": "2026-11-22T10:00:00.000Z",
    "lastAgentText": null,
    "subchannel": null
   },
   {
    "key": "codex:fyi-docs",
    "title": "Finished: docs typo sweep (no action needed)",
    "workspace": "atlas",
    "repo": "acme/atlas",
    "project": "atlas",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T11:12:00.000Z",
    "lastAgentText": null,
    "subchannel": null
   },
   {
    "key": "codex:fyi-deps",
    "title": "Finished: dependency bump in harbor; all checks green",
    "workspace": "harbor",
    "repo": "acme/harbor",
    "project": "harbor",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T10:00:00.000Z",
    "lastAgentText": null,
    "subchannel": null
   },
   {
    "key": "codex:fyi-err",
    "title": "Session error recovered automatically: rate limit on the inv",
    "workspace": "ledger",
    "repo": "acme/ledger",
    "project": "ledger",
    "state": "needs-human",
    "lastActivityAt": "2026-11-23T08:30:00.000Z",
    "lastAgentText": null,
    "subchannel": null
   }
  ]
 },
 "questions": [
  {
   "id": "ny-deploy",
   "kind": "agent-ask",
   "title": "Merge PR #412 and deploy the checkout redesign to production?",
   "body": "The checkout redesign is ready.\n\n- 214 tests pass\n- Staging smoke test passed\n- Visual diff: 3 intended changes",
   "options": [
    "Merge & deploy",
    "Merge, hold deploy",
    "Request changes"
   ],
   "threadKey": "codex:ny-deploy",
   "createdAt": "2026-11-23T11:36:00.000Z",
   "askedAt": "2026-11-23T11:36:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Merge PR #412 and deploy the checkout redesign to production?",
   "decisionFact": "Merging deploys to production. Only you can approve a production deploy.",
   "risky": true,
   "askContext": "I finished the checkout redesign in PR #412. CI is green and staging looks right. Should I merge and deploy to production now?",
   "canReply": true,
   "project": "atlas",
   "subchannel": "atlas/Checkout",
   "chatLabel": "atlas · Checkout (Codex)",
   "prRef": "acme/atlas#412"
  },
  {
   "id": "ny-ci",
   "kind": "ci_failed",
   "title": "Checks failing on PR #418 (search indexing): fix forward or revert the indexer change?",
   "body": "Fix forward in this PR, or revert the indexer change and land the UI part alone?",
   "options": [
    "Fix forward",
    "Revert indexer"
   ],
   "threadKey": "codex:ny-ci",
   "createdAt": "2026-11-23T10:48:00.000Z",
   "askedAt": "2026-11-23T10:48:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Checks failing on PR #418 (search indexing): fix forward or revert the indexer change?",
   "decisionFact": "The indexer change broke two integration tests; the agent stopped instead of guessing which behavior is right.",
   "risky": false,
   "askContext": "search.archived and search.pagination time out after my indexer change. I can add the missing index or revert.",
   "canReply": true,
   "project": "atlas",
   "subchannel": "atlas/Search",
   "chatLabel": "atlas · Search (Codex)",
   "prRef": "acme/atlas#418"
  },
  {
   "id": "ny-region",
   "kind": "agent-ask",
   "title": "Which region should the staging cluster move to: us-east-2 or eu-west-1? The agent compared latency, cost, and the data-residency note in the customer contract and can proceed either way once you pick.",
   "body": "us-east-2 or eu-west-1?",
   "options": [
    "us-east-2",
    "eu-west-1"
   ],
   "threadKey": "codex:ny-region",
   "createdAt": "2026-11-23T09:30:00.000Z",
   "askedAt": "2026-11-23T09:30:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Which region should the staging cluster move to: us-east-2 or eu-west-1? The agent compared latency, cost, and the data-residency note in the customer contract and can proceed either way once you pick.",
   "decisionFact": "The contract's data-residency clause is ambiguous, so the agent needs your call.",
   "risky": false,
   "askContext": "Both target regions are ready. Which one should staging move to?",
   "canReply": true,
   "project": "harbor",
   "subchannel": "harbor/Clusters",
   "chatLabel": "harbor · Clusters (Codex)",
   "prRef": null
  },
  {
   "id": "ny-key",
   "kind": "agent-ask",
   "title": "Approve rotating the CI deploy key (expires in 3 days)",
   "body": "Approve the rotation now, or schedule it for Wednesday's maintenance window?",
   "options": [
    "Rotate now",
    "Schedule Wednesday"
   ],
   "threadKey": "codex:ny-key",
   "createdAt": "2026-11-23T09:00:00.000Z",
   "askedAt": "2026-11-23T09:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Approve rotating the CI deploy key (expires in 3 days)",
   "decisionFact": "Rotation needs an owner-approved key in the vault.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "harbor",
   "subchannel": "harbor/CI",
   "chatLabel": "harbor · CI (Codex)",
   "prRef": null
  },
  {
   "id": "ny-refund",
   "kind": "agent-ask",
   "title": "Refund policy edge case: partial refunds on annual plans",
   "body": "Prorate by month used, or offer account credit only?",
   "options": [
    "Prorate",
    "Credit only"
   ],
   "threadKey": "codex:ny-refund",
   "createdAt": "2026-11-23T08:00:00.000Z",
   "askedAt": "2026-11-23T08:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Refund policy edge case: partial refunds on annual plans",
   "decisionFact": "The policy doc doesn't cover partial refunds after month 6.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "ledger",
   "subchannel": "ledger/Refunds",
   "chatLabel": "ledger · Refunds (Codex)",
   "prRef": null
  },
  {
   "id": "ny-pr77",
   "kind": "merge_ready",
   "title": "PR #77 ready: invoice PDF footer fix",
   "body": "Merge PR #77?",
   "options": [
    "Merge",
    "Not yet"
   ],
   "threadKey": "codex:ny-pr77",
   "createdAt": "2026-11-23T07:00:00.000Z",
   "askedAt": "2026-11-23T07:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "PR #77 ready: invoice PDF footer fix",
   "decisionFact": "Merging to main needs your approval under the current merge policy.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "ledger",
   "subchannel": null,
   "chatLabel": "ledger · General (Codex)",
   "prRef": "acme/ledger#77"
  },
  {
   "id": "ny-name",
   "kind": "agent-ask",
   "title": "Pick the name for the new onboarding checklist",
   "body": "\"Getting started\", \"Setup checklist\", or \"First steps\"?",
   "options": [
    "Getting started",
    "Setup checklist",
    "First steps"
   ],
   "threadKey": "codex:ny-name",
   "createdAt": "2026-11-23T06:00:00.000Z",
   "askedAt": "2026-11-23T06:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Pick the name for the new onboarding checklist",
   "decisionFact": "Copy decisions are yours.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "general",
   "subchannel": null,
   "chatLabel": "general · General (Codex)",
   "prRef": null
  },
  {
   "id": "ny-v1",
   "kind": "agent-ask",
   "title": "Keep the legacy /v1 search endpoint for 30 more days?",
   "body": "Remove now, or keep 30 more days?",
   "options": [
    "Keep 30 days",
    "Remove now"
   ],
   "threadKey": "codex:ny-v1",
   "createdAt": "2026-11-23T05:00:00.000Z",
   "askedAt": "2026-11-23T05:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Keep the legacy /v1 search endpoint for 30 more days?",
   "decisionFact": "Two customers still call /v1 daily.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "atlas",
   "subchannel": "atlas/Search",
   "chatLabel": "atlas · Search (Codex)",
   "prRef": null
  },
  {
   "id": "ny-tf",
   "kind": "agent-ask",
   "title": "codex:7f3a91 asked: proceed with `terraform apply` on 14 resources (2 destroys) in shared-networking?",
   "body": "Apply the plan, or stop and review the destroys first?",
   "options": [
    "Apply",
    "Stop, review destroys"
   ],
   "threadKey": "codex:ny-tf",
   "createdAt": "2026-11-23T04:00:00.000Z",
   "askedAt": "2026-11-23T04:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "codex:7f3a91 asked: proceed with `terraform apply` on 14 resources (2 destroys) in shared-networking?",
   "decisionFact": "The plan destroys 2 resources in a shared module.",
   "risky": true,
   "askContext": "Plan: 12 to change, 2 to destroy. Proceed with terraform apply?",
   "canReply": true,
   "project": "harbor",
   "subchannel": "harbor/Networking",
   "chatLabel": "harbor · Networking (Codex)",
   "prRef": null
  },
  {
   "id": "ny-net30",
   "kind": "suggestion",
   "title": "Clarify: does \"net 30\" start at the invoice date or the delivery date?",
   "body": "Invoice date or delivery date?",
   "options": [
    "Answer question"
   ],
   "threadKey": "codex:ny-net30",
   "createdAt": "2026-11-23T02:00:00.000Z",
   "askedAt": "2026-11-23T02:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Clarify: does \"net 30\" start at the invoice date or the delivery date?",
   "decisionFact": "The answer changes how due dates are computed for 1,240 open invoices.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "ledger",
   "subchannel": null,
   "chatLabel": "ledger · General (Codex)",
   "prRef": null,
   "meta": {
    "plan": {
     "label": "Due-date fix",
     "nextAction": "Answer which date \"net 30\" counts from; the agent then updates the due-date calculation and backfills open invoices."
    }
   }
  },
  {
   "id": "ny-a11y",
   "kind": "agent-ask",
   "title": "Review the accessibility audit findings before the agent files issues",
   "body": "File all 23, or review the 4 contrast findings first?",
   "options": [
    "File all",
    "Review contrast first"
   ],
   "threadKey": "codex:ny-a11y",
   "createdAt": "2026-11-22T16:00:00.000Z",
   "askedAt": "2026-11-22T16:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Review the accessibility audit findings before the agent files issues",
   "decisionFact": "Some findings may be intentional design choices.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "atlas",
   "subchannel": "atlas/Accessibility",
   "chatLabel": "atlas · Accessibility (Codex)",
   "prRef": null
  },
  {
   "id": "ny-idle",
   "kind": "agent-ask",
   "title": "Session idle 3h — keep it, archive it, or hand it to another agent?",
   "body": "Keep, archive, or hand off?",
   "options": [
    "Keep",
    "Archive",
    "Hand off"
   ],
   "threadKey": "codex:ny-idle",
   "createdAt": "2026-11-22T10:00:00.000Z",
   "askedAt": "2026-11-22T10:00:00.000Z",
   "needsYou": true,
   "decisionHeadline": "Session idle 3h — keep it, archive it, or hand it to another agent?",
   "decisionFact": "The session stopped mid-task with no question.",
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "general",
   "subchannel": null,
   "chatLabel": "general · General (Codex)",
   "prRef": null
  },
  {
   "id": "fyi-docs",
   "kind": "completed",
   "title": "Finished: docs typo sweep (no action needed)",
   "body": "",
   "options": [
    "got it"
   ],
   "threadKey": "codex:fyi-docs",
   "createdAt": "2026-11-23T11:12:00.000Z",
   "askedAt": "2026-11-23T11:12:00.000Z",
   "needsYou": false,
   "decisionHeadline": "Finished: docs typo sweep (no action needed)",
   "decisionFact": null,
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "atlas",
   "subchannel": null,
   "chatLabel": "atlas · General (Codex)",
   "prRef": null
  },
  {
   "id": "fyi-deps",
   "kind": "completed",
   "title": "Finished: dependency bump in harbor; all checks green",
   "body": "",
   "options": [
    "got it"
   ],
   "threadKey": "codex:fyi-deps",
   "createdAt": "2026-11-23T10:00:00.000Z",
   "askedAt": "2026-11-23T10:00:00.000Z",
   "needsYou": false,
   "decisionHeadline": "Finished: dependency bump in harbor; all checks green",
   "decisionFact": null,
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "harbor",
   "subchannel": null,
   "chatLabel": "harbor · General (Codex)",
   "prRef": null
  },
  {
   "id": "fyi-err",
   "kind": "session-error",
   "title": "Session error recovered automatically: rate limit on the invoice export job",
   "body": "",
   "options": [
    "got it"
   ],
   "threadKey": "codex:fyi-err",
   "createdAt": "2026-11-23T08:30:00.000Z",
   "askedAt": "2026-11-23T08:30:00.000Z",
   "needsYou": false,
   "decisionHeadline": "Session error recovered automatically: rate limit on the invoice export job",
   "decisionFact": null,
   "risky": false,
   "askContext": null,
   "canReply": true,
   "project": "ledger",
   "subchannel": null,
   "chatLabel": "ledger · General (Codex)",
   "prRef": null
  }
 ],
 "cards": [
  {
   "id": "ny-deploy",
   "questionId": "ny-deploy",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Merge PR #412 and deploy the checkout redesign to production?",
   "needsYou": true,
   "decisionHeadline": "Merge PR #412 and deploy the checkout redesign to production?",
   "decisionFact": "Merging deploys to production. Only you can approve a production deploy.",
   "brief": {
    "context": "Ship the redesigned checkout so mobile conversion stops dropping at the address step.",
    "whatChanged": "PR #412 is green: 214 tests pass, the visual diff shows 3 intended changes, and the staging smoke test finished 18 minutes ago.",
    "decision": "Merge and deploy now, merge and hold the deploy until Monday, or send it back with changes."
   },
   "recommendation": "Merge and hold the deploy until Monday morning, when support is staffed.",
   "summary": "PR #412 is green: 214 tests pass, the visual diff shows 3 intended changes, and the staging smoke test finished 18 minutes ago.",
   "canReply": true,
   "threadKey": "codex:ny-deploy",
   "threadKeys": [
    "codex:ny-deploy"
   ],
   "project": "atlas",
   "subchannel": "atlas/Checkout",
   "workspace": "atlas",
   "repo": "acme/atlas",
   "prRef": "acme/atlas#412",
   "ciState": "SUCCESS",
   "noticedAt": "2026-11-23T11:36:00.000Z",
   "risky": true,
   "options": [
    "Merge & deploy",
    "Merge, hold deploy",
    "Request changes"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Merge & deploy",
    "value": "Merge & deploy"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-ci",
   "questionId": "ny-ci",
   "kind": "ci_failed",
   "kindLabel": "Checks failing",
   "headline": "Checks failing on PR #418 (search indexing): fix forward or revert the indexer change?",
   "needsYou": true,
   "decisionHeadline": "Checks failing on PR #418 (search indexing): fix forward or revert the indexer change?",
   "decisionFact": "The indexer change broke two integration tests; the agent stopped instead of guessing which behavior is right.",
   "brief": {
    "context": "Make search results include archived projects.",
    "whatChanged": "2 of 61 checks fail: search.archived and search.pagination time out after the indexer change.",
    "decision": "Fix forward in this PR, or revert the indexer change and land the UI part alone?"
   },
   "recommendation": "Fix forward: the failure is a missing index, not a logic error.",
   "summary": "2 of 61 checks fail: search.archived and search.pagination time out after the indexer change.",
   "canReply": true,
   "threadKey": "codex:ny-ci",
   "threadKeys": [
    "codex:ny-ci"
   ],
   "project": "atlas",
   "subchannel": "atlas/Search",
   "workspace": "atlas",
   "repo": "acme/atlas",
   "prRef": "acme/atlas#418",
   "ciState": "FAILURE",
   "noticedAt": "2026-11-23T10:48:00.000Z",
   "risky": false,
   "options": [
    "Fix forward",
    "Revert indexer"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Fix forward",
    "value": "Fix forward"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-region",
   "questionId": "ny-region",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Which region should the staging cluster move to: us-east-2 or eu-west-1? The agent compared latency, cost, and the data-residency note in the customer contract and can proceed either way once you pick.",
   "needsYou": true,
   "decisionHeadline": "Which region should the staging cluster move to: us-east-2 or eu-west-1? The agent compared latency, cost, and the data-residency note in the customer contract and can proceed either way once you pick.",
   "decisionFact": "The contract's data-residency clause is ambiguous, so the agent needs your call.",
   "brief": {
    "context": "Move staging off the retiring us-west-1 cluster before Dec 15.",
    "whatChanged": "Both regions are provisioned and tested. eu-west-1 is 11% cheaper; us-east-2 is 40 ms faster for the US team.",
    "decision": "us-east-2 or eu-west-1?"
   },
   "recommendation": null,
   "summary": "Both regions are provisioned and tested. eu-west-1 is 11% cheaper; us-east-2 is 40 ms faster for the US team.",
   "canReply": true,
   "threadKey": "codex:ny-region",
   "threadKeys": [
    "codex:ny-region"
   ],
   "project": "harbor",
   "subchannel": "harbor/Clusters",
   "workspace": "harbor",
   "repo": "acme/harbor",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T09:30:00.000Z",
   "risky": false,
   "options": [
    "us-east-2",
    "eu-west-1"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "us-east-2",
    "value": "us-east-2"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-key",
   "questionId": "ny-key",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Approve rotating the CI deploy key (expires in 3 days)",
   "needsYou": true,
   "decisionHeadline": "Approve rotating the CI deploy key (expires in 3 days)",
   "decisionFact": "Rotation needs an owner-approved key in the vault.",
   "brief": {
    "context": "Keep CI deploys working past the key expiry on Nov 26.",
    "whatChanged": "New key generated and staged; old key still active.",
    "decision": "Approve the rotation now, or schedule it for Wednesday's maintenance window?"
   },
   "recommendation": null,
   "summary": "New key generated and staged; old key still active.",
   "canReply": true,
   "threadKey": "codex:ny-key",
   "threadKeys": [
    "codex:ny-key"
   ],
   "project": "harbor",
   "subchannel": "harbor/CI",
   "workspace": "harbor",
   "repo": "acme/harbor",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T09:00:00.000Z",
   "risky": false,
   "options": [
    "Rotate now",
    "Schedule Wednesday"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Rotate now",
    "value": "Rotate now"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-refund",
   "questionId": "ny-refund",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Refund policy edge case: partial refunds on annual plans",
   "needsYou": true,
   "decisionHeadline": "Refund policy edge case: partial refunds on annual plans",
   "decisionFact": "The policy doc doesn't cover partial refunds after month 6.",
   "brief": {
    "context": "Finish the self-serve refund flow.",
    "whatChanged": "Flow done for monthly plans; annual plans blocked on this rule.",
    "decision": "Prorate by month used, or offer account credit only?"
   },
   "recommendation": null,
   "summary": "Flow done for monthly plans; annual plans blocked on this rule.",
   "canReply": true,
   "threadKey": "codex:ny-refund",
   "threadKeys": [
    "codex:ny-refund"
   ],
   "project": "ledger",
   "subchannel": "ledger/Refunds",
   "workspace": "ledger",
   "repo": "acme/ledger",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T08:00:00.000Z",
   "risky": false,
   "options": [
    "Prorate",
    "Credit only"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Prorate",
    "value": "Prorate"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-pr77",
   "questionId": "ny-pr77",
   "kind": "merge_ready",
   "kindLabel": "PR ready",
   "headline": "PR #77 ready: invoice PDF footer fix",
   "needsYou": true,
   "decisionHeadline": "PR #77 ready: invoice PDF footer fix",
   "decisionFact": "Merging to main needs your approval under the current merge policy.",
   "brief": {
    "context": "Fix the cut-off footer on multi-page invoices.",
    "whatChanged": "Green CI, one approval, no conflicts.",
    "decision": "Merge PR #77?"
   },
   "recommendation": null,
   "summary": "Green CI, one approval, no conflicts.",
   "canReply": true,
   "threadKey": "codex:ny-pr77",
   "threadKeys": [
    "codex:ny-pr77"
   ],
   "project": "ledger",
   "subchannel": null,
   "workspace": "ledger",
   "repo": "acme/ledger",
   "prRef": "acme/ledger#77",
   "ciState": "SUCCESS",
   "noticedAt": "2026-11-23T07:00:00.000Z",
   "risky": false,
   "options": [
    "Merge",
    "Not yet"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Merge",
    "value": "Merge"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-name",
   "questionId": "ny-name",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Pick the name for the new onboarding checklist",
   "needsYou": true,
   "decisionHeadline": "Pick the name for the new onboarding checklist",
   "decisionFact": "Copy decisions are yours.",
   "brief": {
    "context": null,
    "whatChanged": null,
    "decision": "\"Getting started\", \"Setup checklist\", or \"First steps\"?"
   },
   "recommendation": null,
   "summary": null,
   "canReply": true,
   "threadKey": "codex:ny-name",
   "threadKeys": [
    "codex:ny-name"
   ],
   "project": "general",
   "subchannel": null,
   "workspace": "general",
   "repo": "acme/general",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T06:00:00.000Z",
   "risky": false,
   "options": [
    "Getting started",
    "Setup checklist",
    "First steps"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Getting started",
    "value": "Getting started"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-v1",
   "questionId": "ny-v1",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Keep the legacy /v1 search endpoint for 30 more days?",
   "needsYou": true,
   "decisionHeadline": "Keep the legacy /v1 search endpoint for 30 more days?",
   "decisionFact": "Two customers still call /v1 daily.",
   "brief": {
    "context": null,
    "whatChanged": "Deprecation notice sent Oct 30; traffic down 92%.",
    "decision": "Remove now, or keep 30 more days?"
   },
   "recommendation": null,
   "summary": "Deprecation notice sent Oct 30; traffic down 92%.",
   "canReply": true,
   "threadKey": "codex:ny-v1",
   "threadKeys": [
    "codex:ny-v1"
   ],
   "project": "atlas",
   "subchannel": "atlas/Search",
   "workspace": "atlas",
   "repo": "acme/atlas",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T05:00:00.000Z",
   "risky": false,
   "options": [
    "Keep 30 days",
    "Remove now"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Keep 30 days",
    "value": "Keep 30 days"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-tf",
   "questionId": "ny-tf",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "codex:7f3a91 asked: proceed with `terraform apply` on 14 resources (2 destroys) in shared-networking?",
   "needsYou": true,
   "decisionHeadline": "codex:7f3a91 asked: proceed with `terraform apply` on 14 resources (2 destroys) in shared-networking?",
   "decisionFact": "The plan destroys 2 resources in a shared module.",
   "brief": {
    "context": "Replace the NAT gateways with the managed version.",
    "whatChanged": "Plan reviewed: 12 changes, 2 destroys (old NAT gateways).",
    "decision": "Apply the plan, or stop and review the destroys first?"
   },
   "recommendation": "Review the destroys first: one gateway still has active routes.",
   "summary": "Plan reviewed: 12 changes, 2 destroys (old NAT gateways).",
   "canReply": true,
   "threadKey": "codex:ny-tf",
   "threadKeys": [
    "codex:ny-tf"
   ],
   "project": "harbor",
   "subchannel": "harbor/Networking",
   "workspace": "harbor",
   "repo": "acme/harbor",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T04:00:00.000Z",
   "risky": true,
   "options": [
    "Apply",
    "Stop, review destroys"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Apply",
    "value": "Apply"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-net30",
   "questionId": "ny-net30",
   "kind": "suggestion",
   "kindLabel": "Needs your decision",
   "headline": "Clarify: does \"net 30\" start at the invoice date or the delivery date?",
   "needsYou": true,
   "decisionHeadline": "Clarify: does \"net 30\" start at the invoice date or the delivery date?",
   "decisionFact": "The answer changes how due dates are computed for 1,240 open invoices.",
   "brief": {
    "context": null,
    "whatChanged": null,
    "decision": "Invoice date or delivery date?"
   },
   "recommendation": null,
   "summary": null,
   "canReply": true,
   "threadKey": "codex:ny-net30",
   "threadKeys": [
    "codex:ny-net30"
   ],
   "project": "ledger",
   "subchannel": null,
   "workspace": "ledger",
   "repo": "acme/ledger",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T02:00:00.000Z",
   "risky": false,
   "options": [
    "Answer question"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Answer question",
    "value": "Answer question"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-a11y",
   "questionId": "ny-a11y",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Review the accessibility audit findings before the agent files issues",
   "needsYou": true,
   "decisionHeadline": "Review the accessibility audit findings before the agent files issues",
   "decisionFact": "Some findings may be intentional design choices.",
   "brief": {
    "context": null,
    "whatChanged": "23 findings: 4 contrast, 9 missing labels, 10 focus-order.",
    "decision": "File all 23, or review the 4 contrast findings first?"
   },
   "recommendation": null,
   "summary": "23 findings: 4 contrast, 9 missing labels, 10 focus-order.",
   "canReply": true,
   "threadKey": "codex:ny-a11y",
   "threadKeys": [
    "codex:ny-a11y"
   ],
   "project": "atlas",
   "subchannel": "atlas/Accessibility",
   "workspace": "atlas",
   "repo": "acme/atlas",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-22T16:00:00.000Z",
   "risky": false,
   "options": [
    "File all",
    "Review contrast first"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "File all",
    "value": "File all"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "ny-idle",
   "questionId": "ny-idle",
   "kind": "agent-ask",
   "kindLabel": "Needs your decision",
   "headline": "Session idle 3h — keep it, archive it, or hand it to another agent?",
   "needsYou": true,
   "decisionHeadline": "Session idle 3h — keep it, archive it, or hand it to another agent?",
   "decisionFact": "The session stopped mid-task with no question.",
   "brief": {
    "context": null,
    "whatChanged": null,
    "decision": "Keep, archive, or hand off?"
   },
   "recommendation": null,
   "summary": null,
   "canReply": true,
   "threadKey": "codex:ny-idle",
   "threadKeys": [
    "codex:ny-idle"
   ],
   "project": "general",
   "subchannel": null,
   "workspace": "general",
   "repo": "acme/general",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-22T10:00:00.000Z",
   "risky": false,
   "options": [
    "Keep",
    "Archive",
    "Hand off"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Keep",
    "value": "Keep"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "fyi-docs",
   "questionId": "fyi-docs",
   "kind": "completed",
   "kindLabel": "Needs your decision",
   "headline": "Finished: docs typo sweep (no action needed)",
   "needsYou": false,
   "decisionHeadline": "Finished: docs typo sweep (no action needed)",
   "decisionFact": null,
   "brief": {
    "context": null,
    "whatChanged": null,
    "decision": null
   },
   "recommendation": null,
   "summary": null,
   "canReply": true,
   "threadKey": "codex:fyi-docs",
   "threadKeys": [
    "codex:fyi-docs"
   ],
   "project": "atlas",
   "subchannel": null,
   "workspace": "atlas",
   "repo": "acme/atlas",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T11:12:00.000Z",
   "risky": false,
   "options": [
    "got it"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "got it",
    "value": "got it"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "fyi-deps",
   "questionId": "fyi-deps",
   "kind": "completed",
   "kindLabel": "Needs your decision",
   "headline": "Finished: dependency bump in harbor; all checks green",
   "needsYou": false,
   "decisionHeadline": "Finished: dependency bump in harbor; all checks green",
   "decisionFact": null,
   "brief": {
    "context": null,
    "whatChanged": null,
    "decision": null
   },
   "recommendation": null,
   "summary": null,
   "canReply": true,
   "threadKey": "codex:fyi-deps",
   "threadKeys": [
    "codex:fyi-deps"
   ],
   "project": "harbor",
   "subchannel": null,
   "workspace": "harbor",
   "repo": "acme/harbor",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T10:00:00.000Z",
   "risky": false,
   "options": [
    "got it"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "got it",
    "value": "got it"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  },
  {
   "id": "fyi-err",
   "questionId": "fyi-err",
   "kind": "session-error",
   "kindLabel": "Needs your decision",
   "headline": "Session error recovered automatically: rate limit on the invoice export job",
   "needsYou": false,
   "decisionHeadline": "Session error recovered automatically: rate limit on the invoice export job",
   "decisionFact": null,
   "brief": {
    "context": null,
    "whatChanged": null,
    "decision": null
   },
   "recommendation": null,
   "summary": null,
   "canReply": true,
   "threadKey": "codex:fyi-err",
   "threadKeys": [
    "codex:fyi-err"
   ],
   "project": "ledger",
   "subchannel": null,
   "workspace": "ledger",
   "repo": "acme/ledger",
   "prRef": null,
   "ciState": null,
   "noticedAt": "2026-11-23T08:30:00.000Z",
   "risky": false,
   "options": [
    "got it"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "got it",
    "value": "got it"
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "later"
   }
  }
 ],
 "activityEvents": []
}
"""#

    /// `--ui-decision-view-fixture`: synthetic decision-contract cards (the
    /// server's card.decisionView, src/fleet/decision-view.js). The
    /// regression card reproduces a merge-or-wait decision whose old
    /// rendering printed a raw PR table, internal routing, a recommendation
    /// contradicting the primary button, duplicate option rows and a
    /// prefilled bypass reply. Then a sparse card (every section unknown),
    /// a card with an unknown recommendation, and the same card as an older
    /// hub sends it (no decisionView), which keeps the previous rendering.
    static let decisionViewStateJSON = #"""
{
 "mode": "propose",
 "enabled": true,
 "running": false,
 "lastTickAt": "2026-11-26T16:00:00.000Z",
 "snapshot": {
  "at": "2026-11-26T16:00:00.000Z",
  "threads": []
 },
 "questions": [],
 "cards": [
  {
   "id": "fq_regression",
   "questionId": "fq_regression",
   "kind": "approval",
   "kindLabel": "Needs Decision",
   "rank": 1,
   "headline": "example #1201/#1202: merge or wait?",
   "needsYou": true,
   "ownerBlocker": false,
   "decisionHeadline": "example #1201/#1202: merge or wait?",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "decisionSource": {
    "questionId": "fq_regression",
    "threadKey": "paseo:srv_test.00000000-0000-0000-0000-000000000001",
    "threadKeys": []
   },
   "decisionAction": {
    "op": "answer",
    "value": "wait for teammate review",
    "label": "Wait for teammate review"
   },
   "askType": "decision",
   "contextStatus": "complete",
   "decisionContext": {
    "askType": "decision",
    "itemName": "Sales v1 PR review",
    "goal": "Finish the remaining Sales call-type admission work. Route to the existing Sales v1 PR review owner if viable.",
    "assignment": "Finish the Sales flag consolidation PRs and get them merged once verified",
    "verified": null,
    "changed": "Agent's latest update: Both flag PRs are now merge-ready, apart from the required review: | PR | Certificate | Conflicts | Threads | Blocker | |---|---|---|---|---| | #1201 reports flag consolidation | ✅ passed | none | 0 | 1 approving review | | #1202 integrations flag consolidation | ✅ passed | none…",
    "blocked": "Merging needs your approval because you review every merge.",
    "status": "#1201 reports flag consolidation: Certificate: ✅ passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.",
    "groups": null,
    "details": "Changed: Agent's latest update: Both flag PRs are now merge-ready, apart from the required review: | PR | Certificate | Conflicts | Threads | Blocker | |---|---|---|---|---| | #1201 reports flag consolidation | ✅ passed | none | 0 | 1 approving review | | #1202 integrations flag consolidation | ✅ passed | none…\nBlocked: Merging needs your approval because you review every merge.",
    "decision": "[3. Decision] Choose whether to use admin rights to merge both without the required teammate approval, or wait for an independent review.",
    "options": [
     {
      "label": "Merge both",
      "consequence": null
     },
     {
      "label": "Wait for teammate review",
      "consequence": null
     }
    ],
    "recommendation": "Recommend: Wait for teammate review on both PRs, then merge.",
    "sources": [],
    "missing": [],
    "complete": true,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "1. **Goal:** Sales v1 PR review. Finish the remaining Sales call-type admission work. Route to the existing Sales v1 PR review owner if viable.\n2. **You asked the agent to:** Finish the Sales flag consolidation PRs and get them merged once verified\n3. **Where it stands:** #1201 reports flag consolidation: Certificate: ✅ passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.\n4. **Decision now:** [3. Decision] Choose whether to use admin rights to merge both without the required teammate approval, or wait for an independent review. Options: Merge both; Wait for teammate review. Tradeoffs: not stated by the agent. Recommend: Wait for teammate review on both PRs, then merge."
   },
   "decisionView": {
    "version": 1,
    "goal": {
     "title": "Sales v1 PR review",
     "text": "Finish the remaining Sales call-type admission work.",
     "unknown": false
    },
    "status": {
     "done": [
      "GitHub shows no other failing checks on either."
     ],
     "blocked": [
      "Merging needs your approval because you review every merge.",
      "#1201 reports flag consolidation: Certificate: ✅ passed, Conflicts: none, Threads: 0, Blocker: 1 approving review."
     ],
     "unverified": [
      "The post-merge verification on main is still pending."
     ],
     "prs": [
      {
       "ref": "#1201",
       "title": "reports flag consolidation",
       "facts": [
        "Certificate: passed",
        "Conflicts: none",
        "Threads: 0",
        "Blocker: 1 approving review"
       ]
      },
      {
       "ref": "#1202",
       "title": "integrations flag consolidation",
       "facts": [
        "Certificate: passed",
        "Conflicts: none",
        "Threads: 5/5 resolved",
        "Blocker: 1 approving review"
       ]
      }
     ],
     "unknown": false
    },
    "decision": {
     "question": "Choose whether to use admin rights to merge both without the required teammate approval, or wait for an independent review.",
     "options": [
      {
       "value": "merge both",
       "label": "Merge both",
       "consequence": "Admin bypass: merges without the required review",
       "adminBypass": true,
       "recommended": false
      },
      {
       "value": "wait for teammate review",
       "label": "Wait for teammate review",
       "consequence": null,
       "adminBypass": false,
       "recommended": true
      }
     ],
     "unknown": false
    },
    "recommendation": {
     "option": "wait for teammate review",
     "label": "Wait for teammate review",
     "why": "Wait for teammate review on both PRs, then merge.",
     "unknown": false
    },
    "unknowns": [],
    "evidence": []
   },
   "sessionTitle": "Sales v1 PR review",
   "summary": "…d | none | 0 | 1 approving review |\n| **#1202** integrations flag consolidation | ✅ passed | none | 5/5 resolved | 1 approving review |\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?",
   "recommendation": "Recommend: Wait for teammate review on both PRs, then merge.",
   "brief": {
    "context": "Finish the remaining Sales call-type admission work.",
    "currentState": "Paused at a decision checkpoint — waiting for your call before continuing.",
    "whatChanged": "#1201 reports flag consolidation: Certificate: ✅ passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.",
    "decision": "Choose whether to use admin rights to merge both without the required teammate approval, or wait for an independent review.",
    "details": "Both flag PRs are now merge-ready, apart from the required review:\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?\n\nBlocked: Merging needs your approval because you review every merge.",
    "goal": "Finish the remaining Sales call-type admission work.",
    "assignment": "Finish the Sales flag consolidation PRs and get them merged once verified",
    "whereItStands": "#1201 reports flag consolidation: Certificate: ✅ passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.",
    "verified": null,
    "blocked": "Merging needs your approval because you review every merge.",
    "options": [
     {
      "label": "Merge both",
      "consequence": null
     },
     {
      "label": "Wait for teammate review",
      "consequence": null
     }
    ],
    "sources": [],
    "missing": []
   },
   "suggestedReplies": [],
   "canReply": true,
   "agentSummary": "Both flag PRs are now merge-ready, apart from the required review:\n\n| PR | Certificate | Conflicts | Threads | Blocker |\n|---|---|---|---|---|\n| **#1201** reports flag consolidation | ✅ passed | none | 0 | 1 approving review |\n| **#1202** integrations flag consolidation | ✅ passed | none | 5/5 resolved | 1 approving review |\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?",
   "prContext": null,
   "recentMessages": [
    {
     "role": "user",
     "text": "Finish the Sales flag consolidation PRs and get them merged once verified",
     "at": null
    },
    {
     "role": "assistant",
     "text": "Both flag PRs are now merge-ready, apart from the required review:\n\n| PR | Certificate | Conflicts | Threads | Blocker |\n|---|---|---|---|---|\n| **#1201** reports flag consolidation | ✅ passed | none | 0 | 1 approving review |\n| **#1202** integrations flag consolidation | ✅ passed | none | 5/5 resolved | 1 approving review |\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?",
     "at": "2026-11-26T15:50:27Z"
    }
   ],
   "threadKey": "paseo:srv_test.00000000-0000-0000-0000-000000000001",
   "threadKeys": [
    "paseo:srv_test.00000000-0000-0000-0000-000000000001"
   ],
   "repo": null,
   "branch": null,
   "workspace": null,
   "prRef": null,
   "prUrl": null,
   "prNumber": null,
   "headSha": null,
   "ciState": null,
   "mergeState": null,
   "noticedAt": null,
   "answerIn": "here",
   "risky": false,
   "options": [
    "merge both",
    "wait for teammate review"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Wait for teammate review",
    "value": "wait for teammate review",
    "destructive": false,
    "recommended": true
   },
   "secondaryAction": {
    "op": "answer",
    "label": "Merge both (admin bypass)",
    "value": "merge both",
    "destructive": false,
    "adminBypass": true
   },
   "extraActions": [
    {
     "op": "defer",
     "label": "Later",
     "value": "dismiss",
     "destructive": false
    }
   ],
   "timeline": [
    {
     "at": null,
     "label": "Needs your call",
     "detail": "example #1201/#1202: merge or wait?"
    }
   ],
   "resources": [
    {
     "kind": "conversation",
     "label": "Sales v1 PR review",
     "url": null,
     "threadKey": "paseo:srv_test.00000000-0000-0000-0000-000000000001",
     "serverId": "srv_test",
     "agentId": "00000000-0000-0000-0000-000000000001"
    }
   ],
   "openChat": {
    "app": "paseo",
    "url": null,
    "label": "Sales v1 PR review (Paseo)",
    "serverId": "srv_test",
    "agentId": "00000000-0000-0000-0000-000000000001",
    "note": "Open this existing chat on its Paseo host."
   },
   "project": "general",
   "actorLabel": null,
   "subchannel": null,
   "labels": [
    "state=waiting"
   ],
   "blockingCount": 0,
   "blockingSummary": null
  },
  {
   "id": "fq_sparse",
   "questionId": "fq_sparse",
   "kind": "approval",
   "kindLabel": "Needs Decision",
   "rank": 1,
   "headline": "Needs your decision",
   "needsYou": true,
   "ownerBlocker": false,
   "decisionHeadline": "Review this decision",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "decisionSource": {
    "questionId": "fq_sparse",
    "threadKey": null,
    "threadKeys": []
   },
   "decisionAction": {
    "op": "defer",
    "value": "dismiss",
    "label": "Dismiss"
   },
   "askType": "decision",
   "contextStatus": "incomplete",
   "decisionContext": {
    "askType": "decision",
    "itemName": null,
    "goal": null,
    "assignment": null,
    "verified": null,
    "changed": null,
    "blocked": null,
    "status": null,
    "groups": null,
    "details": null,
    "decision": null,
    "options": [],
    "recommendation": "Recommend: Open details or reply below with your call on the blocker above.",
    "sources": [],
    "missing": [
     "goal",
     "assignment",
     "progress",
     "blocked",
     "decision"
    ],
    "complete": false,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "4. **Decision now:** Recommend: Open details or reply below with your call on the blocker above."
   },
   "decisionView": {
    "version": 1,
    "goal": {
     "title": null,
     "text": null,
     "unknown": true
    },
    "status": {
     "done": [],
     "blocked": [],
     "unverified": [],
     "prs": [],
     "unknown": true
    },
    "decision": {
     "question": null,
     "options": [],
     "unknown": true
    },
    "recommendation": {
     "option": null,
     "label": null,
     "why": null,
     "unknown": true
    },
    "unknowns": [
     "Goal: not stated in the source",
     "Done: nothing confirmed as done in the source",
     "Unverified: the source does not say what is still unverified",
     "Decision: the exact choice is not stated in the source",
     "Recommendation: none given"
    ],
    "evidence": []
   },
   "sessionTitle": null,
   "summary": "Waiting for your decision.",
   "recommendation": "Recommend: Open details or reply below with your call on the blocker above.",
   "brief": {
    "context": null,
    "currentState": "Paused at a decision checkpoint — waiting for your call before continuing.",
    "whatChanged": null,
    "decision": "Needs your decision",
    "details": null,
    "goal": null,
    "assignment": null,
    "whereItStands": null,
    "verified": null,
    "blocked": null,
    "options": [],
    "sources": [],
    "missing": [
     "goal",
     "assignment",
     "progress",
     "blocked",
     "decision"
    ]
   },
   "suggestedReplies": [],
   "canReply": false,
   "agentSummary": null,
   "prContext": null,
   "recentMessages": [],
   "threadKey": null,
   "threadKeys": [],
   "repo": null,
   "branch": null,
   "workspace": null,
   "prRef": null,
   "prUrl": null,
   "prNumber": null,
   "headSha": null,
   "ciState": null,
   "mergeState": null,
   "noticedAt": null,
   "answerIn": "here",
   "risky": false,
   "options": [],
   "primaryAction": {
    "op": "defer",
    "label": "Dismiss",
    "value": "dismiss",
    "destructive": false
   },
   "secondaryAction": null,
   "extraActions": [],
   "timeline": [
    {
     "at": null,
     "label": "Needs your call",
     "detail": "Needs your decision"
    }
   ],
   "resources": [],
   "openChat": null,
   "project": "general",
   "actorLabel": null,
   "subchannel": null,
   "labels": [
    "state=waiting"
   ],
   "blockingCount": 0,
   "blockingSummary": null
  },
  {
   "id": "fq_old",
   "questionId": "fq_old",
   "kind": "approval",
   "kindLabel": "Needs Decision",
   "rank": 1,
   "headline": "Merge #77 over the required review?",
   "needsYou": true,
   "ownerBlocker": false,
   "decisionHeadline": "Merge #77 over the required review?",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "decisionSource": {
    "questionId": "fq_old",
    "threadKey": "paseo:s.old",
    "threadKeys": []
   },
   "decisionAction": {
    "op": "answer",
    "value": "wait for review",
    "label": "Wait for review"
   },
   "askType": "decision",
   "contextStatus": "incomplete",
   "decisionContext": {
    "askType": "decision",
    "itemName": null,
    "goal": "Ship the release notes fix",
    "assignment": "Ship the release notes fix",
    "verified": null,
    "changed": null,
    "blocked": null,
    "status": "CI is green on #77.",
    "groups": null,
    "details": null,
    "decision": "Should I merge #77 over the required review with your admin rights, or wait for review?",
    "options": [
     {
      "label": "Merge now",
      "consequence": null
     },
     {
      "label": "Wait for review",
      "consequence": null
     }
    ],
    "recommendation": "Recommend: \"Merge now\" if the caveats above look right — otherwise pick another option or reply below.",
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ],
    "complete": false,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "1. **Goal:** Ship the release notes fix\n3. **Where it stands:** CI is green on #77.\n4. **Decision now:** Should I merge #77 over the required review with your admin rights, or wait for review? Options: Merge now; Wait for review. Tradeoffs: not stated by the agent. Recommend: \"Merge now\" if the caveats above look right — otherwise pick another option or reply below."
   },
   "decisionView": {
    "version": 1,
    "goal": {
     "title": null,
     "text": "Ship the release notes fix",
     "unknown": false
    },
    "status": {
     "done": [
      "CI is green on #77."
     ],
     "blocked": [],
     "unverified": [],
     "prs": [],
     "unknown": false
    },
    "decision": {
     "question": "Should I merge #77 over the required review with your admin rights, or wait for review?",
     "options": [
      {
       "value": "merge now",
       "label": "Merge now",
       "consequence": "Admin bypass: merges without the required review",
       "adminBypass": true,
       "recommended": false
      },
      {
       "value": "wait for review",
       "label": "Wait for review",
       "consequence": null,
       "adminBypass": false,
       "recommended": false
      }
     ],
     "unknown": false
    },
    "recommendation": {
     "option": null,
     "label": null,
     "why": null,
     "unknown": true
    },
    "unknowns": [
     "Unverified: the source does not say what is still unverified",
     "Recommendation: none given"
    ],
    "evidence": []
   },
   "sessionTitle": null,
   "summary": "Should I merge #77 over the required review with your admin rights, or wait for review?",
   "recommendation": null,
   "brief": {
    "context": "Ship the release notes fix",
    "currentState": "Paused at a decision checkpoint — waiting for your call before continuing.",
    "whatChanged": "CI is green on #77.",
    "decision": "Should I merge #77 over the required review with your admin rights, or wait for review?",
    "details": "Should I merge #77 over the required review with your admin rights, or wait for review?",
    "goal": "Ship the release notes fix",
    "assignment": "Ship the release notes fix",
    "whereItStands": "CI is green on #77.",
    "verified": null,
    "blocked": null,
    "options": [
     {
      "label": "Merge now",
      "consequence": null
     },
     {
      "label": "Wait for review",
      "consequence": null
     }
    ],
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ]
   },
   "suggestedReplies": [
    "Proceed with the recommended option above",
    "Approved — finish all remaining in-scope items",
    "Hold off — tell me what's still unverified first"
   ],
   "canReply": true,
   "agentSummary": null,
   "prContext": null,
   "recentMessages": [
    {
     "role": "user",
     "text": "Ship the release notes fix",
     "at": null
    },
    {
     "role": "assistant",
     "text": "CI is green on #77. Should I merge #77 over the required review with your admin rights, or wait for review?",
     "at": null
    }
   ],
   "threadKey": "paseo:s.old",
   "threadKeys": [
    "paseo:s.old"
   ],
   "repo": null,
   "branch": null,
   "workspace": null,
   "prRef": null,
   "prUrl": null,
   "prNumber": null,
   "headSha": null,
   "ciState": null,
   "mergeState": null,
   "noticedAt": null,
   "answerIn": "here",
   "risky": false,
   "options": [
    "merge now",
    "wait for review"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Wait for review",
    "value": "wait for review",
    "destructive": false
   },
   "secondaryAction": {
    "op": "answer",
    "label": "Merge now (admin bypass)",
    "value": "merge now",
    "destructive": false,
    "adminBypass": true
   },
   "extraActions": [
    {
     "op": "defer",
     "label": "Later",
     "value": "dismiss",
     "destructive": false
    }
   ],
   "timeline": [
    {
     "at": null,
     "label": "Needs your call",
     "detail": "Merge #77 over the required review?"
    }
   ],
   "resources": [
    {
     "kind": "conversation",
     "label": "Agent conversation",
     "url": null,
     "threadKey": "paseo:s.old",
     "serverId": "s",
     "agentId": "old"
    }
   ],
   "openChat": {
    "app": "paseo",
    "url": null,
    "label": "Paseo chat (Paseo)",
    "serverId": "s",
    "agentId": "old",
    "note": "Open this existing chat on its Paseo host."
   },
   "project": "general",
   "actorLabel": null,
   "subchannel": null,
   "labels": [
    "state=waiting"
   ],
   "blockingCount": 0,
   "blockingSummary": null
  },
  {
   "id": "fq_legacy",
   "questionId": "fq_legacy",
   "kind": "approval",
   "kindLabel": "Needs Decision",
   "rank": 1,
   "headline": "Older hub: merge #78 over the required review?",
   "needsYou": true,
   "ownerBlocker": false,
   "decisionHeadline": "Older hub: merge #78 over the required review?",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "decisionSource": {
    "questionId": "fq_legacy",
    "threadKey": "paseo:s.legacy",
    "threadKeys": []
   },
   "decisionAction": {
    "op": "answer",
    "value": "wait for review",
    "label": "Wait for review"
   },
   "askType": "decision",
   "contextStatus": "incomplete",
   "decisionContext": {
    "askType": "decision",
    "itemName": null,
    "goal": "Ship the release notes fix",
    "assignment": "Ship the release notes fix",
    "verified": null,
    "changed": null,
    "blocked": null,
    "status": "CI is green on #77.",
    "groups": null,
    "details": null,
    "decision": "Should I merge #77 over the required review with your admin rights, or wait for review?",
    "options": [
     {
      "label": "Merge now",
      "consequence": null
     },
     {
      "label": "Wait for review",
      "consequence": null
     }
    ],
    "recommendation": "Recommend: \"Merge now\" if the caveats above look right — otherwise pick another option or reply below.",
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ],
    "complete": false,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "1. **Goal:** Ship the release notes fix\n3. **Where it stands:** CI is green on #77.\n4. **Decision now:** Should I merge #77 over the required review with your admin rights, or wait for review? Options: Merge now; Wait for review. Tradeoffs: not stated by the agent. Recommend: \"Merge now\" if the caveats above look right — otherwise pick another option or reply below."
   },
   "sessionTitle": null,
   "summary": "Should I merge #77 over the required review with your admin rights, or wait for review?",
   "recommendation": null,
   "brief": {
    "context": "Ship the release notes fix",
    "currentState": "Paused at a decision checkpoint — waiting for your call before continuing.",
    "whatChanged": "CI is green on #77.",
    "decision": "Should I merge #77 over the required review with your admin rights, or wait for review?",
    "details": "Should I merge #77 over the required review with your admin rights, or wait for review?",
    "goal": "Ship the release notes fix",
    "assignment": "Ship the release notes fix",
    "whereItStands": "CI is green on #77.",
    "verified": null,
    "blocked": null,
    "options": [
     {
      "label": "Merge now",
      "consequence": null
     },
     {
      "label": "Wait for review",
      "consequence": null
     }
    ],
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ]
   },
   "suggestedReplies": [
    "Proceed with the recommended option above",
    "Approved — finish all remaining in-scope items",
    "Hold off — tell me what's still unverified first"
   ],
   "canReply": true,
   "agentSummary": null,
   "prContext": null,
   "recentMessages": [
    {
     "role": "user",
     "text": "Ship the release notes fix",
     "at": null
    },
    {
     "role": "assistant",
     "text": "CI is green on #77. Should I merge #77 over the required review with your admin rights, or wait for review?",
     "at": null
    }
   ],
   "threadKey": "paseo:s.legacy",
   "threadKeys": [
    "paseo:s.legacy"
   ],
   "repo": null,
   "branch": null,
   "workspace": null,
   "prRef": null,
   "prUrl": null,
   "prNumber": null,
   "headSha": null,
   "ciState": null,
   "mergeState": null,
   "noticedAt": null,
   "answerIn": "here",
   "risky": false,
   "options": [
    "merge now",
    "wait for review"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Wait for review",
    "value": "wait for review",
    "destructive": false
   },
   "secondaryAction": {
    "op": "answer",
    "label": "Merge now",
    "value": "merge now",
    "destructive": false
   },
   "extraActions": [
    {
     "op": "defer",
     "label": "Later",
     "value": "dismiss",
     "destructive": false
    }
   ],
   "timeline": [
    {
     "at": null,
     "label": "Needs your call",
     "detail": "Merge #77 over the required review?"
    }
   ],
   "resources": [
    {
     "kind": "conversation",
     "label": "Agent conversation",
     "url": null,
     "threadKey": "paseo:s.legacy",
     "serverId": "s",
     "agentId": "legacy"
    }
   ],
   "openChat": {
    "app": "paseo",
    "url": null,
    "label": "Paseo chat (Paseo)",
    "serverId": "s",
    "agentId": "legacy",
    "note": "Open this existing chat on its Paseo host."
   },
   "project": "general",
   "actorLabel": null,
   "subchannel": null,
   "labels": [
    "state=waiting"
   ],
   "blockingCount": 0,
   "blockingSummary": null
  }
 ],
 "activityEvents": []
}
"""#
}
#endif
