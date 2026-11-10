import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { confirmedPaseoTurn, deliverPaseo } from '../src/fleet/paseo-delivery.js';
import { paseoThread } from '../src/fleet/sources/paseo.js';
function setup(t, extra = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-delivery-'));
 t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
 const initial = {id:'chat',status:'idle',updatedAt:'2026-01-01T00:00:00Z',cwd:'/workspace/repo',workspaceId:'workspace'};
 let current={...initial,...extra}, sent=[], confirmed=true;
 const ref={refresh:async()=>{},current:()=>current,send:async(text,options)=>{sent.push({text,options});},timeline:{refetch:async()=>({agent:current,entries:confirmed&&sent.length?[{item:{type:'user_message',messageId:sent.at(-1).options.messageId},turnId:'turn-1',timestamp:initial.updatedAt,seqEnd:1},{item:{type:'assistant_message',text:'working'},turnId:'turn-1',seqStart:2}]:[]})}};
 const factory=()=>({connect:async()=>{},close:async()=>{},hosts:{list:async()=>({self:{serverId:'host'},hosts:[]})},agents:{ref:()=>ref}});
 return {sent,ref,setConfirmed:v=>confirmed=v,args:{config:{paseo:{enabled:true}},thread:paseoThread(initial,'host'),text:'Continue the authorized tests.',store:{dir},actionId:'action',base:{messageHash:'hash'},factory}};
}
test('native send preserves settings and confirms its own message before counting success',async t=>{
 const f=setup(t); assert.equal((await deliverPaseo(f.args)).status,'sent');
 assert.equal(f.sent.length,1); assert.deepEqual(Object.keys(f.sent[0].options).sort(),['activeTurnBehavior','messageId']); assert.equal(f.sent[0].options.activeTurnBehavior,'steer');
 assert.equal((await deliverPaseo(f.args)).status,'blocked');assert.equal(f.sent.length,1);
});
for(const [name,change] of Object.entries({running:{status:'running'},closed:{status:'closed'},archived:{archivedAt:'today'},permission:{pendingPermissions:[{}]},turn:{activeTurn:{}},workspace:{workspaceId:'other'},revision:{updatedAt:'2026-01-02T00:00:00Z'}}))test(`blocks ${name} before dispatch`,async t=>{
 const f=setup(t,change);assert.equal((await deliverPaseo(f.args)).status,'blocked');assert.equal(f.sent.length,0);
});
test('accepted-but-unconfirmed delivery remains durable across later attempts',async t=>{
 const f=setup(t);f.setConfirmed(false);assert.equal((await deliverPaseo(f.args)).status,'blocked');assert.equal(f.sent.length,1);
 assert.equal((await deliverPaseo({...f.args,actionId:'new',base:{messageHash:'different'}})).status,'blocked');assert.equal(f.sent.length,1);
 f.setConfirmed(true);const result=await deliverPaseo({...f.args,actionId:'new'});assert.equal(result.status,'blocked');assert.match(result.detail,/Previous Paseo turn confirmed/);assert.equal(f.sent.length,1);
});
test('storage failure prevents sending',async t=>{
 const f=setup(t);fs.writeFileSync(path.join(f.args.store.dir,'paseo-deliveries'),'obstruction');
 assert.equal((await deliverPaseo(f.args)).status,'blocked');assert.equal(f.sent.length,0);
});
test('send exception cannot trigger a retry',async t=>{
 const f=setup(t);let attempts=0;f.ref.send=async()=>{attempts++;throw Error('lost response');};
 await deliverPaseo(f.args);await deliverPaseo(f.args);assert.equal(attempts,1);
});

test('confirmation accepts provider and turn correlation but rejects unrelated activity', () => {
 const history = { agent: { status: 'idle' }, entries: [
  { item: { type: 'user_message', messageId: 'provider-message' }, turnId: 'turn-1', seqEnd: 10 },
  { item: { type: 'assistant_message', text: 'done' }, turnId: 'turn-1', seqStart: 11 }
 ] };
 assert.equal(confirmedPaseoTurn(history, { messageId: 'client-message', providerMessageId: 'provider-message', turnId: 'turn-1' }), true);
 assert.equal(confirmedPaseoTurn(history, { messageId: 'different-message', turnId: 'different-turn' }), false);
});

