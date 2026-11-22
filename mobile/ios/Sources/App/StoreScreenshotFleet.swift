#if DEBUG
import Foundation

// Fictional coding-agent fleet for App Store captures of the real Supervisor
// views. Projects, agents, PRs and people are invented; nothing here is read
// from a daemon. "@-5m" style values become timestamps relative to launch so
// the views show natural "5m ago" times whenever the capture runs.
enum StoreScreenshotFleet {
    static func object(for path: String) -> Any? {
        switch path {
        case "/fleet/api/state": return json(state)
        case "/fleet/api/hierarchy": return json(hierarchy)
        case "/fleet/api/search": return ["query": "", "totalIndexed": 8, "results": []]
        case "/fleet/api/preferences":
            return ["ok": true, "preferences": ["mergePolicy": "manual_confirm", "cadence": "balanced", "autoSlices": []]]
        case let path where path.hasPrefix("/fleet/api/threads/"):
            let key = String(path.dropFirst("/fleet/api/threads/".count)).removingPercentEncoding ?? ""
            return threadDetail(key)
        default: return nil
        }
    }

    static func supervisorMessages() -> [[String: Any]] {
        [["id": "sup-ask", "role": "user", "at": stamp(-14),
          "text": "What needs me across my projects?"],
         ["id": "sup-answer", "role": "assistant", "at": stamp(-13),
          "text": "Three decisions need you. Everything else is moving.\n\n- **web-app**: PR #482 (checkout retries) is green and ready to merge.\n- **ios-app**: Claude Code needs the dark-mode accent color.\n- **api**: Codex is blocked on a staging key for order webhooks.\n\nFour agents are running and one PR is waiting on CI."]]
    }

