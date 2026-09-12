import {check,hash} from '../shared/contracts.mjs';
import {PresentationRead,idFor,idsFor} from '../presentation/read-unit.mjs';
import {animaticHashes,validateAnimaticTimeline} from './animatic-model.mjs';
import {spatialCatalog,availableLocalViews} from './spatial-views.mjs';
import {materialRows} from '../presentation/materials.mjs';
const frames=['START_FRAME','INTERMEDIATE_FRAME','END_FRAME'];
const evidenceKinds=['SHOT_INPUT_LOCK',...frames,'LOCKED_SHOT'];
const same=(a,b)=>a!==undefined&&b!==undefined&&hash(a)===hash(b);
const remember=(unit,...rows)=>{unit.productionProofIds??=new Set();for(const row of rows.filter(row=>row&&typeof row.id==='string'))unit.productionProofIds.add(row.id);};
async function lockProofSources(unit){const refs=[...(unit.productionProofIds||[])].sort();const rows=(await unit.tx.query('SELECT id,version FROM objects WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[refs])).rows;for(const row of rows)check(unit.basis.get(row.id)?.expectedVersion===row.version,'VERSION_CONFLICT','制作验收期间所用精确对象已变化',409);}
const plain=e=>{if(!e)return null;const{observedImageIds,observedVideoIds,jointFindings,videoFindings,...value}=e;return value;};
const member=v=>({workItemId:v.workItemId,slot:v.slot,familyId:v.familyId,versionId:v.versionId,sha256:v.sha256});

export async function productionContext(unit,workItemId){
 const rows=(await unit.rows(['EXPECTED_OUTPUT'])).filter(r=>r.content.workItemId===workItemId&&r.content.expectationState==='PLANNED');
 check(rows.length===1,'OUTPUT_IDENTITY','制作工作项须绑定唯一当前预期产物',409);
 const output=rows[0],value=output.content,scene=await unit.detail(value.sceneId),shot=value.shotId?await unit.detail(value.shotId):null;
 const settingsRows=(await unit.tx.query("SELECT r.id,r.object_id,r.content FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id WHERE d.consumer_revision_id=$1 AND r.content->>'role'='SHOT_PRODUCTION_SETTINGS'",[output.revisionId])).rows;
 check(settingsRows.length===1,'PRODUCTION_SETTINGS','预期产物缺少唯一的冻结制作设置',409);
 const settings=await unit.detail(settingsRows[0].object_id);
 check(settings.revision.id===settingsRows[0].id,'PRODUCTION_SETTINGS_CHANGED','制作设置已换版，请核对当前预期产物',409);
 const design=(await unit.rows(['SHOT_DESIGN'])).find(r=>idFor(r,'SCENE')===scene.id&&(!shot||idsFor(r,'SHOT').includes(shot.id)));
 check(design?.state==='ADOPTED'&&!scene.historical&&!shot?.historical,'DESIGN_NOT_ADOPTED','请先采用当前场的镜头设计；历史身份不自动换绑',409);
 check(!(await unit.tx.query('SELECT 1 FROM invalidations WHERE consumer_revision_id=ANY($1::text[]) LIMIT 1',[[output.revisionId,settings.revision.id,design.revisionId]])).rowCount,'PRODUCTION_BASIS_STALE','制作设置或镜头设计的实际依据已改变',409);
 remember(unit,output,scene,shot,design,settings);
 return {unit,output,value,scene,shot,design,settings,planned:settingsRows[0].content.settings};
}

export async function productionVersion(unit,output,{versionId,adopted=true,optional=false}={}){
 const familyId=idFor(output,'FAMILY'),family=(await unit.tx.query('SELECT adopted_asset_id FROM material_families WHERE object_id=$1',[familyId])).rows[0];
 let id=versionId||family?.adopted_asset_id;
 if(!id&&!adopted)id=(await unit.tx.query('SELECT a.object_id FROM asset_versions a JOIN objects o ON o.id=a.object_id WHERE a.family_id=$1 AND o.state NOT IN (\'DISABLED\',\'ARCHIVED\') ORDER BY o.created_at DESC,o.id DESC LIMIT 1',[familyId])).rows[0]?.object_id;
 if(!id&&optional)return null;
 check(id,'PRODUCTION_OUTPUT_MISSING','尚未具备 '+output.title+' 的实际版本',409);
 const object=await unit.detail(id),binding=(await unit.tx.query('SELECT family_id FROM asset_versions WHERE object_id=$1',[id])).rows[0];
 check(binding?.family_id===familyId&&!object.historical&&!['DISABLED','ARCHIVED'].includes(object.state),'PRODUCTION_FAMILY','制作版本与预期素材族不一致或已停用',409);
 const revision=adopted?object.adoptedRevisionId:object.revision.id;
 check(revision&&(!adopted||family?.adopted_asset_id===id),'PRODUCTION_NOT_ADOPTED','请先审阅采用 '+output.title+' 的实际版本',409);
 const media=(await unit.tx.query("SELECT m.*,a.sha256 AS bound_sha FROM asset_media a JOIN media m ON(m.id,m.version_id)=(a.media_id,a.media_version_id) WHERE a.revision_id=$1 AND a.role='OUTPUT'",[revision])).rows;
 check(media.length===1&&media[0].availability==='PRESENT'&&media[0].sha256===media[0].bound_sha,'PRODUCTION_MEDIA','制作成果须绑定唯一可用媒体和精确 SHA',409);
 if(adopted){
  const rights=(await unit.tx.query('SELECT * FROM rights WHERE revision_id=$1',[revision])).rows[0];
  check(rights?.fact==='CLEAR'||rights?.fact==='UNKNOWN'&&rights.internal_attestation,'PRODUCTION_RIGHTS','制作输入权利尚未放行',409);
  check(!(await unit.tx.query('SELECT 1 FROM invalidations WHERE consumer_revision_id=$1 LIMIT 1',[revision])).rowCount,'PRODUCTION_MEDIA_STALE','所选制作媒体的实际输入已变化',409);
 }
 remember(unit,output,object);
 const detail=object.revision.id===revision?object:await unit.detail(id,revision);
 return {workItemId:output.content.workItemId,slot:output.content.outputSlot||'main',familyId,versionId:id,sha256:media[0].sha256,revisionId:revision,objectVersion:object.version,mediaUrl:'/api/v1/media/'+media[0].sha256,kind:media[0].mime_type.split('/')[0].toUpperCase(),object:detail};
}
async function proof(unit,version){
 const row=(await unit.tx.query("SELECT r.id,r.decision,r.created_at,p.content FROM reviews r LEFT JOIN provenance p ON p.kind='review' AND p.original_id=r.id WHERE r.object_id=$1 AND r.revision_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 1",[version.versionId,version.revisionId])).rows[0];
 check(row?.decision==='ADOPT'&&row?.content?.shotProductionEvidence,'PRODUCTION_REVIEW_PROOF','当前版本缺少可恢复的正式制作验收证据',409);return row;
}
const base=(c,kind)=>({schemaVersion:'1.0',kind,productionPlanId:c.value.productionPlanId,productionRevisionId:c.settings.revision.id,shotId:c.shot?.id||null});
const peers=async c=>(await c.unit.rows(['EXPECTED_OUTPUT'])).filter(o=>o.content.productionPlanId===c.value.productionPlanId&&o.content.shotId===c.value.shotId&&o.content.expectationState==='PLANNED');

export async function visualInputs(c){
 const {unit,planned}=c,required=planned.visualRequirementIds||[],inputs=[];
 check(required.every(id=>planned.inputs?.some(b=>b.requirementId===id)),'VISUAL_INPUT_REQUIRED','本镜视觉需求尚缺实际采用素材',409);
 for(const binding of (planned.inputs||[]).filter(b=>required.includes(b.requirementId))){
  const requirement=await unit.detail(binding.requirementId);remember(unit,requirement);
  const pseudo={title:requirement.title,links:[{role:'FAMILY',id:binding.familyId}],content:{}};
  const value=await productionVersion(unit,pseudo,{versionId:binding.versionId});
  const ownFamily=requirement.links.some(l=>l.role==='FAMILY'&&l.id===binding.familyId),usage=ownFamily?null:(await materialRows(unit,{requirementId:requirement.id}))[0]?.materialUsageBindings.find(b=>b.eligible&&b.familyId===binding.familyId&&b.versionId===binding.versionId&&b.sha256===binding.sha256);
  check(value.sha256===binding.sha256&&(ownFamily||usage),'VISUAL_INPUT_BINDING','视觉输入需求、素材版本或 SHA 不一致',409);
  if(usage)remember(unit,await unit.detail(usage.usageId));
  inputs.push({...binding,revisionId:value.revisionId,requirementRevisionId:requirement.revision.id,...(usage?{usageRevisionId:usage.usageRevisionId}:{})});
 }
 const catalog=await spatialCatalog(unit),space=planned.space,loc=catalog.locations.find(l=>l.id===space?.loc),zone=loc?.zones.find(z=>z.id===space.zone),local=(await availableLocalViews(unit,c.scene.id)).find(v=>v.id===space?.freeze&&v.cameraId===space.camera&&v.locationId===space.loc&&v.zoneId===space.zone);
 const camera=loc?.cameras.find(v=>v.id===space?.camera&&(!v.zoneIds?.length||v.zoneIds.includes(space.zone)));
 check(loc&&zone&&catalog.states.some(s=>s.id===space?.state)&&(local||camera&&space.freeze===catalog.sourceBinding?.sha256),'SPATIAL_INPUTS_UNKNOWN','地点、状态、区域、机位与冻结空间须完整对应',409);
 if(local)check(local.sceneBinding.sceneRevisionId===c.scene.revision.id&&local.base.sha256===catalog.sourceBinding.sha256,'SPATIAL_VIEW_STALE','本场机位依据已变化',409);
 return {inputs,space,sourceBinding:catalog.sourceBinding,localView:local?{id:local.id,revisionId:local.revisionId}:null};
}
async function inputEvidence(c){const value=await visualInputs(c);return {...base(c,'INPUT_LOCK'),inputHash:hash({shotId:c.shot.id,...value})};}
async function inputLock(c){
 const output=(await peers(c)).find(o=>o.content.deliverableKey==='SHOT_INPUT_LOCK');check(output,'INPUT_LOCK_REQUIRED','本镜输入锁定记录尚未登记',409);
 const version=await productionVersion(c.unit,output),record=await proof(c.unit,version),context=await productionContext(c.unit,output.content.workItemId),expected=await inputEvidence(context);
 check(same(plain(record.content.shotProductionEvidence),expected),'INPUT_LOCK_CHANGED','本镜视觉输入锁已变化，请重新核对',409);return {version,record};
}
async function animaticFor(c){
 const outputs=(await c.unit.rows(['EXPECTED_OUTPUT'])).filter(o=>o.content.sceneId===c.scene.id&&o.content.deliverableKey==='ANIMATIC'&&o.content.expectationState==='PLANNED');check(outputs.length===1,'ANIMATIC_TIMING_LOCK_REQUIRED','本场须有唯一的预演产物',409);
 const version=await productionVersion(c.unit,outputs[0]),timelineId=version.object.revision.content.basis?.executionRevisionId;
 const rev=(await c.unit.tx.query("SELECT object_id,content FROM revisions WHERE id=$1 AND content->>'role'='ANIMATIC'",[timelineId])).rows[0];check(rev,'ANIMATIC_RENDER_PROOF','预演必须来自精确时间线渲染',409);
 const timeline=validateAnimaticTimeline(rev.content.timeline),current=await c.unit.detail(rev.object_id);remember(c.unit,current);const slice=animaticHashes(timeline).shotSlices.find(s=>s.shotId===c.shot?.id),now=animaticHashes(current.revision.content.timeline).shotSlices.find(s=>s.shotId===c.shot?.id);
 check(timeline.shotPlanRevisionId===c.design.revisionId&&slice&&same(slice,now),'ANIMATIC_SLICE_CHANGED','本镜锁时、画面、叠加或前后镜关系已变化',409);
 return {version,timeline,slice};
}
async function frameEvidence(c){
 await inputLock(c);const {slice}=await animaticFor(c);
 return {...base(c,'KEYFRAME'),...Object.fromEntries(['timingHash','visualHash','overlayHash','boundaryHash'].map(k=>[k,slice[k]])),strategyHash:hash(c.planned.keyframeStrategy)};
}
async function frameOutputs(c){
 const outputs=(await peers(c)).filter(o=>frames.includes(o.content.deliverableKey)).sort((a,b)=>frames.indexOf(a.content.deliverableKey)-frames.indexOf(b.content.deliverableKey)||a.content.outputSlot.localeCompare(b.content.outputSlot));
 const strategy=c.planned.keyframeStrategy,count=({START_ONLY:1,START_END:2,MULTI_KEYFRAME:2+strategy.intermediateFrameCount})[strategy.mode];
 check(count&&outputs.length===count&&outputs.filter(o=>o.content.deliverableKey==='START_FRAME').length===1&&outputs.filter(o=>o.content.deliverableKey==='END_FRAME').length===(count>1?1:0),'KEYFRAME_STRATEGY','关键帧集合须完整对应本镜策略',409);return outputs;
}
const requireObservations=(value,required)=>check(Array.isArray(value)&&new Set(value).size===value.length&&required.every(id=>value.includes(id))&&value.every(id=>required.includes(id)),'MEDIA_OBSERVATION_REQUIRED','请实际观察并确认本次全部精确媒体',409);
const requireFindings=(value,keys)=>check(value&&keys.every(k=>value[k]?.outcome==='PASS'&&typeof value[k].note==='string'&&value[k].note.trim()&&value[k].note.length<=4000),'PRODUCTION_FINDINGS','请逐项填写实际观察后的判断与说明',409);
export async function productionFrameSet(c){
 const expected=await frameEvidence(c),versions=[],records=[];
 for(const output of await frameOutputs(c)){const version=await productionVersion(c.unit,output),record=await proof(c.unit,version);const {members,...basis}=plain(record.content.shotProductionEvidence);check(same(basis,expected),'KEYFRAME_BASIS_CHANGED','关键帧仍依据旧版锁时或制作设置',409);versions.push(version);records.push(record);}
 const members=versions.map(member),joint=records.find(r=>same(r.content.shotProductionEvidence.members,members)&&r.content.shotProductionEvidence.jointFindings);
 check(joint,'KEYFRAME_SET_REVIEW_REQUIRED','尚未完成完整关键帧的联合验收',409);requireObservations(joint.content.shotProductionEvidence.observedImageIds,members.map(m=>m.versionId));requireFindings(joint.content.shotProductionEvidence.jointFindings,['continuity','composition']);
 return {id:'keyframe-set:'+hash({expected,members,reviews:records.map(r=>r.id)}),versions,records};
}
export async function productionEvidenceTemplate(unit,workItemId,versionId){
 const c=await productionContext(unit,workItemId),kind=c.value.deliverableKey;
 if(!evidenceKinds.includes(kind))return {required:false,evidence:null};
 if(kind==='SHOT_INPUT_LOCK')return {required:true,evidence:await inputEvidence(c),requiredObservedImageIds:[],requiredObservedVideoIds:[],requiresJointReview:false,observationMedia:[]};
 const expected=await frameEvidence(c);
 if(frames.includes(kind)){
  const versions=[];for(const output of await frameOutputs(c)){const v=await productionVersion(unit,output,{versionId:output.id===c.output.id?versionId:undefined,adopted:false,optional:output.id!==c.output.id});if(v)versions.push(v);}
  return {required:true,evidence:{...expected,members:versions.map(member),observedImageIds:[],jointFindings:{}},requiredObservedImageIds:versions.map(v=>v.versionId),requiredObservedVideoIds:[],requiresJointReview:versions.length===(await frameOutputs(c)).length,observationMedia:versions.map(({versionId,familyId,sha256,kind,mediaUrl})=>({versionId,familyId,sha256,kind,mediaUrl}))};
 }
 const set=await productionFrameSet(c),videoOutput=(await peers(c)).find(o=>o.content.deliverableKey==='SHOT_VIDEO');check(videoOutput,'SHOT_VIDEO_REQUIRED','请先生成并审阅本镜视频',409);
 const video=await productionVersion(unit,videoOutput),animatic=await animaticFor(c),ids=animatic.timeline.shots.map(s=>s.shotId),at=ids.indexOf(c.shot.id),versions=[video,animatic.version];
 return {required:true,evidence:{...expected,kind:'SHOT_LOCK',keyframeSetId:set.id,members:[member(video)],adjacentShotIds:[ids[at-1],ids[at+1]].filter(Boolean),observedVideoIds:[],videoFindings:{}},requiredObservedImageIds:[],requiredObservedVideoIds:versions.map(v=>v.versionId),requiresJointReview:false,observationMedia:versions.map(({versionId,familyId,sha256,kind,mediaUrl})=>({versionId,familyId,sha256,kind,mediaUrl}))};
}
export async function verifyProductionReview(tx,object,revisionId,command){
 const outputs=(await tx.query("SELECT o.id,r.content FROM asset_versions a JOIN memberships m ON m.member_id=a.family_id AND m.role='FAMILY' JOIN objects o ON o.id=m.owner_id JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE a.object_id=$1 AND o.kind='EXPECTED_OUTPUT' AND r.content->>'expectationState'='PLANNED' AND r.content ? 'workItemId'",[object.id])).rows;
 if(!outputs.length)return;
 check(outputs.length===1&&command.reviewBasis?.id===outputs[0].id,'PRODUCTION_REVIEW_BASIS','制作成果必须按本工作项的冻结标准审阅',409);
 check(!command.reviewMetadata?.workItemId||command.reviewMetadata.workItemId===outputs[0].content.workItemId,'PRODUCTION_REVIEW_BASIS','审阅上下文不能换绑其他工作项',409);
 const output=outputs[0],unit=new PresentationRead(tx),c=await productionContext(unit,output.content.workItemId);
 const actual=await unit.detail(object.id,revisionId);
 check(actual.revision.content.basis?.expectedOutputId===output.id,'PRODUCTION_OUTPUT_BASIS','候选未绑定本次预期产物，不能静默采用其他输入',409);
 if(output.content.deliverableKey==='ANIMATIC'){
  const basis=actual.revision.content.basis?.executionRevisionId,render=(await tx.query("SELECT r.content FROM revisions r WHERE r.id=$1 AND r.content->>'role'='ANIMATIC'",[basis])).rows[0];
  check(render&&render.content.timeline.shotPlanRevisionId===c.design.revisionId,'ANIMATIC_RENDER_PROOF','候选预演未绑定当前正式镜头设计',409);
 }
 if(!evidenceKinds.includes(output.content.deliverableKey)){await lockProofSources(unit);return;}
 const template=await productionEvidenceTemplate(unit,output.content.workItemId,object.id),evidence=command.productionEvidence;
 check(evidence&&same(plain(evidence),plain(template.evidence)),'PRODUCTION_EVIDENCE_CHANGED','制作验收证据缺失或依据版本已变化',409);
 requireObservations(evidence.observedImageIds||[],template.requiredObservedImageIds||[]);requireObservations(evidence.observedVideoIds||[],template.requiredObservedVideoIds||[]);
 if(template.requiresJointReview)requireFindings(evidence.jointFindings,['continuity','composition']);
 if(evidence.kind==='SHOT_LOCK')requireFindings(evidence.videoFindings,['action','camera','consistency','timing','adjacency']);
 if(['SHOT_INPUT_LOCK','LOCKED_SHOT'].includes(output.content.deliverableKey))check(same(plain(actual.revision.content.productionManifest?.reviewBinding),plain(evidence)),'MANIFEST_REVIEW_BINDING','清单候选与当前验收绑定不一致',409);
 await lockProofSources(unit);
}

export async function productionRecipeInputs(unit,workItemId){
 const c=await productionContext(unit,workItemId),key=c.value.deliverableKey;
 if(![...frames,'SHOT_VIDEO'].includes(key))return {inputs:[],basis:null};
 const lock=await inputLock(c),timing=await animaticFor(c),basis={inputLockRevisionId:lock.version.revisionId,shotSlices:timing.slice,strategyHash:hash(c.planned.keyframeStrategy),videoBranch:c.planned.videoBranch,handles:c.planned.handles};
 if(frames.includes(key))return {inputs:[],basis};
 check(['SILENT','AUDIO_DRIVEN','POST_LIP'].includes(c.planned.videoBranch),'VIDEO_BRANCH_REQUIRED','请确认本镜声音分支',409);
 const set=await productionFrameSet(c),inputs=set.versions;
 if(c.planned.videoBranch==='AUDIO_DRIVEN'){
  const lines=c.planned.dialogueLines||[];check(lines.length&&lines.every(l=>l.purpose==='FINAL'),'FINAL_DIALOGUE_REQUIRED','声音驱动视频须准备全部正式对白',409);
  for(const line of lines){const output=(await peers(c)).find(o=>o.content.deliverableKey==='DIALOGUE_DRY'&&o.content.outputSlot===line.id);check(output,'FINAL_DIALOGUE_REQUIRED','正式对白预期产物缺失',409);inputs.push(await productionVersion(unit,output));}
 }
 return {inputs,basis:{...basis,keyframeSetId:set.id}};
}
export async function productionReadiness(unit,sceneId,shots){
 const outputs=(await unit.rows(['EXPECTED_OUTPUT'])).filter(o=>o.content.sceneId===sceneId&&o.content.expectationState==='PLANNED'),rows=[];
 for(const shot of shots){let blockers=[];const output=outputs.find(o=>o.content.shotId===shot.id&&o.content.deliverableKey==='SHOT_VIDEO');
  try{check(output,'PRODUCTION_PLAN_REQUIRED','尚未建立本镜制作计划',409);await productionRecipeInputs(unit,output.content.workItemId);}catch(e){if(!e.code)throw e;blockers=[e.message];}
  rows.push({shotId:shot.id,title:shot.title,ready:!blockers.length,blockers});
 }
 return {ready:rows.length>0&&rows.every(r=>r.ready),readyCount:rows.filter(r=>r.ready).length,shotCount:shots.length,shots:rows};
}
