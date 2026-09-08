import {canonicalJson,sha256} from './bytes.mjs';
import {spatialLogicalPath} from './domain-spatial.mjs';

const hash=value=>sha256(canonicalJson(value));
const clone=value=>structuredClone(value);
const list=value=>Array.isArray(value)?value:[];
const fail=message=>{throw Object.assign(new Error(message),{code:'SPATIAL_CONFLICT'});};
const check=(condition,message)=>{if(!condition)fail(message);};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,199}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=(value,max=2000)=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
const fields=(value,allowed,label)=>check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k)),label+'字段无效');
const unique=(values,label)=>check(new Set(values).size===values.length,label+'身份重复');
export const SPATIAL_SHOT_VIEW_SCHEMA='SPATIAL_SHOT_VIEW_V1';
export const spatialCameraOrigins=['NORTH_INTERIOR','NORTHEAST_INTERIOR','EAST_INTERIOR','SOUTHEAST_INTERIOR','SOUTH_INTERIOR','SOUTHWEST_INTERIOR','WEST_INTERIOR','NORTHWEST_INTERIOR','CENTER_INTERIOR'];
export const spatialCameraDirections=['NORTH','NORTHEAST','EAST','SOUTHEAST','SOUTH','SOUTHWEST','WEST','NORTHWEST'];
export const spatialDressingKinds=['BED','BOWL_RACK','TABLE','CHAIR','SHELF','BENCH','CONTAINER'];

/** An adapter for the explicitly named legacy sections, not a scene-number map.
 * Shared overview cameras declare their entire view rather than moving a camera
 * from the tree into the house or from one shop into the other. */
export function projectProductionSpatialSource(spec,binding,previous={}) {
  check(spec&&typeof spec==='object'&&Array.isArray(spec.locations),'空间源缺少地点清单');
  check(binding?.sourceRef===spatialLogicalPath&&id(binding.sourceRevisionId)&&digest(binding.sourceSha256),'空间源冻结三元组无效');
  unique(spec.locations.map(r=>r.id),'空间地点');
  const packages=[];
  for(const [locationId,pack] of Object.entries(spec.minimal_location_packages||{}))packages.push({id:locationId,name:pack.name,factBoundary:pack.fact_boundary,lockBoundary:pack.lock_boundary,zones:clone(list(pack.zones)),cameras:clone(list(pack.cameras)),fixedGeometry:{fact_boundary:pack.fact_boundary||'',lock_boundary:pack.lock_boundary||''},sourcePointer:'/minimal_location_packages/'+locationId});
  const add=(locationId,sectionName,zoneIds,cameraBindings,fixedGeometry)=>{
    const section=spec[sectionName];if(!section)return;
    const location=spec.locations.find(l=>l.id===locationId);check(location,'核心空间主体未登记：'+locationId);
    check(!packages.some(p=>p.id===locationId),'核心空间不能与最小空间包重复：'+locationId);
    const zones=zoneIds.map(zoneId=>{const matches=list(section.zones).filter(z=>z.id===zoneId);check(matches.length===1,'核心空间区域不能精确读回：'+zoneId);return clone(matches[0]);});
    const cameras=cameraBindings.map(([cameraId,allowedZoneIds,relatedLocationIds])=>{
      const matches=list(section.cameras).filter(c=>c.id===cameraId);check(matches.length===1,'核心空间机位不能精确读回：'+cameraId);
      check(allowedZoneIds.every(z=>zoneIds.includes(z)),'相机视域不属于声明地点');
      return {...clone(matches[0]),zoneIds:allowedZoneIds,...(allowedZoneIds.length===1?{zoneId:allowedZoneIds[0]}:{}),...(relatedLocationIds?{relatedLocationIds}:{}),sourcePointer:'/'+sectionName+'/cameras/'+list(section.cameras).findIndex(c=>c.id===cameraId)};
    });
    packages.push({id:locationId,name:location.name,factBoundary:location.fact||'',lockBoundary:location.lock||'',zones,cameras,fixedGeometry:clone(fixedGeometry),sourcePointer:'/'+sectionName});
  };
  if(spec.tower){const zs=list(spec.tower.zones).map(z=>z.id);add('LOC-01','tower',zs,list(spec.tower.cameras).map(c=>[c.id,zs]),{bounds_m:spec.tower.bounds_m,envelope_lock:spec.tower.envelope_lock,zoneGeometry:spec.tower.zones});}
  if(spec.shops){
    const shared=[['HX-CAM-01',['HX-Z01','HX-Z02'],['LOC-02','LOC-03']],['HX-CAM-02',['HX-Z01','HX-Z02'],['LOC-02','LOC-03']]];
    add('LOC-02','shops',['HX-Z01','HX-Z02','HX-Z03','HX-Z04'],[...shared,['HX-CAM-04',['HX-Z02','HX-Z03']],['HX-CAM-05',['HX-Z04']] ],{coordinate_system:spec.shops.key_jar_anchors?.coordinate_system});
    add('LOC-03','shops',['HX-Z01','HX-Z05','HX-Z06','HX-Z07'],[['HX-CAM-01',['HX-Z01','HX-Z05','HX-Z06'],['LOC-02','LOC-03']],['HX-CAM-02',['HX-Z01','HX-Z05','HX-Z06'],['LOC-02','LOC-03']],['HX-CAM-03',['HX-Z07']],['HX-CAM-06',['HX-Z05','HX-Z07']]],{key_jar_anchors:spec.shops.key_jar_anchors});
  }
  if(spec.masan){
    add('LOC-10','masan',['MS-Z01','MS-Z02','MS-Z03'],[['MS-CAM-01',['MS-Z01']],['MS-CAM-02',['MS-Z01'],['LOC-10','LOC-11']],['MS-CAM-04',['MS-Z02']],['MS-CAM-05',['MS-Z03']]],{coordinate_system:spec.masan.anchors?.coordinate_system,east_gate_lock:spec.masan.east_gate_lock});
    add('LOC-11','masan',['MS-Z04','MS-Z05'],[['MS-CAM-02',['MS-Z04','MS-Z05'],['LOC-10','LOC-11']],['MS-CAM-03',['MS-Z04','MS-Z05']]],{anchors:spec.masan.anchors});
  }
  unique(packages.map(p=>p.id),'空间包');
  for(const p of packages){check(spec.locations.some(l=>l.id===p.id),'空间包地点不存在');unique(p.zones.map(z=>z.id),'空间区域');unique(p.cameras.map(c=>c.id),'空间机位');}
  return {...clone(previous),projectionSchemaVersion:'PRODUCTION_SPATIAL_V1',sourceRef:binding.sourceRef,sourceRevisionId:binding.sourceRevisionId,sourceDocumentId:binding.documentId||null,sourceSha256:binding.sourceSha256,version:String(spec.version||'UNKNOWN'),orientation:spec.orientation||'UNKNOWN',locations:clone(spec.locations),locationPackages:packages};
}

