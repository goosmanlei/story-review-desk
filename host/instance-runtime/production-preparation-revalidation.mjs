import {canonicalJson,sha256} from './bytes.mjs';
import {currentGraph} from './domain-service.mjs';
import {directoryProjection} from './material-directory.mjs';

const hash=value=>sha256(canonicalJson(value));
const decode=row=>row?JSON.parse(Buffer.from(row.bytes).toString('utf8')):null;
const conflict=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const invalid=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_INVALID'});};
const unique=(rows,id,key='id')=>{const matches=(rows||[]).filter(row=>row[key]===id);return matches.length===1?matches[0]:null;};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const withoutAlias=({displayId,...row})=>row;
const candidates=view=>(view.eventsByKind?.['creative-revision']||[]).filter(row=>row.subjectKind==='EPISODE_PLAN'&&row.subjectId===(view.profile?.episodePlanId||view.snapshot.instance?.episodePlanId));
function candidateFor(view,basis){
 const row=unique(candidates(view),basis?.candidateRevisionId,'creativeRevisionId');
 return row&&row.contentHash===basis?.candidateContentHash&&hash(row.content)===row.contentHash?row:null;
}
function currentCandidate(view){return [...candidates(view)].sort((a,b)=>Number(b.eventSequence||0)-Number(a.eventSequence||0)||String(b.recordedAt).localeCompare(String(a.recordedAt)))[0]||null;}
function sceneFor(candidate,id){
 const scene=unique(candidate?.content?.narrativeRevision?.scenes,id);
 return scene&&Array.isArray(scene.scriptBlocks)&&hash(scene.scriptBlocks)===scene.contentHash?scene:null;
}
/** Immutable preparation input, local to one permanent scene. Episode design is
 * intentionally included: a changed episode purpose can affect unchanged words.
 * Neither the whole candidate ID/hash nor unrelated episodes are dependencies. */
