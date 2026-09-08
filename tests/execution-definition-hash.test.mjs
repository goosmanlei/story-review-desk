import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {executionDefinitionHash,inspectExecutionDefinitionHash,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA} from '../host/instance-runtime/execution-definition-hash.mjs';

const hash=value=>sha256(canonicalJson(value));
const sourceEnvelope={sourceRef:'story/shot-production/recipes/source.json',sourceRevisionId:'source-r1',sourceSha256:'c'.repeat(64)};
const legacy=()=>({id:'legacy-call',title:'旧调用包',executorKind:'MODEL_CALL',source:{path:'prompts/legacy.md',sha256:'a'.repeat(64)},sourceRef:'prompts/legacy.md',sourceRevisionId:'legacy-source-r1',sourceSha256:'a'.repeat(64),upload:{items:[]},model:{branch:'image-model'},prompt:{main:'保持母版身份',negative:''},parametersRaw:'{}',output:{assetFamilyRef:'FAMILY',path:'media/image.png'},definitionHash:'de2ee4898cf9d43296329aacf90e89b7b933f0a8f9c7807c25d46e9f9dae3045',currentRevisionId:'legacy-call:r1'});
const shot=()=>({id:'SP-CALL-0123456789abcdef01234567',executorKind:'MODEL_CALL',workItemRef:'WORK',currentRevisionId:'SP-CALL-0123456789abcdef01234567:r1',authoringContent:{model:'image-model',prompt:'保持母版身份',negativePrompt:'',parameters:{}},productionBasis:{workItemId:'WORK'},productionBasisHash:'b'.repeat(64),upload:{items:[]},model:{branch:'image-model'},prompt:{main:'保持母版身份',negative:''},parametersRaw:'{}',output:{assetFamilyRef:'FAMILY',path:'media/image.png'},definitionHash:'852a7c55cf86ae1f52daf6288dbd5fd039dc7e875448ba5980ca7e6f40cbeaea'});
function markedShot(){const value={...shot(),definitionHashSchemaVersion:SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA};value.definitionHash=executionDefinitionHash(value);return value;}

test('legacy frozen hashes and bytes retain their exact original normalization',()=>{
 const value=legacy(),bytes=canonicalJson(value);
 assert.equal(executionDefinitionHash(value),'de2ee4898cf9d43296329aacf90e89b7b933f0a8f9c7807c25d46e9f9dae3045');
 assert(inspectExecutionDefinitionHash(value).valid);
 assert.equal(executionDefinitionHash({...value,currentRevisionId:'derived-r2'}),value.definitionHash);
 for(const key of ['sourceRef','sourceRevisionId','sourceSha256'])assert.notEqual(executionDefinitionHash({...value,[key]:'changed'}),value.definitionHash,key);
 assert.equal(canonicalJson(value),bytes);
});
test('existing unversioned SP frozen source and published catalog share the original hash',()=>{
 const value=shot(),bytes=canonicalJson(value),published={...value,...sourceEnvelope};
 assert.equal(executionDefinitionHash(value),'852a7c55cf86ae1f52daf6288dbd5fd039dc7e875448ba5980ca7e6f40cbeaea');
 assert.equal(executionDefinitionHash(published),value.definitionHash);
 assert(inspectExecutionDefinitionHash(published).valid);
 assert.equal(canonicalJson(value),bytes);
 assert.equal(value.definitionHashSchemaVersion,undefined);
});
test('new SP schema binds all source content and revision while excluding only the publication envelope',()=>{
 const value=markedShot(),published={...value,...sourceEnvelope},bytes=canonicalJson(published);
 assert.equal(executionDefinitionHash(value),executionDefinitionHash(published));
 assert(inspectExecutionDefinitionHash(published).valid);
 for(const mutate of [v=>v.prompt.main='另一个动作',v=>v.currentRevisionId+='changed',v=>v.upload.items.push({assetVersionRef:'OTHER'}),v=>v.productionBasisHash='d'.repeat(64),v=>v.parametersRaw='seed=42',v=>v.futureExecutionOption=true,v=>delete v.definitionHashSchemaVersion]){
  const changed=structuredClone(published);mutate(changed);assert.equal(inspectExecutionDefinitionHash(changed).valid,false);
 }
 assert.equal(canonicalJson(published),bytes);
});
test('unknown schemas fail closed and legacy-looking hashes cannot choose another normalization',()=>{
 const unknown={...markedShot(),definitionHashSchemaVersion:'FUTURE'};
 assert.throws(()=>executionDefinitionHash(unknown),/Unsupported/);
 assert.deepEqual(inspectExecutionDefinitionHash(unknown),{declaredHash:unknown.definitionHash,calculatedHash:null,valid:false});
 assert.equal(inspectExecutionDefinitionHash(null).valid,false);
 const old=legacy();old.definitionHash=hash(Object.fromEntries(Object.entries(old).filter(([k])=>!['definitionHash','sourceRef','sourceRevisionId','sourceSha256'].includes(k))));
 assert.equal(inspectExecutionDefinitionHash(old).valid,false);
 const malformed={...shot(),id:'SP-CALL-not-a-generated-id',...sourceEnvelope};
 malformed.definitionHash=hash(Object.fromEntries(Object.entries(malformed).filter(([k])=>!['definitionHash','sourceRef','sourceRevisionId','sourceSha256'].includes(k))));
 assert.equal(inspectExecutionDefinitionHash(malformed).valid,false);
});