function sceneBinding(model,sceneId) {
  const scripts=list(model.sceneScriptRevisions).filter(s=>s.sceneId===sceneId&&s.scopeRole==='CURRENT');
  check(scripts.length===1,'空间局部视图必须绑定唯一当前永久场正文');
  const script=scripts[0],releases=list(model.episodeNarrativeReleases).filter(r=>r.id===script.episodeNarrativeReleaseId&&r.scopeRole==='CURRENT'&&r.sourceSyncState==='SOURCE_CURRENT');
  check(releases.length===1&&list(releases[0].reviewInput?.scenes).some(s=>s.id===sceneId&&s.contentHash===script.contentHash),'空间局部视图不属于当前已同步本集正文');
  check(id(script.id)&&digest(script.contentHash),'空间场正文修订证据无效');
  return {episodeUid:releases[0].episodeUid,episodeNarrativeReleaseId:releases[0].id,sceneId,sceneScriptRevisionId:script.id,sceneContentHash:script.contentHash};
}
function selectedBasis(evidence,locationId,zoneId,dressing) {
  const locations=list(evidence?.locations).filter(l=>l.id===locationId),packs=list(evidence?.locationPackages).filter(p=>p.id===locationId);
  check(locations.length===1&&packs.length===1,'局部视图地点缺少精确空间包');
  const pack=packs[0],zones=list(pack.zones).filter(z=>z.id===zoneId);check(zones.length===1,'局部视图区域不属于地点');
  const anchors=[];
  for(const item of dressing){const members=item.anchor.kind==='CAMERA'?pack.cameras:pack.zones,found=list(members).filter(r=>r.id===item.anchor.id);check(found.length===1,'摆位锚点必须在本地点的原空间源内：'+item.anchor.id);if(item.anchor.kind==='CAMERA')check((found[0].zoneId?found[0].zoneId===zoneId:!found[0].zoneIds||found[0].zoneIds.includes(zoneId)),'摆位相机锚点不属于本区域');else check(item.anchor.id===zoneId,'摆位区域锚点必须是本区域');anchors.push({kind:item.anchor.kind,value:found[0]});}
  return {location:locations[0],zone:zones[0],fixedGeometry:pack.fixedGeometry||{},anchors};
}
export function validateSpatialShotViewAuthorContent(value) {
  fields(value,['viewId','sceneId','locationId','zoneId','camera','dressing','note'],'局部空间作者稿');
  for(const k of ['viewId','sceneId','locationId','zoneId'])check(id(value[k]),'局部空间身份无效：'+k);
  fields(value.camera,['origin','looks','height','purpose'],'局部相机');
  check(spatialCameraOrigins.includes(value.camera.origin)&&spatialCameraDirections.includes(value.camera.looks)&&['EYE_LEVEL','LOW','HIGH'].includes(value.camera.height)&&text(value.camera.purpose),'局部相机位置、方向、高度或用途无效');
  check(Array.isArray(value.dressing)&&value.dressing.length<=20,'局部摆位列表无效');
  for(const item of value.dressing){
    fields(item,['id','kind','anchor','relation','orientation','appearance'],'局部摆位');fields(item.anchor,['kind','id'],'摆位锚点');
    check(id(item.id)&&spatialDressingKinds.includes(item.kind)&&['CAMERA','ZONE'].includes(item.anchor.kind)&&id(item.anchor.id),'只支持引用原空间锚点新增家具');
    check(['NORTH_OF','SOUTH_OF','EAST_OF','WEST_OF','AT'].includes(item.relation)&&['EAST_WEST','NORTH_SOUTH','NONE'].includes(item.orientation)&&text(item.appearance),'局部家具摆位或外观无效');
  }
  unique(value.dressing.map(d=>d.id),'局部家具');check(text(value.note),'请说明局部空间设计依据');
  return clone(value);
}
export function prepareSpatialShotView(model,authorContent) {
  const content=validateSpatialShotViewAuthorContent(authorContent),evidence=model.spatialEvidence;
  check(evidence?.projectionSchemaVersion==='PRODUCTION_SPATIAL_V1'&&digest(evidence.sourceSha256)&&id(evidence.sourceRevisionId),'须先精确读取已发布空间源');
  const cameraId='LOCAL-CAM-'+hash(content.viewId).slice(0,24);
  check(!list(evidence.locationPackages).some(p=>list(p.cameras).some(c=>c.id===cameraId)),'局部相机不能覆盖原机位');
  const occupied=new Set(list(evidence.locationPackages).flatMap(p=>[p.id,...list(p.zones).map(z=>z.id),...list(p.cameras).map(c=>c.id)]));
  check(content.dressing.every(d=>!occupied.has(d.id)),'局部家具不能改写原地点、区域或机位身份');
  const prior=list(model.spatialShotViews).filter(v=>v.viewId===content.viewId);
  check(prior.every(v=>v.content.sceneBinding.sceneId===content.sceneId&&v.content.base.locationId===content.locationId&&v.content.base.zoneId===content.zoneId),'局部视图永久身份不能换绑场、地点或区域');
  const basis=selectedBasis(evidence,content.locationId,content.zoneId,content.dressing);
  const body={schemaVersion:SPATIAL_SHOT_VIEW_SCHEMA,viewId:content.viewId,sceneBinding:sceneBinding(model,content.sceneId),base:{sourceRef:evidence.sourceRef,sourceRevisionId:evidence.sourceRevisionId,sourceSha256:evidence.sourceSha256,locationId:content.locationId,zoneId:content.zoneId,sliceHash:hash(basis)},camera:{id:cameraId,...content.camera},dressing:content.dressing,note:content.note,preserveBaseGeometry:true};
  return {id:'SPATIAL-VIEW-'+hash(body).slice(0,32),...body};
}
export function assertSpatialShotView(body) {
  fields(body,['id','schemaVersion','viewId','sceneBinding','base','camera','dressing','note','preserveBaseGeometry'],'空间冻结源');
  check(body.schemaVersion===SPATIAL_SHOT_VIEW_SCHEMA&&body.preserveBaseGeometry===true,'空间冻结源协议无效');
  fields(body.sceneBinding,['episodeUid','episodeNarrativeReleaseId','sceneId','sceneScriptRevisionId','sceneContentHash'],'空间场绑定');
  for(const key of ['episodeUid','episodeNarrativeReleaseId','sceneId','sceneScriptRevisionId'])check(id(body.sceneBinding[key]),'空间场身份无效');check(digest(body.sceneBinding.sceneContentHash),'空间场哈希无效');
  fields(body.base,['sourceRef','sourceRevisionId','sourceSha256','locationId','zoneId','sliceHash'],'空间原始依据');
  check(body.base.sourceRef===spatialLogicalPath&&id(body.base.sourceRevisionId)&&digest(body.base.sourceSha256)&&digest(body.base.sliceHash),'空间依据修订无效');
  const {id:cameraId,...camera}=body.camera||{};
  validateSpatialShotViewAuthorContent({viewId:body.viewId,sceneId:body.sceneBinding.sceneId,locationId:body.base.locationId,zoneId:body.base.zoneId,camera,dressing:body.dressing,note:body.note});
  check(cameraId==='LOCAL-CAM-'+hash(body.viewId).slice(0,24),'局部相机身份不匹配');
  const {id:bodyId,...payload}=body;check(bodyId==='SPATIAL-VIEW-'+hash(payload).slice(0,32),'空间冻结源内容哈希不一致');return body;
}
export function spatialShotViewProjection(body,sourceBinding) {
  assertSpatialShotView(body);
  check(typeof sourceBinding?.sourceRef==='string'&&sourceBinding.sourceRef===`story/spatial-views/${body.id}.json`&&id(sourceBinding.sourceRevisionId)&&digest(sourceBinding.sourceSha256),'局部空间正式源绑定无效');
  return {id:body.id,viewId:body.viewId,scopeRole:'CURRENT',contentHash:hash(body),content:clone(body),...sourceBinding};
}
export function spatialShotViewReasons(model,settings) {
  const space=settings?.space,rows=list(model.spatialShotViews).filter(v=>v.id===space?.freeze),row=rows[0];
  if(rows.length!==1||row.scopeRole!=='CURRENT'||list(model.spatialShotViews).filter(v=>v.viewId===row.viewId&&v.scopeRole==='CURRENT').length!==1)return ['SPACE_LOCAL_VIEW_NOT_CURRENT'];
  const body=row.content,proof=model.spatialShotViewProofs?.[row.id];
  try {
    assertSpatialShotView(body);check(hash(body)===row.contentHash,'空间冻结内容变化');
    check(proof?.sourceRevisionId===row.sourceRevisionId&&proof?.sourceSha256===row.sourceSha256&&proof?.contentHash===row.contentHash,'空间冻结源未精确读取');
    check(space.loc===body.base.locationId&&space.zone===body.base.zoneId&&space.camera===body.camera.id,'空间冻结地点、区域或机位不匹配');
    const shots=list(model.shots).filter(s=>(s.id||s.shotId)===settings.shotId&&s.scopeRole==='CURRENT'&&s.activeInCurrentProduction!==false);
    check(shots.length===1&&shots[0].sceneId===body.sceneBinding.sceneId,'空间局部视图不属于当前镜头永久场');
    check(hash(sceneBinding(model,shots[0].sceneId))===hash(body.sceneBinding),'空间局部视图正文修订已变化');
    check(hash(selectedBasis(model.spatialEvidence,body.base.locationId,body.base.zoneId,body.dressing))===body.base.sliceHash,'空间局部几何依据已变化');
    return [];
  }catch(error){return ['SPACE_LOCAL_VIEW_INVALID:'+error.message];}
}

