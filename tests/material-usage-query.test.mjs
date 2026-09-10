import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {objectSummary} from '../host/instance-runtime/query-model.mjs';
import {currentMaterialRequirementRows,projectMaterialRequirementDispositions} from '../host/instance-runtime/material-requirement-disposition.mjs';

function emitted(filename,names){const text=readFileSync(new URL(filename,import.meta.url),'utf8'),ast=ts.createSourceFile(filename,text,ts.ScriptTarget.ESNext,true);return ts.transpileModule(ast.statements.filter(node=>!ts.isImportDeclaration(node)&&(!names||ts.isFunctionDeclaration(node)&&names.includes(node.name?.text))).map(node=>node.getText(ast)).join('\n'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;}
async function moduleFor(source,values){globalThis.__usageQueryFixture=values;try{return await import('data:text/javascript;base64,'+Buffer.from('const {'+Object.keys(values).join(',')+'}=globalThis.__usageQueryFixture;\n'+source).toString('base64'));}finally{delete globalThis.__usageQueryFixture;}}
const {ReadTiming}=await moduleFor(emitted('../app/api/_read-timing.ts'),{});
const query=await moduleFor(emitted('../app/api/v8/ui/_material-query.ts',['materialUsagePageBindings','summarizeMaterialPage','materialDirectoryProjection']),{directories:new WeakMap(),objectSummary,currentMaterialRequirementRows,projectMaterialRequirementDispositions});
const digest='a'.repeat(64),sourceFamily={id:'SOURCE',episodeUid:'EP-SOURCE',ownerRef:'WORK-ORIGINAL',currentVersionId:'SOURCE@V002',versionRefs:['SOURCE@V001','SOURCE@V002']};
const usage={usageId:'MUSE-test',eventId:'usage:test',requirementId:'REQ-TARGET',requirementHash:digest,familyId:'SOURCE',versionId:'SOURCE@V001',sha256:digest,eligible:false,reasons:['USAGE_DO_NOT_USE']};
const requirement={id:'REQ-TARGET',requirementClass:'REQUIRED',assetFamilyRefs:[],episodeUid:'EP-TARGET',materialUsageBindings:[usage],coverageSatisfied:false};
const state={materialRequirementsById:{'REQ-TARGET':requirement},materialWorkItemsById:{},workItemsById:{},workPackagesById:{},assetFamiliesById:{SOURCE:sourceFamily},assetVersionsById:Object.fromEntries(['V001','V002'].map(v=>['SOURCE@'+v,{id:'SOURCE@'+v,familyId:'SOURCE',episodeUid:'EP-SOURCE',sha256:digest,mediaToken:'token-'+v}])),expectedOutputsById:{}};
const data={snapshotId:'snapshot:test',creativeLineage:{storyStructure:{planStatus:'CURRENT'}},productionModel:{productionPhases:[],productionGates:[],episodes:[{id:'DISPLAY-TARGET',episodeUid:'EP-TARGET',canonicalScopeId:'EP-TARGET'}],materialRequirements:[requirement],materialWorkItems:[],workItems:[],assetFamilies:[sourceFamily],assetVersions:[],expectedOutputs:[]}};
const operations={snapshotId:data.snapshotId,operationRevision:'OP-1',etag:'"OP-1"',stateProjection:state};
const route=await moduleFor(emitted('../app/api/v8/ui/materials/route.ts'),{
 ...query,ReadTiming,hostedReadOnlyMode:()=>true,instanceRepository:async()=>null,postgresMaterialPage:async()=>null,projectIdFor:()=> 'PROJECT',normalizeEmptyProductionFilters:(_d,f)=>f,
 assertStableId:()=>{},errorResponse:e=>new Response(JSON.stringify({error:e.message}),{status:e.status||500}),HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}},jsonResponse:v=>new Response(JSON.stringify(v)),operationalSnapshot:async()=>operations,reviewData:async()=>data,
 assertCursorOffset:()=>{},encodeUiCursor:()=>null,jsonByteLength:v=>Buffer.byteLength(JSON.stringify(v)),parseUiPageRequest:()=>({filters:{scopeType:'EPISODE',scopeId:'EP-TARGET'},offset:0,limit:20,filterHash:'filter'}),UI_PAGE_MAX_BYTES:2*1024*1024,
});

test('material exact-purpose context crosses source scope only for its bound version, including rejected use',async()=>{
 const response=await route.GET(new Request('http://neutral/api/v8/ui/materials?requirementId=REQ-TARGET&scopeType=EPISODE&scopeId=EP-TARGET'));
 assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(result.page.materialRequirements[0].assetFamilyRefs,[]);assert.equal(result.page.materialRequirements[0].coverageSatisfied,false);
 assert.deepEqual(result.page.assetFamilies.map(f=>f.id),['SOURCE']);assert.equal(result.page.assetFamilies[0].ownerRef,'WORK-ORIGINAL');
 assert.deepEqual(result.page.assetVersions.map(v=>v.id),['SOURCE@V001'],'unrelated newer version does not inherit the purpose scope exemption');
 assert.deepEqual(result.page.materialRequirements[0].materialUsageBindings,[usage]);
});
test('material summary retains exact purpose evidence while leaving original ownership intact',async()=>{
 const result=await (await route.GET(new Request('http://neutral/api/v8/ui/materials?requirementId=REQ-TARGET&detail=summary'))).json();
 assert.equal(result.detailState,'SUMMARY');assert.deepEqual(result.page.materialRequirements[0].materialUsageBindings,[usage]);
 assert.deepEqual(result.page.assetVersions.map(v=>v.id),['SOURCE@V001']);assert.deepEqual(result.page.materialRequirements[0].assetFamilyRefs,[]);
});
