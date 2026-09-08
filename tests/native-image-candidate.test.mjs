import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {productionHash} from '../host/instance-runtime/shot-production-model.mjs';
import {compileShotRecipePreview} from '../host/instance-runtime/shot-production-recipes.mjs';

// Exercise the actual route consumer rather than a second implementation.
const source=readFileSync(new URL('../app/api/v8/asset-versions/route.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('route.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const functions=ast.statements.filter(s=>ts.isFunctionDeclaration(s)&&['knownVersion','isMaterializedVersion','defaultVersionId','realizedExpectedOutput'].includes(s.name?.text)).map(s=>s.getText(ast)).join('\n');
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
const {defaultVersionId,realizedExpectedOutput}=new Function('HttpError','stableObjectHash',ts.transpile(functions+'\nreturn {defaultVersionId,realizedExpectedOutput};', {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}))(HttpError,productionHash);
function fixture(prefix='SP'){
 const key='a'.repeat(24),planId=prefix+'-PLAN-'+key,familyId=prefix+'-AF-'+key,workId=prefix+'-WI-'+key,id=prefix+'-EO-'+key,marker=prefix==='SP'?'shotProductionPlanId':'materialProductionPlanId';
 const expectedOutput={id,familyId,legacyVersionId:id,plannedVersionLabel:'V001',targetPath:'media/_review_pending/'+familyId+'/V001.png',expectationState:'PLANNED',[marker]:planId};
 const family={id:familyId,ownerRef:workId,kind:'IMAGE',currentExpectedOutputId:id,expectedOutputRefs:[id],[marker]:planId};
 const work={id:workId,label:'本镜图像',pipelineStageCode:'P07',outputAssetRef:familyId,[marker]:planId};
 const model={assetVersions:[],expectedOutputs:[expectedOutput],assetFamilies:[family],workItems:prefix==='SP'?[work]:[],materialWorkItems:prefix==='MP'?[work]:[],[prefix==='SP'?'shotProductionPlans':'materialProductionPlans']:[{id:planId,workItemIds:[workId],familyId,workItemId:workId,expectedOutputId:id}]};
 return{family,work,expectedOutput,data:{productionModel:model},marker};
}
for(const prefix of ['MP','SP'])test(prefix+' native output alias derives V001 without modifying the frozen graph',()=>{const f=fixture(prefix),before=structuredClone(f.data);assert.deepEqual(defaultVersionId(f.family.id,f.expectedOutput,f.data,[]),{versionId:f.family.id+'@V001',plannedVersionId:f.expectedOutput.id,nativeOutput:true});assert.deepEqual(f.data,before);});
test('SP successor from real recipe compiler retains the original EO alias and derives V002',()=>{
 const f=fixture(),version={id:f.family.id+'@V001',familyId:f.family.id,path:f.expectedOutput.targetPath,sha256:productionHash('old-bytes'),outputState:'PRESENT'};f.data.productionModel.assetVersions.push(version);
 const c={view:{releaseId:'release'},work:f.work,family:f.family,output:f.expectedOutput,model:f.data.productionModel,state:{assetVersionsById:{[version.id]:version},assetFamiliesById:{[f.family.id]:{...f.family,currentVersionId:version.id}}},inputs:[],basis:{},basisHash:productionHash({})};
 const next=compileShotRecipePreview(c,{model:'codex:gpt-image-2',prompt:'Use the clean master.',negativePrompt:'No drift.',parameters:{width:1024,height:1024}},{draftRevisionId:'DRAFT-2'}).expectedOutput;
 assert.notEqual(next.id,f.expectedOutput.id);assert.equal(next.legacyVersionId,f.expectedOutput.id);f.data.productionModel.expectedOutputs.push(next);f.family.expectedOutputRefs.push(next.id);
 assert.deepEqual(defaultVersionId(f.family.id,next,f.data,[]),{versionId:f.family.id+'@V002',plannedVersionId:f.expectedOutput.id,nativeOutput:true});
});
for(const [name,mutate] of [
 ['cross-family alias',f=>{f.expectedOutput.legacyVersionId='SP-EO-'+'b'.repeat(24);f.data.productionModel.expectedOutputs.push({...f.expectedOutput,id:f.expectedOutput.legacyVersionId,familyId:'SP-AF-'+'b'.repeat(24)});f.family.expectedOutputRefs.push(f.expectedOutput.legacyVersionId);}],
 ['unregistered alias',f=>f.family.expectedOutputRefs=[]],
 ['missing source plan',f=>f.data.productionModel.shotProductionPlans=[]],
 ['wrong work plan',f=>f.work.shotProductionPlanId='SP-PLAN-'+'b'.repeat(24)],
 ['duplicate alias identity',f=>f.data.productionModel.expectedOutputs.push({...f.expectedOutput})],
 ['arbitrary label',f=>f.expectedOutput.plannedVersionLabel='other'],
 ['already materialized label',f=>f.data.productionModel.assetVersions.push({id:f.family.id+'@V001',familyId:f.family.id,path:'media/old.png',sha256:productionHash('old'),outputState:'PRESENT'})],
])test('native candidate rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>defaultVersionId(f.family.id,f.expectedOutput,f.data,[]),{status:409});});
test('legacy family@V001 contract and automatic successor IDs remain byte-compatible',()=>{
 const data={productionModel:{assetFamilies:[],expectedOutputs:[],assetVersions:[]}},output={id:'LEGACY-EO',familyId:'FAMILY',legacyVersionId:'FAMILY@V001',plannedVersionLabel:'V001'};
 assert.deepEqual(defaultVersionId('FAMILY',output,data,[]),{versionId:'FAMILY@V001',plannedVersionId:'FAMILY@V001'});
 data.productionModel.assetVersions.push({id:'FAMILY@V001',familyId:'FAMILY',path:'production/generated/_review_pending/old.png',sha256:productionHash('old'),outputState:'PRESENT'});
 assert.deepEqual(defaultVersionId('FAMILY',output,data,[]),{versionId:'FAMILY@V002',plannedVersionId:'FAMILY@V001'});
});

test('native current EO realizes once without treating a predecessor alias as a new realization',()=>{
 const f=fixture(),first={familyId:f.family.id,expectedOutputId:f.expectedOutput.id,plannedVersionId:f.expectedOutput.id,versionId:f.family.id+'@V001'},next={...f.expectedOutput,id:'SP-EO-'+'b'.repeat(24),plannedVersionLabel:'V002'};
 assert.equal(realizedExpectedOutput(f.expectedOutput,[first]),first);
 assert.equal(realizedExpectedOutput(next,[first]),undefined);
 const second={...first,expectedOutputId:next.id,versionId:f.family.id+'@V002'};
 assert.equal(realizedExpectedOutput(next,[first,second]),second);
 assert.equal(realizedExpectedOutput(next,[{...second,familyId:'OTHER'}]),undefined);
});
test('legacy realization evidence without an ExpectedOutput field is still recognized',()=>{
 const output={id:'OLD-EO',familyId:'OLD',legacyVersionId:'OLD@V001'},candidate={familyId:'OLD',plannedVersionId:'OLD@V001',versionId:'OLD@V001'};
 assert.equal(realizedExpectedOutput(output,[candidate]),candidate);
});