function checkedMap(document,previous) {
  check(document&&!document.deleted&&list(document.aliases).includes(spatialLogicalPath)&&sha256(document.bytes)===document.sha256,'已发布空间源不存在或 SHA 不一致');
  return projectProductionSpatialSource(JSON.parse(Buffer.from(document.bytes).toString('utf8')),{sourceRef:spatialLogicalPath,sourceRevisionId:document.revisionId,sourceSha256:document.sha256,documentId:document.documentId},previous);
}
async function verifyViews(rows,readDocument) {
  const proofs={},seen=new Set(),heads=new Set(),maps=new Map();
  for(const row of rows){
    check(!seen.has(row.id),'空间局部冻结版本重复');seen.add(row.id);
    check(['CURRENT','EVIDENCE_ONLY'].includes(row.scopeRole),'空间局部冻结角色无效');
    if(row.scopeRole==='CURRENT'){check(!heads.has(row.viewId),'空间局部冻结当前版本不唯一');heads.add(row.viewId);}
    assertSpatialShotView(row.content);check(row.id===row.content.id&&row.viewId===row.content.viewId&&row.contentHash===hash(row.content),'空间冻结目录与源内容不一致');
    const source=await readDocument(row.sourceRevisionId);
    check(source&&!source.deleted&&source.revisionId===row.sourceRevisionId&&source.sha256===row.sourceSha256&&sha256(source.bytes)===row.sourceSha256&&source.metadata?.sourceRole==='SPATIAL_SHOT_VIEW'&&list(source.aliases).includes(`story/spatial-views/${row.id}.json`)&&row.sourceRef===`story/spatial-views/${row.id}.json`,'空间冻结正式源不能精确回读');
    check(canonicalJson(JSON.parse(Buffer.from(source.bytes).toString('utf8')))===canonicalJson(row.content),'空间冻结目录不是源原文');
    const base=row.content.base;
    if(!maps.has(base.sourceRevisionId)){const source=await readDocument(base.sourceRevisionId);check(source?.revisionId===base.sourceRevisionId&&source?.sha256===base.sourceSha256&&list(source?.aliases).includes(spatialLogicalPath),'空间局部视图原基线源缺失');maps.set(base.sourceRevisionId,checkedMap(source,{}));}
    const original=maps.get(base.sourceRevisionId);check(original.sourceSha256===base.sourceSha256&&hash(selectedBasis(original,base.locationId,base.zoneId,row.content.dressing))===base.sliceHash,'空间局部冻结原几何切片不一致');
    proofs[row.id]={sourceRevisionId:row.sourceRevisionId,sourceSha256:row.sourceSha256,contentHash:row.contentHash};
  }
  return proofs;
}
export async function applyProductionSpatialProjection(tx,model,{view}={}) {
  view=view||await tx.readView();
  const document=await tx.getPublishedDocument(spatialLogicalPath),rows=list(model.spatialShotViews);
  if(!document){
    // Preserve the earlier, independently validated five-field contract for
    // other instances with their own source alias. It cannot host new overlays.
    const customSource=model.spatialEvidence?.sourceRef||view.snapshot.creativeLineage?.spatialEvidence?.sourceRef;
    check(!rows.length&&(!model.sourceHashes?.productionMapSha256||customSource&&customSource!==spatialLogicalPath),'当前空间依据缺失');
    return {...model,spatialShotViewProofs:{}};
  }
  check(view.sourceRevisionIds.includes(document.revisionId),'空间源不属于当前发布');
  const expected=model.sourceHashes?.productionMapSha256||view.snapshot.sourceHashes?.productionMapSha256;
  check(!expected||expected===document.sha256,'当前空间快照与发布源 SHA 不一致');
  const evidence=checkedMap(document,model.spatialEvidence||view.snapshot.creativeLineage?.spatialEvidence||{});
  for(const row of rows)check(view.sourceRevisionIds.includes(row.sourceRevisionId),'空间冻结源不在当前发布闭包中');
  const proofs=await verifyViews(rows,id=>tx.readDocumentRevision(id));
  return {...model,sourceHashes:model.sourceHashes||view.snapshot.sourceHashes||{},spatialEvidence:evidence,spatialShotViewProofs:proofs};
}
export async function preserveProductionSpatialProjection({snapshot,baseSnapshot,documents,readDocumentRevision}) {
  const candidates=documents.filter(d=>list(d.aliases).includes(spatialLogicalPath));
  check(candidates.length<=1,'空间源别名对应多份当前修订');
  const rows=list(baseSnapshot.productionModel?.spatialShotViews);
  if(!candidates.length){check(!rows.length,'空间冻结历史缺少基线');return snapshot;}
  const evidence=checkedMap(candidates[0],snapshot.creativeLineage?.spatialEvidence||{});
  const expected=snapshot.sourceHashes?.productionMapSha256;check(!expected||expected===evidence.sourceSha256,'编译空间源与快照哈希不一致');
  const byId=new Map(documents.map(d=>[d.revisionId,d]));
  for(const row of rows)check(byId.has(row.sourceRevisionId),'普通源同步丢失空间局部视图源');
  const proofs=await verifyViews(rows,async id=>byId.get(id)||await readDocumentRevision?.(id));
  return {...snapshot,creativeLineage:{...snapshot.creativeLineage,spatialEvidence:evidence},productionModel:{...snapshot.productionModel,spatialShotViews:clone(rows),spatialShotViewProofs:proofs}};
}
