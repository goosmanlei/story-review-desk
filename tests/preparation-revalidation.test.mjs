import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {readProductionPreparation,saveProductionPreparation,savePreparationMaterialLinks,previewProductionPreparationRevalidation,applyProductionPreparationRevalidation} from '../host/instance-runtime/production-preparation.mjs';

const copy=structuredClone,hash=value=>sha256(canonicalJson(value));
async function fixture(){
 const heads=new Map(),history=new Map();let sequence=0;
 const scenes=['A','B','C','D'].map((id,index)=>{const scriptBlocks=[{id:id+'-B001',type:'dialogue',speaker:'甲',performanceNote:'',text:'正文'+id}];return {id,displayId:'S0'+(index+1),title:id,scriptBlocks,contentHash:hash(scriptBlocks),sourceSegmentIds:[],purpose:'作用'+id};});
 const episodes=scenes.map((s,index)=>({episodeUid:'EP-'+s.id,displayId:'E0'+(index+1),title:s.id,sceneIds:[s.id],openingHook:'开场',coreAdvance:'推进',endingCliffhanger:'结尾',reviewQuestion:'问题',reviewDossier:{purpose:'任务'+s.id}}));
 const candidate={creativeRevisionId:'CANDIDATE-1',subjectKind:'EPISODE_PLAN',subjectId:'PLAN',eventSequence:1,content:{planId:'PLAN',episodes,narrativeRevision:{scenes,causalChains:[],sourceNarrationIndex:[]}}};candidate.contentHash=hash(candidate.content);
 const graph={schemaVersion:'1.0',entities:[{id:'E',name:'人物',type:'CHARACTER'}],states:[{id:'STATE',entityId:'E',label:'常态'}],representations:['R1','R2'].map(id=>({id:'REP-'+id,entityId:'E',stateId:'STATE',requirementIds:[id]})),relations:[],requirements:[]};
 const requirements=['R1','R2'].map(id=>({id,requirementClass:'REQUIRED',requirementHash:hash(id),assetFamilyRefs:[]}));
 const view={releaseId:'RELEASE-1',profile:{episodePlanId:'PLAN'},snapshot:{snapshotId:'SNAPSHOT',instance:{episodePlanId:'PLAN'},productionModel:{materialRequirements:requirements}},eventsByKind:{'creative-revision':[candidate]}};
 const tx={readView:async()=>copy(view),listAux:async ns=>[...heads.values()].filter(r=>r.namespace===ns),getAux:async(ns,key,options={})=>options.revisionId?history.get(options.revisionId)||null:heads.get(ns+'/'+key)||null,putAux:async({namespace,key,bytes,expectedRevisionId})=>{
  assert.equal(heads.get(namespace+'/'+key)?.revisionId||null,expectedRevisionId);
  const row={namespace,key,revisionId:'AUX-'+(++sequence),sha256:sha256(bytes),bytes:Buffer.from(bytes)};heads.set(namespace+'/'+key,row);history.set(row.revisionId,row);return row;
 }};
 const put=async(ns,value)=>{const old=await tx.getAux(ns,'current');return tx.putAux({namespace:ns,key:'current',bytes:canonicalJson(value),expectedRevisionId:old?.revisionId||null});};
 const g=await put('domain-graph',graph);view.snapshot.productionModel.domainGraphRef={revisionId:g.revisionId,sha256:g.sha256};
 const directory={baseReleaseId:view.releaseId,graphRef:copy(view.snapshot.productionModel.domainGraphRef),directoryBindings:requirements.map(r=>({requirementId:r.id,requirementHash:r.requirementHash,representationId:'REP-'+r.id,representationHash:hash(graph.representations.find(row=>row.id==='REP-'+r.id)),entityId:'E',stateId:'STATE'}))};
 await put('material-directory',directory);
 const preparation={title:'制作准备',basis:{candidateRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash},episodes:episodes.map(({episodeUid,displayId,title,sceneIds})=>({episodeUid,displayId,title,sceneIds})),scenes:scenes.map((s,i)=>({sceneId:s.id,displayId:s.displayId,episodeUid:episodes[i].episodeUid,sceneContentHash:s.contentHash,preparation:{sceneRole:'作用',audienceTakeaway:'所得',visualIntent:'画面',soundAndDialogueIntent:'对白',reviewFocus:'关注',beats:[{order:1,actionIntent:'动作'}],sourceDialogue:[{scriptBlockId:s.id+'-B001',speaker:'甲',text:'正文'+s.id}],generationAuthorized:false,formalShotIds:[]}}))};
 await saveProductionPreparation(tx,{requestId:'seed',expectedReleaseId:view.releaseId,expectedRevisionId:null,content:preparation});
 await savePreparationMaterialLinks(tx,{expectedReleaseId:view.releaseId,expectedRevisionId:null,content:{basis:copy(preparation.basis),scenes:scenes.map((s,i)=>({sceneId:s.id,episodeUid:episodes[i].episodeUid,sceneContentHash:s.contentHash,references:requirements.map(r=>({requirementId:r.id,requirementHash:r.requirementHash,reason:'本场所需',matchKind:'EXPLICIT'})),unboundNeeds:['空间待核']}))}});
 const manifest=async()=>{const s=await readProductionPreparation(tx);return {requestId:'revalidate-001',expectedReleaseId:s.releaseId,expectedRevisionId:s.revisionId,expectedLinksRevisionId:s.materialLinksRevisionId,expectedDirectoryRevisionId:s.directoryRevisionId,candidateRevisionId:s.candidate.revisionId,candidateContentHash:s.candidate.contentHash,sceneUpdates:[],materialUpdates:[]};};
 const changeCandidate=mutate=>{const c=copy(view.eventsByKind['creative-revision'].at(-1));c.creativeRevisionId='CANDIDATE-'+(view.eventsByKind['creative-revision'].length+1);c.eventSequence++;mutate(c.content);c.contentHash=hash(c.content);view.eventsByKind['creative-revision'].push(c);return c;};
 return {tx,view,heads,history,put,graph,directory,requirements,candidate,changeCandidate,manifest};
}
test('unrelated candidate changes preserve exact occurrences; a source change affects its local closure',async()=>{
 const f=await fixture();f.changeCandidate(p=>{p.changeSummary='其他说明';});const before=f.history.size;
 let s=await readProductionPreparation(f.tx);assert.equal(s.stale,true);assert.equal(s.materialLinks.projectionPolicy,'PER_OCCURRENCE_V2');assert.equal(s.materialLinks.scenes.length,4);assert.equal(s.materialLinks.pending.length,0);assert.equal(f.history.size,before);
 f.changeCandidate(p=>{const scene=p.narrativeRevision.scenes[3];scene.scriptBlocks[0].text='新正文';scene.contentHash=hash(scene.scriptBlocks);});
 s=await readProductionPreparation(f.tx);assert.deepEqual(s.materialLinks.scenes.map(r=>r.sceneId),['A','B']);assert.deepEqual(s.sceneValidity.filter(r=>!r.valid).map(r=>r.sceneId),['C','D']);
});
test('changing one requirement excludes that reference without losing the other reference in each scene',async()=>{
 const f=await fixture();f.view.snapshot.productionModel.materialRequirements[0].requirementHash=hash('changed');
 const s=await readProductionPreparation(f.tx);assert.equal(s.materialLinks.scenes.length,4);for(const row of s.materialLinks.scenes)assert.deepEqual(row.references.map(r=>r.requirementId),['R2']);assert.equal(s.materialLinks.pending.length,4);
});
test('unrelated directory revisions and another scene author edit do not wipe valid usage',async()=>{
 const f=await fixture();await f.put('material-directory',{...f.directory,newEntities:[{id:'UNRELATED',type:'PROP',name:'其他'}]});
 let s=await readProductionPreparation(f.tx);assert.equal(s.materialLinks.pending.length,0);assert.equal(s.materialLinks.scenes.length,4);
 const edited=copy(s.content);edited.scenes[3].preparation.visualIntent='调整本场画面';
 await saveProductionPreparation(f.tx,{requestId:'edit',expectedReleaseId:s.releaseId,expectedRevisionId:s.revisionId,content:edited});
 s=await readProductionPreparation(f.tx);assert.deepEqual(s.materialLinks.scenes.map(r=>r.sceneId),['A','B','C']);
});
test('exact revalidation appends both records with provenance; ordinary save still cannot rebind and preview is read-only',async()=>{
 const f=await fixture();f.changeCandidate(p=>{p.changeSummary='说明变化';});const input=await f.manifest(),before=f.history.size;
 const preview=await previewProductionPreparationRevalidation(f.tx,input);assert.equal(preview.ready,true);assert.equal(preview.carriedSceneIds.length,4);assert.equal(f.history.size,before);
 const old=await readProductionPreparation(f.tx);await assert.rejects(saveProductionPreparation(f.tx,{requestId:'forged',expectedReleaseId:old.releaseId,expectedRevisionId:old.revisionId,content:{...old.content,basis:{candidateRevisionId:input.candidateRevisionId,candidateContentHash:input.candidateContentHash}}}),{code:'DOMAIN_CONFLICT'});
 const applied=await applyProductionPreparationRevalidation(f.tx,{...input,previewHash:preview.previewHash});
 const s=await readProductionPreparation(f.tx);assert.equal(s.stale,false);assert.equal(s.materialLinks.pending.length,0);assert.equal(s.content.scenes[0].revalidation.mode,'EXACT_INPUT_CARRY');assert.ok(f.history.has(old.revisionId));assert.equal(applied.formalAdoptionPerformed,false);
 assert.deepEqual(await applyProductionPreparationRevalidation(f.tx,{...input,previewHash:preview.previewHash}),applied);
 const edit=copy(s.content);edit.scenes[0].preparation.visualIntent='后续作者编辑';
 await saveProductionPreparation(f.tx,{requestId:'later',expectedReleaseId:s.releaseId,expectedRevisionId:s.revisionId,content:edit});assert.equal((await readProductionPreparation(f.tx)).content.schemaVersion,'1.1');
});
test('changed inputs require explicit scene and material review; source dialogue is rebuilt from exact candidate',async()=>{
 const f=await fixture();f.changeCandidate(p=>{const s=p.narrativeRevision.scenes[3];s.scriptBlocks[0].text='当前新台词';s.contentHash=hash(s.scriptBlocks);});
 const input=await f.manifest(),p=await previewProductionPreparationRevalidation(f.tx,input);assert.equal(p.ready,false);assert.deepEqual(p.requiredSceneIds,['C','D']);const before=f.history.size;
 await assert.rejects(applyProductionPreparationRevalidation(f.tx,{...input,previewHash:p.previewHash}),{code:'DOMAIN_CONFLICT'});assert.equal(f.history.size,before);
 const state=await readProductionPreparation(f.tx),rawLinks=JSON.parse(Buffer.from((await f.tx.getAux('preparation-material-links','current')).bytes).toString());
 for(const id of p.requiredSceneIds){const local=p.sceneInputs.find(s=>s.sceneId===id),old=state.content.scenes.find(s=>s.sceneId===id);input.sceneUpdates.push({sceneId:id,expectedInputHash:local.inputHash,reason:'已对当前正文和承接逐项重核',preparation:{...old.preparation,sourceDialogue:[{text:'客户端不可伪造来源'}]}});const link=rawLinks.scenes.find(s=>s.sceneId===id);input.materialUpdates.push({sceneId:id,expectedInputHash:local.inputHash,reason:'核对当前场全部素材和缺项',references:link.references,unboundNeeds:link.unboundNeeds});}
 const reviewed=await previewProductionPreparationRevalidation(f.tx,input);assert.equal(reviewed.ready,true);await applyProductionPreparationRevalidation(f.tx,{...input,previewHash:reviewed.previewHash});
 const s=await readProductionPreparation(f.tx);assert.equal(s.materialLinks.pending.length,0);assert.equal(s.content.scenes[3].preparation.sourceDialogue[0].text,'当前新台词');assert.equal(s.content.scenes[3].preparation.generationAuthorized,false);
});
test('candidate races, directory races, tampered preview and generated facts fail closed',async()=>{
 const f=await fixture(),input=await f.manifest(),preview=await previewProductionPreparationRevalidation(f.tx,input),before=f.history.size;
 await assert.rejects(applyProductionPreparationRevalidation(f.tx,{...input,previewHash:'bad'}),{code:'DOMAIN_CONFLICT'});assert.equal(f.history.size,before);
 const invalid=copy(input);invalid.sceneUpdates=[{sceneId:'A',expectedInputHash:preview.sceneInputs[0].inputHash,reason:'重核',preparation:{generationAuthorized:true}}];await assert.rejects(previewProductionPreparationRevalidation(f.tx,invalid),{code:'DOMAIN_INVALID'});
 f.changeCandidate(p=>{p.episodes[0].title='新标题';});await assert.rejects(applyProductionPreparationRevalidation(f.tx,{...input,previewHash:preview.previewHash}),{code:'DOMAIN_CONFLICT'});
 const fresh=await f.manifest(),freshPreview=await previewProductionPreparationRevalidation(f.tx,fresh);await f.put('material-directory',{...f.directory,note:'new'});await assert.rejects(applyProductionPreparationRevalidation(f.tx,{...fresh,previewHash:freshPreview.previewHash}),{code:'DOMAIN_CONFLICT'});
});
test('missing historical preparation evidence and obsolete display IDs never become current usage',async()=>{
 const f=await fixture(),row=await f.tx.getAux('preparation-material-links','current'),links=JSON.parse(Buffer.from(row.bytes).toString());links.scenes[0].sceneId='S01';await f.put('preparation-material-links',links);
 let s=await readProductionPreparation(f.tx);assert.deepEqual(s.materialLinks.scenes.map(r=>r.sceneId),['B','C','D']);
 const frozen=links.preparationBinding.revisionId;f.history.delete(frozen);f.heads.delete('production-preparation/current');
 s=await readProductionPreparation(f.tx);assert.equal(s.materialLinks.scenes.length,0);
});
