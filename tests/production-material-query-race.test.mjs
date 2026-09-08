import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {parseProductionMaterialQuery,queryProductionMaterialPage} from '../host/instance-runtime/production-material-query.mjs';
const source=readFileSync(new URL('../app/api/v8/ui/production-materials/route.ts',import.meta.url),'utf8');
const transformed=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;$/gm,'');
const model={workItems:[],workPackages:[],assetFamilies:[],assetVersions:[],expectedOutputs:[]};
let operationReads=0,changeAtEnd=false,snapshotMismatch=false;
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
globalThis.__productionMaterialQueryRace={parseProductionMaterialQuery,queryProductionMaterialPage,HttpError,
 reviewData:async()=>({snapshotId:'snapshot',productionModel:model}),
 operationalSnapshot:async()=>({snapshotId:snapshotMismatch?'other-snapshot':'snapshot',operationRevision:changeAtEnd&&operationReads++?'new-op':'old-op',stateProjection:{}}),
 stableObjectHash:()=> 'hash',jsonByteLength:value=>Buffer.byteLength(JSON.stringify(value)),UI_PAGE_MAX_BYTES:2*1024*1024,
 jsonResponse:(value,options)=>new Response(JSON.stringify(value),options),errorResponse:error=>new Response(JSON.stringify({error:error.message}),{status:error.status||500})};
const declarations='const {parseProductionMaterialQuery,queryProductionMaterialPage,HttpError,reviewData,operationalSnapshot,stableObjectHash,jsonByteLength,UI_PAGE_MAX_BYTES,jsonResponse,errorResponse}=globalThis.__productionMaterialQueryRace;';
const {GET}=await import('data:text/javascript;base64,'+Buffer.from(declarations+transformed).toString('base64'));
delete globalThis.__productionMaterialQueryRace;
test('process materials reject state changes while reading instead of publishing a stale page',async()=>{
 operationReads=0;changeAtEnd=true;snapshotMismatch=false;
 const response=await GET(new Request('http://localhost/api/v8/ui/production-materials'));assert.equal(response.status,409);
});
test('process materials reject a mixed business snapshot before query',async()=>{
 operationReads=0;changeAtEnd=false;snapshotMismatch=true;
 assert.equal((await GET(new Request('http://localhost/api/v8/ui/production-materials'))).status,409);
});
test('empty process view is a truthful empty list and conditional reads keep the same cache boundary',async()=>{
 operationReads=0;changeAtEnd=false;snapshotMismatch=false;
 const response=await GET(new Request('http://localhost/api/v8/ui/production-materials'));assert.equal(response.status,200);const body=await response.json();assert.equal(body.total,0);assert.deepEqual(body.entries,[]);assert.equal(body.operationRevision,'old-op');
 const cached=await GET(new Request('http://localhost/api/v8/ui/production-materials',{headers:{'If-None-Match':response.headers.get('ETag')}}));assert.equal(cached.status,304);
});
