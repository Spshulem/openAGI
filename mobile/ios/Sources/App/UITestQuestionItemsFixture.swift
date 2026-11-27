#if DEBUG
import Foundation
import os

// `--ui-question-items-fixture`: synthetic Needs You asks that carry several
// questions (card.questionItems, src/fleet/decision-items.js). Generated from
// the server's synthetic fixtures: a fresh ten-question release ask, the same
// ask partially answered (one delivered, one skipped, one failed with its
// answer kept), a single-question card that keeps the decision contract, and
// a completed FYI that carries items but must never offer the walkthrough.
enum UITestQuestionItemsFixture {
    static let stateJSON = #"""
{
 "mode": "propose",
 "enabled": true,
 "running": false,
 "lastTickAt": "2026-11-27T17:00:00.000Z",
 "snapshot": {
  "at": "2026-11-27T17:00:00.000Z",
  "threads": []
 },
 "questions": [],
 "cards": [
  {
   "id": "fq_release",
   "questionId": "fq_release",
   "kind": "approval",
   "kindLabel": "Needs Decision",
   "rank": 1,
   "headline": "example #7913: resolve release decisions",
   "needsYou": true,
   "ownerBlocker": false,
   "decisionHeadline": "Authorize the production release",
   "decisionFact": "Channel watches: should pausing alerts and enabling autonomous turns require approval?",
   "decisionSource": {
    "questionId": "fq_release",
    "threadKey": "paseo:srv_test.release-coordinator",
    "threadKeys": []
   },
   "decisionAction": {
    "op": "review_items",
    "value": "fq_release",
    "label": "Review 10 questions"
   },
   "askType": "decision",
   "contextStatus": "complete",
   "decisionContext": {
    "askType": "decision",
    "itemName": "app · Release coordinator",
    "goal": "Coordinate and ship the scoped release.",
    "assignment": "Ship the scoped release",
    "verified": null,
    "changed": "Agent's latest update: The owner recommends separate documents. 4. 5. Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7. The audit owner recommends yes for both.…",
    "blocked": "Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "status": "Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.",
    "groups": null,
    "details": "Changed: Agent's latest update: The owner recommends separate documents. 4. 5. Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7. The audit owner recommends yes for both.…\nBlocked: Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "decision": "Answer the ten unresolved release questions or approve the audit owner's recommended choices.",
    "options": [
     {
      "label": "Answer all questions",
      "consequence": null
     },
     {
      "label": "Approve recommended choices",
      "consequence": null
     }
    ],
    "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
    "sources": [
     {
      "label": "PR #7913",
      "url": "https://github.com/example/app/pull/7913"
     }
    ],
    "missing": [],
    "complete": true,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "1. **Goal:** app · Release coordinator. Coordinate and ship the scoped release.\n2. **You asked the agent to:** Ship the scoped release\n3. **Where it stands:** Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.\n4. **Decision now:** Answer the ten unresolved release questions or approve the audit owner's recommended choices. Options: Answer all questions; Approve recommended choices. Tradeoffs: not stated by the agent. Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.\nSources: [PR #7913](https://github.com/example/app/pull/7913)"
   },
   "decisionView": {
    "version": 1,
    "goal": {
     "title": "app · Release coordinator",
     "text": "Coordinate and ship the scoped release.",
     "unknown": false
    },
    "status": {
     "done": [
      "The owner recommends separate documents. 4. 5.",
      "Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6.",
      "Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7.",
      "The audit owner recommends yes for both.…"
     ],
     "blocked": [
      "Channel watches: should pausing alerts and enabling autonomous turns require approval?"
     ],
     "unverified": [],
     "prs": [
      {
       "ref": "example/app#7913",
       "title": null,
       "facts": []
      }
     ],
     "unknown": false
    },
    "decision": {
     "question": "10 separate questions need your answers. Answer them one at a time; any you skip stay open.",
     "options": [],
     "unknown": false
    },
    "recommendation": {
     "option": null,
     "label": null,
     "why": "Each question shows the agent's recommendation where it gave one. Nothing is approved in bulk.",
     "unknown": false
    },
    "unknowns": [
     "Unverified: the source does not say what is still unverified"
    ],
    "evidence": [
     {
      "label": "PR #7913",
      "url": "https://github.com/example/app/pull/7913"
     }
    ]
   },
   "questionItems": [
    {
     "itemId": "q1-b1dbd1d7",
     "index": 1,
     "label": "Reviewers",
     "question": "who approves #101 and #102/#103?",
     "context": null,
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q2-1102b412",
     "index": 2,
     "label": "Certificates",
     "question": "which clean host produces them?",
     "context": "It should run uncached.",
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q3-ff23e326",
     "index": 3,
     "label": "Canvas pages",
     "question": "should a Canvas's pages be pages inside one document, or separate documents?",
     "context": null,
     "choices": [
      "Pages inside one document",
      "Separate documents"
     ],
     "freeText": true,
     "recommendation": "The owner recommends separate documents.",
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q4-9843173b",
     "index": 4,
     "label": "Canvas closed-memory",
     "question": "is it acceptable to drop the per-browser closed memory?",
     "context": null,
     "choices": [
      "Yes",
      "No"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q5-7e1f26ac",
     "index": 5,
     "label": "Canvas E2E",
     "question": "a synthetic staging account and a clean preview for the browser test.",
     "context": "a synthetic staging account and a clean preview for the browser test.",
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q6-94676d03",
     "index": 6,
     "label": "Mac preflight",
     "question": "run the signing preflight once in your Mac's GUI session, or name another approved host.",
     "context": "run the signing preflight once in your Mac's GUI session, or name another approved host.",
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q7-a068554e",
     "index": 7,
     "label": "Channel watches",
     "question": "should pausing alerts and enabling autonomous turns require approval?",
     "context": null,
     "choices": [
      "Yes",
      "No"
     ],
     "freeText": true,
     "recommendation": "The audit owner recommends yes for both.",
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q8-4eb49b00",
     "index": 8,
     "label": "#104 native-history bug",
     "question": "Should they open the fix PR?",
     "context": null,
     "choices": [
      "Yes",
      "No"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": "the audit owner rates it a blocker for the next native build, not for web.",
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q9-2c0e4391",
     "index": 9,
     "label": "#105 owner",
     "question": "restart it, or move it to another model.",
     "context": "restart it, or move it to another model.",
     "choices": [
      "Restart it",
      "Move it to another model"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q10-46c29810",
     "index": 10,
     "label": "Store scope",
     "question": "is the whole shared store suspect, or only Vite?",
     "context": null,
     "choices": [
      "The whole shared store suspect",
      "Only Vite"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    }
   ],
   "questionItemsSummary": {
    "total": 10,
    "unanswered": 10,
    "skipped": 0,
    "queued": 0,
    "delivered": 0,
    "failed": 0,
    "open": 10
   },
   "sessionTitle": "Release coordinator",
   "summary": "…7. Channel watches: should pausing alerts and enabling autonomous turns require approval? …",
   "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
   "brief": {
    "context": "Coordinate and ship the scoped release.",
    "currentState": "Paused at a decision checkpoint (PR #7913) — waiting for your call before continuing.",
    "whatChanged": "Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.",
    "decision": "Answer the ten unresolved release questions or approve the audit owner's recommended choices.",
    "details": "…r test.\n6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.\n7. Channel watches: should pausing alerts and enabling autonomous turns require approval? The audit owner recommends yes for both.\n8. #104 native-history bug: the audit owner rates it a blocker for the next native build, not for web. Should they open the fix PR?\n9. #105 owner: restart it, or move it to another model.\n10. Store scope: is the whole shared store suspect, or only Vite?\n\nChanged: Agent's latest update: The owner recommends separate documents. 4. 5. Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7. The audit owner recommends yes for both.…\nBlocked: Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "goal": "Coordinate and ship the scoped release.",
    "assignment": "Ship the scoped release",
    "whereItStands": "Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.",
    "verified": null,
    "blocked": "Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "options": [
     {
      "label": "Answer all questions",
      "consequence": null
     },
     {
      "label": "Approve recommended choices",
      "consequence": null
     }
    ],
    "sources": [
     {
      "label": "PR #7913",
      "url": "https://github.com/example/app/pull/7913"
     }
    ],
    "missing": []
   },
   "suggestedReplies": [],
   "canReply": true,
   "agentSummary": "Nothing has merged yet. Original questions, unchanged:\n1. **Reviewers:** who approves #101 and #102/#103?\n2. **Certificates:** which clean host produces them? It should run uncached.\n3. **Canvas pages:** should a Canvas's pages be pages inside one document, or separate documents? The owner recommends separate documents.\n4. **Canvas closed-memory:** is it acceptable to drop the per-browser closed memory?\n5. **Canvas E2E:** a synthetic staging account and a clean preview for the browser test.\n6. **Mac preflight:** run the signing preflight once in your Mac's GUI session, or name another approved host.\n7. **Channel watches:** should pausing alerts and enabling autonomous turns require approval? The audit owner recommends yes for both.\n8. **#104 native-history bug:** the audit owner rates it a blocker for the next native build, not for web. Should they open the fix PR?\n9. **#105 owner:** restart it, or move it to another model.\n10. **Store scope:** is the whole shared store suspect, or only Vite?",
   "prContext": {
    "ref": "example/app#7913",
    "url": "https://github.com/example/app/pull/7913",
    "title": null,
    "bodySummary": null,
    "additions": null,
    "deletions": null,
    "changedFiles": null,
    "files": [],
    "gates": [],
    "qa": null,
    "ciState": null
   },
   "recentMessages": [
    {
     "role": "user",
     "text": "Ship the scoped release",
     "at": null
    },
    {
     "role": "assistant",
     "text": "…te documents.\n4. **Canvas closed-memory:** is it acceptable to drop the per-browser closed memory?\n5. **Canvas E2E:** a synthetic staging account and a clean preview for the browser test.\n6. **Mac preflight:** run the signing preflight once in your Mac's GUI session, or name another approved host.\n7. **Channel watches:** should pausing alerts and enabling autonomous turns require approval? The audit owner recommends yes for both.\n8. **#104 native-history bug:** the audit owner rates it a blocker for the next native build, not for web. Should they open the fix PR?\n9. **#105 owner:** restart it, or move it to another model.\n10. **Store scope:** is the whole shared store suspect, or only Vite?",
     "at": null
    }
   ],
   "threadKey": "paseo:srv_test.release-coordinator",
   "threadKeys": [
    "paseo:srv_test.release-coordinator"
   ],
   "repo": "example/app",
   "branch": null,
   "workspace": null,
   "prRef": "example/app#7913",
   "prUrl": "https://github.com/example/app/pull/7913",
   "prNumber": 7913,
   "headSha": null,
   "ciState": null,
   "mergeState": null,
   "noticedAt": null,
   "answerIn": "here",
   "risky": false,
   "options": [
    "open thread"
   ],
   "primaryAction": {
    "op": "review_items",
    "label": "Review 10 questions",
    "value": "fq_release",
    "destructive": false
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "dismiss",
    "destructive": false
   },
   "extraActions": [],
   "timeline": [
    {
     "at": null,
     "label": "Needs your call",
     "detail": "example #7913: resolve release decisions"
    }
   ],
   "resources": [
    {
     "kind": "conversation",
     "label": "Release coordinator",
     "url": null,
     "threadKey": "paseo:srv_test.release-coordinator",
     "serverId": "srv_test",
     "agentId": "release-coordinator"
    },
    {
     "kind": "pr",
     "label": "Pull Request #7913 (example/app)",
     "url": "https://github.com/example/app/pull/7913",
     "threadKey": null
    }
   ],
   "openChat": {
    "app": "paseo",
    "url": null,
    "label": "Release coordinator (Paseo)",
    "serverId": "srv_test",
    "agentId": "release-coordinator",
    "note": "Open this existing chat on its Paseo host."
   },
   "project": "app",
   "actorLabel": null,
   "subchannel": null,
   "labels": [
    "state=waiting",
    "pr=#7913"
   ],
   "blockingCount": 0,
   "blockingSummary": null
  },
  {
   "id": "fq_single",
   "questionId": "fq_single",
   "kind": "approval",
   "kindLabel": "Needs Decision",
   "rank": 1,
   "headline": "Deploy or hold?",
   "needsYou": true,
   "ownerBlocker": false,
   "decisionHeadline": "Deploy or hold?",
   "decisionFact": "The agent is waiting for your answer before it can continue.",
   "decisionSource": {
    "questionId": "fq_single",
    "threadKey": "paseo:s.single",
    "threadKeys": []
   },
   "decisionAction": {
    "op": "answer",
    "value": "deploy",
    "label": "Deploy"
   },
   "askType": "decision",
   "contextStatus": "incomplete",
   "decisionContext": {
    "askType": "decision",
    "itemName": null,
    "goal": "Ship the fix",
    "assignment": "Ship the fix",
    "verified": null,
    "changed": null,
    "blocked": null,
    "status": "CI is green.",
    "groups": null,
    "details": null,
    "decision": "Deploy or hold?",
    "options": [
     {
      "label": "Deploy",
      "consequence": null
     },
     {
      "label": "Hold",
      "consequence": "Nothing changes now; this stays open and the agent stays paused."
     }
    ],
    "recommendation": "Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below.",
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ],
    "complete": false,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "1. **Goal:** Ship the fix\n3. **Where it stands:** CI is green.\n4. **Decision now:** Deploy or hold? Options: Deploy; Hold (Nothing changes now; this stays open and the agent stays paused). Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below."
   },
   "decisionView": {
    "version": 1,
    "goal": {
     "title": null,
     "text": "Ship the fix",
     "unknown": false
    },
    "status": {
     "done": [
      "CI is green."
     ],
     "blocked": [],
     "unverified": [],
     "prs": [],
     "unknown": false
    },
    "decision": {
     "question": "Deploy or hold?",
     "options": [
      {
       "value": "deploy",
       "label": "Deploy",
       "consequence": null,
       "adminBypass": false,
       "recommended": false
      },
      {
       "value": "hold",
       "label": "Hold",
       "consequence": "Nothing changes now; this stays open and the agent stays paused.",
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
   "summary": "Waiting for your decision.",
   "recommendation": "Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below.",
   "brief": {
    "context": "Ship the fix",
    "currentState": "Paused at a decision checkpoint — waiting for your call before continuing.",
    "whatChanged": "CI is green.",
    "decision": "Deploy or hold?\n\nOptions:\n- Deploy\n- Hold — Nothing changes now; this stays open and the agent stays paused.",
    "details": null,
    "goal": "Ship the fix",
    "assignment": "Ship the fix",
    "whereItStands": "CI is green.",
    "verified": null,
    "blocked": null,
    "options": [
     {
      "label": "Deploy",
      "consequence": null
     },
     {
      "label": "Hold",
      "consequence": "Nothing changes now; this stays open and the agent stays paused."
     }
    ],
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ]
   },
   "suggestedReplies": [
    "Approved — finish all remaining in-scope items",
    "Hold off — tell me what's still unverified first"
   ],
   "canReply": true,
   "agentSummary": null,
   "prContext": null,
   "recentMessages": [
    {
     "role": "user",
     "text": "Ship the fix",
     "at": null
    },
    {
     "role": "assistant",
     "text": "CI is green. Deploy or hold?",
     "at": null
    }
   ],
   "threadKey": "paseo:s.single",
   "threadKeys": [
    "paseo:s.single"
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
    "deploy",
    "hold"
   ],
   "primaryAction": {
    "op": "answer",
    "label": "Deploy",
    "value": "deploy",
    "destructive": false
   },
   "secondaryAction": {
    "op": "answer",
    "label": "Hold",
    "value": "hold",
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
     "detail": "Deploy or hold?"
    }
   ],
   "resources": [
    {
     "kind": "conversation",
     "label": "Agent conversation",
     "url": null,
     "threadKey": "paseo:s.single",
     "serverId": "s",
     "agentId": "single"
    }
   ],
   "openChat": {
    "app": "paseo",
    "url": null,
    "label": "Paseo chat (Paseo)",
    "serverId": "s",
    "agentId": "single",
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
   "id": "fq_release_partial",
   "questionId": "fq_release_partial",
   "kind": "approval",
   "kindLabel": "Needs Decision",
   "rank": 1,
   "headline": "example #7913: resolve release decisions",
   "needsYou": true,
   "ownerBlocker": false,
   "decisionHeadline": "Authorize the production release",
   "decisionFact": "Channel watches: should pausing alerts and enabling autonomous turns require approval?",
   "decisionSource": {
    "questionId": "fq_release_partial",
    "threadKey": "paseo:srv_test.release-coordinator",
    "threadKeys": []
   },
   "decisionAction": {
    "op": "review_items",
    "value": "fq_release_partial",
    "label": "Review 9 questions"
   },
   "askType": "decision",
   "contextStatus": "complete",
   "decisionContext": {
    "askType": "decision",
    "itemName": "app · Release coordinator",
    "goal": "Coordinate and ship the scoped release.",
    "assignment": "Ship the scoped release",
    "verified": null,
    "changed": "Agent's latest update: The owner recommends separate documents. 4. 5. Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7. The audit owner recommends yes for both.…",
    "blocked": "Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "status": "Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.",
    "groups": null,
    "details": "Changed: Agent's latest update: The owner recommends separate documents. 4. 5. Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7. The audit owner recommends yes for both.…\nBlocked: Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "decision": "Answer the ten unresolved release questions or approve the audit owner's recommended choices.",
    "options": [
     {
      "label": "Answer all questions",
      "consequence": null
     },
     {
      "label": "Approve recommended choices",
      "consequence": null
     }
    ],
    "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
    "sources": [
     {
      "label": "PR #7913",
      "url": "https://github.com/example/app/pull/7913"
     }
    ],
    "missing": [],
    "complete": true,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "1. **Goal:** app · Release coordinator. Coordinate and ship the scoped release.\n2. **You asked the agent to:** Ship the scoped release\n3. **Where it stands:** Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.\n4. **Decision now:** Answer the ten unresolved release questions or approve the audit owner's recommended choices. Options: Answer all questions; Approve recommended choices. Tradeoffs: not stated by the agent. Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.\nSources: [PR #7913](https://github.com/example/app/pull/7913)"
   },
   "decisionView": {
    "version": 1,
    "goal": {
     "title": "app · Release coordinator",
     "text": "Coordinate and ship the scoped release.",
     "unknown": false
    },
    "status": {
     "done": [
      "The owner recommends separate documents. 4. 5.",
      "Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6.",
      "Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7.",
      "The audit owner recommends yes for both.…"
     ],
     "blocked": [
      "Channel watches: should pausing alerts and enabling autonomous turns require approval?"
     ],
     "unverified": [],
     "prs": [
      {
       "ref": "example/app#7913",
       "title": null,
       "facts": []
      }
     ],
     "unknown": false
    },
    "decision": {
     "question": "10 separate questions need your answers. Answer them one at a time; any you skip stay open.",
     "options": [],
     "unknown": false
    },
    "recommendation": {
     "option": null,
     "label": null,
     "why": "Each question shows the agent's recommendation where it gave one. Nothing is approved in bulk.",
     "unknown": false
    },
    "unknowns": [
     "Unverified: the source does not say what is still unverified"
    ],
    "evidence": [
     {
      "label": "PR #7913",
      "url": "https://github.com/example/app/pull/7913"
     }
    ]
   },
   "questionItems": [
    {
     "itemId": "q1-b1dbd1d7",
     "index": 1,
     "label": "Reviewers",
     "question": "who approves #101 and #102/#103?",
     "context": null,
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "skipped",
      "answer": null,
      "at": "2026-11-27T17:50:00Z",
      "detail": null
     }
    },
    {
     "itemId": "q2-1102b412",
     "index": 2,
     "label": "Certificates",
     "question": "which clean host produces them?",
     "context": "It should run uncached.",
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q3-ff23e326",
     "index": 3,
     "label": "Canvas pages",
     "question": "should a Canvas's pages be pages inside one document, or separate documents?",
     "context": null,
     "choices": [
      "Pages inside one document",
      "Separate documents"
     ],
     "freeText": true,
     "recommendation": "The owner recommends separate documents.",
     "unblocks": null,
     "state": {
      "status": "delivered",
      "answer": "Separate documents",
      "at": "2026-11-27T17:50:00Z",
      "detail": null
     }
    },
    {
     "itemId": "q4-9843173b",
     "index": 4,
     "label": "Canvas closed-memory",
     "question": "is it acceptable to drop the per-browser closed memory?",
     "context": null,
     "choices": [
      "Yes",
      "No"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "failed",
      "answer": "Yes",
      "at": "2026-11-27T17:51:00Z",
      "detail": "host offline"
     }
    },
    {
     "itemId": "q5-7e1f26ac",
     "index": 5,
     "label": "Canvas E2E",
     "question": "a synthetic staging account and a clean preview for the browser test.",
     "context": "a synthetic staging account and a clean preview for the browser test.",
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q6-94676d03",
     "index": 6,
     "label": "Mac preflight",
     "question": "run the signing preflight once in your Mac's GUI session, or name another approved host.",
     "context": "run the signing preflight once in your Mac's GUI session, or name another approved host.",
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q7-a068554e",
     "index": 7,
     "label": "Channel watches",
     "question": "should pausing alerts and enabling autonomous turns require approval?",
     "context": null,
     "choices": [
      "Yes",
      "No"
     ],
     "freeText": true,
     "recommendation": "The audit owner recommends yes for both.",
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q8-4eb49b00",
     "index": 8,
     "label": "#104 native-history bug",
     "question": "Should they open the fix PR?",
     "context": null,
     "choices": [
      "Yes",
      "No"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": "the audit owner rates it a blocker for the next native build, not for web.",
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q9-2c0e4391",
     "index": 9,
     "label": "#105 owner",
     "question": "restart it, or move it to another model.",
     "context": "restart it, or move it to another model.",
     "choices": [
      "Restart it",
      "Move it to another model"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q10-46c29810",
     "index": 10,
     "label": "Store scope",
     "question": "is the whole shared store suspect, or only Vite?",
     "context": null,
     "choices": [
      "The whole shared store suspect",
      "Only Vite"
     ],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    }
   ],
   "questionItemsSummary": {
    "total": 10,
    "unanswered": 7,
    "skipped": 1,
    "queued": 0,
    "delivered": 1,
    "failed": 1,
    "open": 9
   },
   "sessionTitle": "Release coordinator",
   "summary": "…7. Channel watches: should pausing alerts and enabling autonomous turns require approval? …",
   "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
   "brief": {
    "context": "Coordinate and ship the scoped release.",
    "currentState": "Paused at a decision checkpoint (PR #7913) — waiting for your call before continuing.",
    "whatChanged": "Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.",
    "decision": "Answer the ten unresolved release questions or approve the audit owner's recommended choices.",
    "details": "…r test.\n6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.\n7. Channel watches: should pausing alerts and enabling autonomous turns require approval? The audit owner recommends yes for both.\n8. #104 native-history bug: the audit owner rates it a blocker for the next native build, not for web. Should they open the fix PR?\n9. #105 owner: restart it, or move it to another model.\n10. Store scope: is the whole shared store suspect, or only Vite?\n\nChanged: Agent's latest update: The owner recommends separate documents. 4. 5. Canvas E2E: a synthetic staging account and a clean preview for the browser test. 6. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host. 7. The audit owner recommends yes for both.…\nBlocked: Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "goal": "Coordinate and ship the scoped release.",
    "assignment": "Ship the scoped release",
    "whereItStands": "Canvas E2E: a synthetic staging account and a clean preview for the browser test. Mac preflight: run the signing preflight once in your Mac's GUI session, or name another approved host.",
    "verified": null,
    "blocked": "Channel watches: should pausing alerts and enabling autonomous turns require approval?",
    "options": [
     {
      "label": "Answer all questions",
      "consequence": null
     },
     {
      "label": "Approve recommended choices",
      "consequence": null
     }
    ],
    "sources": [
     {
      "label": "PR #7913",
      "url": "https://github.com/example/app/pull/7913"
     }
    ],
    "missing": []
   },
   "suggestedReplies": [],
   "canReply": true,
   "agentSummary": "Nothing has merged yet. Original questions, unchanged:\n1. **Reviewers:** who approves #101 and #102/#103?\n2. **Certificates:** which clean host produces them? It should run uncached.\n3. **Canvas pages:** should a Canvas's pages be pages inside one document, or separate documents? The owner recommends separate documents.\n4. **Canvas closed-memory:** is it acceptable to drop the per-browser closed memory?\n5. **Canvas E2E:** a synthetic staging account and a clean preview for the browser test.\n6. **Mac preflight:** run the signing preflight once in your Mac's GUI session, or name another approved host.\n7. **Channel watches:** should pausing alerts and enabling autonomous turns require approval? The audit owner recommends yes for both.\n8. **#104 native-history bug:** the audit owner rates it a blocker for the next native build, not for web. Should they open the fix PR?\n9. **#105 owner:** restart it, or move it to another model.\n10. **Store scope:** is the whole shared store suspect, or only Vite?",
   "prContext": {
    "ref": "example/app#7913",
    "url": "https://github.com/example/app/pull/7913",
    "title": null,
    "bodySummary": null,
    "additions": null,
    "deletions": null,
    "changedFiles": null,
    "files": [],
    "gates": [],
    "qa": null,
    "ciState": null
   },
   "recentMessages": [
    {
     "role": "user",
     "text": "Ship the scoped release",
     "at": null
    },
    {
     "role": "assistant",
     "text": "…te documents.\n4. **Canvas closed-memory:** is it acceptable to drop the per-browser closed memory?\n5. **Canvas E2E:** a synthetic staging account and a clean preview for the browser test.\n6. **Mac preflight:** run the signing preflight once in your Mac's GUI session, or name another approved host.\n7. **Channel watches:** should pausing alerts and enabling autonomous turns require approval? The audit owner recommends yes for both.\n8. **#104 native-history bug:** the audit owner rates it a blocker for the next native build, not for web. Should they open the fix PR?\n9. **#105 owner:** restart it, or move it to another model.\n10. **Store scope:** is the whole shared store suspect, or only Vite?",
     "at": null
    }
   ],
   "threadKey": "paseo:srv_test.release-coordinator",
   "threadKeys": [
    "paseo:srv_test.release-coordinator"
   ],
   "repo": "example/app",
   "branch": null,
   "workspace": null,
   "prRef": "example/app#7913",
   "prUrl": "https://github.com/example/app/pull/7913",
   "prNumber": 7913,
   "headSha": null,
   "ciState": null,
   "mergeState": null,
   "noticedAt": null,
   "answerIn": "here",
   "risky": false,
   "options": [
    "open thread"
   ],
   "primaryAction": {
    "op": "review_items",
    "label": "Review 9 questions",
    "value": "fq_release_partial",
    "destructive": false
   },
   "secondaryAction": {
    "op": "defer",
    "label": "Later",
    "value": "dismiss",
    "destructive": false
   },
   "extraActions": [],
   "timeline": [
    {
     "at": null,
     "label": "Needs your call",
     "detail": "example #7913: resolve release decisions"
    }
   ],
   "resources": [
    {
     "kind": "conversation",
     "label": "Release coordinator",
     "url": null,
     "threadKey": "paseo:srv_test.release-coordinator",
     "serverId": "srv_test",
     "agentId": "release-coordinator"
    },
    {
     "kind": "pr",
     "label": "Pull Request #7913 (example/app)",
     "url": "https://github.com/example/app/pull/7913",
     "threadKey": null
    }
   ],
   "openChat": {
    "app": "paseo",
    "url": null,
    "label": "Release coordinator (Paseo)",
    "serverId": "srv_test",
    "agentId": "release-coordinator",
    "note": "Open this existing chat on its Paseo host."
   },
   "project": "app",
   "actorLabel": null,
   "subchannel": null,
   "labels": [
    "state=waiting",
    "pr=#7913"
   ],
   "blockingCount": 0,
   "blockingSummary": null
  },
  {
   "id": "fq_fyi_done",
   "questionId": "fq_fyi_done",
   "kind": "completed",
   "kindLabel": "Completed",
   "rank": 1,
   "headline": "Release notes published",
   "needsYou": false,
   "ownerBlocker": false,
   "decisionHeadline": "Release notes published",
   "decisionFact": "The agent finished and is only letting you know.",
   "decisionSource": {
    "questionId": "fq_single",
    "threadKey": "paseo:s.single",
    "threadKeys": []
   },
   "decisionAction": null,
   "askType": "fyi",
   "contextStatus": "incomplete",
   "decisionContext": {
    "askType": "decision",
    "itemName": null,
    "goal": "Ship the fix",
    "assignment": "Ship the fix",
    "verified": null,
    "changed": null,
    "blocked": null,
    "status": "CI is green.",
    "groups": null,
    "details": null,
    "decision": "Deploy or hold?",
    "options": [
     {
      "label": "Deploy",
      "consequence": null
     },
     {
      "label": "Hold",
      "consequence": "Nothing changes now; this stays open and the agent stays paused."
     }
    ],
    "recommendation": "Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below.",
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ],
    "complete": false,
    "agentSupplied": false,
    "contextRequested": false,
    "text": "1. **Goal:** Ship the fix\n3. **Where it stands:** CI is green.\n4. **Decision now:** Deploy or hold? Options: Deploy; Hold (Nothing changes now; this stays open and the agent stays paused). Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below."
   },
   "sessionTitle": null,
   "summary": "Waiting for your decision.",
   "recommendation": "Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below.",
   "brief": {
    "context": "Ship the fix",
    "currentState": "Paused at a decision checkpoint — waiting for your call before continuing.",
    "whatChanged": "CI is green.",
    "decision": "Deploy or hold?\n\nOptions:\n- Deploy\n- Hold — Nothing changes now; this stays open and the agent stays paused.",
    "details": null,
    "goal": "Ship the fix",
    "assignment": "Ship the fix",
    "whereItStands": "CI is green.",
    "verified": null,
    "blocked": null,
    "options": [
     {
      "label": "Deploy",
      "consequence": null
     },
     {
      "label": "Hold",
      "consequence": "Nothing changes now; this stays open and the agent stays paused."
     }
    ],
    "sources": [],
    "missing": [
     "progress",
     "blocked"
    ]
   },
   "suggestedReplies": [
    "Approved — finish all remaining in-scope items",
    "Hold off — tell me what's still unverified first"
   ],
   "canReply": true,
   "agentSummary": null,
   "prContext": null,
   "recentMessages": [
    {
     "role": "user",
     "text": "Ship the fix",
     "at": null
    },
    {
     "role": "assistant",
     "text": "CI is green. Deploy or hold?",
     "at": null
    }
   ],
   "threadKey": "paseo:s.single",
   "threadKeys": [
    "paseo:s.single"
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
    "deploy",
    "hold"
   ],
   "primaryAction": {
    "op": "open_chat",
    "label": "View Chat",
    "value": "open thread",
    "destructive": false
   },
   "secondaryAction": null,
   "extraActions": [],
   "timeline": [
    {
     "at": null,
     "label": "Needs your call",
     "detail": "Deploy or hold?"
    }
   ],
   "resources": [
    {
     "kind": "conversation",
     "label": "Agent conversation",
     "url": null,
     "threadKey": "paseo:s.single",
     "serverId": "s",
     "agentId": "single"
    }
   ],
   "openChat": {
    "app": "paseo",
    "url": null,
    "label": "Paseo chat (Paseo)",
    "serverId": "s",
    "agentId": "single",
    "note": "Open this existing chat on its Paseo host."
   },
   "project": "general",
   "actorLabel": null,
   "subchannel": null,
   "labels": [
    "state=waiting"
   ],
   "blockingCount": 0,
   "blockingSummary": null,
   "questionItems": [
    {
     "itemId": "q1-b1dbd1d7",
     "index": 1,
     "label": "Reviewers",
     "question": "who approves #101 and #102/#103?",
     "context": null,
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    },
    {
     "itemId": "q2-1102b412",
     "index": 2,
     "label": "Certificates",
     "question": "which clean host produces them?",
     "context": "It should run uncached.",
     "choices": [],
     "freeText": true,
     "recommendation": null,
     "unblocks": null,
     "state": {
      "status": "unanswered",
      "answer": null,
      "at": null,
      "detail": null
     }
    }
   ],
   "questionItemsSummary": {
    "total": 2,
    "unanswered": 2,
    "skipped": 0,
    "queued": 0,
    "delivered": 0,
    "failed": 0,
    "open": 2
   }
  }
 ],
 "activityEvents": []
}
"""#

    private struct ItemState: Sendable {
        let status: String
        let answer: String?
        let at: String
        let detail: String?

        var json: [String: Any] {
            ["status": status, "answer": answer ?? NSNull(), "at": at, "detail": detail ?? NSNull()]
        }
    }

    /// Item states the stub has recorded, per card id and item id.
    private static let recorded = OSAllocatedUnfairLock(initialState: [String: [String: ItemState]]())

    /// The fixture state with every recorded item state applied, and each
    /// card's summary and "Review N questions" label recounted.
    static func state() -> [String: Any] {
        guard var root = (try? JSONSerialization.jsonObject(with: Data(stateJSON.utf8))) as? [String: Any],
              let cards = root["cards"] as? [[String: Any]] else { return [:] }
        let saved = recorded.withLock { $0 }
        root["cards"] = cards.map { card -> [String: Any] in
            guard let id = card["id"] as? String, let items = card["questionItems"] as? [[String: Any]],
                  let updates = saved[id] else { return card }
            var card = card
            let patched = items.map { item -> [String: Any] in
                var item = item
                if let itemID = item["itemId"] as? String, let state = updates[itemID] { item["state"] = state.json }
                return item
            }
            card["questionItems"] = patched
            let statuses = patched.compactMap { ($0["state"] as? [String: Any])?["status"] as? String }
            func count(_ status: String) -> Int { statuses.filter { $0 == status }.count }
            let open = count("unanswered") + count("skipped") + count("failed")
            card["questionItemsSummary"] = ["total": patched.count, "unanswered": count("unanswered"), "skipped": count("skipped"),
                                            "queued": count("queued"), "delivered": count("delivered"), "failed": count("failed"),
                                            "open": open]
            if var primary = card["primaryAction"] as? [String: Any], primary["op"] as? String == "review_items" {
                primary["label"] = "Review \(open) question\(open == 1 ? "" : "s")"
                card["primaryAction"] = primary
            }
            return card
        }
        return root
    }

    /// POST /fleet/api/cards/<id>/act. `answer_items`: a typed answer is
    /// queued (the Mac cannot type yet), a picked choice is delivered, a
    /// skip is recorded; unknown items are refused. Anything else on an
    /// ask with several questions is refused, as the hub does.
    static func act(cardID: String, body: [String: Any]) -> (status: Int, object: [String: Any]) {
        guard let card = (state()["cards"] as? [[String: Any]])?.first(where: { $0["id"] as? String == cardID }),
              let items = card["questionItems"] as? [[String: Any]], items.count >= 2 else {
            return (200, ["result": ["ok": false, "kind": body["op"] ?? "", "status": "blocked", "detail": "This card has a single question."], "state": state()])
        }
        guard body["op"] as? String == "answer_items" else {
            return (200, ["result": ["ok": false, "kind": body["op"] ?? "", "status": "blocked",
                                     "detail": "Answer each question on its own; a blanket answer is not sent."], "state": state()])
        }
        let byID = Dictionary(items.compactMap { item in (item["itemId"] as? String).map { ($0, item) } }, uniquingKeysWith: { a, _ in a })
        let answers = (body["items"] as? [[String: Any]] ?? []).compactMap { entry -> (String, String)? in
            guard let id = entry["itemId"] as? String, byID[id] != nil,
                  let answer = (entry["answer"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !answer.isEmpty else { return nil }
            return (id, answer)
        }
        let skips = (body["skip"] as? [String] ?? []).filter { byID[$0] != nil }
        guard !answers.isEmpty || !skips.isEmpty else {
            return (200, ["result": ["ok": false, "kind": "answer_items", "status": "blocked", "detail": "Answer or skip at least one question."], "state": state()])
        }
        let at = "2026-11-27T18:00:00Z"
        var statuses: [String] = []
        var updates: [String: ItemState] = [:]
        for id in skips { updates[id] = ItemState(status: "skipped", answer: nil, at: at, detail: nil) }
        for (id, answer) in answers {
            let choices = byID[id]?["choices"] as? [String] ?? []
            let status = choices.contains(answer) ? "delivered" : "queued"
            statuses.append(status)
            updates[id] = ItemState(status: status, answer: answer, at: at,
                                    detail: status == "queued" ? "Saved. It goes to the agent once the Mac can type." : nil)
        }
        let applied = updates
        recorded.withLock { saved in
            saved[cardID, default: [:]].merge(applied) { _, new in new }
        }
        let fresh = state()
        let updated = (fresh["cards"] as? [[String: Any]])?.first { $0["id"] as? String == cardID }?["questionItems"] ?? []
        let status = answers.isEmpty ? "skipped" : (statuses.contains("queued") ? "queued" : "delivered")
        let detail: String
        switch status {
        case "skipped": detail = "Skipped questions stay open."
        case "queued": detail = "\(answers.count) answer\(answers.count == 1 ? "" : "s") queued for the agent."
        default: detail = "\(answers.count) answer\(answers.count == 1 ? "" : "s") delivered to the agent."
        }
        return (200, ["result": ["ok": true, "kind": "answer_items", "status": status, "detail": detail, "items": updated],
                      "state": fresh])
    }
}
#endif