test('persists a pre-send cursor and reads after it for exact confirmation', async t => {
 const f = setup(t), reads = [];
 f.ref.timeline.refetch = async options => {
  reads.push(options);
  if (options.direction === 'tail' && options.limit === 1) {
   return { epoch: 'epoch-1', endCursor: { epoch: 'epoch-1', seq: 100 }, agent: f.ref.current(), entries: [] };
  }
  const own = { item: { type: 'user_message', clientMessageId: f.sent[0].options.messageId }, turnId: 'turn-1', seqStart: 101, seqEnd: 101 };
  return { agent: f.ref.current(), entries: [own, { item: { type: 'assistant_message', text: 'done' }, turnId: 'turn-1', seqStart: 102 }] };
 };
 assert.equal((await deliverPaseo(f.args)).status, 'sent');
 assert.equal(reads[0].direction, 'tail');
 assert.deepEqual(reads[1], { direction: 'after', cursor: { epoch: 'epoch-1', seq: 100 }, limit: 80 });
 assert.deepEqual(receipt(f).cursor, { epoch: 'epoch-1', seq: 100 });
});

test('persists host correlation and accepts an exact returned turn without guessing from text', async t => {
 const f = setup(t);
 f.ref.send = async (text, options) => { f.sent.push({ text, options }); return { clientMessageId: options.messageId, providerMessageId: 'provider-message', turnId: 'turn-1' }; };
 f.ref.timeline.refetch = async options => options.direction === 'tail' && options.limit === 1
  ? { epoch: 'epoch-1', endCursor: { epoch: 'epoch-1', seq: 10 }, agent: f.ref.current(), entries: [] }
  : { agent: { ...f.ref.current(), status: 'running', activeTurn: { turnId: 'turn-1', startedAt: '2026-01-01T00:00:01Z' } }, entries: [] };
 assert.equal((await deliverPaseo(f.args)).status, 'sent');
 assert.deepEqual(receipt(f), {
  messageId: f.sent[0].options.messageId,
  clientMessageId: f.sent[0].options.messageId,
  messageHash: 'hash',
  activityAt: '2026-01-01T00:00:00Z',
  cursor: { epoch: 'epoch-1', seq: 10 },
  providerMessageId: 'provider-message',
  turnId: 'turn-1',
  pending: false,
 });
});

test('mismatched host correlation remains pending and cannot be retried automatically', async t => {
 const f = setup(t);
 f.ref.send = async (text, options) => { f.sent.push({ text, options }); return { clientMessageId: 'different-client-message' }; };
 const result = await deliverPaseo(f.args);
 assert.equal(result.status, 'blocked');
 assert.match(result.detail, /mismatched client message ID/);
 assert.equal(receipt(f).pending, true);
 assert.equal(receipt(f).correlationMismatch, true);
 assert.equal((await deliverPaseo(f.args)).status, 'blocked');
 assert.equal(f.sent.length, 1);
});

function receipt(f) {
  const dir = path.join(f.args.store.dir, 'paseo-deliveries');
  return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
}

for (const evidence of ['running turn', 'completed response']) {
  test(`accepted send waits for its delayed ${evidence} without sending again`, async t => {
    const f = setup(t);
    let reads = 0;
    f.ref.timeline.refetch = async () => {
      reads++;
      // Acceptance can precede both the user entry and provider turn start.
      if (reads <= 2) return { agent: f.ref.current(), entries: [] };
      const own = { item: { type: 'user_message', clientMessageId: f.sent[0].options.messageId },
        turnId: 'turn-1', timestamp: '2026-01-01T00:00:01Z', seqStart: 1, seqEnd: 1 };
      return evidence === 'running turn'
        ? { agent: { ...f.ref.current(), status: 'running', activeTurn: { turnId: 'turn-1', startedAt: own.timestamp } }, entries: [own] }
        : { agent: f.ref.current(), entries: [own, { item: { type: 'assistant_message', text: 'Finished.' }, turnId: 'turn-1', seqStart: 2 }] };
    };
    const result = await deliverPaseo(f.args);
    assert.equal(result.status, 'sent');
    assert.equal(reads, 3);
    assert.equal(f.sent.length, 1);
    assert.equal(receipt(f).pending, false);
  });
}

