// Synthetic decision cards for the four-part Needs You decision
// (src/fleet/decision-view.js): the Sales #8685/#8694 regression with its
// names replaced, a sparse card, an older-style card, and a legacy card
// from a hub before `decisionView`. Mirrors the hub's own example cards.
enum FleetDecisionViewFixture {
  /// Three hub cards, exactly as /fleet/api/state sends them.
  static let cardsJSON = #"""
[
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
     "Merging needs your approval because you review every merge."
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
   "whatChanged": "#1201 reports flag consolidation: Certificate: passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.",
   "decision": "Choose whether to use admin rights to merge both without the required teammate approval, or wait for an independent review.",
   "details": "Both flag PRs are now merge-ready, apart from the required review:\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?\n\nBlocked: Merging needs your approval because you review every merge.",
   "goal": "Finish the remaining Sales call-type admission work.",
   "assignment": "Finish the Sales flag consolidation PRs and get them merged once verified",
   "whereItStands": "#1201 reports flag consolidation: Certificate: passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.",
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
 }
]
"""#

  /// A whole state: the four questions and their cards (fq_legacy has no
  /// decisionView).
  static let stateJSON = #"""
{
 "mode": "propose",
 "enabled": true,
 "running": false,
 "lastTickAt": "2026-11-26T15:50:00.000Z",
 "questions": [
  {
   "id": "fq_regression",
   "kind": "approval",
   "title": "example #1201/#1202: merge or wait?",
   "body": "…d | none | 0 | 1 approving review |\n| **#1202** integrations flag consolidation | ✅ passed | none | 5/5 resolved | 1 approving review |\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?",
   "options": [
    "merge both",
    "wait for teammate review"
   ],
   "needsYou": true,
   "decisionHeadline": "example #1201/#1202: merge or wait?",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "canReply": true,
   "project": "general",
   "askContext": "Both flag PRs are now merge-ready, apart from the required review:\n\n| PR | Certificate | Conflicts | Threads | Blocker |\n|---|---|---|---|---|\n| **#1201** reports flag consolidation | ✅ passed | none | 0 | 1 approving review |\n| **#1202** integrations flag consolidation | ✅ passed | none | 5/5 resolved | 1 approving review |\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?",
   "labels": [
    "state=waiting"
   ]
  },
  {
   "id": "fq_sparse",
   "kind": "approval",
   "title": "Needs your decision",
   "body": "Waiting for your decision.",
   "options": [],
   "needsYou": true,
   "decisionHeadline": "Review this decision",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "canReply": false,
   "project": "general"
  },
  {
   "id": "fq_old",
   "kind": "approval",
   "title": "Merge #77 over the required review?",
   "body": "Should I merge #77 over the required review with your admin rights, or wait for review?",
   "options": [
    "merge now",
    "wait for review"
   ],
   "needsYou": true,
   "decisionHeadline": "Merge #77 over the required review?",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "canReply": true,
   "project": "general"
  },
  {
   "id": "fq_legacy",
   "kind": "approval",
   "title": "Merge #78 over the required review?",
   "body": "Should I merge #78 over the required review with your admin rights, or wait for review?",
   "options": [
    "merge now",
    "wait for review"
   ],
   "needsYou": true,
   "decisionHeadline": "Merge #78 over the required review?",
   "canReply": true,
   "project": "general"
  }
 ],
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
      "Merging needs your approval because you review every merge."
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
    "whatChanged": "#1201 reports flag consolidation: Certificate: passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.",
    "decision": "Choose whether to use admin rights to merge both without the required teammate approval, or wait for an independent review.",
    "details": "Both flag PRs are now merge-ready, apart from the required review:\n\nGitHub shows no other failing checks on either. The post-merge verification on main is still pending.\n\nDecision needed: should I merge #1201 and #1202 over the required review with your admin rights (they're your PRs, so you can't approve them yourself), or leave them for a teammate's review?\n\nBlocked: Merging needs your approval because you review every merge.",
    "goal": "Finish the remaining Sales call-type admission work.",
    "assignment": "Finish the Sales flag consolidation PRs and get them merged once verified",
    "whereItStands": "#1201 reports flag consolidation: Certificate: passed, Conflicts: none, Threads: 0, Blocker: 1 approving review. GitHub shows no other failing checks on either.",
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
   "needsYou": true,
   "brief": {
    "context": "Ship the release notes fix",
    "currentState": "Paused at a decision checkpoint — waiting for your call before continuing.",
    "whatChanged": "CI is green on #78.",
    "decision": "Should I merge #78 over the required review with your admin rights, or wait for review?"
   },
   "recommendation": null,
   "primaryAction": {
    "op": "answer",
    "label": "Merge now",
    "value": "merge now"
   },
   "secondaryAction": {
    "op": "answer",
    "label": "Wait for review",
    "value": "wait for review"
   },
   "extraActions": [],
   "suggestedReplies": []
  }
 ]
}
"""#
}
