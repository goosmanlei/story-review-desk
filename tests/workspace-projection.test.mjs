import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {projectWorkspaceModules,WORKSPACE_MODULES} from '../host/instance-runtime/workspace-projection.mjs';
import {workflowOverview} from '../host/instance-runtime/workflow-overview.mjs';
import {CREATOR_PRODUCTION_STAGES,creatorProductionGateDefinition} from '../host/instance-runtime/creator-production-workflow.mjs';
const counts={total:1,ready:1,inProgress:0,waiting:0,blocked:0,humanCanAdvance:1,aiCanAdvance:0,humanAndAi:0,aiCanAssist:1,automation:0};
function fixture(){
 const gates=CREATOR_PRODUCTION_STAGES.flatMap(stage=>stage.gateIds).map(id=>({id,...creatorProductionGateDefinition(id)}));
 const model={episodes:[{id:'episode-a'},{id:'episode-a'}],scenes:[{id:'scene-a'}],shots:[{id:'historical-shot',scopeRole:'EVIDENCE_ONLY'}],
  domainGraph:{entities:[{id:'one',type:'CHARACTER'},{id:'place',type:'LOCATION'}],relations:[]},domainGraphRef:{revisionId:'graph-a'},
  systemConfiguration:{reference:{revisionId:'config-a',sha256:'a'.repeat(64)},config:{workflow:{phases:[...new Set(gates.map(gate=>gate.phaseId))].map(id=>({id})),gates}}}};
 const queue={snapshotId:'snapshot-a',operationRevision:'ops-a',summary:{inventory:{materialRequirements:2,covered:1,pendingReviewCandidates:1}},workspaceSummary:{domains:[{id:'STORY_CREATION',status:'ACTIVE',headline:'候选待核',counts,stages:[]},{id:'FULL_PRODUCTION',status:'UNKNOWN',headline:'范围未锁',counts:{...counts,total:0,ready:0},stages:CREATOR_PRODUCTION_STAGES.map(stage=>({id:stage.id,label:stage.label,count:0,denominator:null,denominatorState:'UNKNOWN'}))}]}};
 const metadata={snapshotId:'snapshot-a',releaseId:'release-a',runtimeEpoch:'epoch-a',repositoryRevision:8,eventSequence:5};
 return {model,queue,metadata,operations:{snapshotId:'snapshot-a',operationRevision:'ops-a',counts:{reviews:3,episodePlanSubmissions:6}},preparation:{revisionId:'prep-a',content:{scenes:[{sceneId:'candidate-scene'}]},candidate:{revisionId:'candidate-a'},stale:false}};
}
test('workspace catalogue has four stable module owners and no story-specific facts',()=>{
 assert.deepEqual(WORKSPACE_MODULES.map(module=>module.id),['STORY_CREATION','STORY_SETTINGS','WORLD_AND_MATERIALS','FULL_PRODUCTION']);
 assert.equal(Object.isFrozen(WORKSPACE_MODULES),true);
 assert.doesNotMatch(JSON.stringify(WORKSPACE_MODULES),/九头案|七集|142/);
});
test('live module projection preserves exact metadata and never promotes preparation or inventory to denominator',()=>{
 const f=fixture(),before=JSON.stringify(f),result=projectWorkspaceModules(f);
 assert.equal(JSON.stringify(f),before);assert.equal(result.freshness.mode,'LIVE_TRANSACTION');assert.equal(result.freshness.eventSequence,5);
 assert.equal(result.modules[0].facts[0].value,1);assert.equal(result.modules[1].facts.find(fact=>fact.id==='locations').value,1);
 const production=result.modules.find(module=>module.id==='FULL_PRODUCTION');
 assert.equal(production.facts.find(fact=>fact.id==='preparation-scenes').value,1);
 assert.equal(production.facts.find(fact=>fact.id==='registered-shots').value,1);
 assert.ok(production.stages.every(stage=>stage.denominator===null&&stage.denominatorState==='UNKNOWN'));
 assert.equal(result.modules[1].work,null,'settings must not impersonate all material work');
 assert.equal(result.audit.configuration.phaseCount,5);assert.equal(result.audit.creatorStages.length,4);
 const overview=workflowOverview(f.model,f.preparation,f);
 assert.equal(overview.denominatorState,'UNKNOWN');assert.equal(overview.definition.phases,f.model.systemConfiguration.config.workflow.phases);
 assert.ok(overview.nodes.filter(node=>node.group==='全剧制作').every(node=>node.definitionState==='DEFINED'));
});
test('no evidence remains UNKNOWN; declared CURRENT records do not imply a release',()=>{
 const result=projectWorkspaceModules();assert.equal(result.freshness.mode,'UNVERIFIED');
 assert.equal(result.modules[0].facts[0].value,null);assert.equal(result.modules[2].facts[0].value,null);
 const overview=workflowOverview({episodePlanRevisions:[{isCurrent:true,scopeRole:'CURRENT'}]},null);
 assert.doesNotMatch(overview.nodes.find(node=>node.id==='STORY').detail,/分集已采用/);
 assert.equal(overview.denominatorState,'UNKNOWN');
});
test('read-only projection identifies a published snapshot and does not expose local epoch as live status',()=>{
 const result=projectWorkspaceModules({...fixture(),readOnly:true});
 assert.equal(result.freshness.mode,'PUBLISHED_READ_ONLY');assert.equal(result.freshness.runtimeEpoch,null);
 assert.equal(result.freshness.repositoryRevision,null);assert.equal(result.freshness.eventSequence,null);
 assert.equal(result.freshness.snapshotId,'snapshot-a');assert.match(result.audit.authority,/只读快照/);
});

