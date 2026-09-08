import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {projectProductionSpatialSource,prepareSpatialShotView,assertSpatialShotView,spatialShotViewProjection,applyProductionSpatialProjection,preserveProductionSpatialProjection} from '../host/instance-runtime/spatial-production.mjs';
import {productionSpaceReasons} from '../host/instance-runtime/shot-production-space.mjs';

const copy=structuredClone,hash=v=>sha256(canonicalJson(v)),sceneA='scene-current-a',sceneB='scene-current-b';
const document=(alias,revisionId,content)=>{const bytes=Buffer.from(canonicalJson(content));return {documentId:'document:'+alias,aliases:[alias],revisionId,sha256:sha256(bytes),bytes,metadata:{sourceRole:alias.startsWith('story/spatial-views/')?'SPATIAL_SHOT_VIEW':'MACHINE_MODEL_SOURCE'},deleted:false};};
function fixture(){
  const spec={version:'1.3',orientation:'北上东右',locations:[{id:'LOC-10',name:'家',entrance:'东院门'},{id:'LOC-11',name:'荒地枯树／荒沟'},{id:'ROOM-B',name:'另一地点'}],minimal_location_packages:{'ROOM-B':{name:'另一地点',fact_boundary:'另一独立地点',lock_boundary:'南门',zones:[{id:'B-ZONE'}],cameras:[{id:'B-CAM',zoneId:'B-ZONE'}]}},masan:{anchors:{coordinate_system:'东门为原点，东+x北+y',tree_m:[18,-10],gully_m:[4,-24]},east_gate_lock:'东院门向内西开',zones:['MS-Z01','MS-Z02','MS-Z03','MS-Z04','MS-Z05'].map(id=>({id,name:id})),cameras:[{id:'MS-CAM-01',from:'院外东侧',looks:'西'},{id:'MS-CAM-02',from:'荒地东南上方',looks:'西北'},{id:'MS-CAM-03',from:'枯树东北上方',looks:'西南'},{id:'MS-CAM-04',from:'前屋南门槛内',looks:'北'},{id:'MS-CAM-05',from:'柴房南门槛内',looks:'北'}]}};
  const base=document('data/production_map_spec.json','base-r1',spec);
  const model={sourceHashes:{productionMapSha256:base.sha256},spatialEvidence:projectProductionSpatialSource(spec,{sourceRef:base.aliases[0],sourceRevisionId:base.revisionId,sourceSha256:base.sha256}),spatialShotViews:[],episodeNarrativeReleases:[sceneA,sceneB].map((scene,i)=>({id:'release-'+i,episodeUid:'episode-'+i,scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',reviewInput:{scenes:[{id:scene,contentHash:hash(scene)}]}})),sceneScriptRevisions:[sceneA,sceneB].map((scene,i)=>({id:'script-'+i,sceneId:scene,scopeRole:'CURRENT',episodeNarrativeReleaseId:'release-'+i,contentHash:hash(scene)})),shots:[sceneA,sceneB].map(scene=>({id:scene+'-shot',sceneId:scene,scopeRole:'CURRENT',activeInCurrentProduction:true})),domainGraph:{entities:[{id:'LOC-10',type:'LOCATION'}],states:[{id:'room-state',entityId:'LOC-10',authority:'A'}],representations:[{id:'room-rep',entityId:'LOC-10',stateId:'room-state'}]},materialRequirements:[{id:'room-requirement',requirementClass:'REQUIRED',representationRef:'room-rep',assetFamilyRefs:['room-image']}]};
  const author={viewId:'view-a',sceneId:sceneA,locationId:'LOC-10',zoneId:'MS-Z02',camera:{origin:'NORTHEAST_INTERIOR',looks:'SOUTHWEST',height:'EYE_LEVEL',purpose:'门、门西卧处与门东碗架的视线'},dressing:[{id:'cold-bed',kind:'BED',anchor:{kind:'CAMERA',id:'MS-CAM-04'},relation:'WEST_OF',orientation:'EAST_WEST',appearance:'独立短榻与旧被，不替换木箱'},{id:'cold-bowl-rack',kind:'BOWL_RACK',anchor:{kind:'CAMERA',id:'MS-CAM-04'},relation:'EAST_OF',orientation:'NONE',appearance:'两层木碗架，上层为空'}],note:'新增未展示区域的家具，保留原门窗及全部固定几何'};
  const documents=[base],modelBefore=copy(model);
  const stage=(content=author)=>{
    const body=prepareSpatialShotView(model,content),source=document('story/spatial-views/'+body.id+'.json','view-source-'+documents.length,body),row=spatialShotViewProjection(body,{sourceRef:source.aliases[0],sourceRevisionId:source.revisionId,sourceSha256:source.sha256});
    model.spatialShotViews=model.spatialShotViews.map(r=>r.viewId===row.viewId?{...r,scopeRole:'EVIDENCE_ONLY'}:r).concat(row);documents.push(source);return row;
  };
  const view=()=>({sourceRevisionIds:documents.map(d=>d.revisionId),snapshot:{sourceHashes:copy(model.sourceHashes),productionModel:copy(model),creativeLineage:{spatialEvidence:copy(model.spatialEvidence)}}});
  const tx={readView:async()=>view(),getPublishedDocument:async alias=>documents.find(d=>d.aliases.includes(alias)),readDocumentRevision:async id=>documents.find(d=>d.revisionId===id)};
  const settings=row=>({shotId:row.content.sceneBinding.sceneId+'-shot',space:{loc:'LOC-10',state:'room-state',zone:'MS-Z02',camera:row.content.camera.id,freeze:row.id},inputs:[{requirementId:'room-requirement',familyId:'room-image',versionId:'room-image@1',sha256:hash('pixels')}]});
  return {spec,base,model,modelBefore,author,documents,stage,view,tx,settings};
}

test('published core projection preserves exact source bytes and separates house, tree and shared overview',()=>{
  const f=fixture(),before=canonicalJson(f.spec),e=f.model.spatialEvidence;
  const house=e.locationPackages.find(p=>p.id==='LOC-10'),tree=e.locationPackages.find(p=>p.id==='LOC-11');
  assert.deepEqual(house.zones.map(z=>z.id),['MS-Z01','MS-Z02','MS-Z03']);assert.deepEqual(tree.zones.map(z=>z.id),['MS-Z04','MS-Z05']);
  assert(!house.cameras.some(c=>c.id==='MS-CAM-03'));assert(!tree.cameras.some(c=>c.id==='MS-CAM-04'));
  assert.deepEqual(house.cameras.find(c=>c.id==='MS-CAM-02').relatedLocationIds,['LOC-10','LOC-11']);
  assert.deepEqual(house.cameras.find(c=>c.id==='MS-CAM-04').zoneIds,['MS-Z02']);
  assert.equal(house.cameras.find(c=>c.id==='MS-CAM-04').looks,'北');assert.equal(canonicalJson(f.spec),before);
  assert.equal(e.sourceRevisionId,f.base.revisionId);assert.equal(e.sourceSha256,f.base.sha256);
});

test('core projection fails closed on duplicate IDs, missing declared cameras and competing packages',()=>{
  const f=fixture();for(const mutate of [s=>s.locations.push(copy(s.locations[0])),s=>s.masan.cameras.pop(),s=>s.minimal_location_packages['LOC-10']={zones:[],cameras:[]}]){const spec=copy(f.spec);mutate(spec);assert.throws(()=>projectProductionSpatialSource(spec,{sourceRef:f.base.aliases[0],sourceRevisionId:f.base.revisionId,sourceSha256:f.base.sha256}));}
});

test('new view freezes source and current permanent scene while requiring explicit adopted room-state input',async()=>{
  const f=fixture(),row=f.stage(),before=canonicalJson(f.base);
  assertSpatialShotView(row.content);assert.equal(row.content.camera.looks,'SOUTHWEST');assert.notEqual(row.content.camera.id,'MS-CAM-04');assert.equal(row.content.base.sourceRevisionId,f.base.revisionId);
  assert.deepEqual(productionSpaceReasons(f.model,f.settings(row)).map(r=>r.split(':')[0]),['SPACE_LOCAL_VIEW_INVALID'],'unverified source labels cannot authorize a freeze');
  const loaded=await applyProductionSpatialProjection(f.tx,f.model,{view:f.view()});assert.deepEqual(productionSpaceReasons(loaded,f.settings(row)),[]);
  assert.deepEqual(productionSpaceReasons(loaded,{...f.settings(row),inputs:[]}),['SPACE_STATE_NOT_BOUND_TO_ADOPTED_INPUT']);
  const foreign=copy(loaded);foreign.domainGraph.states[0].entityId='LOC-11';foreign.domainGraph.entities.push({id:'LOC-11',type:'LOCATION'});foreign.domainGraph.representations[0].entityId='LOC-11';
  assert.deepEqual(productionSpaceReasons(foreign,f.settings(row)),['SPACE_STATE_NOT_BOUND_TO_ADOPTED_INPUT'],'an adopted tree state cannot satisfy a house view');
  assert.equal(canonicalJson(f.base),before);assert.deepEqual(f.modelBefore.spatialShotViews,[]);
});

test('a scoped local view cannot bind another scene, stale script, wrong camera, house/tree zone or missing source proof',async()=>{
  const f=fixture(),row=f.stage(),loaded=await applyProductionSpatialProjection(f.tx,f.model,{view:f.view()});
  const cases=[(m,s)=>s.shotId=sceneB+'-shot',(m,s)=>s.space.camera='MS-CAM-04',(m,s)=>s.space.zone='MS-Z04',m=>m.sceneScriptRevisions[0].contentHash=hash('new script'),m=>m.episodeNarrativeReleases[0].sourceSyncState='STALE',m=>delete m.spatialShotViewProofs[row.id]];
  for(const mutate of cases){const m=copy(loaded),s=f.settings(row);mutate(m,s);assert(productionSpaceReasons(m,s).some(r=>r.startsWith('SPACE_LOCAL_VIEW_INVALID')));}
});

test('strict author fields cannot overwrite doors, windows, old cameras or source bindings',()=>{
  const f=fixture();for(const mutate of [a=>a.camera.id='MS-CAM-04',a=>a.base={sourceSha256:f.base.sha256},a=>a.dressing[0].kind='DOOR',a=>a.dressing[0].kind='WINDOW',a=>a.dressing[0].operation='REPLACE',a=>a.dressing[0].id='MS-CAM-04',a=>a.dressing[0].anchor.id='MS-CAM-03',a=>a.zoneId='MS-Z04',a=>a.sceneId='S21']){const a=copy(f.author);mutate(a);assert.throws(()=>prepareSpatialShotView(f.model,a));}
  f.stage();const moved={...copy(f.author),sceneId:sceneB};assert.throws(()=>prepareSpatialShotView(f.model,moved),/永久身份不能换绑/);
});

test('local revision invalidates only its exact consumers; another scene view and legacy base freeze remain valid',async()=>{
  const f=fixture(),a=f.stage(),b=f.stage({...copy(f.author),viewId:'view-b',sceneId:sceneB});
  const initial=await applyProductionSpatialProjection(f.tx,f.model,{view:f.view()}),globalHash=initial.spatialEvidence.sourceSha256;
  assert.deepEqual(productionSpaceReasons(initial,f.settings(a)),[]);assert.deepEqual(productionSpaceReasons(initial,f.settings(b)),[]);
  const a2=f.stage({...copy(f.author),note:'改进本场空架顶部的摆放空间'}),loaded=await applyProductionSpatialProjection(f.tx,f.model,{view:f.view()});
  assert.deepEqual(productionSpaceReasons(loaded,f.settings(a)),['SPACE_LOCAL_VIEW_NOT_CURRENT']);assert.deepEqual(productionSpaceReasons(loaded,f.settings(a2)),[]);assert.deepEqual(productionSpaceReasons(loaded,f.settings(b)),[]);
  assert.equal(loaded.spatialEvidence.sourceSha256,globalHash);assert.equal(f.documents.filter(d=>d.aliases.includes('data/production_map_spec.json')).length,1);
  const legacy=f.settings(b);legacy.space.camera='MS-CAM-04';legacy.space.freeze=globalHash;assert.deepEqual(productionSpaceReasons(loaded,legacy),[]);
  legacy.space.camera='MS-CAM-03';assert.deepEqual(productionSpaceReasons(loaded,legacy),['SPACE_COORDINATES_NOT_IN_LOCATION']);
});

test('unrelated map changes preserve a local geometry slice, but changing its actual anchor invalidates it',async()=>{
  const f=fixture(),row=f.stage(),sourceBefore=copy(f.base),spec=copy(f.spec);spec.locations.find(l=>l.id==='ROOM-B').name='另一场地点更名';
  let changed=document(f.base.aliases[0],'base-r2',spec);f.documents[0]=changed;
  f.model.sourceHashes.productionMapSha256=changed.sha256;f.tx.readDocumentRevision=async id=>id===sourceBefore.revisionId?sourceBefore:f.documents.find(d=>d.revisionId===id);
  let loaded=await applyProductionSpatialProjection(f.tx,f.model,{view:f.view()});assert.deepEqual(productionSpaceReasons(loaded,f.settings(row)),[]);
  spec.masan.cameras.find(c=>c.id==='MS-CAM-04').from='实际被修改的门槛锚点';changed=document(f.base.aliases[0],'base-r3',spec);f.documents[0]=changed;f.model.sourceHashes.productionMapSha256=changed.sha256;
  loaded=await applyProductionSpatialProjection(f.tx,f.model,{view:f.view()});assert(productionSpaceReasons(loaded,f.settings(row)).some(r=>r.includes('局部几何依据已变化')));
});

for(const fault of ['missing','deleted','storedSha','actualBytes','revision','alias','content'])test(`exact source read rejects ${fault} even for retained historical view revisions`,async()=>{
  const f=fixture(),old=f.stage();f.stage({...copy(f.author),note:'第二个不可变空间版本'});
  const read=f.tx.readDocumentRevision;f.tx.readDocumentRevision=async id=>{const d=await read(id);if(id!==old.sourceRevisionId)return d;return fault==='missing'?null:fault==='deleted'?{...d,deleted:true}:fault==='storedSha'?{...d,sha256:'0'.repeat(64)}:fault==='actualBytes'?{...d,bytes:Buffer.from('tampered')}:fault==='revision'?{...d,revisionId:'wrong-revision'}:fault==='alias'?{...d,aliases:['story/elsewhere.json']}:{...d,bytes:Buffer.from(canonicalJson({...old.content,note:'forged'}))};};
  await assert.rejects(applyProductionSpatialProjection(f.tx,f.model,{view:f.view()}));
});

test('source recompilation retains all immutable view revisions and original source proof; missing closure fails closed',async()=>{
  const f=fixture(),old=f.stage();f.stage({...copy(f.author),note:'当前修订'});
  const original=copy(f.view().snapshot),snapshot=copy(original);snapshot.productionModel.spatialShotViews=[];snapshot.creativeLineage.spatialEvidence.locationPackages=[];
  const result=await preserveProductionSpatialProjection({snapshot,baseSnapshot:original,documents:f.documents});
  assert.deepEqual(result.productionModel.spatialShotViews,original.productionModel.spatialShotViews);assert(result.creativeLineage.spatialEvidence.locationPackages.some(p=>p.id==='LOC-10'));
  assert.deepEqual(original,f.view().snapshot,'prior snapshots are never edited');
  await assert.rejects(preserveProductionSpatialProjection({snapshot,baseSnapshot:original,documents:f.documents.filter(d=>d.revisionId!==old.sourceRevisionId)}),/丢失空间局部视图源/);
  const tampered=copy(f.documents);tampered.find(d=>d.revisionId===old.sourceRevisionId).sha256='0'.repeat(64);await assert.rejects(preserveProductionSpatialProjection({snapshot,baseSnapshot:original,documents:tampered}),/精确回读/);
});

test('unsupported or unpublished parent-scene identity cannot author a scoped camera',()=>{
  const f=fixture();for(const mutate of [m=>m.sceneScriptRevisions.push(copy(m.sceneScriptRevisions[0])),m=>m.episodeNarrativeReleases[0].scopeRole='EVIDENCE_ONLY',m=>m.episodeNarrativeReleases[0].reviewInput.scenes[0].contentHash=hash('other')]){const m=copy(f.model);mutate(m);assert.throws(()=>prepareSpatialShotView(m,f.author));}
});
