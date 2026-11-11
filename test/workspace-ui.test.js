import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { workspaceUi } from '../src/workspace-ui.js';
import { navigation } from '../src/app-shell.js';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.isConnected = true; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
}
const all = node => [node, ...node.children.flatMap(all)];
function fixture() {
  const main = new Element('main');
  const context = vm.createContext({ window: { location: {} }, main, state: { tab: 'tasks' }, document: { createElement: tag => new Element(tag) },
    fetchJson: async () => ({ pairedTo: 'https://agent.example.invalid' }), safeLinkHref: value => value });
  vm.runInContext(workspaceUi, context);
  return { main, context };
}

test('failed task access shows recovery instead of zero tasks and preserves explicit retry', async () => {
  const { main, context } = fixture(); let retries = 0;
  await context.renderWorkspaceUnavailable('Tasks', { code: 'main-pairing-required' }, () => retries++);
  const nodes = all(main);
  assert.ok(nodes.some(x => /reconnect to your agent/.test(x.textContent)));
  assert.ok(!nodes.some(x => /0 tasks|No tasks yet/.test(x.textContent)));
  const link = nodes.find(x => x.tag === 'a');
  assert.equal(link.href, 'https://agent.example.invalid');
  nodes.find(x => x.tag === 'button').onclick(); assert.equal(retries, 1);
});

test('ordinary API failure keeps the error visible without suggesting permission changes', async () => {
  const { main, context } = fixture();
  await context.renderWorkspaceUnavailable('Today', { status: 500 }, () => {});
  assert.ok(all(main).some(x => /could not be loaded/.test(x.textContent)));
  assert.ok(!all(main).some(x => x.tag === 'a'));
});

test('Supervisor opens the existing full view; coding setup is secondary', () => {
  const { main, context } = fixture(); context.renderSupervisor();
  assert.equal(context.window.location.href, '/fleet');
  assert.ok(!all(main).some(x => x.tag === 'iframe'));
  assert.ok(navigation.indexOf('data-tab="supervisor"') < navigation.indexOf('nav-advanced'));
  assert.ok(navigation.indexOf('data-tab="coding-agents"') > navigation.indexOf('nav-advanced'));
  assert.ok(!navigation.includes('Fleet overview'));
});
