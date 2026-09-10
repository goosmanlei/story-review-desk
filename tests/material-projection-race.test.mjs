import test from 'node:test';
import {readBasis,workspaceReadMetadata} from '../host/instance-runtime/read-basis.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {currentMaterialRequirementRows,projectMaterialRequirementDispositions} from '../host/instance-runtime/material-requirement-disposition.mjs';
const source=readFileSync(new URL('../app/api/v8/ui/_material-query.ts',import.meta.url),'utf8');
const transformed=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;$/gm,'');
let locked=false,writes=[],currentOperations,marker=null,lockCount=0;
const metadata={releaseId:'release-current',eventSequence:2};
const repo={backend:'postgres',getMetadata:async()=>metadata,getWorkspaceFingerprint:async()=>String(metadata.workspaceRevision||'workspace-1'),writeTransaction:async fn=>{locked=true;lockCount++;try{return await fn(repo);}finally{locked=false;}},readTransaction:async fn=>fn(repo)};
const bridge={readBasis,workspaceReadMetadata,currentMaterialRequirementRows,projectMaterialRequirementDispositions,instanceRepository:async()=>repo,operationalSnapshot:async()=>{assert.equal(locked,true);return currentOperations;},operationalProjectionMatches:async(_tx,input)=>marker?.eventSequence===input.eventSequence&&marker?.operationRevision===input.operationRevision,updateOperationalProjection:async(_tx,input)=>{writes.push(input);marker=input;},queryObjects:async()=>({items:[],total:0,lastId:null}),objectSummary:x=>x,parseUiPageRequest:()=>({filters:{},filterHash:'filters',limit:10}),stableObjectHash:()=> 'hash',jsonResponse:(x,init)=>new Response(JSON.stringify(x),init),HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}}};
globalThis.__materialProjectionRace=bridge;
const declarations='const {readBasis,workspaceReadMetadata,currentMaterialRequirementRows,projectMaterialRequirementDispositions,instanceRepository,operationalSnapshot,operationalProjectionMatches,updateOperationalProjection,queryObjects,objectSummary,parseUiPageRequest,stableObjectHash,jsonResponse,HttpError}=globalThis.__materialProjectionRace;';
const {postgresMaterialPage}=await import('data:text/javascript;base64,'+Buffer.from(declarations+transformed).toString('base64'));
delete globalThis.__materialProjectionRace;
const data={snapshotId:'same-snapshot',productionModel:{workItems:[]}};
const request=()=>new Request('http://localhost/api/v8/ui/materials');
test('an event arriving before metadata read cannot stamp stale material state as current',async()=>{
 writes=[];currentOperations={snapshotId:data.snapshotId,operationRevision:'new-event',stateProjection:{fresh:true}};
 await assert.rejects(postgresMaterialPage(request(),data,{...currentOperations,operationRevision:'old-event',stateProjection:{stale:true}},()=>{}),error=>error.status===409);
 assert.equal(writes.length,0);
});
test('snapshot drift fails closed and matching state is rebuilt under the write lock',async()=>{
 writes=[];currentOperations={snapshotId:'other-snapshot',operationRevision:'same-op',stateProjection:{}};
 await assert.rejects(postgresMaterialPage(request(),data,{...currentOperations,snapshotId:data.snapshotId},()=>{}),error=>error.status===409);assert.equal(writes.length,0);
 currentOperations={snapshotId:data.snapshotId,operationRevision:'current-op',stateProjection:{fresh:true}};
 const response=await postgresMaterialPage(request(),data,currentOperations,()=>{});assert.equal(response.status,200);
 assert.deepEqual(writes,[{releaseId:metadata.releaseId,eventSequence:metadata.eventSequence,stateProjection:currentOperations.stateProjection,operationRevision:currentOperations.operationRevision}]);
});

test('matching committed projection and conditional GET never acquire a writer or rebuild operations',async()=>{
 const before=lockCount,oldWrites=writes.length;
 const first=await postgresMaterialPage(request(),data,currentOperations,()=>{});
 const response=await postgresMaterialPage(new Request(request(),{headers:{'If-None-Match':first.headers.get('etag')}}),data,currentOperations,()=>{});
 assert.equal(response.status,304);assert.equal(lockCount,before);assert.equal(writes.length,oldWrites);
});
test('an auxiliary operation change rebuilds even without an event watermark change',async()=>{
 const before=lockCount;currentOperations={...currentOperations,operationRevision:'aux-only-change'};
 const response=await postgresMaterialPage(request(),data,currentOperations,()=>{});
 assert.equal(response.status,200);assert.equal(lockCount,before+1);assert.equal(marker.operationRevision,'aux-only-change');
});
