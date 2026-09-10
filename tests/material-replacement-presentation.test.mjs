import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {replacementFixture} from './fixtures/material-requirement-replacement.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {currentMaterialRequirementRows,projectMaterialRequirementDispositions} from '../host/instance-runtime/material-requirement-disposition.mjs';
import {objectSummary} from '../host/instance-runtime/query-model.mjs';

function emitted(file,names){const source=readFileSync(new URL(file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.ESNext,true);return ts.transpileModule(ast.statements.filter(node=>!ts.isImportDeclaration(node)&&(!names||ts.isFunctionDeclaration(node)&&names.includes(node.name?.text))).map(node=>node.getText(ast)).join('\n'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;}
let ordinal=0;
async function load(code,dependencies={}){globalThis.__replacementPresentation=dependencies;try{return await import('data:text/javascript;base64,'+Buffer.from('const {'+Object.keys(dependencies).join(',')+'}=globalThis.__replacementPresentation;\n'+code+'\n// fixture '+(++ordinal)).toString('base64'));}finally{delete globalThis.__replacementPresentation;}}
const presentation=await load(emitted('../app/material-requirement-presentation.ts'));
const facets=await load(emitted('../app/material-catalog-facets.ts'));
const {ReadTiming}=await load(emitted('../app/api/_read-timing.ts'),{});
const query=await load(emitted('../app/api/v8/ui/_material-query.ts',['materialDirectoryProjection','materialUsagePageBindings','summarizeMaterialPage']),{directories:new WeakMap(),currentMaterialRequirementRows,projectMaterialRequirementDispositions,objectSummary});
const projection=await load(emitted('../app/api/v8/ui/_projection.ts'),{currentMaterialRequirementRows});
function modelFixture(){const f=replacementFixture(),base={productionModel:{workItems:[],assetFamilies:[],assetVersions:[],materialWorkItems:[],expectedOutputs:[],materialRequirements:[],scenes:[],episodes:[],shots:[]}};return projectDomainGraph(projectDomainGraph(base,f.before,{revisionId:'before',sha256:domainHash(f.before)}),f.after,{revisionId:'after',sha256:domainHash(f.after)}).productionModel;}

test('browser disposition uses server receipt, excludes historical and unknown states, and retains legacy rows',()=>{
  const model=modelFixture(),rows=query.materialDirectoryProjection(model).rows;
  assert.deepEqual(rows.filter(presentation.atomicMaterialDirectoryRow).map(r=>r.id).sort(),['leaf-a','leaf-b']);
  assert.deepEqual(rows.filter(presentation.currentMaterialDirectoryRow).map(r=>r.id).sort(),['complete-new','leaf-a','leaf-b']);
  for(const currentDisposition of ['REPLACED','INVALID_REPLACEMENT','HISTORICAL','UNSUPPORTED'])assert.equal(presentation.currentMaterialDirectoryRow({requirementClass:'REQUIRED',currentDisposition}),false);
  assert.equal(presentation.currentMaterialDirectoryRow({requirementClass:'REQUIRED',requirementReplacement:{status:'VALID'}}),false,'partial receipt cannot impersonate legacy');
  for (const requirementReplacement of [undefined, {status:'VALID'}, {protocol:'UNSUPPORTED',status:'VALID'}, {protocol:'MATERIAL_REQUIREMENT_REPLACEMENT_V1',status:'UNKNOWN'}]) assert.equal(presentation.currentMaterialDirectoryRow({requirementClass:'REQUIRED',currentDisposition:'CURRENT_ATOMIC',requirementReplacement}),false,'incomplete or unknown receipt cannot grant current selection');
  assert.equal(presentation.currentMaterialDirectoryRow({requirementClass:'REQUIRED'}),true);
  assert.equal(presentation.atomicMaterialDirectoryRow({requirementClass:'REQUIRED',composition:{mode:'ALL'}}),false);
});
test('facets and entity totals count current atomic IDs once while showing ALL',()=>{
  const rows=query.materialDirectoryProjection(modelFixture()).rows.map(r=>({id:r.id,required:true,currentSelectable:presentation.currentMaterialDirectoryRow(r),countsAsAtomic:presentation.atomicMaterialDirectoryRow(r),mediaType:'IMAGE',entityType:'PROP',entityId:'prop',stateId:'base',episodeUids:[],sceneIds:[],creatorStage:'APPROVED',searchText:r.title}));
  const filter=facets.allMaterialCatalogFilters();
  assert.equal(facets.countMaterialCatalogRequirements([...rows,rows[1]],filter),2);
  assert.equal(facets.materialCatalogEntityGroups(facets.filterMaterialCatalogRows(rows,filter))[0].requirementCount,2);
  assert.equal(facets.filterMaterialCatalogRows(rows,filter).length,3);
  assert.equal(facets.countMaterialCatalogRequirements(rows,{...filter,search:'old-broad'}),0);
});
test('bootstrap denominator is atomic and does not inherit old adopted root completion',()=>{
  const model=modelFixture();assert.equal(projection.productionBootstrapSeed(model).counts.requiredMaterialRequirements,2);
  assert.equal(projection.productionBootstrapSeed({materialRequirements:[{id:'legacy',requirementClass:'REQUIRED'}]}).counts.requiredMaterialRequirements,1);
});
test('hosted/fallback material pagination and summaries use the same full replacement closure',async()=>{
  const model=modelFixture(),data={snapshotId:'snapshot:replacement',productionModel:model,creativeLineage:{storyStructure:{planStatus:'CANDIDATE'}}},operations={snapshotId:data.snapshotId,operationRevision:'op:replacement',etag:'"replacement"',stateProjection:{materialRequirementsById:{},materialWorkItemsById:{},workItemsById:{},workPackagesById:{},assetFamiliesById:{},assetVersionsById:{},expectedOutputsById:{}}};
  const route=await load(emitted('../app/api/v8/ui/materials/route.ts'),{...query,ReadTiming,hostedReadOnlyMode:()=>true,instanceRepository:async()=>null,postgresMaterialPage:async()=>null,projectIdFor:()=> 'project',normalizeEmptyProductionFilters:(_d,f)=>f,assertStableId:()=>{},errorResponse:e=>new Response(JSON.stringify({error:e.message}),{status:e.status||500}),HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}},jsonResponse:v=>new Response(JSON.stringify(v)),reviewData:async()=>data,operationalSnapshot:async()=>operations,assertCursorOffset:(offset,total)=>assert.ok(offset<=total),encodeUiCursor:(_r,_s,_h,offset)=>String(offset),jsonByteLength:v=>Buffer.byteLength(JSON.stringify(v)),parseUiPageRequest:r=>{const u=new URL(r.url);return{filters:{},offset:Number(u.searchParams.get('cursor')||0),limit:Number(u.searchParams.get('limit')||1),filterHash:'filter'};},UI_PAGE_MAX_BYTES:2*1024*1024});
  for(const detail of ['summary','full']){
    let cursor=null;const ids=[];
    do{const response=await route.GET(new Request('http://neutral/materials?'+new URLSearchParams({detail,limit:'1',...(cursor?{cursor}:{})}))),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.total,3);assert.equal(body.atomicTotal,2);assert.equal(body.aggregateTotal,1);ids.push(...body.page.materialRequirements.map(r=>r.id));cursor=body.nextCursor;}while(cursor);
    assert.deepEqual(ids,['complete-new','leaf-a','leaf-b']);
    const history=await (await route.GET(new Request('http://neutral/materials?requirementId=old-broad&detail='+detail))).json();assert.equal(history.page.materialRequirements[0].currentDisposition,'REPLACED');assert.equal(history.page.materialRequirements[0].requirementReplacement.replacedByRequirementId,'complete-new');assert.equal(history.atomicTotal,0);
  }  model.materialRequirements=model.materialRequirements.filter(row=>row.id!=='leaf-b');
  const invalid=await (await route.GET(new Request('http://neutral/materials?requirementId=complete-new'))).json();
  assert.equal(invalid.page.materialRequirements[0].currentDisposition,'INVALID_REPLACEMENT');assert.equal(invalid.atomicTotal,0);assert.equal(invalid.aggregateTotal,0);
});
