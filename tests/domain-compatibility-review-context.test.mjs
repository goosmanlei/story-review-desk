import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {api} from './domain-new-production-fixture.mjs';
import {makeCompatibilityFixture} from './fixtures/domain-production-compatibility.mjs';
import {domainHash as hash} from '../host/instance-runtime/domain-model.mjs';
import {executionDefinitionHash,inspectExecutionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';

// Same direct-function isolation convention as execution-definition-hash tests.
// Real context contracts and real scope bridge; only I/O adapters are synthetic.
function loadContext(bindings){
  const file='../app/api/v8/material-review-drafts/_context.ts',text=readFileSync(new URL(file,import.meta.url),'utf8');
  const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),names=['asRows','strings','exactSha','eventState','mediaKind','buildMaterialReviewAuthorityContext'];
  const nodes=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));assert.equal(nodes.length,names.length);
  const source=ts.transpileModule(nodes.map(n=>n.getText(ast)).join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,module={exports:{}};
  new Function('module','exports',...Object.keys(bindings),source)(module,module.exports,...Object.values(bindings));return module.exports.buildMaterialReviewAuthorityContext;
}
function fixture(){
  const c=makeCompatibilityFixture({scopeExtension:true}),model=structuredClone(c.model),v=model.assetVersions[0],requirement=model.materialRequirements[0];
  model.assetFamilies[0].versionRefs=[v.id];requirement.assetFamilyRefs=[v.familyId];requirement.acceptanceCriteria=[];
  Object.assign(v,{path:'media/isolated.png',outputState:'PRESENT'});
  const data={snapshotId:'snapshot:fixture',instance:{instanceId:c.options.instanceId},productionModel:model};
  const definition={id:'definition:original',materialRequirementRef:requirement.id,materialRequirementHash:c.query.beforeHash,output:{assetFamilyRef:v.familyId,path:v.path},prompt:{main:'unchanged original recipe'},source:{path:'immutable-source.json',sha256:'7'.repeat(64)}};
  definition.definitionHash=executionDefinitionHash(definition);
  const candidate={eventId:'candidate:fixture',snapshotId:data.snapshotId,familyId:v.familyId,versionId:v.id,path:v.path,sha256:v.sha256,executionDefinitionId:definition.id,executionDefinitionHash:definition.definitionHash,callPackageHash:definition.definitionHash,promptRevisionId:'prompt:original',actualPrompt:definition.prompt,actualPromptHash:hash(definition.prompt),recipePromptHash:hash(definition.prompt),inputBindings:[],inputBindingsHash:hash([]),executionRequestId:'request:fixture',runId:'run:fixture',parentVersionId:null,parentVersionSha256:null,parentBindingState:'EXPLICIT_ROOT',promptChangedFromCallPackage:false,promptSyncRequired:false};
  const request={...structuredClone(candidate),eventId:'request:event'},run={...structuredClone(candidate),eventId:'run:event',runState:'SUCCEEDED'};
  const input={data,stateProjection:{},requirementId:requirement.id,familyId:v.familyId,versionId:v.id,versionSha256:v.sha256,contextHash:'current-review-context'};
  const build=loadContext({hasMaterialRequirementCompatibility:api.hasMaterialRequirementCompatibility,inspectExecutionDefinitionHash,stableObjectHash:hash,HttpError:api.HttpError,withInstanceMediaRead:fn=>fn(),safeGeneratedPath:async()=>'/isolated/no-media-is-read',hashStableFile:async()=>({sha256:v.sha256,size:1}),assetReviewContextHash:()=>input.contextHash,resolveFormalReviewSpec:()=>({criteria:[{id:'fixed',label:'固定标准'}]}),recipeCatalog:async()=>({snapshotId:data.snapshotId,executionDefinitions:[definition]}),listAllEvents:async kind=>({'asset-version':[candidate],'execution-request':[request],run:[run],review:[]}[kind]||[])});
  return {c,data,definition,candidate,request,run,read:()=>build(input)};
}
test('old exact recipe scope can be read against current demand without changing either hash or prompt',async()=>{
  const f=fixture(),frozen=hash([f.data,f.definition,f.candidate,f.request,f.run]),result=await f.read();
  assert.equal(result.productionMaterials.definitionEvidenceState,'CURRENT_DEFINITION_EXACT_MATCH');
  assert.equal(result.requirement.requirementHash,f.c.query.afterHash);
  assert.equal(result.productionMaterials.definitionHash,f.definition.definitionHash);
  assert.deepEqual(result.productionMaterials.recipePrompt,f.definition.prompt);
  assert.equal(f.definition.materialRequirementHash,f.c.query.beforeHash);
  assert.equal(hash([f.data,f.definition,f.candidate,f.request,f.run]),frozen);
});
for(const [label,change]of [
  ['no proof',f=>f.data.productionModel.domainProductionCompatibilities=[]],
  ['missing instance identity',f=>delete f.data.instance],
  ['different current physical requirement',f=>f.data.productionModel.domainGraph.requirements[0].acceptanceCriteria.push('new physical trait')],
  ['actual prompt hash drift',f=>f.candidate.actualPromptHash='0'.repeat(64)],
  ['actual input hash drift',f=>f.candidate.inputBindings.push({versionId:'unapproved'})],
  ['request input closure drift',f=>f.request.inputBindings.push({versionId:'unapproved'})],
  ['run source hash drift',f=>f.run.executionDefinitionHash='0'.repeat(64)],
  ['run result unknown',f=>f.run.runState='RESULT_UNKNOWN'],
  ['source bytes drift',f=>f.definition.source.sha256='0'.repeat(64)],
  ['recipe prompt bytes drift',f=>f.definition.prompt={main:'not the frozen recipe'}],
])test('compatibility does not bypass '+label,async()=>{const f=fixture();change(f);await assert.rejects(f.read(),e=>e.status===409);});
