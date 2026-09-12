import {productionReviewSpec} from './review-spec.mjs';
import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead,idFor,idsFor} from '../presentation/read-unit.mjs';
import {assets,materialRows} from '../presentation/materials.mjs';

const list=(value,label,max=500)=>{check(Array.isArray(value)&&value.length<=max,'PRODUCTION_LIST',label+'列表无效');return value;};
const fields=(value,allowed,label)=>{check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k)),'PRODUCTION_FIELDS',label+'含不支持的字段');};
const text=(value,label,max=20000)=>{check(typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),'PRODUCTION_TEXT',label+'文本无效');return value;};
const planId=sceneId=>'shot-production:'+sceneId;
export async function shotSettingsBasis(unit,sceneId) {
  identity(sceneId);
  const scene=await unit.detail(sceneId);check(scene.kind==='SCENE','SCENE_REQUIRED','请选择永久场身份');
  const designs=(await unit.rows(['SHOT_DESIGN'])).filter(r=>idFor(r,'SCENE')===sceneId);
  check(designs.length<=1,'DESIGN_AMBIGUOUS','本场有多个设计对象，请先核对归属',409);
  const design=designs[0],shotIds=design?idsFor(design,'SHOT'):[];
  const rows=await unit.rows(['SHOT'],{ids:shotIds});
  check(rows.length===shotIds.length,'SHOT_BASIS_MISSING','本场镜头依据不完整',409);
  const shots=shotIds.map(id=>rows.find(r=>r.id===id));
  const saved=(await unit.rows(['NOTE'],{ids:[planId(sceneId)]}))[0];
  let published=saved?.content.status==='PUBLISHED'?saved:null;
  if(!published&&saved?.content.publishedRevisionId){const d=await unit.detail(saved.id,saved.content.publishedRevisionId);published={...saved,content:d.revision.content,revisionId:d.revision.id};}
  const releaseId=hash({scene:scene.revision.id,design:design?.revisionId,shots:shots.map(r=>[r.id,r.revisionId])});
  return {scene,design,shots,saved,published,releaseId};
}
export function defaultShotSettings(basis,requirements) {
  if(!basis.design)return null;
  return {schemaVersion:'2.0',stagePolicy:'PREVIS_FIRST_V1',sceneId:basis.scene.id,shotPlanRevisionId:basis.design.revisionId,shotPlanHash:basis.design.sha256,shots:basis.shots.map(r=>({shotId:r.id,keyframeStrategy:r.content.design?.keyframeStrategy||{mode:'UNDECIDED',reason:'等待确认本镜关键帧策略',intermediateFrameCount:0},dialogueLines:[],inputs:[],previsInputs:[],visualRequirementIds:idsFor(r,'REQUIREMENT').filter(id=>requirements.find(q=>q.id===id)?.mediaType!=='AUDIO'),space:{loc:'UNKNOWN',state:'UNKNOWN',zone:'UNKNOWN',camera:'UNKNOWN',freeze:'UNKNOWN'},handles:{headFrames:0,tailFrames:0},videoBranch:'UNKNOWN'}))};
}
export function validateShotSettings(content,basis,requirements) {
  fields(content,['schemaVersion','stagePolicy','sceneId','shotPlanRevisionId','shotPlanHash','shots'],'制作计划');
  check(content.schemaVersion==='2.0'&&content.stagePolicy==='PREVIS_FIRST_V1'&&content.sceneId===basis.scene.id&&content.shotPlanRevisionId===basis.design?.revisionId&&content.shotPlanHash===basis.design?.sha256,'PRODUCTION_BASIS','制作设置须绑定本场精确镜头设计',409);
  const rows=list(content.shots,'制作镜头',90),lines=new Set();
  check(hash(rows.map(r=>r.shotId))===hash(basis.shots.map(r=>r.id)),'SHOT_IDENTITY','制作设置须完整保留本场镜头身份与顺序',409);
  for(const [i,row] of rows.entries()){
    fields(row,['shotId','keyframeStrategy','dialogueLines','inputs','previsInputs','visualRequirementIds','space','handles','videoBranch'],'镜头设置');
    fields(row.keyframeStrategy,['mode','reason','intermediateFrameCount'],'关键帧策略');
    const strategy=row.keyframeStrategy;
    check(['UNDECIDED','START_ONLY','START_END','MULTI_KEYFRAME'].includes(strategy.mode)&&Number.isSafeInteger(strategy.intermediateFrameCount)&&(strategy.mode==='MULTI_KEYFRAME'?strategy.intermediateFrameCount>=1&&strategy.intermediateFrameCount<=24:strategy.intermediateFrameCount===0),'KEYFRAME_STRATEGY','关键帧策略与中间帧数量不一致');text(strategy.reason,'策略依据');
    check(['UNKNOWN','SILENT','AUDIO_DRIVEN','POST_LIP'].includes(row.videoBranch),'VIDEO_BRANCH','声音分支无效');
    for(const line of list(row.dialogueLines,'对白',100)){
      fields(line,['id','text','speakerEntityId','purpose','performance'],'对白');identity(line.id);check(!lines.has(line.id),'DIALOGUE_ID','对白身份重复');lines.add(line.id);text(line.text,'台词');text(line.performance,'表演');if(line.speakerEntityId!==null)identity(line.speakerEntityId);check(['TEMPORARY','FINAL'].includes(line.purpose),'DIALOGUE_PURPOSE','对白用途无效');
    }
    check(row.videoBranch!=='SILENT'||!row.dialogueLines.length,'SILENT_DIALOGUE','无对白分支不能登记对白');
    const allowed=idsFor(basis.shots[i],'REQUIREMENT');
    for(const key of ['inputs','previsInputs']){
      const seen=new Set();for(const input of list(row[key],key,100)){
        fields(input,['requirementId','familyId','versionId','sha256','purpose'],'素材输入');for(const k of ['requirementId','familyId','versionId'])identity(input[k]);
        check(allowed.includes(input.requirementId)&&/^[a-f0-9]{64}$/.test(input.sha256),'INPUT_BINDING','素材输入须绑定本镜需求、版本和 SHA');
        const unique=input.requirementId+':'+input.familyId;check(!seen.has(unique),'INPUT_DUPLICATE','素材输入重复');seen.add(unique);text(input.purpose||'REFERENCE','输入用途',300);
      }
    }
    const visual=allowed.filter(id=>requirements.find(r=>r.id===id)?.mediaType!=='AUDIO');
    check(hash(row.visualRequirementIds||[])===hash(visual),'REQUIREMENT_CLASSIFICATION','视觉需求分类已改变，请重新核对',409);
    fields(row.space,['loc','state','zone','camera','freeze'],'空间条件');for(const k of ['loc','state','zone','camera','freeze'])text(row.space[k],'空间条件',300);
    fields(row.handles,['headFrames','tailFrames'],'剪辑余量');for(const k of ['headFrames','tailFrames'])check(Number.isSafeInteger(row.handles[k])&&row.handles[k]>=0&&row.handles[k]<=240,'EDIT_HANDLES','剪辑余量须为 0 至 240 的整数帧');
  }
  return content;
}
const stages={SHOT_INPUT_LOCK:['SHOT_PLAN_INPUT_LOCK','PREVIS','TEXT','输入锁定记录'],STORYBOARD:['STORYBOARD_DIALOGUE','PREVIS','IMAGE','粗分镜'],DIALOGUE_TEMP:['STORYBOARD_DIALOGUE','PREVIS','AUDIO','临时对白'],DIALOGUE_DRY:['STORYBOARD_DIALOGUE','PREVIS','AUDIO','正式对白'],ANIMATIC:['ANIMATIC_LOCK','PREVIS','VIDEO','场级预演'],START_FRAME:['KEYFRAMES','SHOT_FINISH','IMAGE','首帧'],END_FRAME:['KEYFRAMES','SHOT_FINISH','IMAGE','尾帧'],INTERMEDIATE_FRAME:['KEYFRAMES','SHOT_FINISH','IMAGE','中间关键帧'],SHOT_VIDEO:['SHOT_VIDEO','SHOT_FINISH','VIDEO','镜头视频'],LOCKED_SHOT:['SHOT_LOCK','SHOT_FINISH','TEXT','单镜锁定记录']};
export function plannedShotOutputs(content) {
  const outputs=[];
  const add=(shot,key,slot='main')=>{const [gateId,phaseId,mediaType,label]=stages[key],scopeId=shot?.shotId||content.sceneId,token=hash({sceneId:content.sceneId,scopeId,key,slot}).slice(0,28);outputs.push({id:'shot-output:'+token,familyId:'shot-material:'+token,workItemId:'shot-work:'+token,workPackageId:'shot-package:'+hash({sceneId:content.sceneId,scopeId,gateId}).slice(0,28),sceneId:content.sceneId,shotId:shot?.shotId||null,scopeType:shot?'SHOT':'SCENE',scopeId,deliverableKey:key,outputSlot:slot,gateId,phaseId,mediaType,label,settings:shot||{sceneId:content.sceneId,shots:content.shots.map(s=>s.shotId)},expectationState:'PLANNED'});};
  for(const shot of content.shots){
    for(const key of ['SHOT_INPUT_LOCK','STORYBOARD','SHOT_VIDEO','LOCKED_SHOT'])add(shot,key);
    if(shot.keyframeStrategy.mode!=='UNDECIDED')add(shot,'START_FRAME');
    if(['START_END','MULTI_KEYFRAME'].includes(shot.keyframeStrategy.mode))add(shot,'END_FRAME');
    for(let i=0;i<shot.keyframeStrategy.intermediateFrameCount;i++)add(shot,'INTERMEDIATE_FRAME',String(i+1));
    for(const line of shot.dialogueLines){add(shot,'DIALOGUE_TEMP',line.id);if(line.purpose==='FINAL')add(shot,'DIALOGUE_DRY',line.id);}
  }
  add(null,'ANIMATIC');check(outputs.length<=400,'PRODUCTION_SCOPE_LIMIT','一次制作计划最多包含 400 个预期产物');return outputs;
}
export async function planShotSettingsChange(tx,body) {
  const unit=new PresentationRead(tx),basis=await shotSettingsBasis(unit,body.sceneId),{scene,design,shots,saved,published}=basis;
  check(design&&!scene.historical,'DESIGN_REQUIRED','请先建立本场镜头设计',409);
  const requirements=await materialRows(unit),media=await assets(unit);
  const assertions=[scene,...[design,...shots].map(r=>({...r,revision:{id:r.revisionId}}))].map(r=>({type:'assert',id:r.id,expectedVersion:r.version}));
  const validate=async content=>{
    validateShotSettings(content,basis,requirements);
    for(const shot of content.shots){
      for(const input of [...shot.inputs,...shot.previsInputs]){
        const req=requirements.find(r=>r.id===input.requirementId),v=media.assetVersions.find(v=>v.id===input.versionId&&v.familyId===input.familyId&&v.sha256===input.sha256&&v.canFlowDownstream);
        check(v&&req&&(req.assetFamilyRefs.includes(input.familyId)||req.materialUsageBindings?.some(b=>b.eligible&&b.familyId===input.familyId&&b.versionId===input.versionId&&b.sha256===input.sha256)),'INPUT_UNAVAILABLE','所选素材版本、权利或需求归属已改变',409);
        assertions.push({type:'assert',id:v.id,expectedVersion:v.objectVersion},{type:'assert',id:req.id,expectedVersion:req.objectVersion});
      }
      for(const line of shot.dialogueLines)if(line.speakerEntityId){const e=await unit.detail(line.speakerEntityId);check(e.kind==='ENTITY'&&e.revision.content.type==='CHARACTER','SPEAKER_IDENTITY','对白须绑定已登记人物');assertions.push({type:'assert',id:e.id,expectedVersion:e.version});}
    }
  };
  if(body.action==='save'){
    check(body.expectedReleaseId===basis.releaseId&&(body.expectedDraftRevisionId||null)===(saved?.revisionId||null),'VERSION_CONFLICT','制作设置或本场依据已改变；编辑仍保留',409);
    await validate(body.content);
    return {commands:[...assertions,{type:'save',id:planId(scene.id),kind:'NOTE',expectedVersion:saved?.version||0,title:scene.title+' · 镜头制作设置',content:{workspace:'shot-production',role:'SHOT_PRODUCTION_PLAN',sceneId:scene.id,status:'DRAFT',content:body.content,publishedRevisionId:published?.revisionId||null},links:[{id:scene.id,role:'SCENE'}],dependencies:[{revisionId:design.revisionId,purpose:'DESIGN'}]}],response:results=>({revisionId:results.at(-1).revisionId,contentHash:hash(body.content),formalAdoptionPerformed:false})};
  }
  check(['preview','publish'].includes(body.action),'PRODUCTION_ACTION','制作设置动作无效');
  check(saved?.content.status==='DRAFT'&&saved.revisionId===body.draftRevisionId,'VERSION_CONFLICT','请先保存并核对当前制作草稿',409);
  const content=saved.content.content;await validate(content);
  const configuration=await unit.configuration(),outputs=plannedShotOutputs(content).map(o=>({...o,reviewSpec:productionReviewSpec(o,scene,shots.find(s=>s.id===o.shotId),configuration)})),oldOutputs=(await unit.rows(['EXPECTED_OUTPUT'])).filter(r=>r.content.productionPlanId===planId(scene.id));
  const allOld=await unit.rows(['EXPECTED_OUTPUT','MATERIAL','NOTE'],{ids:[...outputs.flatMap(r=>[r.id,r.familyId]),...shots.map(r=>'shot-settings:'+r.id),'scene-settings:'+scene.id]});
  const expected=allOld.map(r=>[r.id,r.version,r.revisionId]),previewHash=hash({draft:saved.revisionId,basis:basis.releaseId,outputs,expected,previous:oldOutputs.map(r=>[r.id,r.version,r.revisionId])});
  assertions.push({type:'assert',id:saved.id,expectedVersion:saved.version},...oldOutputs.map(r=>({type:'assert',id:r.id,expectedVersion:r.version})));
  const preview={previewHash,sceneId:scene.id,draftRevisionId:saved.revisionId,expectedReleaseId:basis.releaseId,workItemCount:outputs.length,outputCount:outputs.length,previousWorkItemIds:oldOutputs.filter(r=>!outputs.some(o=>o.id===r.id)).map(r=>r.content.workItemId)};
  if(body.action==='preview')return {commands:assertions,response:()=>preview};
  check(body.previewHash===previewHash,'PREVIEW_STALE','制作需求预览已改变，请重新核对',409);
  const commands=[...assertions],settingRefs=new Map();
  for(const settings of [...content.shots,{sceneId:scene.id,shots:content.shots.map(s=>s.shotId)}]){
    const id=settings.shotId?'shot-settings:'+settings.shotId:'scene-settings:'+scene.id,old=allOld.find(r=>r.id===id),value={role:'SHOT_PRODUCTION_SETTINGS',settings};
    if(old&&hash(old.content)===hash(value)){commands.push({type:'assert',id,expectedVersion:old.version});settingRefs.set(settings.shotId||scene.id,{revisionId:old.revisionId,purpose:'DESIGN'});}
    else {settingRefs.set(settings.shotId||scene.id,{revisionIdFrom:commands.length,objectId:id,purpose:'DESIGN'});commands.push({type:'save',id,kind:'NOTE',expectedVersion:old?.version||0,title:'镜头制作设置',content:value,links:[{id:scene.id,role:'SCENE'},...(settings.shotId?[{id:settings.shotId,role:'SHOT'}]:[])],dependencies:[{revisionId:settings.shotId?shots.find(r=>r.id===settings.shotId).revisionId:scene.revision.id,purpose:settings.shotId?'DESIGN':'CONTENT'}]});}
  }
  for(const output of outputs){
    const {settings,...value}=output,old=allOld.find(r=>r.id===output.id),family=allOld.find(r=>r.id===output.familyId),links=[{id:scene.id,role:'SCENE'},...(output.shotId?[{id:output.shotId,role:'SHOT'}]:[])];
    if(!family)commands.push({type:'save',id:output.familyId,kind:'MATERIAL',expectedVersion:0,title:output.label,content:{kind:output.mediaType,label:output.label,ownerRef:output.workItemId,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION',deliverableKey:output.deliverableKey},links});
    const next={...value,productionPlanId:planId(scene.id),settingsHash:hash(settings)};
    if(old&&hash(old.content)===hash(next))commands.push({type:'assert',id:old.id,expectedVersion:old.version});
    else commands.push({type:'save',id:output.id,kind:'EXPECTED_OUTPUT',expectedVersion:old?.version||0,title:output.label,content:next,links:[...links,{id:output.familyId,role:'FAMILY'}],dependencies:[settingRefs.get(output.shotId||scene.id)]});
  }
  for(const old of oldOutputs.filter(r=>!outputs.some(o=>o.id===r.id)&&r.content.expectationState!=='RETIRED'))commands.push({type:'save',id:old.id,expectedVersion:old.version,content:{...old.content,expectationState:'RETIRED'}});
  commands.push({type:'save',id:saved.id,expectedVersion:saved.version,content:{...saved.content,status:'PUBLISHED',publishedRevisionId:null,outputIds:outputs.map(r=>r.id)}});
  return {commands,response:results=>({...preview,revisionId:results.at(-1).revisionId,status:'SUCCEEDED',formalAdoptionPerformed:false,generationAuthorized:false})};
}
