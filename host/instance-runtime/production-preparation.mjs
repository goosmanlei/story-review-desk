import {canonicalJson,sha256} from './bytes.mjs';
import {projectPreparationUsage,previewPreparationRevalidation,applyPreparationRevalidation} from './production-preparation-revalidation.mjs';
const read=r=>r?JSON.parse(Buffer.from(r.bytes).toString('utf8')):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
// A CAS grants an edit of authoring fields, never a rewrite of source or binding facts.
const authoringKeys=new Set(['sceneRole','audienceTakeaway','informationBoundary','beats','visualIntent','soundAndDialogueIntent','entityStateRequirements','timeAndSpace','materialGaps','nextPreparationAction','reviewFocus']);
const immutableKeys=new Set(['sourceDialogue','generationAuthorized','formalShotIds','formalReviewCreated','adoptionCreated','formalAdoptionPerformed','adoptedAssetBindings','mediaObserved','canonicalEntityId','stateId','bindingStatus','locationBinding','stateBinding','zoneBinding','cameraBinding','freezeBinding']);
function immutableNested(value){
 if(Array.isArray(value)){const rows=value.map(immutableNested);return rows.some(v=>v!==undefined)?rows.map(v=>v===undefined?null:v):undefined;}
 if(!value||typeof value!=='object')return undefined;
 const entries=Object.entries(value).flatMap(([key,item])=>{if(immutableKeys.has(key))return [[key,{frozen:item}]];const nested=immutableNested(item);return nested===undefined?[]:[[key,nested]];});
 return entries.length?Object.fromEntries(entries):undefined;
}
function preparationEnvelope(content){
 const {scenes,...top}=content;
 return {...top,scenes:scenes.map(({preparation,...scene})=>({...scene,preparation:Object.fromEntries(Object.entries(preparation).flatMap(([key,value])=>{if(!authoringKeys.has(key))return [[key,value]];const frozen=immutableNested(value);return frozen===undefined?[]:[[key,frozen]];}))}))};
}
function validateInitialFacts(value){
 if(Array.isArray(value)){for(const row of value)validateInitialFacts(row);return;}
 if(!value||typeof value!=='object')return;
 for(const [key,item] of Object.entries(value)){
  if(['generationAuthorized','formalReviewCreated','adoptionCreated','formalAdoptionPerformed','mediaObserved'].includes(key)&&item!==false)fail('初始准备稿不能声明生成、观察、审阅或采用事实：'+key,'DOMAIN_INVALID');
  if(['formalShotIds','adoptedAssetBindings'].includes(key)&&(!Array.isArray(item)||item.length))fail('初始准备稿不能登记正式镜头或采用版本：'+key,'DOMAIN_INVALID');
  if(['canonicalEntityId','stateId','locationBinding','stateBinding','zoneBinding','cameraBinding','freezeBinding'].includes(key)&&item!==null&&item!=='UNKNOWN')fail('初始准备稿中的精确绑定必须保持待核：'+key,'DOMAIN_INVALID');
  if(key==='bindingStatus'&&!['UNKNOWN','UNBOUND_PROPOSAL'].includes(item))fail('初始准备稿不能声明已完成绑定','DOMAIN_INVALID');
  validateInitialFacts(item);
 }
}
export function preparationCandidate(view){const planId=view.profile?.episodePlanId||view.snapshot.instance?.episodePlanId;return [...(view.eventsByKind?.['creative-revision']||[])].filter(e=>e.subjectKind==='EPISODE_PLAN'&&(!planId||e.subjectId===planId)&&e.content?.narrativeRevision).sort((a,b)=>Number(b.eventSequence||0)-Number(a.eventSequence||0)||String(b.recordedAt).localeCompare(String(a.recordedAt)))[0]||null;}
export async function readProductionPreparation(tx){
 const projection=await projectPreparationUsage(tx),{view,preparationRecord:record,linksRecord,content:value,candidate}=projection.ctx;
 const comments=(await tx.listAux('production-preparation-comments')).map(r=>({...read(r),revisionId:r.revisionId}));
 return {releaseId:view.releaseId,revisionId:record?.revisionId||null,materialLinksRevisionId:linksRecord?.revisionId||null,directoryRevisionId:projection.ctx.directoryRecord?.revisionId||null,content:value,comments,materialLinks:projection.materialLinks,materialLinksStale:projection.materialLinksStale,sceneValidity:projection.sceneValidity,
  candidate:candidate?{revisionId:candidate.creativeRevisionId,contentHash:candidate.contentHash,episodes:candidate.content.episodes,scenes:candidate.content.narrativeRevision.scenes}:null,
  stale:Boolean(value&&(!candidate||value.basis?.candidateRevisionId!==candidate.creativeRevisionId||value.basis?.candidateContentHash!==candidate.contentHash)),readOnly:false,formalAdoptionPerformed:false,denominatorState:'UNKNOWN'};
}
export async function previewProductionPreparationRevalidation(tx,input){
 const {nextContent,nextLinks,...preview}=await previewPreparationRevalidation(tx,input,validateInitialFacts);
 return preview;
}
export async function applyProductionPreparationRevalidation(tx,input){return applyPreparationRevalidation(tx,input,validateInitialFacts);}
export async function saveProductionPreparation(tx,input){
 const requestHash=sha256(canonicalJson(input)),prior=read(await tx.getAux('production-preparation-requests',input.requestId));if(prior){if(prior.requestHash!==requestHash)fail('请求身份已用于其他内容');return prior.result;}
 const state=await readProductionPreparation(tx);if(input.expectedReleaseId!==state.releaseId||input.expectedRevisionId!==state.revisionId)fail('准备稿或实例已变化，请保留修改并重新核对');
 if(state.stale)fail('准备稿来源已变化；普通保存不能将原稿换绑到新候选');
 if(!state.candidate)fail('没有可绑定的完整分集候选','DOMAIN_INVALID');const content=structuredClone(input.content);
 if(!content||!Array.isArray(content.scenes)||content.basis?.candidateRevisionId!==state.candidate.revisionId||content.basis?.candidateContentHash!==state.candidate.contentHash)fail('准备稿必须绑定当前完整候选及哈希','DOMAIN_INVALID');
 const expected=new Map(state.candidate.scenes.map(s=>[s.id,s]));if(content.scenes.length!==expected.size||new Set(content.scenes.map(s=>s.sceneId)).size!==expected.size)fail('准备稿必须逐场且仅一次覆盖完整候选','DOMAIN_INVALID');
 for(const s of content.scenes){const scene=expected.get(s.sceneId);if(!scene||s.sceneContentHash!==scene.contentHash)fail('场正文身份或哈希不匹配：'+s.sceneId,'DOMAIN_INVALID');if(!state.candidate.episodes.some(ep=>ep.episodeUid===s.episodeUid&&ep.sceneIds.includes(s.sceneId)))fail('准备稿归集身份不匹配','DOMAIN_INVALID');if(!s.preparation||typeof s.preparation!=='object'||Array.isArray(s.preparation))fail('缺少逐场准备内容','DOMAIN_INVALID');}
 content.kind='PRODUCTION_PREPARATION';content.schemaVersion=state.content?.schemaVersion||'1.0';content.formalAdoptionPerformed=false;
 const episodeIdentity=episodes=>(episodes||[]).map(({episodeUid,displayId,title,sceneIds})=>({episodeUid,displayId,title,sceneIds}));
 if(!Array.isArray(content.episodes)||canonicalJson(episodeIdentity(content.episodes))!==canonicalJson(episodeIdentity(state.candidate.episodes)))fail('准备稿集目录必须精确保持当前候选身份、顺序及场归属','DOMAIN_INVALID');
 if(state.content){
  if(canonicalJson(preparationEnvelope(content))!==canonicalJson(preparationEnvelope(state.content)))fail('仅可修改本场作者准备字段；来源、集场身份及精确绑定事实不可通过准备稿编辑改写','DOMAIN_INVALID');
 }else validateInitialFacts(content);
 const record=await tx.putAux({namespace:'production-preparation',key:'current',bytes:canonicalJson(content),expectedRevisionId:state.revisionId});
 const result={revisionId:record.revisionId,contentHash:record.sha256,formalAdoptionPerformed:false};await tx.putAux({namespace:'production-preparation-requests',key:input.requestId,bytes:canonicalJson({requestHash,result}),expectedRevisionId:null});return result;
}
export async function commentProductionPreparation(tx,input){const state=await readProductionPreparation(tx);if(state.stale||state.revisionId!==input.expectedRevisionId||state.releaseId!==input.expectedReleaseId)fail('准备稿依据已变化');if(!state.content?.scenes.some(s=>s.sceneId===input.sceneId))fail('场不在准备稿内','DOMAIN_INVALID');if(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000)fail('意见必须为1至12000字','DOMAIN_INVALID');const key=input.requestId,old=await tx.getAux('production-preparation-comments',key),body={sceneId:input.sceneId,preparationRevisionId:state.revisionId,text:input.text.trim(),recordedAt:input.recordedAt||new Date().toISOString(),role:'COMMENT_ONLY'};if(old){const previous=read(old);if(previous.sceneId!==body.sceneId||previous.text!==body.text||previous.preparationRevisionId!==state.revisionId)fail('意见请求身份冲突');return{revisionId:old.revisionId};}const result=await tx.putAux({namespace:'production-preparation-comments',key,bytes:canonicalJson(body),expectedRevisionId:null});return{revisionId:result.revisionId,formalAdoptionPerformed:false};}
export async function savePreparationMaterialLinks(tx,input){
 const state=await readProductionPreparation(tx),view=await tx.readView(),content=structuredClone(input.content),head=await tx.getAux('preparation-material-links','current');
 if(input.expectedReleaseId!==state.releaseId||input.expectedRevisionId!==(head?.revisionId||null))fail('准备素材图谱基线已变化');
 if(!state.candidate||content?.basis?.candidateRevisionId!==state.candidate.revisionId||content?.basis?.candidateContentHash!==state.candidate.contentHash)fail('准备素材图谱必须绑定当前候选','DOMAIN_INVALID');
 if(!Array.isArray(content.scenes)||content.scenes.length!==state.candidate.scenes.length||new Set(content.scenes.map(s=>s.sceneId)).size!==state.candidate.scenes.length)fail('准备图谱须精确逐场覆盖','DOMAIN_INVALID');
 for(const s of content.scenes){if(!state.candidate.scenes.some(c=>c.id===s.sceneId&&c.contentHash===s.sceneContentHash)||!state.candidate.episodes.some(e=>e.episodeUid===s.episodeUid&&e.sceneIds.includes(s.sceneId)))fail('准备图谱场身份不匹配','DOMAIN_INVALID');for(const r of s.references||[]){const requirement=view.snapshot.productionModel.materialRequirements.find(m=>m.id===r.requirementId);if(!requirement||requirement.requirementHash!==r.requirementHash)fail('素材需求依据已变化：'+r.requirementId);}}
 const preparationRecord=await tx.getAux('production-preparation','current'),directoryRecord=await tx.getAux('material-directory','current');if(!preparationRecord||state.stale||!directoryRecord)fail('准备稿与实体目录必须存在且来源仍匹配');content.preparationBinding={revisionId:preparationRecord.revisionId,sha256:preparationRecord.sha256};content.directoryBinding={revisionId:directoryRecord.revisionId,sha256:directoryRecord.sha256};
 const result=await tx.putAux({namespace:'preparation-material-links',key:'current',bytes:canonicalJson(content),expectedRevisionId:head?.revisionId||null});return{revisionId:result.revisionId,formalAdoptionPerformed:false};
}
