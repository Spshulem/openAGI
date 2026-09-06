import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHost } from '../src/agent-host.js';
import { InMemoryAgentStore } from '../src/agent-store.js';
test('budget-blocked requests skip expensive processing while retaining a terminal failure',async()=>{
  let processed=0,generated=0,indexed=0;
  const store=new InMemoryAgentStore();
  const host=new AgentHost({store,runtime:{sessionIndex:{async indexMessage(){indexed++;}},processSignal(){processed++;throw new Error('must not process');}},modelProvider:{
    budgetGuard:{check(){throw Object.assign(new Error('Daily budget reached'),{code:'BUDGET_EXCEEDED'});}},
    async generate(){generated++;throw new Error('must not generate');}
  }});
  host.messageToSignal=async()=>{processed++;throw new Error('must not build signal');};
  await assert.rejects(host.handleMessage({text:'Fixture budget check',sessionId:'fixture',routeTo:false}),{code:'BUDGET_EXCEEDED'});
  assert.equal(processed,0);assert.equal(generated,0);assert.equal(indexed,0);
  const history=store.getSession('fixture').messages;assert.equal(history.length,2);
  assert.equal(history[1].metadata.status,'failed');assert.equal(history[1].metadata.code,'budget');
});
