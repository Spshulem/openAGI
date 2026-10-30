import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileBackedAgentStore } from '../src/agent-store.js';
function fixture(t, options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-retention-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return new FileBackedAgentStore({dir,ensureDefault:false,maxActiveMessages:4,retainedMessages:2,...options});
}
test('rotation keeps recent messages active and preserves every older message in private immutable history', t=>{
  const s=fixture(t);
  for(let i=0;i<5;i++)s.appendMessage('fixture',{role:i%2?'assistant':'user',content:String(i)});
  const active=s.getSession('fixture');assert.deepEqual(active.messages.map(m=>m.content),['3','4']);
  assert.equal(active.metadata.archivedMessageCount,3);
  const archiveDir=path.join(s.archivesDir,'fixture.history');const [file]=fs.readdirSync(archiveDir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archiveDir,file))).messages.map(m=>m.content),['0','1','2']);
  assert.equal(fs.statSync(path.join(archiveDir,file)).mode&0o777,0o600);
  const restarted=new FileBackedAgentStore({dir:s.dir,ensureDefault:false,maxActiveMessages:4,retainedMessages:2});
  assert.deepEqual(restarted.getSession('fixture'),active);assert.equal(fs.readdirSync(archiveDir).length,1);
});
test('oversized existing history cannot freeze reads/listing or be overwritten by append',t=>{
  const s=fixture(t,{maxSessionBytes:1024});const file=s.sessionPath('oversized');
  const original=JSON.stringify({id:'oversized',messages:[{role:'user',content:'x'.repeat(2048)}]});fs.writeFileSync(file,original);
  assert.throws(()=>s.getSession('oversized'),{code:'SESSION_TOO_LARGE'});
  assert.throws(()=>s.appendMessage('oversized',{role:'user',content:'new'}),{code:'SESSION_TOO_LARGE'});
  assert.equal(s.listSessions()[0].recoveryNeeded,true);assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('archive write failure leaves active history unchanged',t=>{
  const s=fixture(t);for(let i=0;i<4;i++)s.appendMessage('fixture',{role:'user',content:String(i)});
  const original=fs.readFileSync(s.sessionPath('fixture'),'utf8');fs.writeFileSync(s.archivesDir,'not a directory');
  assert.throws(()=>s.appendMessage('fixture',{role:'assistant',content:'not committed'}));
  assert.equal(fs.readFileSync(s.sessionPath('fixture'),'utf8'),original);
});

test('repeated maximum photo turns rotate by bytes and keep all original pixels readable', t => {
  const s = fixture(t, { maxActiveMessages: 2000, retainedMessages: 1000 });
  const data = Buffer.alloc(768 * 1024, 1).toString('base64');
  for (let turn = 0; turn < 4; turn++) {
    s.appendMessage('photos', { role: 'user', content: `Photo turn ${turn}`, metadata: {
      attachments: Array.from({ length: 4 }, (_, i) => ({ id: `photo-${turn}-${i}`, mimeType: 'image/jpeg', name: 'Synthetic.jpg', data }))
    } });
    s.appendMessage('photos', { role: 'assistant', content: `Reply ${turn}` });
  }
  const active = s.getSession('photos');
  assert.equal(active.metadata.historyArchived, true);
  assert.ok(fs.statSync(s.sessionPath('photos')).size <= s.maxSessionBytes);
  const history = [...s.archivedMessages('photos'), ...active.messages];
  assert.equal(history.length, 8);
  assert.deepEqual(history.map(m => m.content), Array.from({ length: 4 }, (_, i) => [`Photo turn ${i}`, `Reply ${i}`]).flat());
  for (const message of history.filter(m => m.role === 'user')) {
    assert.equal(message.metadata.attachments.length, 4);
    assert.ok(message.metadata.attachments.every(image => image.data === data));
  }
  s.appendMessage('photos', { role: 'user', content: 'A later text request still works' });
  assert.equal(s.getSession('photos').messages.at(-1).content, 'A later text request still works');
});