export function preparationSceneInput(candidate,sceneId){
 const plan=candidate?.content,narrative=plan?.narrativeRevision,scene=sceneFor(candidate,sceneId);
 const owners=(plan?.episodes||[]).filter(ep=>ep.sceneIds.includes(sceneId));
 if(!scene||owners.length!==1)return null;
 const episode=owners[0],ordered=plan.episodes.flatMap(ep=>ep.sceneIds),index=ordered.indexOf(sceneId);
 const adjacent=id=>{if(!id)return null;const row=sceneFor(candidate,id),owner=plan.episodes.filter(ep=>ep.sceneIds.includes(id));return row&&owner.length===1?{episodeUid:owner[0].episodeUid,scene:withoutAlias(row)}:undefined;};
 const previous=adjacent(ordered[index-1]),next=adjacent(ordered[index+1]);
 if(previous===undefined||next===undefined)return null;
 const chains=(narrative.causalChains||[]).filter(c=>[...(c.setupSceneIds||[]),...(c.payoffSceneIds||[])].includes(sceneId));
 const causal=chains.map(chain=>({chain,scenes:[...new Set([...(chain.setupSceneIds||[]),...(chain.payoffSceneIds||[])])].sort().map(adjacent)}));
 if(causal.some(c=>c.scenes.some(s=>s===undefined)))return null;
 const local=new Set([sceneId,...causal.flatMap(c=>c.scenes.map(s=>s.scene.id))]);
 return {schemaVersion:'1.0',planId:plan.planId,episode:withoutAlias(episode),scene:withoutAlias(scene),previous,next,causal,
  sources:(narrative.sourceNarrationIndex||[]).filter(row=>(row.sceneIds||[]).some(id=>local.has(id))).map(row=>({...row,sceneIds:row.sceneIds.filter(id=>local.has(id))})),
  sourceHashes:{baseScriptSha256:narrative.baseScriptSha256,transcriptSha256:narrative.transcriptSha256},runtimeMethod:narrative.runtimeMethod};
}
function inputHash(candidate,id){const input=preparationSceneInput(candidate,id);return input?hash(input):null;}
function preparedSceneValid(row,content,candidate){
 const scene=sceneFor(candidate,row?.sceneId);
 return Boolean(scene&&row.sceneContentHash===scene.contentHash&&candidate.content.episodes.some(ep=>ep.episodeUid===row.episodeUid&&ep.sceneIds.includes(row.sceneId))&&content);
}
function boundRecord(row,binding){return Boolean(row&&binding&&row.revisionId===binding.revisionId&&row.sha256===binding.sha256&&sha256(row.bytes)===row.sha256);}
async function historical(tx,namespace,current,binding){
 const row=current?.revisionId===binding?.revisionId?current:binding?.revisionId?await tx.getAux(namespace,'current',{revisionId:binding.revisionId}):null;
 return boundRecord(row,binding)?row:null;
}
async function directoryContext(tx,view,record,current=false){
 if(!record)return null;
 const content=decode(record),ref=content.graphRef;
 let graph;
 if(current)graph=(await currentGraph(tx,view)).graph;
 else {const row=ref?.revisionId?await tx.getAux('domain-graph','current',{revisionId:ref.revisionId}):null;if(!row||row.sha256!==ref.sha256||sha256(row.bytes)!==row.sha256)return null;graph=decode(row);}
 // Old requirement hashes are checked separately; keep this historical directory
 // projection independent of current requirements so one changed need stays local.
 const result=structuredClone(graph);
 for(const key of ['entities','states','relations'])for(const row of content['new'+key[0].toUpperCase()+key.slice(1)]||[])if(!result[key].some(r=>r.id===row.id))result[key].push(row);
 return {content,graph:result,current};
}
function directoryRequirement(context,requirementId){
 if(!context)return null;
 const binding=unique(context.content.directoryBindings,requirementId,'requirementId');
 if(!binding)return null;
 const representation=unique(context.graph.representations,binding.representationId),entity=unique(context.graph.entities,binding.entityId),state=unique(context.graph.states,binding.stateId);
 if(!representation||!entity||!state||state.entityId!==entity.id||hash(representation)!==binding.representationHash)return null;
 return {binding,entity,state,representation};
}
async function inputs(tx){
 const view=await tx.readView(),preparationRecord=await tx.getAux('production-preparation','current'),linksRecord=await tx.getAux('preparation-material-links','current'),directoryRecord=await tx.getAux('material-directory','current');
 const content=decode(preparationRecord),links=decode(linksRecord),candidate=currentCandidate(view),oldCandidate=candidateFor(view,content?.basis);
 const frozenPreparation=await historical(tx,'production-preparation',preparationRecord,links?.preparationBinding),frozenDirectory=await historical(tx,'material-directory',directoryRecord,links?.directoryBinding);
 const frozenContent=decode(frozenPreparation),linkCandidate=candidateFor(view,links?.basis);
 const [directory,oldDirectory]=await Promise.all([directoryContext(tx,view,directoryRecord,true),directoryContext(tx,view,frozenDirectory)]);
 const effective=directory?directoryProjection({...view.snapshot.productionModel,domainGraph:(await currentGraph(tx,view)).graph},directory.content):null;
 return {view,preparationRecord,linksRecord,directoryRecord,content,links,candidate,oldCandidate,frozenPreparation,frozenContent,linkCandidate,directory,oldDirectory,effective};
}
/** A read proves exact local equivalence without appending or changing the old
 * candidate binding. Invalid occurrences are returned separately, never hidden
 * by a global candidate/directory revision mismatch. */
