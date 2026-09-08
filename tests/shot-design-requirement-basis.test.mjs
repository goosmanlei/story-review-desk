import test from 'node:test';
import assert from 'node:assert/strict';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {validateDomainGraph,domainHash} from '../host/instance-runtime/domain-model.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {loadModernEventRuntime} from '../host/instance-modern-event-validator.mjs';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {deriveShotDesignRequirementBasisV3,assertShotDesignRequirementBasisV3Current,shotDesignRequirementBasisSchema} from '../host/instance-runtime/shot-design-requirement-basis.mjs';

const clone=structuredClone,sceneId='scene:room',requirementId='demand:room';
const evidence=[{sourceId:'source:script',revisionId:'source:revision1',sha256:'a'.repeat(64),locator:'scene:room/block:1',quote:'The visitor enters the dark room.'}];
const scope=[{scopeType:'SCENE',scopeId:sceneId,revisionId:'script:revision1'}];
function fixture(){
 const graph={schemaVersion:'1.0',entities:[{id:'entity:room',type:'LOCATION',name:'Room',aliases:[],description:'A small room',authority:'A',evidence:clone(evidence),layout:{door:'south',table:'north'}},{id:'entity:visitor',type:'CHARACTER',name:'Visitor',aliases:[],description:'An anonymous adult visitor',authority:'A',evidence:clone(evidence)}],states:[{id:'state:room-night',entityId:'entity:room',label:'Night room',dimensions:{time:'night',viewpoint:'door south, table north'},scope:clone(scope),authority:'A',evidence:clone(evidence)}],representations:[{id:'rep:room',entityId:'entity:room',stateId:'state:room-night',type:'LOCATION_EMPTY',label:'Room at night',dimensions:{weather:'dry'},assetFamilyIds:[],requirementIds:[requirementId],authority:'A',evidence:clone(evidence)}],relations:[{id:'relation:visitor-room',type:'LOCATED_IN',from:{kind:'ENTITY',id:'entity:visitor'},to:{kind:'ENTITY',id:'entity:room'},label:'Visitor location',purpose:'Visitor may enter through the southern door',inherit:[],exclude:[],scope:clone(scope),authority:'A',status:'CONFIRMED',evidence:clone(evidence)}],requirements:[{id:requirementId,title:'Empty room reference',representationId:'rep:room',mediaType:'IMAGE',category:'empty-location',reuseScope:'SCENE',scope:clone(scope),evidence:clone(evidence),acceptanceCriteria:['Preserve the southern door and northern table.']}]};
 const content={sceneId,beats:[{beatId:'beat:enter',materialRequirementRefs:[requirementId],dialogueContext:'The visitor says hello.'}]};
 const snapshot={snapshotId:'snapshot:before',creativeLineage:{},productionModel:{systemConfiguration:{config:defaultConfiguration()},sceneCoveragePlanRevisions:[{id:'coverage:1',scopeId:sceneId,scopeRole:'CURRENT',revisionState:'CURRENT',isCurrent:true,content,contentHash:domainHash(content)}],materialRequirements:[],assetFamilies:[],assetVersions:[],workItems:[],materialWorkItems:[],expectedOutputs:[]}};
 validateDomainGraph(graph);return {graph,snapshot:project(snapshot,graph)};
}
function project(snapshot,graph,extra={}){return projectDomainGraph(snapshot,graph,{revisionId:'graph:'+domainHash(graph).slice(0,12),sha256:domainHash(graph)},extra);}
function firstFamily(f,{directory=false}={}){
 const graph=clone(f.graph);graph.representations[0].assetFamilyIds=['family:room'];
 const snapshot=clone(f.snapshot);snapshot.productionModel.assetFamilies.push({id:'family:room',kind:'IMAGE',currentVersionId:null,versionRefs:[],expectedOutputRefs:['output:1']});snapshot.productionModel.expectedOutputs.push({id:'output:1',familyId:'family:room',expectationState:'PLANNED'});
 const extra={};if(directory){const prior=f.snapshot.productionModel.materialDirectory;extra.directorySource={revisionId:'directory:2',sha256:domainHash('new-directory'),content:{directoryBindings:prior.bindings.map(b=>({...b,requirementHash:domainHash({demand:graph.requirements[0],representation:graph.representations[0]}),representationHash:domainHash(graph.representations[0])}))}};}
 const after=project(snapshot,graph,extra),r=after.productionModel.materialRequirements[0];
 r.sourceRef='story/material-production/plans/plan:room.json#requirement';r.materialWorkItemRef='work:room';r.plannedAssetFamilyId='family:room';return after;
}
const derive=snapshot=>deriveShotDesignRequirementBasisV3(snapshot.productionModel,sceneId);
const {api}=loadModernEventRuntime(fileURLToPath(new URL('..',import.meta.url)));
// Read the real private gate, without exporting it as an additional product API
// or opening a repository. The test never replaces its implementation formula.
const storeSource=readFileSync(new URL('../app/api/v8/_store.ts',import.meta.url),'utf8'),storeAst=ts.createSourceFile('_store.ts',storeSource,ts.ScriptTarget.ESNext,true);
const gateDeclarations=storeAst.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='gateShotPlanDerivedOperationalProjection');assert.equal(gateDeclarations.length,1);
const gateJs=ts.transpileModule(gateDeclarations[0].getText(storeAst),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const gateShotPlan=new Function('HttpError',gateJs+'\nreturn gateShotPlanDerivedOperationalProjection;')(Error);
test('real DOMAIN_GRAPH first-family projection changes V2 implementation hashes but leaves the new explicit V3 basis byte-identical',()=>{
 const f=fixture(),bytes=JSON.stringify(f.snapshot),before=derive(f.snapshot),after=firstFamily(f);
 assert.notEqual(f.snapshot.productionModel.materialRequirements[0].requirementHash,after.productionModel.materialRequirements[0].requirementHash);
 assert.notEqual(domainHash(f.graph.representations[0]),domainHash(after.productionModel.domainGraph.representations[0]));
 assert.notEqual(f.snapshot.productionModel.domainGraphRef.revisionId,after.productionModel.domainGraphRef.revisionId);
 assert.deepEqual(derive(after),before);assert.equal(JSON.stringify(f.snapshot),bytes);
 assert.deepEqual(assertShotDesignRequirementBasisV3Current(after.productionModel,sceneId,before),before);
 assert.equal(before.schemaVersion,'3.0');assert.equal(Object.hasOwn(before.bindings[0],'requirementHash'),false);
 assert.equal(Object.hasOwn(before.bindings[0].conditions.representation.value,'assetFamilyIds'),false);
});
test('registered directory binding refresh changes only its two implementation hashes, preserving semantic ownership',()=>{
 const f=fixture(),r=f.snapshot.productionModel.materialRequirements[0],rep=f.graph.representations[0],binding={requirementId,requirementHash:r.requirementHash,representationId:rep.id,representationHash:domainHash(rep),entityId:rep.entityId,stateId:rep.stateId,purpose:'Group under this night state'};
 f.snapshot=project(f.snapshot,f.graph,{directorySource:{revisionId:'directory:1',sha256:domainHash(binding),content:{directoryBindings:[binding]}}});
 const before=derive(f.snapshot),after=firstFamily(f,{directory:true});assert.notEqual(after.productionModel.materialDirectory.bindings[0].requirementHash,binding.requirementHash);assert.deepEqual(derive(after),before);
 const stale=firstFamily(f);assert.throws(()=>derive(stale),/失效/);
});
test('explicit in-memory realization metadata, new output slots and work/recipe state are independent from design demand',()=>{
 const f=fixture(),after=firstFamily(f),before=derive(after),m=after.productionModel;
 m.assetFamilies[0].currentVersionId='family:room@V1';m.assetFamilies[0].canFlowDownstream=true;m.assetFamilies[0].versionRefs=['family:room@V1'];m.assetVersions.push({id:'family:room@V1',familyId:'family:room',sha256:'b'.repeat(64),lifecycleState:'RELEASED'});
 m.expectedOutputs[0].expectationState='REALIZED';m.materialWorkItems.push({id:'work:room',executionDefinitionRef:'call:revision2',lifecycleState:'RELEASED'});m.materialRequirements[0].formalAdoptionPerformed=true;m.materialRequirements[0].lifecycleState='RELEASED';m.materialRequirements[0].canFlowDownstream=true;
 assert.deepEqual(derive(after),before);
});
test('real operational projection before setup, pending output and exact ASSET approval leaves V3 stable despite changed coverage and current-shot projections',()=>{
 const f=fixture(),{snapshot:blank}=blankSnapshot(blankProfile({title:'Neutral pure projection fixture',instanceId:'instance:semantic-test'}));
 f.snapshot={...blank,...f.snapshot,productionModel:{...blank.productionModel,...f.snapshot.productionModel}};
 const projectState=(data,reviews=[])=>{const state=api.projectOperationalState(data,reviews,[],[],[],[]);gateShotPlan(data,state,{},{});return state;};
 const withState=(data,state)=>({...data,productionModel:{...data.productionModel,materialRequirements:data.productionModel.materialRequirements.map(r=>state.materialRequirementsById[r.id])}});
 const initialState=projectState(f.snapshot),initialBasis=derive(withState(f.snapshot,initialState));
 const data=firstFamily(f),model=data.productionModel,family=model.assetFamilies[0],versionId='family:room@V1',sha='b'.repeat(64);
 family.reviewOwner='MATERIAL';family.currentExpectedOutputId='output:1';
 model.materialWorkItems.push({id:'work:room',outputAssetRef:family.id,inputAssetRefs:[],additionalOutputAssetRefs:[],executionDefinitionRef:'call:1',scopeRole:'CURRENT',activeInCurrentProduction:true});
 const plannedState=projectState(data);assert.deepEqual(derive(withState(data,plannedState)),initialBasis);
 model.assetVersions.push({id:versionId,familyId:family.id,path:'media/_review_pending/family-room/V1.png',sha256:sha,byteSize:1,expectedOutputId:'output:1',outputState:'PRESENT',projectRightsGate:'CLEAR',historyRole:'CANDIDATE',lifecycleState:'REVIEW_PENDING',canFlowDownstream:false,inputVersionBindings:[],materialRequirementBindings:[{requirementRef:requirementId,requirementHash:model.materialRequirements[0].requirementHash}]});
 family.versionRefs=[versionId];family.currentExpectedOutputId=null;
 const pendingState=projectState(data),review={eventId:'review:pure-fixture',eventKind:'review',schemaVersion:'2.2',eventSequence:1,recordedAt:'2026-09-09T00:00:00.000Z',snapshotId:data.snapshotId,subjectType:'ASSET',subjectId:family.id,familyId:family.id,versionId,versionSha256:sha,contextHash:api.assetReviewContextHash(data,family.id,versionId,sha),action:'APPROVE_AND_RELEASE',reviewEventRole:'INITIAL_DECISION',projectRightsGateAtReview:'CLEAR',appliedProjectRightsGate:'CLEAR',reviewDecision:'RELEASED',lifecycleState:'RELEASED',canFlowDownstream:true,adoptionIntent:'ADOPT_THIS_VERSION',internalDownstreamEligibility:'ELIGIBLE',sourceSyncRequired:false,sourceSyncState:'NOT_REQUIRED',applicationStatus:'APPLIED',effect:'APPLIED',rightsUnknownConfirmation:null};
 review.reviewSpecHash=api.resolveFormalReviewSpec(data,'ASSET',family.id)?.hash;
 const releasedState=projectState(data,[review]),released=releasedState.materialRequirementsById[requirementId];
 assert.equal(releasedState.assetVersionsById[versionId].canFlowDownstream,true,JSON.stringify(releasedState.assetVersionsById[versionId]));
 assert.equal(released.coverageSatisfied,true);assert.deepEqual(released.coveredByFamilyRefs,[family.id]);assert.deepEqual(released.coveredByVersionRefs,[versionId]);assert.equal(released.materialWorkItemLifecycleState,'RELEASED');
 assert.notDeepEqual(released,pendingState.materialRequirementsById[requirementId]);
 for(const state of [initialState,plannedState,pendingState,releasedState])assert.deepEqual(derive(withState(state===initialState?f.snapshot:data,state)),initialBasis);
 // gateShotPlanDerivedOperationalProjection produced these fields even before
 // a ShotPlanSet exists. A later design's consumer identities must not feed
 // back into its own demand baseline. No formal ShotPlanSet is fabricated.
 assert.deepEqual(released.currentShotIds,[]);assert.equal(released.currentShotRelationState,'UNKNOWN_PENDING_SHOT_PLAN_SET_SYNC');
 const derived=withState(data,releasedState);derived.productionModel.materialRequirements[0]={...released,currentShotIds:['test-projection:consumer'],currentShotRelationState:'DECLARED_CURRENT_SHOT_SPECS'};
 assert.deepEqual(derive(derived),initialBasis);
});
for(const [label,change] of [
 ['scope revision',g=>g.requirements[0].scope[0].revisionId='script:revision2'],
 ['scope target',g=>g.requirements[0].scope[0].scopeId='scene:other'],
 ['reuse scope',g=>g.requirements[0].reuseScope='PROJECT'],
 ['acceptance condition',g=>g.requirements[0].acceptanceCriteria.push('Keep a basin by the bed.')],
 ['demand source quote',g=>g.requirements[0].evidence[0].quote='The visitor enters a different room.'],
 ['demand source revision and SHA',g=>{g.requirements[0].evidence[0].revisionId='source:revision2';g.requirements[0].evidence[0].sha256='c'.repeat(64);}],
 ['state time',g=>g.states[0].dimensions.time='dawn'],
 ['state scope',g=>g.states[0].scope[0].revisionId='script:revision2'],
 ['space geometry',g=>g.entities[0].layout.door='east'],
 ['representation state',g=>{g.states.push({...clone(g.states[0]),id:'state:other'});g.representations[0].stateId='state:other';}],
 ['representation conditions',g=>g.representations[0].dimensions.weather='rain'],
 ['entity identity',g=>g.entities[0].aliases.push('a different physical room')],
 ['related relationship',g=>g.relations[0].purpose='The visitor must stay outside'],
 ['related endpoint identity',g=>g.entities[1].description='Another named visitor'],
 ['unknown demand semantic field',g=>g.requirements[0].futureSemanticCondition={dialogue:'Only hello is permitted'}],
 ['unknown state semantic field',g=>g.states[0].futureBlocking={bedSide:'west'}],
 ['unknown relation semantic field',g=>g.relations[0].futureRule='No identity transfer'],
])test('V3 changes on '+label+' through a real graph projection',()=>{
 const f=fixture(),before=derive(f.snapshot),g=clone(f.graph);change(g);validateDomainGraph(g);const after=project(f.snapshot,g);
 assert.notEqual(derive(after).contentHash,before.contentHash);assert.throws(()=>assertShotDesignRequirementBasisV3Current(after.productionModel,sceneId,before),/语义需求基线已变化/);
});
test('coverage wording, ordered dialogue context and precise adopted coverage identity remain frozen',()=>{
 const f=fixture(),before=derive(f.snapshot),after=clone(f.snapshot),c=after.productionModel.sceneCoveragePlanRevisions[0];c.content.beats[0].dialogueContext='The visitor says goodbye.';c.contentHash=domainHash(c.content);
 assert.notEqual(derive(after).contentHash,before.contentHash);c.content=clone(f.snapshot.productionModel.sceneCoveragePlanRevisions[0].content);c.contentHash=domainHash(c.content);c.id='coverage:2';assert.notEqual(derive(after).contentHash,before.contentHash);
});
test('unrelated graph components and their family allocations do not invalidate this scene',()=>{
 const f=fixture(),before=derive(f.snapshot),g=clone(f.graph);g.entities.push({id:'entity:remote',type:'PROP',name:'Remote prop',aliases:[],description:'No relation to this scene',authority:'A',evidence:[]});g.representations.push({id:'rep:remote',entityId:'entity:remote',stateId:null,type:'PROP_STATE',label:'Remote prop',dimensions:{},assetFamilyIds:['family:remote'],requirementIds:[],authority:'A',evidence:[]});
 assert.deepEqual(derive(project(f.snapshot,g)),before);
});
test('a relation scoped solely to another permanent scene does not pull its endpoint or changes into this scene basis',()=>{
 const f=fixture(),g=clone(f.graph);g.relations[0].scope=[{scopeType:'SCENE',scopeId:'scene:other',revisionId:'script:other'}];
 const before=derive(project(f.snapshot,g));assert.equal(before.bindings[0].graphClosure.relations.length,0);
 const changed=clone(g);changed.relations[0].purpose='Different action in another scene';changed.entities[1].description='Changed other-scene visitor';
 assert.deepEqual(derive(project(f.snapshot,changed)),before);
 changed.relations[0].scope.push(...clone(scope));assert.notEqual(derive(project(f.snapshot,changed)).contentHash,before.contentHash);
});
test('relation global/episode/shot applicability requires exact permanent scope ownership and preserves applicable revisions',()=>{
 const f=fixture();f.snapshot.productionModel.instance={projectId:'project:neutral'};f.snapshot.productionModel.scenes=[{id:sceneId,episodeUid:'episode:one',scopeRole:'CURRENT'}];f.snapshot.productionModel.episodes=[{id:'episode:one',sceneIds:[sceneId],scopeRole:'CURRENT'}];f.snapshot.productionModel.shots=[{id:'shot:one',sceneId},{id:'shot:other',sceneId:'scene:other'}];
 for(const [relationScope,count] of [[[],1],[[{scopeType:'PROJECT',scopeId:'project:neutral'}],1],[[{scopeType:'PROJECT',scopeId:'project:other'}],0],[[{scopeType:'EPISODE',scopeId:'episode:one',revisionId:'episode:rev1'}],1],[[{scopeType:'EPISODE',scopeId:'episode:other',revisionId:'episode:rev2'}],0],[[{scopeType:'SHOT',scopeId:'shot:one',revisionId:'shot:rev1'}],1],[[{scopeType:'SHOT',scopeId:'shot:other',revisionId:'shot:rev2'}],0]]){
  const graph=clone(f.graph);graph.relations[0].scope=relationScope;const value=derive(project(f.snapshot,graph));assert.equal(value.bindings[0].graphClosure.relations.length,count,JSON.stringify(relationScope));
 }
 for(const binding of [{scopeType:'UNRECOGNIZED',scopeId:'x',revisionId:'r'},{scopeType:'SHOT',scopeId:'shot:missing',revisionId:'r'},{scopeType:'SCENE',scopeId:'scene:other',revisionId:'r',futureApplicability:'unknown'}]){
  const graph=clone(f.graph);graph.relations[0].scope=[binding];assert.throws(()=>derive(project(f.snapshot,graph)),{code:'DOMAIN_CONFLICT'});
 }
 const graph=clone(f.graph);graph.relations[0].scope=[{scopeType:'EPISODE',scopeId:'episode:one',revisionId:'r'}];const missing=clone(f.snapshot);missing.productionModel.scenes=[];missing.productionModel.episodes=[];assert.throws(()=>derive(project(missing,graph)),/唯一永久集归属/);
});
test('current independent-episode release owns scope even while legacy model scenes and episodes remain untouched',()=>{
 const f=fixture(),m=f.snapshot.productionModel,coverage=m.sceneCoveragePlanRevisions[0],input={episodeUid:'episode:new',scenes:[{id:sceneId,contentHash:domainHash('current scene body')}]};
 m.scenes=[{id:'scene:OLD',episodeUid:'episode:OLD'}];m.episodes=[{id:'episode:OLD',sceneIds:['scene:OLD']}];
 m.episodeNarrativeReleases=[{id:'release:episode:new',episodeUid:'episode:new',scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',reviewInput:input,contentHash:domainHash(input)}];
 coverage.episodeNarrativeReleaseId='release:episode:new';coverage.episodeUid='episode:new';
 const graph=clone(f.graph);graph.relations[0].scope=[{scopeType:'EPISODE',scopeId:'episode:new',revisionId:'revision:episode:new'}];
 const before=project(f.snapshot,graph),basis=derive(before);assert.equal(basis.bindings[0].graphClosure.relations.length,1);
 assert.deepEqual(before.productionModel.scenes,[{id:'scene:OLD',episodeUid:'episode:OLD'}]);
 const changed=clone(graph);changed.relations[0].scope[0].revisionId='revision:episode:next';assert.notEqual(derive(project(before,changed)).contentHash,basis.contentHash);
 for(const mutate of [model=>model.episodeNarrativeReleases[0].scopeRole='EVIDENCE_ONLY',model=>model.episodeNarrativeReleases[0].contentHash='0'.repeat(64),model=>model.sceneCoveragePlanRevisions[0].episodeUid='episode:wrong',model=>delete model.sceneCoveragePlanRevisions[0].episodeNarrativeReleaseId,model=>model.episodeNarrativeReleases.push({...clone(model.episodeNarrativeReleases[0]),id:'release:ambiguous'})]){
  const invalid=clone(before);mutate(invalid.productionModel);assert.throws(()=>derive(invalid),{code:'DOMAIN_CONFLICT'});
 }
});
test('reference policies and linked representation conditions are semantic even when a new family alone is not',()=>{
 const f=fixture(),g=clone(f.graph);g.representations.push({id:'rep:reference',entityId:'entity:room',stateId:null,type:'LOCATION_EMPTY',label:'Space reference',dimensions:{},assetFamilyIds:[],requirementIds:[],authority:'A',evidence:[]});g.relations.push({id:'relation:reference',type:'VISUAL_REFERENCE',from:{kind:'REPRESENTATION',id:'rep:reference'},to:{kind:'REPRESENTATION',id:'rep:room'},label:'Space anchor',purpose:'space',inherit:['layout'],exclude:[],scope:clone(scope),authority:'A',status:'CONFIRMED',referencePolicyId:'CLEAN_MASTER',evidence:clone(evidence)});
 validateDomainGraph(g);const before=project(f.snapshot,g),basis=derive(before),after=clone(before);after.productionModel.domainReferencePolicyBindings['relation:reference'].maxDerivedGenerations=1;assert.notEqual(derive(after).contentHash,basis.contentHash);
 const next=clone(g);next.representations[1].assetFamilyIds=['family:reference'];assert.deepEqual(derive(project(before,next)),basis);next.representations[1].dimensions.viewpoint='eastern wall';assert.notEqual(derive(project(before,next)).contentHash,basis.contentHash);
});
test('unknown projected requirement fields are retained, and unknown derived domain context fields fail closed',()=>{
 const f=fixture(),basis=derive(f.snapshot),after=clone(f.snapshot);after.productionModel.materialRequirements[0].futureDialogueCondition={text:'hello',speaker:'visitor'};assert.notEqual(derive(after).contentHash,basis.contentHash);
 after.productionModel.materialRequirements[0].domainContext.futureSemanticConstraint='Do not ignore this';assert.throws(()=>derive(after),/未识别的域上下文字段/);
});
for(const [label,change] of [
 ['source graph SHA',m=>m.domainGraphRef.sha256='0'.repeat(64)],
 ['projected demand hash',m=>m.materialRequirements[0].requirementHash='0'.repeat(64)],
 ['projected state contradiction',m=>m.materialRequirements[0].stateRef='state:other'],
 ['duplicate requirement',m=>m.materialRequirements.push(clone(m.materialRequirements[0]))],
 ['missing adopted coverage',m=>m.sceneCoveragePlanRevisions=[]],
 ['coverage hash mismatch',m=>m.sceneCoveragePlanRevisions[0].contentHash='0'.repeat(64)],
 ['unknown graph schema',m=>m.domainGraph.schemaVersion='2.0'],
 ['undefined semantic value',m=>m.materialRequirements[0].futureMeaning=undefined],
])test('malformed '+label+' does not yield an apparently current V3 basis',()=>{const f=fixture();change(f.snapshot.productionModel);assert.throws(()=>derive(f.snapshot),{code:'DOMAIN_CONFLICT'});});
test('legacy registry hash/source tokens and old V2 frozen objects are not silently reinterpreted or upgraded',()=>{
 const f=fixture(),m=f.snapshot.productionModel;m.materialRequirements[0].sourceKind='LEGACY';const basis=derive(f.snapshot);assert.equal(basis.bindings[0].requirement.requirementHash,m.materialRequirements[0].requirementHash);
 const before=clone(m.materialRequirements[0]);m.materialRequirements[0].requirementHash='d'.repeat(64);assert.notEqual(derive(f.snapshot).contentHash,basis.contentHash);m.materialRequirements[0]=before;
 const frozenV2={id:'MATERIAL-REQUIREMENT-SET:'+sceneId,schemaVersion:'2.0',sceneId,bindings:[{requirementId,requirementHash:before.requirementHash}],contentHash:domainHash('old-exact-token')},bytes=JSON.stringify(frozenV2);
 assert.equal(shotDesignRequirementBasisSchema(frozenV2),'2.0');assert.throws(()=>assertShotDesignRequirementBasisV3Current(m,sceneId,frozenV2),/旧基线必须继续/);assert.equal(JSON.stringify(frozenV2),bytes);
 for(const invalid of [{},{schemaVersion:'3.0'},{schemaVersion:'4.0'}])assert.throws(()=>shotDesignRequirementBasisSchema(invalid),/版本未知/);
});
