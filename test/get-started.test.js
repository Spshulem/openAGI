import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { GET_STARTED_FLOWS, GET_STARTED_GUIDANCE } from "../src/get-started.js";
import { getStartedUi } from "../src/get-started-ui.js";
import { AgentHost } from "../src/agent-host.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.value = ""; this.textContent = ""; }
  append(...nodes) { this.children.push(...nodes); }
  set innerHTML(value) { this.children = []; this.html = value; }
  dispatchEvent() { this.changed = true; }
  focus() { this.focused = true; }
}
const all = node => [node, ...node.children.flatMap(all)];
function harness(saved = "[]") {
  const main = new Element("main"), input = new Element("textarea"), writes = [], tabs = [], urls = [];
  const context = vm.createContext({ main, state: { sessionId: "old-chat", agentId: "old-specialist", messages: ["old"], activeRequestId: "old-request" },
    document: { createElement: tag => new Element(tag), getElementById: id => id === "input" ? input : null },
    localStorage: { getItem: () => saved, setItem: (key, value) => writes.push([key, value]) },
    window: { location: { href: "http://localhost:43210/?tab=get-started&session=old&request=old&compose=remember&pending=old" } },
    history: { replaceState: (_a, _b, url) => urls.push(url) },
    switchTab: async tab => tabs.push(tab), URL, Event: class {} });
  vm.runInContext(getStartedUi, context);
  context.renderGettingStarted();
  return { context, main, input, writes, tabs, urls };
}

test("every goal opens an editable fresh main-agent chat without sending or marking completion", async () => {
  for (const flow of GET_STARTED_FLOWS) {
    const h = harness();
    await h.context.startGettingStartedChat(flow.id);
    assert.equal(h.input.value, flow.prompt);
    assert.equal(h.input.focused, true);
    assert.equal(h.context.state.sessionId, null);
    assert.equal(h.context.state.agentId, "main");
    assert.equal(h.context.state.activeRequestId, null);
    assert.deepEqual(h.tabs, ["chat"]);
    assert.equal(h.writes.length, 0, "opening instructions does not mark a working capability");
    const url = new URL(h.urls[0]);
    assert.equal(url.search, "?tab=chat", "old chat and approval handoffs are removed");
  }
});

test("invalid goals cannot reset a conversation or seed arbitrary instructions", async () => {
  const h = harness();
  await h.context.startGettingStartedChat("<script>arbitrary</script>");
  assert.equal(h.context.state.sessionId, "old-chat");
  assert.equal(h.tabs.length, 0);
});

test("progress is explicit, reversible, and tolerates corrupt browser storage", () => {
  for (const saved of ["not json", "{}", '"memory"', '["unknown"]']) {
    const h = harness(saved);
    assert.ok(all(h.main).some(e => e.textContent.startsWith("0 of 6")));
  }
  const h = harness('["memory"]');
  const checks = all(h.main).filter(e => e.type === "checkbox");
  assert.equal(checks[1].checked, true);
  checks[1].checked = false;
  checks[1].onchange();
  assert.equal(h.writes[0][1], "[]");
  assert.equal(all(h.main).filter(e => /Meet your agent →|Try it in chat →/.test(e.textContent)).length, 6);
});

test("guided instructions reach the agent on every chat surface without changing approval authority", () => {
  const instructions = AgentHost.prototype.instructionsForAgent.call({ runtime: {} }, { name: "test-agent" });
  assert.ok(instructions.includes(GET_STARTED_GUIDANCE));
  assert.match(instructions, /Ask one question at a time/);
  assert.match(instructions, /never in chat/);
  assert.match(instructions, /not blanket authorization/);
  assert.match(instructions, /PolyForm Noncommercial/);
});
