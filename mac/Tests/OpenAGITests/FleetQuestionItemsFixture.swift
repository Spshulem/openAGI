// Synthetic Needs You cards for an ask that carries several questions
// (src/fleet/decision-items.js): a fresh ten-question release card, the same
// card partly answered (item 3 delivered, item 1 skipped, item 4 failed with
// its answer kept), and a single-question card that keeps the #391 decision
// contract. Names and links are synthetic.
enum FleetQuestionItemsFixture {
  /// The three hub cards, trimmed to the fields the app reads.
  static let cardsJSON = #"""
[
 {
  "id": "fq_release",
  "questionId": "fq_release",
  "kind": "approval",
  "needsYou": true,
  "headline": "example #7913: resolve release decisions",
  "decisionHeadline": "Authorize the production release",
  "threadKey": "paseo:srv_test.release-coordinator",
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
  "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
  "prRef": "example/app#7913",
  "prUrl": "https://github.com/example/app/pull/7913",
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
  "suggestedReplies": [],
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
  }
 },
 {
  "id": "fq_release_partial",
  "questionId": "fq_release_partial",
  "kind": "approval",
  "needsYou": true,
  "headline": "example #7913: resolve release decisions",
  "decisionHeadline": "Authorize the production release",
  "threadKey": "paseo:srv_test.release-coordinator",
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
  "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
  "prRef": "example/app#7913",
  "prUrl": "https://github.com/example/app/pull/7913",
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
  "suggestedReplies": [],
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
  }
 },
 {
  "id": "fq_single",
  "questionId": "fq_single",
  "kind": "approval",
  "needsYou": true,
  "headline": "Deploy or hold?",
  "decisionHeadline": "Deploy or hold?",
  "threadKey": "paseo:s.single",
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
  "recommendation": "Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below.",
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
  "suggestedReplies": [
   "Approved — finish all remaining in-scope items",
   "Hold off — tell me what's still unverified first"
  ]
 }
]
"""#

  /// A whole state: the three questions and their cards. The questions keep
  /// the agent's blanket options, as a hub's raw question can.
  static let stateJSON = #"""
{
 "mode": "propose",
 "enabled": true,
 "running": false,
 "lastTickAt": "2026-11-27T17:52:00.000Z",
 "questions": [
  {
   "id": "fq_release",
   "kind": "agent-ask",
   "title": "example #7913: resolve release decisions",
   "body": "Release coordinator asks 10 questions (see the thread).",
   "options": [
    "Answer all questions",
    "Approve recommended choices"
   ],
   "threadKey": "paseo:srv_test.release-coordinator",
   "needsYou": true,
   "decisionHeadline": "Authorize the production release",
   "canReply": true,
   "project": "general",
   "askedAt": "2026-11-27T17:40:00.000Z"
  },
  {
   "id": "fq_release_partial",
   "kind": "agent-ask",
   "title": "example #7913: resolve release decisions",
   "body": "Release coordinator asks 10 questions (see the thread).",
   "options": [
    "Answer all questions",
    "Approve recommended choices"
   ],
   "threadKey": "paseo:srv_test.release-coordinator",
   "needsYou": true,
   "decisionHeadline": "Authorize the production release",
   "canReply": true,
   "project": "general",
   "askedAt": "2026-11-27T17:40:00.000Z"
  },
  {
   "id": "fq_single",
   "kind": "agent-ask",
   "title": "Deploy or hold?",
   "body": "CI is green. Deploy or hold?",
   "options": [
    "deploy",
    "hold"
   ],
   "threadKey": "paseo:s.single",
   "needsYou": true,
   "decisionHeadline": "Deploy or hold?",
   "canReply": true,
   "project": "general",
   "askedAt": "2026-11-27T17:40:00.000Z"
  }
 ],
 "cards": [
  {
   "id": "fq_release",
   "questionId": "fq_release",
   "kind": "approval",
   "needsYou": true,
   "headline": "example #7913: resolve release decisions",
   "decisionHeadline": "Authorize the production release",
   "threadKey": "paseo:srv_test.release-coordinator",
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
   "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
   "prRef": "example/app#7913",
   "prUrl": "https://github.com/example/app/pull/7913",
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
   "suggestedReplies": [],
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
   }
  },
  {
   "id": "fq_release_partial",
   "questionId": "fq_release_partial",
   "kind": "approval",
   "needsYou": true,
   "headline": "example #7913: resolve release decisions",
   "decisionHeadline": "Authorize the production release",
   "threadKey": "paseo:srv_test.release-coordinator",
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
   "recommendation": "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
   "prRef": "example/app#7913",
   "prUrl": "https://github.com/example/app/pull/7913",
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
   "suggestedReplies": [],
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
   }
  },
  {
   "id": "fq_single",
   "questionId": "fq_single",
   "kind": "approval",
   "needsYou": true,
   "headline": "Deploy or hold?",
   "decisionHeadline": "Deploy or hold?",
   "threadKey": "paseo:s.single",
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
   "recommendation": "Recommend: \"Deploy\" if the caveats above look right — otherwise pick another option or reply below.",
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
   "suggestedReplies": [
    "Approved — finish all remaining in-scope items",
    "Hold off — tell me what's still unverified first"
   ]
  }
 ]
}
"""#
}