export async function projectPreparationUsage(tx){
 const ctx=await inputs(tx),{view,content,links,candidate,oldCandidate}=ctx;
 const sceneValidity=(candidate?.content.narrativeRevision.scenes||[]).map(scene=>{
  const old=unique(content?.scenes,scene.id,'sceneId'),before=inputHash(oldCandidate,scene.id),after=inputHash(candidate,scene.id);
  return {sceneId:scene.id,inputHash:after,valid:Boolean(old&&before&&before===after&&preparedSceneValid(old,content,oldCandidate)),reason:!old?'PREPARATION_MISSING':before&&before===after?'':'SCENE_INPUT_CHANGED'};
 });
 const validScenes=new Map(sceneValidity.map(row=>[row.sceneId,row])),pending=[],scenes=[];
 for(const link of links?.scenes||[]){
  const row=validScenes.get(link.sceneId),currentPrep=unique(content?.scenes,link.sceneId,'sceneId'),frozenPrep=unique(ctx.frozenContent?.scenes,link.sceneId,'sceneId');
  const linkInput=inputHash(ctx.linkCandidate,link.sceneId);
  const scopeValid=Boolean(unique(links.scenes,link.sceneId,'sceneId')&&row?.valid&&linkInput&&linkInput===row.inputHash&&ctx.frozenPreparation&&frozenPrep&&currentPrep&&hash(currentPrep)===hash(frozenPrep)&&preparedSceneValid(frozenPrep,ctx.frozenContent,ctx.linkCandidate)&&link.sceneContentHash===frozenPrep.sceneContentHash&&link.episodeUid===frozenPrep.episodeUid);
  const references=[];
  for(const ref of link.references||[]){
   const requirement=unique(view.snapshot.productionModel.materialRequirements,ref.requirementId),before=directoryRequirement(ctx.oldDirectory,ref.requirementId),after=directoryRequirement(ctx.directory,ref.requirementId);
   const valid=Boolean(unique(link.references,ref.requirementId,'requirementId')&&scopeValid&&requirement?.requirementClass==='REQUIRED'&&requirement.requirementHash===ref.requirementHash&&before&&after&&hash(before)===hash(after)&&ctx.effective?.bindings.some(b=>b.requirementId===ref.requirementId));
   if(valid)references.push({...ref,validity:'EXACT_CURRENT_EVIDENCE'});
   else pending.push({sceneId:link.sceneId,requirementId:ref.requirementId,reason:!scopeValid?'SCENE_OR_PREPARATION_CHANGED':!requirement||requirement.requirementHash!==ref.requirementHash?'REQUIREMENT_CHANGED':'DIRECTORY_BINDING_CHANGED'});
  }
  if(scopeValid)scenes.push({...link,references,usageValidity:'EXACT_CURRENT_EVIDENCE'});
  else if(!(link.references||[]).length)pending.push({sceneId:link.sceneId,requirementId:null,reason:'SCENE_OR_PREPARATION_CHANGED'});
 }
 return {ctx,sceneValidity,materialLinks:links?{...links,projectionPolicy:'PER_OCCURRENCE_V2',projectionCandidate:{revisionId:candidate?.creativeRevisionId,contentHash:candidate?.contentHash},scenes,pending}:null,materialLinksStale:pending.length>0};
}
function updateMap(rows,label){
 if(!Array.isArray(rows)||rows.some(row=>!plain(row)||typeof row.sceneId!=='string')||new Set(rows.map(row=>row.sceneId)).size!==rows.length)invalid(label+'必须按永久场身份唯一登记');
 return new Map(rows.map(row=>[row.sceneId,row]));
}
function reason(row,label){if(typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>4000)invalid(label+'需要明确的重核说明');}
function canonicalScene(row,scene,episode,candidate,preparation,provenance){
 return {...row,sceneId:scene.id,displayId:scene.displayId,episodeUid:episode.episodeUid,episodeDisplayId:episode.displayId,title:scene.title,sceneContentHash:scene.contentHash,
  sourceSummary:{title:scene.title,slugline:scene.slugline,purpose:scene.purpose,storyTime:scene.storyTime,audienceKnown:scene.audienceKnown,audienceWithheld:scene.audienceWithheld,transition:scene.transition},
  sourceEvidence:{candidateRevisionId:candidate.creativeRevisionId,dossierEpisodeUid:episode.episodeUid,narrativeRef:'NARRATIVE:'+scene.id+':'+scene.contentHash,scriptBlockIds:scene.scriptBlocks.map(b=>b.id),sourceSegmentIds:scene.sourceSegmentIds||[]},
  preparation:{...preparation,sourceDialogue:scene.scriptBlocks.filter(b=>b.type==='dialogue').map(b=>({scriptBlockId:b.id,speaker:b.speaker,text:b.text,performanceNote:b.performanceNote||''})),formalShotIds:[],generationAuthorized:false,formalReviewCreated:false,adoptionCreated:false},
  revalidation:provenance};
}
function validateReferences(rows,sceneId,ctx){
 if(!Array.isArray(rows)||new Set(rows.map(r=>r.requirementId)).size!==rows.length)invalid('用途引用必须唯一：'+sceneId);
 for(const ref of rows){const requirement=unique(ctx.view.snapshot.productionModel.materialRequirements,ref.requirementId);if(!requirement||requirement.requirementClass!=='REQUIRED'||requirement.requirementHash!==ref.requirementHash||!ctx.effective?.bindings.some(b=>b.requirementId===ref.requirementId))invalid('用途必须绑定当前有效需求及目录：'+ref.requirementId);if(typeof ref.reason!=='string'||!ref.reason.trim()||typeof ref.matchKind!=='string'||!ref.matchKind.trim())invalid('用途缺少具体依据：'+ref.requirementId);}
}
export async function previewPreparationRevalidation(tx,input,validateFacts){
 const projected=await projectPreparationUsage(tx),ctx=projected.ctx,{view,content,candidate}=ctx;
 if(!content||!candidate||!ctx.links||!ctx.directoryRecord)conflict('重核需要现有准备稿、用途图谱、当前候选和素材目录');
 if(input.expectedReleaseId!==view.releaseId||input.expectedRevisionId!==ctx.preparationRecord.revisionId||input.expectedLinksRevisionId!==ctx.linksRecord.revisionId||input.expectedDirectoryRevisionId!==ctx.directoryRecord.revisionId)conflict('重核基线已变化，请重新预览');
 if(input.candidateRevisionId!==candidate.creativeRevisionId||input.candidateContentHash!==candidate.contentHash||hash(candidate.content)!==candidate.contentHash)conflict('当前候选已变化或内容不完整');
 const updates=updateMap(input.sceneUpdates||[],'准备稿更新'),materialUpdates=updateMap(input.materialUpdates||[],'用途更新'),validity=new Map(projected.sceneValidity.map(row=>[row.sceneId,row]));
 for(const id of [...updates.keys(),...materialUpdates.keys()])if(!validity.has(id))invalid('更新场不在当前候选：'+id);
 const requiredSceneIds=[],requiredMaterialSceneIds=[],carriedSceneIds=[],scenes=[],materialScenes=[];
 for(const scene of candidate.content.narrativeRevision.scenes){
  const valid=validity.get(scene.id),old=unique(content.scenes,scene.id,'sceneId'),update=updates.get(scene.id),materialUpdate=materialUpdates.get(scene.id),episode=candidate.content.episodes.find(ep=>ep.sceneIds.includes(scene.id));
  if(!valid.inputHash)invalid('无法重建本场精确输入：'+scene.id);
  if(update){reason(update,'准备稿更新');if(update.expectedInputHash!==valid.inputHash||!plain(update.preparation))invalid('准备稿更新必须绑定预览输入：'+scene.id);validateFacts(update.preparation);for(const key of ['sceneRole','audienceTakeaway','visualIntent','soundAndDialogueIntent','reviewFocus'])if(typeof update.preparation[key]!=='string'||!update.preparation[key].trim())invalid('本场作者内容缺失：'+scene.id+'/'+key);if(!Array.isArray(update.preparation.beats)||!update.preparation.beats.length)invalid('本场节拍不能为空：'+scene.id);}
  if(!valid.valid&&!update)requiredSceneIds.push(scene.id);
  if(valid.valid&&!update)carriedSceneIds.push(scene.id);
  const preparation=update?.preparation||old?.preparation||{};
  scenes.push(canonicalScene(old||{},scene,episode,candidate,preparation,{protocol:'PREPARATION_REVALIDATION_V1',inputHash:valid.inputHash,mode:update?'REAUTHORED':'EXACT_INPUT_CARRY',previousPreparationRevisionId:ctx.preparationRecord.revisionId,previousSceneHash:old?hash(old):null,previousCandidateRevisionId:content.basis.candidateRevisionId,reason:update?.reason||'永久身份与完整局部输入闭包相同'}));
  const previous=unique(ctx.links.scenes,scene.id,'sceneId'),exact=unique(projected.materialLinks?.scenes,scene.id,'sceneId');
  const materialValid=Boolean(exact&&!projected.materialLinks.pending.some(row=>row.sceneId===scene.id)&&!update);
  if(materialUpdate){reason(materialUpdate,'用途更新');validateFacts(materialUpdate);if(materialUpdate.expectedInputHash!==valid.inputHash)invalid('用途更新输入已变化：'+scene.id);validateReferences(materialUpdate.references,scene.id,ctx);if(!Array.isArray(materialUpdate.unboundNeeds))invalid('用途更新必须明确列出未绑定需要：'+scene.id);}
  if(!materialValid&&!materialUpdate)requiredMaterialSceneIds.push(scene.id);
  const selected=materialUpdate||exact||previous||{references:[],unboundNeeds:[]};
  materialScenes.push({sceneId:scene.id,episodeUid:episode.episodeUid,sceneContentHash:scene.contentHash,references:selected.references.map(({validity,...ref})=>ref),unboundNeeds:selected.unboundNeeds||[],revalidation:{mode:materialUpdate?'EXPLICIT_REVIEW':'EXACT_INPUT_CARRY',reason:materialUpdate?.reason||'本场准备与逐项需求、目录闭包相同',previousLinksRevisionId:ctx.linksRecord.revisionId}});
 }
 const basis={...content.basis,candidateRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash,contextHash:candidate.contextHash,basisBindingsHash:candidate.basisBindingsHash,snapshotId:view.snapshot.snapshotId,sourceRole:'CANDIDATE',sourceEndpoint:'/api/v8/ui/episode-plan?revisionId='+encodeURIComponent(candidate.creativeRevisionId)};
 const nextContent={...content,schemaVersion:'1.1',kind:'PRODUCTION_PREPARATION',basis,episodes:candidate.content.episodes.map(({episodeUid,displayId,title,sceneIds})=>({episodeUid,displayId,title,sceneIds})),scenes,formalAdoptionPerformed:false,basisRevalidation:{protocol:'PREPARATION_REVALIDATION_V1',previousRevisionId:ctx.preparationRecord.revisionId,previousSha256:ctx.preparationRecord.sha256,previousLinksRevisionId:ctx.linksRecord.revisionId,previousLinksSha256:ctx.linksRecord.sha256},coverage:{...content.coverage,basisEpisodeCount:candidate.content.episodes.length,basisSceneCount:scenes.length,preparedSceneCount:scenes.length,uniqueSceneCount:scenes.length}};
 const nextLinks={...ctx.links,basis:{...ctx.links.basis,candidateRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash},scenes:materialScenes};
 const body={protocol:'PREPARATION_REVALIDATION_V1',expectedReleaseId:view.releaseId,expectedRevisionId:ctx.preparationRecord.revisionId,expectedLinksRevisionId:ctx.linksRecord.revisionId,expectedDirectoryRevisionId:ctx.directoryRecord.revisionId,candidateRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash,sceneInputs:projected.sceneValidity.map(({sceneId,inputHash,valid})=>({sceneId,inputHash,valid})),carriedSceneIds,requiredSceneIds,requiredMaterialSceneIds,contentHash:hash(nextContent),linksHash:hash(nextLinks),ready:!requiredSceneIds.length&&!requiredMaterialSceneIds.length,formalAdoptionPerformed:false};
 return {...body,previewHash:hash(body),nextContent,nextLinks};
}
export async function applyPreparationRevalidation(tx,input,validateFacts){
 if(typeof input.requestId!=='string'||!/^[A-Za-z0-9._:-]{8,160}$/.test(input.requestId))invalid('重核需要稳定请求身份');
 const requestHash=hash(input),prior=decode(await tx.getAux('preparation-revalidation-requests',input.requestId));
 if(prior){if(prior.requestHash!==requestHash)conflict('重核请求身份已用于其他内容');return prior.result;}
 const plan=await previewPreparationRevalidation(tx,input,validateFacts);
 if(!plan.ready)conflict('仍有准备稿或用途需要明确重核，不能自动换绑');
 if(input.previewHash!==plan.previewHash)conflict('重核预览已变化');
 const prep=await tx.putAux({namespace:'production-preparation',key:'current',bytes:canonicalJson(plan.nextContent),expectedRevisionId:plan.expectedRevisionId});
 const directory=await tx.getAux('material-directory','current');
 const links={...plan.nextLinks,preparationBinding:{revisionId:prep.revisionId,sha256:prep.sha256},directoryBinding:{revisionId:directory.revisionId,sha256:directory.sha256}};
 const saved=await tx.putAux({namespace:'preparation-material-links',key:'current',bytes:canonicalJson(links),expectedRevisionId:plan.expectedLinksRevisionId});
 const result={protocol:plan.protocol,revisionId:prep.revisionId,contentHash:prep.sha256,materialLinksRevisionId:saved.revisionId,materialLinksHash:saved.sha256,sceneCount:plan.nextContent.scenes.length,carriedSceneCount:plan.carriedSceneIds.length,formalAdoptionPerformed:false};
 await tx.putAux({namespace:'preparation-revalidation-requests',key:input.requestId,bytes:canonicalJson({requestHash,previewHash:plan.previewHash,result}),expectedRevisionId:null});
 return result;
}