test('unrelated activity cannot confirm an accepted message; timeout preserves replay protection', async t => {
  const f = setup(t);
  f.args.config.paseo.timeoutMs = 40;
  let reads = 0;
  f.ref.timeline.refetch = async () => {
    reads++;
    if (reads === 1) return { agent: f.ref.current(), entries: [] };
    return { agent: { ...f.ref.current(), status: 'running', activeTurn: { startedAt: '2026-01-01T00:00:01Z' } },
      entries: [{ item: { type: 'user_message', messageId: 'another-message' }, timestamp: '2026-01-01T00:00:00Z', seqEnd: 1 },
        { item: { type: 'assistant_message', text: 'Working on the other message.' }, seqStart: 2 }] };
  };
  assert.equal((await deliverPaseo(f.args)).status, 'blocked');
  assert.equal(receipt(f).pending, true);
  const atTimeout = reads;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(reads, atTimeout, 'no further reads after the request has timed out');
  assert.equal((await deliverPaseo(f.args)).status, 'blocked');
  assert.equal(f.sent.length, 1);
});

test('completed exact turn confirms even when the submitted user entry is outside the page', () => {
  const history = { agent: { status: 'idle' }, entries: [
    { item: { type: 'assistant_message', text: 'Done.' }, turnId: 'accepted-turn', seqStart: 100 }
  ] };
  assert.equal(confirmedPaseoTurn(history, { messageId: 'client', turnId: 'accepted-turn' }), true);
  assert.equal(confirmedPaseoTurn(history, { messageId: 'client', turnId: 'another-turn' }), false);
});

test('message identity and later activity do not substitute for exact turn identity', () => {
  const own = { item: { type: 'user_message', clientMessageId: 'client' }, seqEnd: 10,
    timestamp: '2026-01-01T00:00:00Z' };
  for (const userTurn of [undefined, 'own-turn']) {
    for (const responseTurn of [undefined, 'other-turn']) {
      assert.equal(confirmedPaseoTurn({
        agent: { status: 'running', activeTurn: { turnId: responseTurn, startedAt: '2026-01-01T00:00:01Z' } },
        entries: [{ ...own, turnId: userTurn }, { item: { type: 'assistant_message', text: 'Other work.' },
          turnId: responseTurn, seqStart: 11 }]
      }, { messageId: 'client' }), false);
    }
  }
  assert.equal(confirmedPaseoTurn({ agent: { status: 'running', activeTurn: { turnId: 'accepted-turn' } },
    entries: [{ ...own, turnId: 'conflicting-turn' }] }, { messageId: 'client', turnId: 'accepted-turn' }), false);
});

for (const [name, change] of Object.entries({
  running: { status: 'running' }, archived: { archivedAt: 'today' },
  permission: { pendingPermissions: [{}] }, turn: { activeTurn: {} },
  directory: { cwd: '/workspace/other' }, workspace: { workspaceId: 'other' },
  revision: { updatedAt: '2026-01-02T00:00:00Z' }
})) {
  for (const source of ['baseline', 'current']) {
    test(`rechecks ${name} from ${source} after baseline read, before journaling or sending`, async t => {
      const f = setup(t), initial = f.ref.current();
      f.ref.timeline.refetch = async () => {
        if (source === 'current') f.ref.current = () => ({ ...initial, ...change });
        return { agent: source === 'baseline' ? { ...initial, ...change } : initial, entries: [] };
      };
      assert.equal((await deliverPaseo(f.args)).status, 'blocked');
      assert.equal(f.sent.length, 0);
      assert.equal(fs.existsSync(path.join(f.args.store.dir, 'paseo-deliveries')), false);
    });
  }
}