const require=createRequire(import.meta.url),ts=require('typescript');
function routeFixture({mismatch=false,hosted=false}={}){
 let active=false,transactions=0;
 const f=fixture(),data={snapshotId:'snapshot-a',productionModel:f.model};
 const check=()=>{if(!hosted)assert.equal(active,true,'every read belongs to the same outer transaction');};
 const repo={async readTransaction(callback){assert.equal(active,false);active=true;transactions++;try{return await callback({async getMetadata(){check();return f.metadata;}});}finally{active=false;}}};
 class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
 const mod={exports:{}},ctx={module:mod,exports:mod.exports,URL,Request,Promise,Error,require(id){
  if(id.endsWith('workflow-overview.mjs'))return {workflowOverview};
  if(id.endsWith('production-preparation.mjs'))return {async readProductionPreparation(){check();return f.preparation;}};
  if(id==='../../v8/_action-queue')return {async buildActionQueue(){check();return {...f.queue,operationRevision:mismatch?'different':'ops-a'};}};
  if(id==='../../v8/_store')return {hostedReadOnlyMode:()=>hosted,HttpError,async reviewData(){check();return data;},async operationalSnapshot(){check();return f.operations;}};
  if(id==='../_domain')return {domainRepository:async()=>repo,jsonResponse:body=>({status:200,body}),domainError:error=>({status:error.status||500,error:error.message})};
  throw Error('unmocked dependency '+id);
 }};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app/api/instance/workflow/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 return {GET:mod.exports.GET,transactions:()=>transactions};
}
test('combined endpoint reads queue, configuration model, preparation and watermarks in one transaction',async()=>{
 const f=routeFixture(),result=await f.GET(new Request('http://local/api/instance/workflow?workspace=1'));
 assert.equal(result.status,200);assert.equal(f.transactions(),1);
 assert.equal(result.body.queue.operationRevision,result.body.workflow.freshness.operationRevision);
 assert.equal(result.body.queue.snapshotId,result.body.workflow.freshness.snapshotId);
});
test('legacy workflow shape remains available; mixed event watermarks fail closed',async()=>{
 const f=routeFixture(),result=await f.GET(new Request('http://local/api/instance/workflow'));
 assert.equal(result.status,200);assert.ok(result.body.nodes);assert.equal(result.body.queue,undefined);
 const bad=await routeFixture({mismatch:true}).GET(new Request('http://local/api/instance/workflow?workspace=1'));assert.equal(bad.status,409);
 const published=routeFixture({hosted:true}),readOnly=await published.GET(new Request('http://local/api/instance/workflow?workspace=1'));
 assert.equal(published.transactions(),0);assert.equal(readOnly.body.workflow.freshness.mode,'PUBLISHED_READ_ONLY');
});
