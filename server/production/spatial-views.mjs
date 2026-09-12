import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead,idFor} from '../presentation/read-unit.mjs';
import {spatialBaseline} from '../workspaces.mjs';

export const spatialOptions={cameraOrigins:['NORTH_INTERIOR','NORTHEAST_INTERIOR','EAST_INTERIOR','SOUTHEAST_INTERIOR','SOUTH_INTERIOR','SOUTHWEST_INTERIOR','WEST_INTERIOR','NORTHWEST_INTERIOR','CENTER_INTERIOR'],cameraDirections:['NORTH','NORTHEAST','EAST','SOUTHEAST','SOUTH','SOUTHWEST','WEST','NORTHWEST'],cameraHeights:['EYE_LEVEL','LOW','HIGH'],dressingKinds:['BED','BOWL_RACK','TABLE','CHAIR','SHELF','BENCH','CONTAINER'],relations:['NORTH_OF','SOUTH_OF','EAST_OF','WEST_OF','AT'],orientations:['EAST_WEST','NORTH_SOUTH','NONE']};
const list=v=>Array.isArray(v)?v:[];
export async function spatialCatalog(unit) {
  const baseline=await spatialBaseline(unit.tx),spec=baseline.specification;
  if(!spec)return {sourceBinding:null,version:null,locations:[],states:[]};
  await unit.detail(baseline.sourceBinding.id,baseline.sourceBinding.revisionId);
  const normalized=(await unit.rows(['SOURCE'],{roles:['SPATIAL_CATALOG']})).filter(r=>r.content.base?.revisionId===baseline.sourceBinding.revisionId&&r.content.base?.sha256===baseline.sourceBinding.sha256);
  check(normalized.length<=1,'SPATIAL_CATALOG_AMBIGUOUS','空间目录有多个当前版本，须先核对',409);
  const declared=normalized[0]?.content.locationPackages||spec.locationPackages||Object.entries(spec.minimal_location_packages||{}).map(([id,v])=>({id,...v}));
  const locations=list(spec.locations).map(location=>{
    const packages=list(declared).filter(p=>p.id===location.id||p.locationId===location.id);check(packages.length<=1,'SPATIAL_PACKAGE_AMBIGUOUS','空间包身份重复',409);
    const p=packages[0];return {...location,label:location.name||location.id,name:location.name||location.id,zones:list(p?.zones).map(z=>({...z,label:z.name||z.label||z.id,name:z.name||z.label||z.id})),cameras:list(p?.cameras).map(c=>({...c,label:c.name||c.label||c.id})),fixedGeometry:p?.fixedGeometry||{},sourcePointer:p?.sourcePointer||null};
  });
  return {sourceBinding:baseline.sourceBinding,catalogBinding:normalized[0]?{id:normalized[0].id,revisionId:normalized[0].revisionId,sha256:normalized[0].sha256}:null,version:spec.version,locations,states:list(spec.states).map(s=>({...s,label:s.label||s.name||s.id}))};
}
export async function spatialViewWorkspace(unit,input) {
  identity(input.sceneId);const scene=await unit.detail(input.sceneId);check(scene.kind==='SCENE','SCENE_REQUIRED','请选择永久场');
  const viewId=input.viewId||'SPATIAL-AUTHOR-'+hash({sceneId:input.sceneId}).slice(0,24);identity(viewId);
  const old=(await unit.rows(['NOTE'],{ids:['spatial-view:'+viewId]}))[0];
  check(!old||old.content.sceneId===scene.id,'SPATIAL_IDENTITY','局部空间不能换绑永久场',409);
  let published=old?.content.status==='PUBLISHED'?old:null;
  if(!published&&old?.content.publishedRevisionId){const d=await unit.detail(old.id,old.content.publishedRevisionId);published={...old,revisionId:d.revision.id,content:d.revision.content};}
  const catalog=await spatialCatalog(unit),basis={sceneId:scene.id,sceneRevisionId:scene.revision.id,sceneContentHash:scene.revision.sha256,sourceBinding:catalog.sourceBinding,catalogBinding:catalog.catalogBinding,currentRevisionId:published?.revisionId||null},basisHash=hash(basis),draft=old?.content.status==='DRAFT'?old:null;
  const currentView=published?.content.view||null;
  const defaults=published?.content.author||{sceneId:scene.id,viewId,locationId:'',zoneId:'',camera:{origin:'',looks:'',height:'EYE_LEVEL',purpose:''},dressing:[],note:''};
  const stale=draft&&draft.content.basisHash!==basisHash;
  const value={sceneId:scene.id,viewId,releaseId:hash(basis),basisHash,draftHeadRevisionId:draft?.revisionId||null,draft:draft&&!stale?{revisionId:draft.revisionId,content:draft.content.author}:null,staleDraft:stale?{revisionId:draft.revisionId,content:draft.content.author,reason:'本场正文或空间依据已改变，请核对原稿后重新保存'}:null,defaults,currentView,availableLocations:catalog.locations,options:spatialOptions,blockers:catalog.sourceBinding?[]:['当前项目尚未登记空间基线'],jobs:[],readOnly:scene.historical};
  return {value,scene,old,published,catalog,basis};
}
function validateAuthor(value,state) {
  const allowed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
  const text=v=>typeof v==='string'&&v.trim()&&v.length<=2000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
  check(allowed(value,['sceneId','viewId','locationId','zoneId','camera','dressing','note'])&&value.sceneId===state.scene.id&&value.viewId===state.value.viewId,'SPATIAL_IDENTITY','局部空间作者稿身份无效');
  const location=state.catalog.locations.find(l=>l.id===value.locationId),zone=location?.zones.find(z=>z.id===value.zoneId);
  check(location&&zone,'SPATIAL_ZONE','请在已登记的空间地点与区域内设计',409);
  const before=state.published?.content.author;
  check(!before||before.locationId===value.locationId&&before.zoneId===value.zoneId,'SPATIAL_IDENTITY','已有局部视图不能换绑地点与区域',409);
  check(allowed(value.camera,['origin','looks','height','purpose'])&&spatialOptions.cameraOrigins.includes(value.camera.origin)&&spatialOptions.cameraDirections.includes(value.camera.looks)&&spatialOptions.cameraHeights.includes(value.camera.height)&&text(value.camera.purpose),'SPATIAL_CAMERA','请完整填写机位、朝向、高度和用途');
  check(Array.isArray(value.dressing)&&value.dressing.length<=20&&new Set(value.dressing.map(d=>d.id)).size===value.dressing.length,'SPATIAL_DRESSING','家具摆位无效或身份重复');
  const occupied=new Set(state.catalog.locations.flatMap(l=>[l.id,...l.zones.map(z=>z.id),...l.cameras.map(c=>c.id)]));
  const anchors=[];
  for(const d of value.dressing){
    identity(d.id);check(!occupied.has(d.id)&&allowed(d,['id','kind','anchor','relation','orientation','appearance'])&&spatialOptions.dressingKinds.includes(d.kind)&&spatialOptions.relations.includes(d.relation)&&spatialOptions.orientations.includes(d.orientation)&&text(d.appearance),'SPATIAL_DRESSING','家具身份、类型、位置或外观无效');
    check(allowed(d.anchor,['kind','id'])&&['CAMERA','ZONE'].includes(d.anchor.kind),'SPATIAL_ANCHOR','摆位锚点无效');
    const anchor=d.anchor.kind==='ZONE'?zone.id===d.anchor.id&&zone:location.cameras.find(c=>c.id===d.anchor.id&&(!c.zoneId||c.zoneId===zone.id)&&(!c.zoneIds?.length||c.zoneIds.includes(zone.id)));
    check(anchor,'SPATIAL_ANCHOR','摆位锚点不属于所选地点与区域',409);anchors.push({kind:d.anchor.kind,value:anchor});
  }
  check(text(value.note),'SPATIAL_NOTE','请说明空间设计依据');
  const body={schemaVersion:'SPATIAL_SHOT_VIEW_V2',viewId:value.viewId,sceneBinding:{sceneId:state.scene.id,sceneRevisionId:state.scene.revision.id,sceneContentHash:state.scene.revision.sha256},base:{...state.catalog.sourceBinding,locationId:location.id,zoneId:zone.id,sliceHash:hash({location,zone,anchors})},camera:{id:'LOCAL-CAM-'+hash(value.viewId).slice(0,24),...value.camera},dressing:value.dressing,note:value.note,preserveBaseGeometry:true};
  return {id:'SPATIAL-VIEW-'+hash(body).slice(0,32),...body};
}
export async function planSpatialViewChange(tx,input) {
  const unit=new PresentationRead(tx),state=await spatialViewWorkspace(unit,input),{value,old,published}=state;
  check(!value.readOnly&&!value.blockers.length,'SPATIAL_BASIS','当前空间依据不可编辑',409);
  const assertions=unit.finish({})._basis.filter(b=>b.objectId!==old?.id).map(b=>({type:'assert',id:b.objectId,expectedVersion:b.expectedVersion}));
  if(input.action==='save'){
    check(input.expectedReleaseId===value.releaseId&&input.expectedBasisHash===value.basisHash&&(input.expectedDraftRevisionId||null)===value.draftHeadRevisionId,'VERSION_CONFLICT','空间草稿或当前依据已改变；编辑仍保留',409);
    validateAuthor(input.content,state);
    return {commands:[...assertions,{type:'save',id:'spatial-view:'+value.viewId,kind:'NOTE',title:'局部机位与摆位',expectedVersion:old?.version||0,content:{role:'SPATIAL_VIEW',sceneId:value.sceneId,viewId:value.viewId,status:'DRAFT',author:input.content,basisHash:value.basisHash,publishedRevisionId:published?.revisionId||null},links:[{id:value.sceneId,role:'SCENE'}]}],response:results=>({revisionId:results.at(-1).revisionId,modelCalls:0,formalAdoptionPerformed:false})};
  }
  check(['preview','publish'].includes(input.action)&&old?.content.status==='DRAFT'&&old.revisionId===input.draftRevisionId&&old.content.basisHash===value.basisHash,'VERSION_CONFLICT','空间草稿或依据已改变，请核对并重新保存',409);
  const view=validateAuthor(old.content.author,state),previewHash=hash({view,draft:old.revisionId,basis:value.basisHash});
  if(input.action==='preview')return {commands:[...assertions,{type:'assert',id:old.id,expectedVersion:old.version}],response:()=>({view,previewHash,modelCalls:0,formalAdoptionPerformed:false})};
  check(input.previewHash===previewHash,'PREVIEW_STALE','空间预览已改变',409);
  return {commands:[...assertions,{type:'save',id:old.id,expectedVersion:old.version,content:{...old.content,status:'PUBLISHED',view,publishedRevisionId:null},dependencies:[{revisionId:state.scene.revision.id,purpose:'CONTENT'},{revisionId:state.catalog.sourceBinding.revisionId,purpose:'DESIGN'},...(state.catalog.catalogBinding?[{revisionId:state.catalog.catalogBinding.revisionId,purpose:'DEFINITION'}]:[])]}],response:results=>({revisionId:results.at(-1).revisionId,status:'SUCCEEDED',view,modelCalls:0,formalAdoptionPerformed:false})};
}
export async function availableLocalViews(unit,sceneId) {
  const rows=(await unit.rows(['NOTE'])).filter(r=>r.content.role==='SPATIAL_VIEW'&&(!sceneId||r.content.sceneId===sceneId)),views=[];
  for(const r of rows){let content=r.content,revisionId=r.revisionId;if(content.status!=='PUBLISHED'&&content.publishedRevisionId){const d=await unit.detail(r.id,content.publishedRevisionId);content=d.revision.content;revisionId=d.revision.id;}if(content.status==='PUBLISHED'&&content.view){const v=content.view;views.push({id:v.id,viewId:v.viewId,revisionId,objectId:r.id,expectedVersion:r.version,label:v.camera.purpose,locationId:v.base.locationId,zoneId:v.base.zoneId,cameraId:v.camera.id,sceneBinding:v.sceneBinding,base:v.base});}}
  return views;
}