test('real SDK void acknowledgement confirms from timeline and persists the exact turn across pages', async t => {
  const f = setup(t), reads = [];
  const agent = f.ref.current();
  const api = createPaseoApi({
    getLastServerInfoMessage: () => ({ serverId: 'host' }),
    fetchAgent: async () => ({ agent }),
    sendAgentMessage: async (_id, text, options) => { f.sent.push({ text, options }); return {}; },
    fetchAgentTimeline: async (_id, options) => {
      reads.push(options);
      if (!f.sent.length) return { agent, epoch: 'epoch', endCursor: { epoch: 'epoch', seq: 100 }, entries: [] };
      if (options.cursor.seq === 100) return { agent, epoch: 'epoch', hasNewer: true,
        endCursor: { epoch: 'epoch', seq: 180 }, entries: [
          { item: { type: 'user_message', clientMessageId: f.sent[0].options.messageId, messageId: 'provider' },
            turnId: 'turn-1', seqStart: 101, seqEnd: 101 }
        ] };
      assert.equal(receipt(f).turnId, 'turn-1', 'persist correlation before requesting the next page');
      return { agent, epoch: 'epoch', hasNewer: false, entries: [
        { item: { type: 'assistant_message', text: 'Done.' }, turnId: 'turn-1', seqStart: 181 }
      ] };
    }
  });
  f.args.factory = () => ({ ...api, connect: async () => {}, close: () => api.dispose(),
    hosts: { list: async () => ({ self: { serverId: 'host' }, hosts: [] }) } });
  assert.equal((await deliverPaseo(f.args)).status, 'sent');
  assert.equal(f.sent.length, 1);
  assert.equal(reads.length, 3);
  assert.equal(reads[2].cursor.seq, 180);
  assert.equal(receipt(f).pending, false);
  assert.equal(receipt(f).turnId, 'turn-1');
  assert.equal(receipt(f).providerMessageId, 'provider');
});

for (const problem of ['exception', 'reset', 'staleCursor', 'gap', 'epoch']) {
  test(`cursor ${problem} falls back to a fresh tail with exact correlation`, async t => {
    const f = setup(t), reads = [];
    f.ref.timeline.refetch = async options => {
      reads.push(options);
      if (!f.sent.length) return { agent: f.ref.current(), epoch: 'epoch', endCursor: { epoch: 'epoch', seq: 10 }, entries: [] };
      if (options.direction === 'after') {
        if (problem === 'exception') throw Error('unsupported');
        return { agent: f.ref.current(), entries: [], epoch: 'epoch',
          [problem]: problem === 'epoch' ? 'replacement-epoch' : true };
      }
      return { agent: f.ref.current(), entries: [
        { item: { type: 'user_message', clientMessageId: f.sent[0].options.messageId }, turnId: 'turn-1' },
        { item: { type: 'assistant_message', text: 'Done.' }, turnId: 'turn-1' }
      ] };
    };
    assert.equal((await deliverPaseo(f.args)).status, 'sent');
    assert.deepEqual(reads.map(o => o.direction), ['tail', 'after', 'tail']);
    assert.equal(f.sent.length, 1);
  });
}

test('missing baseline agent blocks dispatch even when the handle retains an old snapshot', async t => {
  const f = setup(t);
  f.ref.timeline.refetch = async () => ({ agent: null, entries: [] });
  assert.equal((await deliverPaseo(f.args)).status, 'blocked');
  assert.equal(f.sent.length, 0);
});

test('learned turn survives a timeout and confirms a later completed response without resending', async t => {
  const f = setup(t);
  f.args.config.paseo.timeoutMs = 40;
  f.ref.timeline.refetch = async () => ({ agent: f.ref.current(), entries: f.sent.length ? [
    { item: { type: 'user_message', clientMessageId: f.sent[0].options.messageId }, turnId: 'turn-1' }
  ] : [] });
  assert.equal((await deliverPaseo(f.args)).status, 'blocked');
  assert.equal(receipt(f).turnId, 'turn-1');
  assert.equal(receipt(f).pending, true);
  f.ref.timeline.refetch = async () => ({ agent: f.ref.current(), entries: [
    { item: { type: 'assistant_message', text: 'Done.' }, turnId: 'turn-1' }
  ] });
  const result = await deliverPaseo(f.args);
  assert.match(result.detail, /Previous Paseo turn confirmed/);
  assert.equal(receipt(f).pending, false);
  assert.equal(f.sent.length, 1);
});

test('another delivery cannot send while turn confirmation is pending', async t => {
  const f = setup(t);
  const confirmed = f.ref.timeline.refetch;
  let firstRead;
  const reading = new Promise(resolve => { firstRead = resolve; });
  let reads = 0;
  f.ref.timeline.refetch = async () => {
    if (++reads === 1) { firstRead(); return { agent: f.ref.current(), entries: [] }; }
    return confirmed();
  };
  const pending = deliverPaseo(f.args);
  await reading;
  const concurrent = await deliverPaseo({ ...f.args, actionId: 'another-action' });
  assert.equal(concurrent.status, 'blocked');
  assert.match(concurrent.detail, /already in progress/);
  assert.equal((await pending).status, 'sent');
  assert.equal(f.sent.length, 1);
});