    private static func stamp(_ minutes: Int) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(TimeInterval(minutes * 60)))
    }

    private static func json(_ text: String) -> Any {
        var resolved = text
        let pattern = try! NSRegularExpression(pattern: "\"@(-?\\d+)m\"")
        for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let minutes = Int((text as NSString).substring(with: match.range(at: 1))) ?? 0
            resolved = (resolved as NSString).replacingCharacters(in: match.range, with: "\"\(stamp(minutes))\"")
        }
        return (try? JSONSerialization.jsonObject(with: Data(resolved.utf8))) ?? [:]
    }

    private static func threadDetail(_ key: String) -> [String: Any] {
        let story: (owner: String, agent: String, history: [(String, String)]) = {
            switch key {
            case "claude:checkout-retry":
                return ("Retry a declined payment once before we email the customer.",
                        "Done. PR #482 retries a declined card once after 30 seconds, then sends the email. All 214 tests pass and CI is green. Ready for your review.",
                        [("user", "Retry a declined payment once before we email the customer."),
                         ("assistant", "On it. I'll add the retry to the payment worker and cover it with tests."),
                         ("assistant", "Done. PR #482 retries a declined card once after 30 seconds, then sends the email. All 214 tests pass and CI is green. Ready for your review.")])
            case "claude:dark-mode":
                return ("Polish dark mode across onboarding and settings.",
                        "The dark backgrounds are done. Which accent should buttons use on dark: Indigo or Teal?",
                        [("user", "Polish dark mode across onboarding and settings."),
                         ("assistant", "The dark backgrounds are done. Which accent should buttons use on dark: Indigo or Teal?")])
            default:
                return ("Add webhooks for order events.",
                        "Webhook delivery and retries are built. I need a staging API key to run the end-to-end test.",
                        [("user", "Add webhooks for order events."),
                         ("assistant", "Webhook delivery and retries are built. I need a staging API key to run the end-to-end test.")])
            }
        }()
        return ["thread": ["key": key, "scannedAt": stamp(-1),
                           "lastOwnerMessage": ["text": story.owner, "at": stamp(-50)],
                           "lastAgentMessage": ["text": story.agent, "at": stamp(-6)],
                           "conversation": ["messages": story.history.enumerated().map { index, row in
                               ["id": "\(key)-\(index)", "role": row.0, "text": row.1, "at": stamp(-50 + index * 20)]
                           }, "truncated": false]]]
    }

    private static let state = #"""
    {
      "mode": "observe", "enabled": true, "running": true,
      "lastTickAt": "@-1m", "nextTickAt": "@4m",
      "activeSummary": { "running": 4, "waitingCi": 1, "needsYou": 3, "total": 8 },
      "catchUpSummary": "Three decisions need you. Four agents are running; one PR is waiting on CI.",
      "snapshot": { "at": "@-1m", "threads": [
        { "key": "claude:checkout-retry", "kind": "claude", "title": "Retry declined checkout payments", "project": "web-app",
          "workspace": "web-app", "repo": "acme/web-app", "branch": "checkout-retry", "agentStatus": "idle", "state": "needs-human",
          "health": "yellow", "reason": "PR #482 is green and ready for review", "blockers": [], "live": true,
          "pr": { "ref": "#482", "state": "open", "title": "Retry declined payments once before emailing", "additions": 86, "deletions": 12, "changedFiles": 3,
                  "ci": { "state": "success", "failing": [], "pending": [] } },
          "lastActivityAt": "@-6m", "lastAgentText": "PR #482 is ready. All 214 tests pass.", "actorLabel": "Claude Code", "labels": ["payments"] },
        { "key": "codex:search-cache", "kind": "codex", "title": "Speed up product search", "project": "api", "workspace": "api",
          "repo": "acme/api", "branch": "search-cache", "agentStatus": "running", "state": "running", "health": "green", "blockers": [], "live": true,
          "lastActivityAt": "@-1m", "lastAgentText": "Benchmarking the search cache: p95 latency is down 38% so far.", "actorLabel": "Codex", "labels": ["performance"] },
        { "key": "claude:onboarding", "kind": "claude", "title": "New onboarding flow", "project": "ios-app", "workspace": "ios-app",
          "repo": "acme/ios-app", "branch": "onboarding", "agentStatus": "running", "state": "running", "health": "green", "blockers": [], "live": true,
          "lastActivityAt": "@-2m", "lastAgentText": "Building the welcome screens. 4 of 6 are done.", "actorLabel": "Claude Code", "labels": ["onboarding"] },
        { "key": "codex:rate-limits", "kind": "codex", "title": "Rate limits for the public API", "project": "api", "workspace": "api",
          "repo": "acme/api", "branch": "rate-limits", "agentStatus": "idle", "state": "waiting-ci", "health": "green", "blockers": [], "live": true,
          "pr": { "ref": "#311", "state": "open", "title": "Per-key rate limits", "ci": { "state": "pending", "failing": [], "pending": ["integration"] } },
          "lastActivityAt": "@-4m", "lastAgentText": "PR #311 is open. Waiting for the integration suite.", "actorLabel": "Codex", "labels": ["api"] },
        { "key": "claude:dark-mode", "kind": "claude", "title": "Dark mode polish", "project": "ios-app", "workspace": "ios-app",
          "repo": "acme/ios-app", "branch": "dark-mode", "agentStatus": "idle", "state": "needs-human", "health": "yellow",
          "reason": "Waiting for your accent color choice", "blockers": ["Needs the dark-mode accent color"], "live": true,
          "lastActivityAt": "@-9m", "lastAgentText": "Which accent should buttons use on dark: Indigo or Teal?", "actorLabel": "Claude Code", "labels": ["design"] },
        { "key": "codex:order-webhooks", "kind": "codex", "title": "Webhooks for order events", "project": "api", "workspace": "api",
          "repo": "acme/api", "branch": "order-webhooks", "agentStatus": "idle", "state": "needs-human", "health": "red",
          "reason": "Blocked: needs a staging API key", "blockers": ["Needs a staging API key"], "live": true,
          "lastActivityAt": "@-18m", "lastAgentText": "Delivery and retries are built. I need a staging key to test end to end.", "actorLabel": "Codex", "labels": ["integrations"] },
        { "key": "claude:flaky-login", "kind": "claude", "title": "Fix the flaky login test", "project": "web-app", "workspace": "web-app",
          "repo": "acme/web-app", "branch": "flaky-login", "agentStatus": "running", "state": "running", "health": "green", "blockers": [], "live": true,
          "lastActivityAt": "@-3m", "lastAgentText": "Found a race in the session cookie setup. Writing the fix.", "actorLabel": "Claude Code", "labels": ["tests"] },
        { "key": "codex:quickstart", "kind": "codex", "title": "Rewrite the quickstart", "project": "docs", "workspace": "docs",
          "repo": "acme/docs", "branch": "quickstart", "agentStatus": "running", "state": "running", "health": "green", "blockers": [], "live": true,
          "lastActivityAt": "@-5m", "lastAgentText": "Drafted the new 5-minute quickstart. Checking every code sample.", "actorLabel": "Codex", "labels": ["docs"] }
      ] },
      "cards": [
        { "id": "card-checkout", "questionId": "q-checkout", "kind": "merge", "kindLabel": "Ready to merge", "headline": "Retry declined checkout payments",
          "needsYou": true, "decisionHeadline": "Merge PR #482?",
          "decisionFact": "Retries a declined card once after 30 seconds, then emails the customer. All 214 tests pass.",
          "sessionTitle": "Retry declined checkout payments", "summary": "Small, well-tested change to the payment worker.",
          "brief": { "context": "Customers were emailed about declined cards that would have gone through on a retry.",
                     "whatChanged": "The payment worker retries a declined card once after 30 seconds before emailing.",
                     "decision": "Merge PR #482 into main?", "nextAction": "Merge" },
          "recommendation": "Merge. CI is green and the change is covered by tests.",
          "agentSummary": "PR #482 is ready. All 214 tests pass.",
          "threadKey": "claude:checkout-retry", "threadKeys": ["claude:checkout-retry"], "repo": "acme/web-app", "branch": "checkout-retry",
          "workspace": "web-app", "project": "web-app", "prRef": "#482", "prNumber": 482, "ciState": "success", "mergeState": "clean",
          "noticedAt": "@-6m", "risky": false, "canReply": true,
          "suggestedReplies": ["Merge it", "Add a test for two declines first"],
          "primaryAction": { "op": "merge", "label": "Merge" },
          "secondaryAction": { "op": "hold", "label": "Not yet" },
          "prContext": { "ref": "#482", "title": "Retry declined payments once before emailing", "additions": 86, "deletions": 12, "changedFiles": 3,
                         "files": ["workers/payments.ts", "workers/payments.test.ts", "emails/declined.ts"], "gates": [], "ciState": "success", "mergeState": "clean" },
          "actorLabel": "Claude Code", "labels": ["payments"], "blockingCount": 0 },
        { "id": "card-dark-mode", "questionId": "q-dark-mode", "kind": "agent-ask", "kindLabel": "Question", "headline": "Dark mode polish",
          "needsYou": true, "decisionHeadline": "Which accent for dark mode?",
          "decisionFact": "Claude Code finished the dark backgrounds and needs the button accent before it continues.",
          "sessionTitle": "Dark mode polish", "threadKey": "claude:dark-mode", "threadKeys": ["claude:dark-mode"], "repo": "acme/ios-app",
          "workspace": "ios-app", "project": "ios-app", "noticedAt": "@-9m", "risky": false, "canReply": true,
          "options": ["Indigo", "Teal"], "suggestedReplies": ["Indigo", "Teal"],
          "primaryAction": { "op": "answer", "label": "Indigo", "value": "Indigo" },
          "secondaryAction": { "op": "answer", "label": "Teal", "value": "Teal" },
          "actorLabel": "Claude Code", "labels": ["design"], "blockingCount": 1, "blockingSummary": "Blocks the dark mode PR" },
        { "id": "card-webhooks", "questionId": "q-webhooks", "kind": "blocker", "kindLabel": "Blocked", "headline": "Webhooks for order events",
          "needsYou": true, "decisionHeadline": "Codex needs a staging API key",
          "decisionFact": "Webhook delivery and retries are built. The end-to-end test needs a staging key.",
          "sessionTitle": "Webhooks for order events", "threadKey": "codex:order-webhooks", "threadKeys": ["codex:order-webhooks"],
          "repo": "acme/api", "workspace": "api", "project": "api", "noticedAt": "@-18m", "risky": false, "canReply": true,
          "suggestedReplies": ["I added it to the staging vault", "Skip the end-to-end test for now"],
          "primaryAction": { "op": "reply", "label": "Reply" },
          "actorLabel": "Codex", "labels": ["integrations"], "blockingCount": 1, "blockingSummary": "Blocks the webhooks PR" }
      ],
      "questions": [
        { "id": "q-checkout", "title": "Merge PR #482?", "body": "Retries a declined card once after 30 seconds, then emails the customer. All 214 tests pass.",
          "kind": "merge", "threadKey": "claude:checkout-retry", "prRef": "#482", "options": ["Merge", "Not yet"], "createdAt": "@-6m", "needsYou": true,
          "decisionHeadline": "Merge PR #482?" },
        { "id": "q-dark-mode", "title": "Which accent for dark mode?", "body": "The dark backgrounds are done. Which accent should buttons use on dark: Indigo or Teal?",
          "kind": "agent-ask", "threadKey": "claude:dark-mode", "options": ["Indigo", "Teal"], "createdAt": "@-9m", "needsYou": true },
        { "id": "q-webhooks", "title": "Codex needs a staging API key", "body": "Webhook delivery and retries are built. I need a staging API key to run the end-to-end test.",
          "kind": "agent-ask", "threadKey": "codex:order-webhooks", "options": [], "createdAt": "@-18m", "needsYou": true }
      ],
      "actions": [],
      "activityEvents": [
        { "id": "ev1", "kind": "pr", "actor": "Claude Code", "project": "web-app", "title": "Opened PR #482", "detail": "Retry declined payments once before emailing", "threadKey": "claude:checkout-retry", "prRef": "#482", "labels": [], "at": "@-7m" },
        { "id": "ev2", "kind": "ci", "actor": "CI", "project": "web-app", "title": "CI passed on #482", "detail": "214 tests", "threadKey": "claude:checkout-retry", "prRef": "#482", "labels": [], "at": "@-6m" },
        { "id": "ev3", "kind": "progress", "actor": "Codex", "project": "api", "title": "Search cache benchmark", "detail": "p95 latency down 38%", "threadKey": "codex:search-cache", "labels": [], "at": "@-1m" },
        { "id": "ev4", "kind": "pr", "actor": "Codex", "project": "api", "title": "Opened PR #311", "detail": "Per-key rate limits", "threadKey": "codex:rate-limits", "prRef": "#311", "labels": [], "at": "@-4m" },
        { "id": "ev5", "kind": "ask", "actor": "Claude Code", "project": "ios-app", "title": "Asked about the dark-mode accent", "threadKey": "claude:dark-mode", "labels": [], "at": "@-9m" }
      ],
      "preferences": { "mergePolicy": "manual_confirm", "cadence": "balanced", "autoSlices": [] }
    }
    """#

    private static let hierarchy = #"""
    {
      "generatedAt": "@-1m", "totalProjects": 4, "totalThemes": 7, "totalSessions": 8,
      "generalSupervisor": { "title": "Supervisor", "runningCount": 4, "needsYouCount": 3, "overlapCount": 0, "headline": "Three decisions need you" },
      "projects": [
        { "id": "api", "name": "api", "supervisorTitle": "api supervisor", "repo": "acme/api",
          "counts": { "running": 1, "idle": 2, "sleeping": 0, "archived": 0, "total": 3 }, "needsYouCount": 1, "latestActivityAt": "@-1m",
          "themes": [
            { "id": "api-perf", "name": "Performance", "source": "label", "counts": { "running": 1, "idle": 0, "sleeping": 0, "total": 1 }, "needsYouCount": 0, "prRefs": [],
              "latestActivityAt": "@-1m", "sessions": [ { "key": "codex:search-cache", "title": "Speed up product search", "workspace": "api", "theme": "Performance", "state": "running", "host": "Studio Mac", "prRefs": [], "snippet": "p95 latency is down 38% so far.", "needsYouCount": 0 } ] },
            { "id": "api-platform", "name": "Platform", "source": "label", "counts": { "running": 0, "idle": 2, "sleeping": 0, "total": 2 }, "needsYouCount": 1, "prRefs": ["#311"],
              "latestActivityAt": "@-4m", "sessions": [
                { "key": "codex:rate-limits", "title": "Rate limits for the public API", "workspace": "api", "theme": "Platform", "state": "waiting-ci", "host": "Studio Mac", "prRefs": ["#311"], "snippet": "Waiting for the integration suite.", "needsYouCount": 0 },
                { "key": "codex:order-webhooks", "title": "Webhooks for order events", "workspace": "api", "theme": "Platform", "state": "needs-human", "host": "Studio Mac", "prRefs": [], "snippet": "Needs a staging API key.", "needsYouCount": 1 } ] } ] },
        { "id": "ios-app", "name": "ios-app", "supervisorTitle": "ios-app supervisor", "repo": "acme/ios-app",
          "counts": { "running": 1, "idle": 1, "sleeping": 0, "archived": 0, "total": 2 }, "needsYouCount": 1, "latestActivityAt": "@-2m",
          "themes": [
            { "id": "ios-onboarding", "name": "Onboarding", "source": "label", "counts": { "running": 1, "idle": 0, "sleeping": 0, "total": 1 }, "needsYouCount": 0, "prRefs": [],
              "latestActivityAt": "@-2m", "sessions": [ { "key": "claude:onboarding", "title": "New onboarding flow", "workspace": "ios-app", "theme": "Onboarding", "state": "running", "host": "MacBook Pro", "prRefs": [], "snippet": "4 of 6 welcome screens done.", "needsYouCount": 0 } ] },
            { "id": "ios-design", "name": "Design", "source": "label", "counts": { "running": 0, "idle": 1, "sleeping": 0, "total": 1 }, "needsYouCount": 1, "prRefs": [],
              "latestActivityAt": "@-9m", "sessions": [ { "key": "claude:dark-mode", "title": "Dark mode polish", "workspace": "ios-app", "theme": "Design", "state": "needs-human", "host": "MacBook Pro", "prRefs": [], "snippet": "Which accent for dark mode?", "needsYouCount": 1 } ] } ] },
        { "id": "web-app", "name": "web-app", "supervisorTitle": "web-app supervisor", "repo": "acme/web-app",
          "counts": { "running": 1, "idle": 1, "sleeping": 0, "archived": 0, "total": 2 }, "needsYouCount": 1, "latestActivityAt": "@-3m",
          "themes": [
            { "id": "web-payments", "name": "Payments", "source": "label", "counts": { "running": 0, "idle": 1, "sleeping": 0, "total": 1 }, "needsYouCount": 1, "prRefs": ["#482"],
              "latestActivityAt": "@-6m", "sessions": [ { "key": "claude:checkout-retry", "title": "Retry declined checkout payments", "workspace": "web-app", "theme": "Payments", "state": "needs-human", "host": "Studio Mac", "prRefs": ["#482"], "snippet": "PR #482 is ready to merge.", "needsYouCount": 1 } ] },
            { "id": "web-tests", "name": "Tests", "source": "label", "counts": { "running": 1, "idle": 0, "sleeping": 0, "total": 1 }, "needsYouCount": 0, "prRefs": [],
              "latestActivityAt": "@-3m", "sessions": [ { "key": "claude:flaky-login", "title": "Fix the flaky login test", "workspace": "web-app", "theme": "Tests", "state": "running", "host": "Studio Mac", "prRefs": [], "snippet": "Writing the fix for a cookie race.", "needsYouCount": 0 } ] } ] },
        { "id": "docs", "name": "docs", "supervisorTitle": "docs supervisor", "repo": "acme/docs",
          "counts": { "running": 1, "idle": 0, "sleeping": 0, "archived": 0, "total": 1 }, "needsYouCount": 0, "latestActivityAt": "@-5m",
          "themes": [
            { "id": "docs-guides", "name": "Guides", "source": "label", "counts": { "running": 1, "idle": 0, "sleeping": 0, "total": 1 }, "needsYouCount": 0, "prRefs": [],
              "latestActivityAt": "@-5m", "sessions": [ { "key": "codex:quickstart", "title": "Rewrite the quickstart", "workspace": "docs", "theme": "Guides", "state": "running", "host": "MacBook Pro", "prRefs": [], "snippet": "Checking every code sample.", "needsYouCount": 0 } ] } ] }
      ]
    }
    """#
}
#endif
