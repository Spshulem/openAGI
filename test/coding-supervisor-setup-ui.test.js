import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { codingSupervisorUi } from "../src/coding-supervisor-ui.js";

// Exercise the shipped handlers without network, provider accounts or live data.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.value = ""; this.textContent = ""; this.isConnected = true; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this[key] = value; }
}
const all = node => [node, ...node.children.flatMap(all)];
async function render(setup) {
  const panel = new Element("section"), sent = [], tabs = [];
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) },
    fetchJson: async () => setup,
    postJson: async (route, body) => { sent.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { status: "awaiting_confirmation" }; },
    switchTab: tab => tabs.push(tab) });
  vm.runInContext(codingSupervisorUi + '\nrenderCodingAgents = async () => {};', context);
  await context.renderCodingSetup(panel);
  return { panel, sent, tabs, elements: all(panel) };
}
const workspace = { id: "a".repeat(64), label: '<img src=x onerror="alert(1)">' };
const provider = { provider: "codex", installed: true, loginCommand: "codex login" };

test("fresh setup blocks empty folders before making any request and links to public instructions", async () => {
  const f = await render({ enabled: false, workspaces: [], providers: [{ ...provider, installed: false }] });
  await f.elements.find(e => e.textContent === "Save folders and enable").onclick();
  assert.equal(f.sent.length, 0);
  assert.ok(f.elements.some(e => /Choose at least one/.test(e.textContent)));
  const guide = f.elements.find(e => e.tag === "a");
  assert.match(guide.href, /\/docs\/setup\/coding-supervisor\.md$/);
  assert.equal(guide.rel, "noopener noreferrer");
});

test("blank editor preserves saved selection; explicit folders replace it", async () => {
  const f = await render({ enabled: false, workspaces: [workspace], providers: [provider] });
  const save = f.elements.find(e => e.textContent === "Keep saved folders and enable");
  assert.ok(f.elements.some(e => (e.textContent || "").includes(workspace.label)), "hostile labels remain text");
  assert.equal(f.elements.some(e => e.tag === "img"), false);
  await save.onclick();
  assert.deepEqual(f.sent[0], { route: "/coding-agents/configure", body: { enabled: true } });
  const folders = f.elements.find(e => e.tag === "textarea");
  folders.value = " /projects/one \n /projects/two \n"; folders.oninput();
  assert.equal(save.textContent, "Replace folders and enable");
  await save.onclick();
  assert.deepEqual(f.sent[1].body, { enabled: true, workspaces: ["/projects/one", "/projects/two"] });
});

test("missing CLI or legacy empty folders show recovery instead of a start form", async () => {
  for (const setup of [
    { enabled: true, workspaces: [workspace], providers: [{ ...provider, installed: false }] },
    { enabled: true, workspaces: [], providers: [provider] }
  ]) {
    const f = await render(setup);
    assert.equal(f.elements.some(e => e.textContent === "Review start approval"), false);
    assert.ok(f.elements.some(e => /No provider CLI found|Choose a Git project folder before/.test(e.textContent)));
    assert.equal(f.sent.length, 0);
  }
});

test("configured start still queues approval with the exact selected identity", async () => {
  const f = await render({ enabled: true, workspaces: [workspace], providers: [provider] });
  const selects = f.elements.filter(e => e.tag === "select");
  selects[0].value = "codex"; selects[1].value = workspace.id;
  f.elements.filter(e => e.tag === "textarea").at(-1).value = "Inspect the chosen project";
  await f.elements.find(e => e.textContent === "Review start approval").onclick();
  assert.equal(f.sent[0].route, "/coding-agents/start");
  assert.equal(f.sent[0].body.workspaceId, workspace.id);
  assert.equal(f.sent[0].body.message, "Inspect the chosen project");
  assert.deepEqual(f.tabs, ["approvals"]);
});

test("external adapters keep the public guide visible", async () => {
  const f = await render({ external: true });
  assert.ok(f.elements.some(e => e.tag === "a"));
  assert.equal(f.elements.some(e => e.tag === "textarea"), false);
  assert.equal(f.sent.length, 0);
});
