import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverPaseo } from '../src/fleet/paseo-delivery.js';
import { paseoThread } from '../src/fleet/sources/paseo.js';
function setup(t, extra = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-delivery-'));
 t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
 const initial = {id:'chat',status:'idle',updatedAt:'2026-01-01T00:00:00Z',cwd:'/workspace/repo',workspaceId:'workspace'};
 let current={...initial,...extra}, sent=[], confirmed=true;
 const ref={refresh:async()=>{},current:()=>current,send:async(text,options)=>{sent.push({text,options});},timeline:{refetch:async()=>({agent:current,entries:confirmed&&sent.length?[{item:{type:'user_message',messageId:sent.at(-1).options.messageId},timestamp:initial.updatedAt,seqEnd:1},{item:{type:'assistant_message',text:'working'},seqStart:2}]:[]})}};
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
      if (reads === 1) return { agent: f.ref.current(), entries: [] };
      const own = { item: { type: 'user_message', clientMessageId: f.sent[0].options.messageId },
        timestamp: '2026-01-01T00:00:01Z', seqStart: 1, seqEnd: 1 };
      return evidence === 'running turn'
        ? { agent: { ...f.ref.current(), status: 'running', activeTurn: { startedAt: own.timestamp } }, entries: [own] }
        : { agent: f.ref.current(), entries: [own, { item: { type: 'assistant_message', text: 'Finished.' }, seqStart: 2 }] };
    };
    const result = await deliverPaseo(f.args);
    assert.equal(result.status, 'sent');
    assert.equal(reads, 2);
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
