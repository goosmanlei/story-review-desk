import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {createExecutionGrant,validTurnExecution,validExecutionGrant} from '../host/instance-runtime/assistant-execution-policy.mjs';
import {executeAssistantAction,assistantActionReceipts} from '../host/instance-runtime/assistant-action-service.mjs';
function fixture({publish=false}={}){
 const metadata={instanceId:'instance-test',runtimeEpoch:'epoch-test',releaseId:'release-first'},aux=new Map(),writes=[];
 const record=(key,value)=>{const bytes=Buffer.from(canonicalJson(value));const r={key,bytes,sha256:sha256(bytes),revisionId:'revision-'+key,metadata:{runtimeEpoch:metadata.runtimeEpoch}};aux.set(key,r);return r;};
 const turn={turnId:'turn_test123',conversationId:'codx_test123',projectId:'story-test',mode:'EXECUTE',capabilityProfile:'CONTROLLED_PROJECT_ACTIONS',assistantContext:{packetId:'ctx',packetHash:'a'.repeat(64)},requestHash:'b'.repeat(64),execution:createExecutionGrant(metadata,{allowSettingsPublish:publish})};
 const claim={turnId:turn.turnId,conversationId:turn.conversationId,bridgeInstanceId:'bridge-test',slotId:'slot-test',leaseId:'lease-test',fencingToken:7};
 record('turns/'+turn.turnId+'.json',turn);record('claims/'+turn.turnId+'.json',claim);
 record('health.json',{checkedAt:new Date().toISOString(),status:'PROCESSING',bridgeInstanceId:claim.bridgeInstanceId,schedulerProtocol:'scheduler-test',slots:[{slotId:claim.slotId,status:'ACTIVE',runtimePoisoned:false}]});
 record('scheduler/slots/'+claim.slotId+'.json',{...claim,schedulerProtocol:'scheduler-test'});
 const tx={getMetadata:async()=>({...metadata}),getProfile:async()=>({projectId:'story-test',instanceId:metadata.instanceId,assistant:{schedulerProtocol:'scheduler-test'}}),getAux:async(_ns,key)=>aux.get(key)||null,listAux:async(_ns,{prefix})=>[...aux.values()].filter(row=>row.key.startsWith(prefix)),putAux:async({key,bytes})=>record(key,JSON.parse(bytes))};
 const handlers={getDomainWorkspace:async()=>({releaseId:metadata.releaseId,revisionId:'graph-current',draftHeadRevisionId:null,draft:{changes:[{collection:'entities',id:'existing',beforeHash:null,value:{id:'existing'}}]},graph:{entities:[{id:'one'}]},ownership:{},configuration:{}}),
  saveDomainWorkspace:async(_tx,input)=>{assert.equal(input.owner,'SETTINGS');if(input.expectedReleaseId!==metadata.releaseId)throw Object.assign(Error('CAS'),{code:'DOMAIN_CONFLICT'});writes.push(input);return {revisionId:'draft-result'};},
  previewDomainWorkspace:async(_tx,input)=>({draftRevisionId:input.draftRevisionId,previewHash:'p'.repeat(64)}),
  publishDomainWorkspace:async(_tx,input)=>{writes.push(input);metadata.releaseId='release-own-update';return {revisionId:'graph-published',releaseId:metadata.releaseId};},
  readProductionPreparation:async()=>({revisionId:'prep-one',releaseId:metadata.releaseId,content:{scenes:[{sceneId:'scene-one',sceneContentHash:'hash',preparation:{sceneRole:'old',generationAuthorized:false}}]}}),
  saveProductionPreparation:async(_tx,input)=>{writes.push(input);return {revisionId:'prep-two'};},
  previewProductionPreparationRevalidation:async()=>({previewHash:'r'.repeat(64)}),applyProductionPreparationRevalidation:async()=>({revisionId:'revalidated'})};
 const request=(action,args={},callId='call-a')=>({turnId:turn.turnId,conversationId:turn.conversationId,requestHash:turn.requestHash,claim,callId,action,arguments:args});
 const call=(action,args,id)=>executeAssistantAction(tx,request(action,args,id),handlers);
 return {metadata,aux,record,turn,claim,tx,handlers,request,call,writes};
}
const changes=[{collection:'entities',id:'new',beforeHash:null,value:{id:'new'}}];
test('legacy and explicit DISCUSS never grant actions; EXECUTE requires exact safe grant',()=>{
 assert.equal(validTurnExecution({}),true);assert.equal(validTurnExecution({mode:'DISCUSS'}),true);
 for(const mode of [null,'execute','SHELL',true])assert.equal(validTurnExecution({mode}),false);
 const f=fixture();assert.equal(validTurnExecution(f.turn),true);assert.equal(f.turn.execution.allowedActions.includes('publish_settings'),false);
 assert.equal(validTurnExecution({...f.turn,mode:'DISCUSS'}),false);
 for(const extra of [{allowedActions:['exec_command']},{unexpected:'shell'},{runtimeEpoch:''}])assert.equal(validExecutionGrant({...f.turn.execution,...extra}),false);
});
test('turn, instance, epoch, project, lease, cancellation, completion and release boundaries fail before mutation',async()=>{
 for(const mutate of [
  f=>f.record('turns/'+f.turn.turnId+'.json',{...f.turn,mode:'DISCUSS'}),
  f=>{f.metadata.runtimeEpoch='restored';},
  f=>{f.metadata.instanceId='foreign';},
  f=>{f.tx.getProfile=async()=>({projectId:'foreign',instanceId:f.metadata.instanceId});},
  f=>f.record('claims/'+f.turn.turnId+'.json',{...f.claim,fencingToken:99}),
  f=>f.record('cancel/'+f.turn.turnId+'.json',{}),
  f=>f.record('results/'+f.turn.turnId+'.json',{}),
  f=>{f.metadata.releaseId='unrelated-release';},
 ]){
  const f=fixture();mutate(f);await assert.rejects(f.call('save_settings_draft',{expectedReleaseId:'release-first',expectedDraftRevisionId:null,changes}));assert.equal(f.writes.length,0);
 }
});
test('no publish without separate permission and exact preview in this turn; no arbitrary fields or deletion',async()=>{
 const f=fixture();await assert.rejects(f.call('publish_settings',{draftRevisionId:'draft',previewHash:'p'.repeat(64)}),{code:'ASSISTANT_ACTION_DENIED'});
 const allowed=fixture({publish:true});await assert.rejects(allowed.call('publish_settings',{draftRevisionId:'draft',previewHash:'p'.repeat(64)}),{code:'ASSISTANT_PREVIEW_REQUIRED'});
 await assert.rejects(f.call('save_settings_draft',{expectedReleaseId:'release-first',expectedDraftRevisionId:null,changes:[{collection:'entities',id:'new',value:null}]}));
 await assert.rejects(f.call('inspect_settings',{path:'/outside/project'}));
 await assert.rejects(f.call('generate_image',{}));assert.equal(f.writes.length,0);
});
test('successful changes and receipts share an atomic call identity; repeats cannot change arguments',async()=>{
 const f=fixture(),args={expectedReleaseId:'release-first',expectedDraftRevisionId:null,changes};
 const first=await f.call('save_settings_draft',args),again=await f.call('save_settings_draft',args);
 assert.deepEqual(first,again);assert.equal(f.writes.length,1);assert.equal(f.writes[0].changes.length,2,'existing unrelated draft changes are preserved');
 assert.equal(first.receipt.resultHash,sha256(canonicalJson(first.result)));assert.match(first.receipt.operationId,/^assistant_action_[a-f0-9]{64}$/);
 assert.equal((await assistantActionReceipts(f.tx,f.turn.turnId)).length,1);
 await assert.rejects(f.call('save_settings_draft',{...args,changes:[]}),{code:'ASSISTANT_ACTION_CONFLICT'});
});
test('settings publish requires own exact preview and permits only its own resulting release chain',async()=>{
 const f=fixture({publish:true});
 await f.call('preview_settings_draft',{draftRevisionId:'draft'},'preview');
 const published=await f.call('publish_settings',{draftRevisionId:'draft',previewHash:'p'.repeat(64)},'publish');
 assert.equal(published.receipt.resultReleaseId,'release-own-update');
 await f.call('inspect_settings',{},'after-own-publish');
 f.metadata.releaseId='other-user-publish';await assert.rejects(f.call('inspect_settings',{},'after-other'),{code:'ASSISTANT_RELEASE_CHANGED'});
});
test('production scene saves preserve identity and immutable fields and never adopt or generate',async()=>{
 const f=fixture();
 await f.call('save_preparation_scene',{expectedReleaseId:'release-first',expectedRevisionId:'prep-one',sceneId:'scene-one',fields:{sceneRole:'new'}});
 assert.equal(f.writes[0].content.scenes[0].sceneContentHash,'hash');assert.equal(f.writes[0].content.scenes[0].preparation.generationAuthorized,false);
 await assert.rejects(f.call('save_preparation_scene',{expectedReleaseId:'release-first',expectedRevisionId:'prep-one',sceneId:'scene-one',fields:{generationAuthorized:true}},'forged'));
 await assert.rejects(f.call('apply_preparation_revalidation',{previewHash:'not-previewed'},'forged-revalidation'),{code:'ASSISTANT_PREVIEW_REQUIRED'});
});

test('expired or future heartbeat, poisoned/inactive slot and replaced private fencing cannot use a persisted claim',async()=>{
 for(const mutate of [
  f=>f.record('health.json',{...JSON.parse(f.aux.get('health.json').bytes),checkedAt:new Date(Date.now()-16000).toISOString()}),
  f=>f.record('health.json',{...JSON.parse(f.aux.get('health.json').bytes),checkedAt:new Date(Date.now()+10000).toISOString()}),
  f=>f.record('health.json',{...JSON.parse(f.aux.get('health.json').bytes),slots:[{slotId:f.claim.slotId,status:'POISONED',runtimePoisoned:true}]}),
  f=>f.record('health.json',{...JSON.parse(f.aux.get('health.json').bytes),slots:[{slotId:f.claim.slotId,status:'IDLE'}]}),
  f=>f.record('scheduler/slots/'+f.claim.slotId+'.json',{...f.claim,fencingToken:99,schedulerProtocol:'scheduler-test'}),
 ]){
  const f=fixture();mutate(f);await assert.rejects(f.call('save_settings_draft',{expectedReleaseId:'release-first',expectedDraftRevisionId:null,changes}),{code:'ASSISTANT_LEASE_EXPIRED'});assert.equal(f.writes.length,0);
 }
});
