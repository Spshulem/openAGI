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
      operations: ["send"],
      detail: "Sends chat messages to the agent from the phone."
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
    ["POST", "/nodes/speech-token"]
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
    ["POST", "/tick"]
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

test("path traversal and lookalike ids cannot widen the scope", () => {
  assert.equal(isMobileRouteAllowed("POST", "/tasks/../control/restart"), false);
  assert.equal(isMobileRouteAllowed("POST", "/tasks/a/b/complete"), false);
  assert.equal(isMobileRouteAllowed("POST", "/tasks//complete"), false);
  assert.equal(isMobileRouteAllowed("POST", "/pending-actions/pa 1/approve"), false);
  assert.equal(isMobileRouteAllowed("GET", "/tasks/clarifications/extra"), false);
});

test("node names are bounded and never empty", () => {
  assert.equal(boundedMobileNodeName("Sean's iPhone"), "Sean's iPhone");
  assert.equal(boundedMobileNodeName(""), "Phone");
  assert.equal(boundedMobileNodeName(null), "Phone");
  assert.equal(boundedMobileNodeName("x".repeat(200)).length, 60);
  assert.equal(boundedMobileNodeName("bad\u0000name"), "badname");
});
