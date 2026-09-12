import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead,idsFor} from '../presentation/read-unit.mjs';
import {sourceCatalog} from '../presentation/story.mjs';
import {randomUUID} from 'node:crypto';

const kinds=['STORY_OUTLINE','SCREENPLAY','SCENE_SCRIPT','EPISODE_PLAN'];
const show=row=>({...row.content,id:row.id,title:row.title,revisionId:row.revisionId,sha256:row.sha256,contentHash:row.sha256,status:row.state,sourcePath:'',createdAt:row.createdAt,updatedAt:row.updatedAt,formalAdoptionPerformed:false});
export async function authoringWorkspace(unit){
 const roots=(await unit.rows(['NOTE','SCENE'],{roles:['AUTHORING_ROOT']})).map(show),sources=await sourceCatalog(unit),stories=await unit.rows(['STORY']);
 check(stories.length<=1,'STORY_IDENTITY','当前实例只能绑定一个故事',409);
 const story=stories[0],candidates=story?.content.authoringRootId?[{creativeRevisionId:story.revisionId,rootId:story.content.authoringRootId,rootRevisionId:story.content.authoringRootRevisionId,review:null}]:[];
 return {releaseId:unit.version(),roots,sourceBindings:[],sourceChoices:sources.sources.map(s=>({sourceId:s.id,revisionId:s.revisionId,sha256:s.sha256,title:s.title})),candidates,adoptedCreativeRevisionId:story?.state==='ADOPTED'?story.revisionId:null,currentStory:story?{id:story.id,revisionId:story.revisionId,expectedVersion:story.version}:null,initializationReady:true,readOnly:false};
}
const isText=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max;
export async function planAuthoringChange(tx,input,operationId){
 const unit=new PresentationRead(tx),state=await authoringWorkspace(unit);
 if(input.action==='save'){
  const v=input.root;check(v&&kinds.includes(v.kind)&&isText(v.title,500)&&isText(v.body,500000),'AUTHORING_FIELDS','请填写完整草稿名称和正文');
  const id=v.id||'author:'+hash(operationId).slice(0,32);identity(id);
  const old=state.roots.find(r=>r.id===id);
  check((old?.revisionId||null)===(input.expectedRevisionId||null)&&(!old||old.kind===v.kind),'VERSION_CONFLICT','作者草稿已改变，未覆盖你的编辑',409);
  const existing=(await unit.rows(['NOTE','SCENE'],{ids:[id],historical:true}))[0];check(!existing||old,'AUTHORING_IDENTITY','所选身份不属于作者草稿',409);
  const parent=v.parentId?state.roots.find(r=>r.id===v.parentId):null;
  const parentKind=v.kind==='SCREENPLAY'?'STORY_OUTLINE':'SCREENPLAY';
  check(v.kind==='STORY_OUTLINE'?!v.parentId:parent?.kind===parentKind,'AUTHORING_PARENT','请选择正确的上层作者草稿');
  if(input.expectedParentRevisionId!==undefined)check((parent?.revisionId||null)===input.expectedParentRevisionId,'VERSION_CONFLICT','所选上层草稿已改变',409);
  check(Array.isArray(v.sourceBindings)&&v.sourceBindings.length<=100&&new Set(v.sourceBindings.map(s=>s.sourceId)).size===v.sourceBindings.length,'AUTHORING_SOURCES','来源清单无效');
  const dependencies=[],assertions=[];
  for(const source of v.sourceBindings){const d=await unit.detail(source.sourceId,source.revisionId);check(d.kind==='SOURCE'&&(d.revision.content.sha256||d.revision.sha256)===source.sha256,'SOURCE_BINDING','来源身份、版本或 SHA 不一致',409);dependencies.push({revisionId:source.revisionId,purpose:'SOURCE'});}
  if(parent){const d=await unit.detail(parent.id);assertions.push({type:'assert',id:parent.id,expectedVersion:d.version});dependencies.push({revisionId:parent.revisionId,purpose:'CONTENT'});}
  const sceneIds=v.kind==='EPISODE_PLAN'?v.sceneIds:[];
  check(Array.isArray(sceneIds)&&sceneIds.length<=500&&new Set(sceneIds).size===sceneIds.length,'AUTHORING_SCENES','场稿身份列表无效');
  const sceneRevisionBindings=[];
  for(const sceneId of sceneIds){const s=state.roots.find(r=>r.id===sceneId);check(s?.kind==='SCENE_SCRIPT'&&s.parentId===v.parentId,'AUTHORING_SCENE_PARENT','场稿不属于所选剧本',409);sceneRevisionBindings.push({sceneId,revisionId:s.revisionId,contentHash:s.sha256});dependencies.push({revisionId:s.revisionId,purpose:'CONTENT'});}
  if(v.planContent){check(v.kind==='EPISODE_PLAN'&&isText(v.planContent.planId,200)&&Array.isArray(v.planContent.episodes)&&v.planContent.episodes.length>0&&v.planContent.episodes.length<=200,'AUTHORING_PLAN','请导入完整分集方案');const assigned=v.planContent.episodes.flatMap(e=>e.sceneIds||[]);check(hash([...assigned].sort())===hash([...sceneIds].sort())&&new Set(assigned).size===assigned.length,'AUTHORING_COVERAGE','每份所选场稿须在分集方案中恰好出现一次');}
  const blocks=v.kind==='SCENE_SCRIPT'?(old?.body===v.body?old.scriptBlocks:[{id:old?.scriptBlocks?.length===1?old.scriptBlocks[0].id:'block:'+randomUUID(),type:'action',speaker:'',performanceNote:'',text:v.body}]):undefined;
  const content={role:'AUTHORING_ROOT',kind:v.kind,body:v.body,parentId:parent?.id||null,parentRevisionId:parent?.revisionId||null,sourceBindings:v.sourceBindings,sceneIds,sceneRevisionBindings,planContent:v.planContent||null,...(blocks?{text:v.body,blocks,scriptBlocks:blocks}:{}),authority:'A'};
  return {commands:[...assertions,{type:'save',id,kind:v.kind==='SCENE_SCRIPT'?'SCENE':'NOTE',title:v.title,expectedVersion:existing?.version||0,content,links:v.sourceBindings.map(s=>({id:s.sourceId,role:'SOURCE'})),dependencies}],response:r=>({root:{...content,id,title:v.title,revisionId:r.at(-1).revisionId,sha256:hash(content),contentHash:hash(content),status:'DRAFT',sourcePath:'',formalAdoptionPerformed:false},releaseId:r.at(-1).revisionId,formalAdoptionPerformed:false})};
 }
 check(input.action==='submit','AUTHORING_ACTION','正式审阅的一次确认即采用，无需额外同步审批');
 const root=state.roots.find(r=>r.id===input.rootId);check(root?.kind==='EPISODE_PLAN'&&root.planContent&&root.revisionId===input.expectedRevisionId,'VERSION_CONFLICT','请先保存并核对完整方案草稿',409);
 const row=await unit.detail(root.id),plan=root.planContent;
 check(!state.currentStory||plan.planId===state.currentStory.id,'STORY_IDENTITY','已绑定故事的永久身份不能替换',409);
 check((input.expectedStoryRevisionId||null)===(state.currentStory?.revisionId||null),'VERSION_CONFLICT','当前故事方案已改变',409);
 const commands=[{type:'assert',id:row.id,expectedVersion:row.version}],episodeIds=[],sceneDeps=[];
 for(const bound of root.sceneRevisionBindings){const scene=await unit.detail(bound.sceneId);check(scene.revision.id===bound.revisionId,'VERSION_CONFLICT','所选场稿已改变，请重新保存方案',409);commands.push({type:'assert',id:scene.id,expectedVersion:scene.version});sceneDeps.push({id:scene.id,revisionId:scene.revision.id,content:scene.revision.content});}
 const spec=(await unit.configuration()).reviewProfiles.find(p=>p.id==='episode-plan');
 check(spec?.criteria?.length,'REVIEW_SPEC_REQUIRED','请先配置分集叙事审阅标准',409);
 const episodeRefs=[];
 for(const [index,episode] of plan.episodes.entries()){
  identity(episode.episodeUid);check(!episodeIds.includes(episode.episodeUid)&&isText(episode.title,500)&&Array.isArray(episode.sceneIds)&&episode.sceneIds.length>0&&episode.reviewDossier,'EPISODE_CONTENT','分集永久身份、卷宗或场稿列表不完整');episodeIds.push(episode.episodeUid);
  const prior=(await unit.rows(['EPISODE'],{ids:[episode.episodeUid],historical:true}))[0];
  check(!prior,'AUTHORING_EXISTING_EPISODE','已有分集请使用集场编辑，不能由导入方案覆盖其正文或判断',409);
  const inputs=episode.sceneIds.map(id=>sceneDeps.find(s=>s.id===id));check(inputs.every(Boolean),'AUTHORING_COVERAGE','分集引用了未选择的场稿',409);
  if(plan.narrativeRevision?.scenes)for(const embedded of plan.narrativeRevision.scenes.filter(s=>episode.sceneIds.includes(s.id)))check(hash(embedded.scriptBlocks)===hash(inputs.find(s=>s.id===embedded.id).content.blocks),'AUTHORING_TEXT_CONFLICT','方案内嵌正文与所选场稿不一致；请先在场稿中确认',409);
  const {episodeUid,sceneIds,...content}=episode;
  episodeRefs.push({revisionIdFrom:commands.length,objectId:episodeUid,purpose:'CONTENT'});
  commands.push({type:'save',id:episodeUid,kind:'EPISODE',title:episode.title,displayId:episode.displayId||'',position:index,expectedVersion:0,content:{...content,reviewSpec:spec},links:sceneIds.map(id=>({id,role:'SCENE'})),dependencies:inputs.map(s=>({revisionId:s.revisionId,purpose:'CONTENT'}))});
 }
 const {scenes:discardScenes,documents:discardDocuments,...narrative}=plan.narrativeRevision||{};
 check(!discardDocuments?.length,'AUTHORING_DOCUMENTS','附文须先通过来源接口登记，不能在导入时静默舍弃');
 commands.push({type:'save',id:plan.planId,kind:'STORY',title:root.title,expectedVersion:state.currentStory?.expectedVersion||0,content:{...narrative,role:'EPISODE_PLAN',changeSummary:plan.changeSummary||root.body,retiredEpisodeUids:plan.retiredEpisodeUids||[],authoringRootId:root.id,authoringRootRevisionId:root.revisionId,reviewSpec:spec},links:episodeIds.map(id=>({id,role:'EPISODE'})),dependencies:[{revisionId:root.revisionId,purpose:'SOURCE'},...episodeRefs]});
 return {commands,response:r=>({creativeRevisionId:r.at(-1).revisionId,rootId:root.id,formalAdoptionPerformed:false,state:'DRAFT'})};
}
