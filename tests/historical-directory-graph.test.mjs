import test from'node:test';import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{historicalDirectoryGraph}from'../host/instance-runtime/historical-directory-graph.mjs';
const canon=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canon).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canon(x[k])).join(',')+'}',sha=x=>createHash('sha256').update(x).digest('hex'),hash=x=>sha(canon(x)),copy=x=>structuredClone(x);
const record=(revisionId,value)=>({revisionId,sha256:hash(value),bytes:Buffer.from(canon(value))});
function fixture(){
 const demand={id:'R',representationId:'REP',mediaType:'AUDIO'},rep={id:'REP',entityId:'E',stateId:null,type:'VOICE_IDENTITY',assetFamilyIds:[]};
 const old={entities:[{id:'E',name:'identity'}],states:[],requirements:[demand],representations:[rep],relations:[]},next={...copy(old),representations:[{...rep,assetFamilyIds:['FAMILY']}]},before=record('G-OLD',old),after=record('G-AFTER',next);
 const beforeBinding={requirementId:'R',entityId:'E',stateId:'DIRSTATE',representationId:'REP',requirementHash:hash({demand,representation:rep}),representationHash:hash(rep)},afterBinding={...beforeBinding,requirementHash:hash({demand,representation:next.representations[0]}),representationHash:hash(next.representations[0])};
 const beforeContent={graphRef:{revisionId:before.revisionId,sha256:before.sha256},directoryBindings:[beforeBinding]},afterContent={...copy(beforeContent),directoryBindings:[afterBinding]},directory=record('DIR-AFTER',afterContent),basis={requirementId:'R'};
 const body={schemaVersion:'MATERIAL_PRODUCTION_PLAN_V1',id:'PLAN',requirementId:'R',representationId:'REP',basis,basisHash:hash(basis),requirementBefore:{id:'R',requirementHash:beforeBinding.requirementHash,assetFamilyRefs:[]},requirementAfter:{id:'R',representationRef:'REP',requirementHash:afterBinding.requirementHash,assetFamilyRefs:['FAMILY']},graphBinding:{before:{revisionId:before.revisionId,sha256:before.sha256},after:{sha256:after.sha256},requirement:demand,representationId:'REP',beforeRepresentation:rep,afterRepresentation:next.representations[0]},directoryBinding:{requirementId:'R',before:{revisionId:'DIR-OLD',sha256:hash(beforeContent)},after:{sha256:directory.sha256},beforeBinding,afterBinding,beforeContent,afterContent}};
 const doc={...record('SOURCE',body),aliases:['story/material-production/plans/PLAN.json'],metadata:{sourceRole:'MATERIAL_PRODUCTION_PLAN'}},plan={id:'PLAN',requirementId:'R',representationId:'REP',basisHash:hash(basis),directoryRevisionId:directory.revisionId,directorySha256:directory.sha256,graphRevisionId:after.revisionId,graphSha256:after.sha256,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256,sourcePath:doc.aliases[0],familyId:'FAMILY',requirementHash:afterBinding.requirementHash};
 const graphRecords=new Map([before,after].map(r=>[r.revisionId,r])),documents=new Map([[doc.revisionId,doc]]),calls=[];
 const tx={getAux:async(ns,key,{revisionId})=>{assert.equal(ns,'domain-graph');assert.equal(key,'current');calls.push(revisionId);return graphRecords.get(revisionId)||null;},readDocumentRevision:async id=>documents.get(id)||null};
 const view={sourceRevisionIds:[doc.revisionId],snapshot:{productionModel:{materialProductionPlans:[plan],domainGraph:next,domainGraphRef:{revisionId:'G-LATEST',sha256:hash('not-a-historical-anchor')}}}};
 return{tx,view,directory,plan,doc,body,graphRecords,documents,calls,beforeGraph:old,afterGraph:next};
}
test('frozen native plan resolves unchanged directory history without borrowing current graph',async()=>{const f=fixture(),old=JSON.stringify(f.directory),r=await historicalDirectoryGraph(f.tx,f.view,f.directory);assert.deepEqual(r,f.afterGraph);assert.equal(JSON.stringify(f.directory),old);assert.deepEqual(f.calls,['G-OLD','G-AFTER']);assert.notEqual(f.view.snapshot.productionModel.domainGraphRef.revisionId,'G-AFTER');});
test('old records without a matching native plan retain their original historical graph',async()=>{const f=fixture();f.view.snapshot.productionModel.materialProductionPlans=[];assert.deepEqual(await historicalDirectoryGraph(f.tx,f.view,f.directory),f.beforeGraph);});
for(const[name,mutate]of [
 ['missing source',f=>f.documents.clear()],
 ['unpublished source',f=>f.view.sourceRevisionIds=[]],
 ['duplicate exact directory plan',f=>f.view.snapshot.productionModel.materialProductionPlans.push(copy(f.plan))],
 ['wrong directory SHA',f=>f.plan.directorySha256=hash('wrong')],
 ['wrong source SHA',f=>f.plan.sourceSha256=hash('wrong')],
 ['wrong source bytes',f=>f.doc.bytes=Buffer.from('{}')],
 ['wrong document role',f=>f.doc.metadata.sourceRole='DRAFT'],
 ['wrong source alias',f=>f.doc.aliases=[]],
 ['missing before graph',f=>f.graphRecords.delete('G-OLD')],
 ['missing after graph',f=>f.graphRecords.delete('G-AFTER')],
 ['bad after graph bytes',f=>f.graphRecords.get('G-AFTER').bytes=Buffer.from('{}')],
 ['wrong plan graph revision',f=>f.plan.graphRevisionId='G-LATEST'],
 ])test(name+' fails closed without current-graph fallback',async()=>{const f=fixture();mutate(f);assert.equal(await historicalDirectoryGraph(f.tx,f.view,f.directory),null);assert(!f.calls.includes('G-LATEST')||name==='wrong plan graph revision');});
test('rehashing a plan cannot hide an unrelated graph edit',async()=>{const f=fixture(),g=copy(f.afterGraph);g.entities[0].name='unrelated';const after=record('G-AFTER',g);f.graphRecords.set('G-AFTER',after);f.plan.graphSha256=after.sha256;f.body.graphBinding.after.sha256=after.sha256;Object.assign(f.doc,record('SOURCE',f.body));f.plan.sourceSha256=f.doc.sha256;assert.equal(await historicalDirectoryGraph(f.tx,f.view,f.directory),null);});
test('later current definition change stays distinguishable from frozen historical graph',async()=>{const f=fixture();f.view.snapshot.productionModel.domainGraph.entities[0].name='new-author-state';const historical=await historicalDirectoryGraph(f.tx,f.view,f.directory);assert.equal(historical.entities[0].name,'identity');assert.notDeepEqual(historical,f.view.snapshot.productionModel.domainGraph);});
test('transport failure propagates instead of becoming a success or current fallback',async()=>{const f=fixture();f.tx.readDocumentRevision=async()=>{throw Object.assign(Error('transport-down'),{code:'IO'});};await assert.rejects(historicalDirectoryGraph(f.tx,f.view,f.directory),{code:'IO'});});
