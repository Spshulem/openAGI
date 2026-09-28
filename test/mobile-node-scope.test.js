// test/mobile-node-scope.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOBILE_PLATFORM,
  MOBILE_CAPABILITIES,
  isMobileRouteAllowed,
  boundedMobileNodeName
} from "../src/mobile-node.js";

test("the platform string and capabilities are the documented ones", () => {
  assert.equal(MOBILE_PLATFORM, "mobile");
  // Capability objects, not bare strings: sanitizeNodeCapabilities() only
  // keeps entries carrying an .id, so a phone's declared capabilities must
  // already be shaped like this to survive being stored and echoed back.
  assert.deepEqual(MOBILE_CAPABILITIES, [
    {
      id: "mobile-task-client",
      ready: true,
      operations: ["list", "create", "update", "delete", "complete"],
      detail: "Reads, creates, edits, completes, and deletes tasks in the user queue from the phone."
    },
    {
      id: "mobile-approval-client",
      ready: true,
      operations: ["approve", "deny"],
      detail: "Approves or denies queued agent actions from the phone."
    },
    {
      id: "mobile-chat-client",
      ready: true,
      operations: ["send", "history"],
      detail: "Sends chat messages to the agent from the phone and reads the shared device threads."
    },
    {
      id: "mobile-fleet-client",
      ready: true,
      operations: ["read", "answer", "mode", "send", "scan"],
      detail: "Reads the coding-fleet supervisor, answers its questions, changes its mode, sends proposed nudges, and runs a scan from the phone."
    },
    {
      id: "mobile-lifelog-client",
      ready: true,
      operations: ["read"],
      detail: "Reads and searches retained G2 conversation moments from the phone."
    }
  ]);
});

test("every route the phone app needs is allowed", () => {
  const allowed = [
    ["GET", "/mobile/summary"],
    ["GET", "/tasks"],
    ["POST", "/tasks"],
    ["GET", "/tasks/task_abc"],
    ["PATCH", "/tasks/task_abc"],
    ["POST", "/tasks/task_abc/complete"],
    ["DELETE", "/tasks/task_abc"],
    ["GET", "/tasks/clarifications"],
    ["POST", "/tasks/clarifications/clar_1/answer"],
    ["GET", "/pending-actions"],
    ["POST", "/pending-actions/pa_1/approve"],
    ["POST", "/pending-actions/pa_1/deny"],
    ["POST", "/message"],
    ["GET", "/events"],
    ["GET", "/brief/today"],
    ["POST", "/brief/focus/dismiss"],
    ["GET", "/recap/daily"],
    ["GET", "/plan/daily"],
    ["GET", "/outreach/digest"],
    ["POST", "/nodes/heartbeat"],
    ["POST", "/nodes/revoke"],
    ["POST", "/nodes/speech-token"],
    ["GET", "/fleet/api/state"],
    ["POST", "/fleet/api/scan"],
    ["POST", "/fleet/api/mode"],
    ["POST", "/fleet/api/questions/fq_abc-1"],
    ["POST", "/fleet/api/actions/fa_abc-1/send"],
    ["GET", "/conversations/agent/messages"],
    ["GET", "/conversations/supervisor/messages"],
    ["GET", "/lifelog/moments"]
  ];
  for (const [method, pathname] of allowed) {
    assert.equal(isMobileRouteAllowed(method, pathname), true, `${method} ${pathname} should be allowed`);
  }
});

test("one representative route from every excluded family is refused", () => {
  const refused = [
    ["POST", "/control/restart"],
    ["POST", "/control/update"],
    ["POST", "/nodes/control/poll"],
    ["POST", "/nodes/control/result"],
    ["POST", "/admin/provider"],
    ["GET", "/setup"],
    ["POST", "/setup/save"],
    ["POST", "/mcp/call"],
    ["POST", "/mcp/register"],
    ["GET", "/skills"],
    ["POST", "/skills/reload"],
    ["GET", "/memory"],
    ["POST", "/memory/remember"],
    ["GET", "/computer-use/log"],
    ["POST", "/computer-use/toggle"],
    ["POST", "/nodes/capture-memory"],
    ["POST", "/nodes/enroll"],
    ["POST", "/nodes/g2/ask"],
    ["GET", "/budget/ledger"],
    ["GET", "/observations"],
    ["GET", "/sessions"],
    ["POST", "/tick"],
    ["GET", "/outreach/feed"],
    ["GET", "/conversations/owner/messages"],
    ["POST", "/conversations/agent/messages"],
    ["POST", "/lifelog/moments"],
    ["GET", "/g2/lifelog"]
  ];
  for (const [method, pathname] of refused) {
    assert.equal(isMobileRouteAllowed(method, pathname), false, `${method} ${pathname} must be refused`);
  }
});

test("the method matters, not just the path", () => {
  assert.equal(isMobileRouteAllowed("DELETE", "/message"), false);
  assert.equal(isMobileRouteAllowed("POST", "/events"), false);
  assert.equal(isMobileRouteAllowed("POST", "/mobile/summary"), false);
});

test("only the fleet JSON API opens to the phone, never the page or other fleet paths", () => {
  const refused = [
    ["GET", "/fleet"],
    ["GET", "/fleet/"],
    ["GET", "/fleet/api"],
    ["GET", "/fleet/api/"],
    ["GET", "/fleet/api/unknown"],
    ["POST", "/fleet/api/unknown"],
    ["POST", "/fleet/api/state"],
    ["GET", "/fleet/api/scan"],
    ["GET", "/fleet/api/mode"],
    ["GET", "/fleet/api/questions/fq_1"],
    ["DELETE", "/fleet/api/questions/fq_1"],
    ["POST", "/fleet/api/questions"],
    ["POST", "/fleet/api/questions/"],
    ["POST", "/fleet/api/questions/fq_1/answer"],
    ["POST", "/fleet/api/actions/fa_1"],
    ["GET", "/fleet/api/actions/fa_1/send"],
    ["POST", "/fleet/api/actions/fa_1/cancel"],
    ["POST", "/fleet/api/state/extra"]
  ];
  for (const [method, pathname] of refused) {
    assert.equal(isMobileRouteAllowed(method, pathname), false, `${method} ${pathname} must be refused`);
  }
});

test("path traversal and lookalike ids cannot widen the scope", () => {
  assert.equal(isMobileRouteAllowed("POST", "/tasks/../control/restart"), false);
  assert.equal(isMobileRouteAllowed("POST", "/tasks/a/b/complete"), false);
  assert.equal(isMobileRouteAllowed("POST", "/tasks//complete"), false);
  assert.equal(isMobileRouteAllowed("POST", "/pending-actions/pa 1/approve"), false);
  assert.equal(isMobileRouteAllowed("GET", "/tasks/clarifications/extra"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/questions/../mode"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/questions/../../control/restart"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/actions/../../nodes/enroll/send"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/actions//send"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/actions/a/b/send"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/questions/fq 1"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/questions/fq.1"), false);
  assert.equal(isMobileRouteAllowed("POST", "/fleet//api/state"), false);
  assert.equal(isMobileRouteAllowed("POST", `/fleet/api/questions/${"a".repeat(121)}`), false);
});

test("node names are bounded and never empty", () => {
  assert.equal(boundedMobileNodeName("Sean's iPhone"), "Sean's iPhone");
  assert.equal(boundedMobileNodeName(""), "Phone");
  assert.equal(boundedMobileNodeName(null), "Phone");
  assert.equal(boundedMobileNodeName("x".repeat(200)).length, 60);
  assert.equal(boundedMobileNodeName("bad\u0000name"), "badname");
});