// Exercise the real route/context functions with isolated authority adapters;
// no registered media, current instance database or source documents are touched.
function loadFunctions(path,names,bindings){
 const text=readFileSync(new URL(path,import.meta.url),'utf8'),ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const selected=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));
 assert.equal(selected.length,names.length);
 const source=selected.map(n=>n.getText(ast)).join('\n');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};new Function('module','exports',...Object.keys(bindings),js)(module,module.exports,...Object.values(bindings));return module.exports;
}
const {projectProductionEvidence}=loadFunctions('../app/api/v8/asset-versions/route.ts',['runState','evidenceField','exactSha','latestEvidenceEvent','projectProductionEvidence'],{stableObjectHash:hash,inspectExecutionDefinitionHash});
function lineage(definition){
 const outputSha=hash('isolated media fixture'),bindings=[],candidate={eventId:'candidate-1',snapshotId:'snapshot-1',familyId:'FAMILY',versionId:'VERSION',path:'media/image.png',sha256:outputSha,executionDefinitionId:definition.id,executionDefinitionHash:definition.definitionHash,callPackageHash:definition.definitionHash,promptRevisionId:definition.currentRevisionId,actualPrompt:definition.prompt,actualPromptHash:hash(definition.prompt),recipePromptHash:hash(definition.prompt),inputBindings:bindings,inputBindingsHash:hash(bindings),executionRequestId:'request-1',runId:'run-1',parentVersionId:null,parentVersionSha256:null,parentBindingState:'EXPLICIT_ROOT',promptChangedFromCallPackage:false,promptSyncRequired:false};
 const request={...candidate,eventId:'request-event-1'},run={...candidate,eventId:'run-event-1',runState:'SUCCEEDED'};
 return{candidate,outputSha,sources:{definitions:[definition],runEvents:[run],executionRequestEvents:[request],versions:[{id:'VERSION',familyId:'FAMILY',sha256:outputSha,path:candidate.path}],candidateEvents:[candidate]}};
}
test('actual candidate evidence verifies legacy, existing SP and new SP definitions after publication',()=>{
 for(const definition of [legacy(),{...shot(),...sourceEnvelope},{...markedShot(),...sourceEnvelope}]){
  const {candidate,sources}=lineage(definition),projection=projectProductionEvidence(candidate,sources);
  assert.equal(projection.fields.executionDefinition.status,'VERIFIED',definition.id);
  assert.equal(projection.counts.VERIFIED,8);
  const changed=structuredClone(sources);changed.definitions[0].prompt.main='篡改内容';
  assert.equal(projectProductionEvidence(candidate,changed).fields.executionDefinition.status,'CONFLICT');
  changed.definitions[0]={...definition,definitionHashSchemaVersion:'UNKNOWN'};
  assert.equal(projectProductionEvidence(candidate,changed).fields.executionDefinition.status,'CONFLICT');
 }
});

class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
function authority(definition){
 const bound={...definition,materialRequirementRef:'REQUIREMENT',materialRequirementHash:'requirement-hash'};bound.definitionHash=executionDefinitionHash(bound);
 const fixture=lineage(bound),version=fixture.sources.versions[0];
 const {buildMaterialReviewAuthorityContext}=loadFunctions('../app/api/v8/material-review-drafts/_context.ts',['asRows','strings','exactSha','eventState','mediaKind','buildMaterialReviewAuthorityContext'],{
  inspectExecutionDefinitionHash,stableObjectHash:hash,HttpError,
  withInstanceMediaRead:fn=>fn(),safeGeneratedPath:async()=>'/isolated/media/image.png',hashStableFile:async()=>({sha256:fixture.outputSha,size:10}),assetReviewContextHash:()=> 'context-hash',
  resolveFormalReviewSpec:()=>({criteria:[{id:'visual',label:'核对图像'}]}),recipeCatalog:async()=>({snapshotId:'snapshot-1',executionDefinitions:fixture.sources.definitions}),
  listAllEvents:async kind=>({'asset-version':[fixture.candidate],run:fixture.sources.runEvents,'execution-request':fixture.sources.executionRequestEvents,review:[]}[kind]||[]),
 });
 const input={data:{snapshotId:'snapshot-1',productionModel:{materialRequirements:[{id:'REQUIREMENT',requirementClass:'REQUIRED',requirementHash:'requirement-hash',assetFamilyRefs:['FAMILY']}],assetFamilies:[{id:'FAMILY',versionRefs:['VERSION']}],assetVersions:[version]}},stateProjection:{},requirementId:'REQUIREMENT',familyId:'FAMILY',versionId:'VERSION',versionSha256:fixture.outputSha,contextHash:'context-hash'};
 return{read:()=>buildMaterialReviewAuthorityContext(input),fixture};
}
test('actual material review context resolves exact SP definitions and still rejects claimed-hash contradictions',async()=>{
 for(const definition of [legacy(),{...shot(),...sourceEnvelope},{...markedShot(),...sourceEnvelope}]){
  const a=authority(definition),result=await a.read();
  assert.equal(result.productionMaterials.definitionEvidenceState,'CURRENT_DEFINITION_EXACT_MATCH');
  assert.deepEqual(result.productionMaterials.missingFields,[]);
  a.fixture.sources.definitions[0].parametersRaw='tampered';
  await assert.rejects(a.read(),error=>error.status===409&&/contradicts that hash/.test(error.message));
 }
});
test('historical material evidence keeps its immutable hash when the current definition is a different version',async()=>{
 const a=authority({...markedShot(),...sourceEnvelope});
 a.fixture.sources.definitions[0].prompt={main:'下一版本提示词'};
 a.fixture.sources.definitions[0].definitionHash=executionDefinitionHash(a.fixture.sources.definitions[0]);
 const result=await a.read();
 assert.equal(result.productionMaterials.definitionEvidenceState,'IMMUTABLE_HASH_ONLY');
 assert.equal(result.productionMaterials.definitionHash,a.fixture.candidate.executionDefinitionHash);
});
