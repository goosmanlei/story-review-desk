import {assets} from './materials.mjs';
import {hash,check} from '../shared/contracts.mjs';
import {reviewHistory} from './review.mjs';
const parsed=value=>typeof value==='string'?JSON.parse(value):value;
async function scopeEvidence(unit,scopeId){
 const key='candidate-evidence:'+scopeId;if(unit.loaded.has(key))return unit.loaded.get(key);
 const rows=(await unit.tx.query("SELECT original_id,content FROM provenance WHERE kind=$1 AND (original_id='meta/config' OR original_id LIKE 'recipes/%' OR original_id LIKE 'executions/%') ORDER BY original_id",['aux:local-trial:'+scopeId])).rows;
 const decode=r=>{const body=parsed(r.content.body||r.content);return parsed(body.value||body.body||body);};
 const config=rows.find(r=>r.original_id==='meta/config');
 const result={config:config?decode(config):null,recipes:rows.filter(r=>r.original_id.startsWith('recipes/')).map(decode),executions:rows.filter(r=>r.original_id.startsWith('executions/')).map(r=>({...decode(r),historical:true,executionAuthorized:false}))};unit.loaded.set(key,result);return result;
}
export async function candidateScopeIndex(unit){
 const rows=(await unit.rows(['ASSET'],{historical:true})).filter(r=>r.content.sourceRef?.scopeId&&r.content.sourceRef.trialAssetId===r.id);
 const ids=[...new Set(rows.map(r=>r.content.sourceRef.scopeId))].sort(),profile=await unit.profile(),scopes=[];
 for(const id of ids){const {config}=await scopeEvidence(unit,id);check(!config||config.scope?.id===id,'CANDIDATE_SCOPE','候选范围与原始证明不一致',409);scopes.push({id,title:config?.scope?.title||'独立素材候选',projectTitle:config?.scope?.projectTitle||profile.storyTitle,countsTowardFormalProject:false,executionAuthorized:false});}
 return {schemaVersion:'1.0',scopes,defaultScopeId:scopes[0]?.id||null};
}
export async function candidateSnapshot(unit,scopeId){
 const index=await candidateScopeIndex(unit),scope=index.scopes.find(s=>s.id===(scopeId||index.defaultScopeId));check(scope,'CANDIDATE_SCOPE','此候选范围不存在',404);
 const media=await assets(unit),rows=media.assetVersions.filter(v=>v.sourceRef?.scopeId===scope.id&&v.sourceRef.trialAssetId===v.id),events=await reviewHistory(unit,{limit:5000}),evidence=await scopeEvidence(unit,scope.id);
 const projected=rows.map(v=>{const head=events.find(e=>e.subjectId===v.familyId&&e.versionId===v.id);return {id:v.id,objectRevisionId:v.revisionId,expectedVersion:v.objectVersion,mediaId:v.familyId,versionId:v.sourceRef.versionId,scopeId:scope.id,sha256:v.sha256,mediaUrl:v.mediaUrl,mediaKind:v.mediaKind,version:Number(v.sourceRef.versionId?.match(/V(\d+)$/)?.[1]||1),title:v.title,metadata:{...v.metadata,RIGHTS_STATUS:v.rightsFact},prompt:v.actualPrompt||'',qa:v.technical||{},lifecycle:v.lifecycleState,reviewSpecHash:v.reviewSpec?.hash||hash(v.reviewSpec),reviewCriteria:(v.reviewSpec?.criteria||[]).map(c=>({id:c.id,label:c.label,description:c.question||c.description||''})),reviewHeadId:head?.eventId,latestReview:head?{payload:{decision:head.reviewDecision,comment:head.note,criteria:head.criterionFindings.map(c=>({id:c.criterionId,result:c.verdict,comment:c.note||''}))}}:undefined,reviewLock:{locked:v.outputState!=='PRESENT',reason:v.outputState!=='PRESENT'?'原件缺失或已退役，不能采用此候选':''},nonWaivableBlocked:v.rightsFact==='BLOCKED',countsTowardFormalProject:false};}).sort((a,b)=>a.mediaId.localeCompare(b.mediaId)||a.version-b.version||a.id.localeCompare(b.id));
 const recipes=evidence.recipes.map(r=>({...r,id:r.id||r.recipeId,subjectId:r.subjectId||r.mediaId,blockedBy:['本次尚未授予新的精确生成权限'],executionAuthorized:false})).filter(r=>r.id&&r.subjectId);
 for(const v of projected)if(!recipes.some(r=>r.subjectId===v.mediaId))recipes.push({id:'candidate-recipe:'+v.mediaId,subjectId:v.mediaId,label:v.title,model:typeof v.prompt==='object'?v.prompt.model||'UNKNOWN':'UNKNOWN',mediaKind:v.mediaKind,fullPrompt:typeof v.prompt==='string'?v.prompt:v.prompt.full||v.prompt.main||'',blockedBy:['本次尚未授予新的精确生成权限'],executionAuthorized:false});
 return {mode:'LOCAL_TRIAL',mutationEtag:unit.version(),scope,checkpoint:{historical:evidence.config?.checkpoint||null,executionAuthorized:false},recipes,story:evidence.config?.story||{episodes:[],sourceScenes:[],shotProposals:[],dialogue:[]},assets:projected,budgets:{historicalLimits:evidence.config?.limits||{},currentAuthorization:null},executions:evidence.executions};
}
export async function candidateDirectory(unit,graph){
 const media=await assets(unit),values=media.assetVersions.filter(v=>v.sourceRef?.scopeId&&v.sourceRef.trialAssetId===v.id),groups=new Map();
 for(const v of values){
  const key=v.sourceRef.scopeId+':'+v.familyId;
  let row=groups.get(key);
  if(!row){const explicit=[v.metadata?.ENTITY_ID,v.metadata?.SUBJECT_ID,v.metadata?.LOC].find(id=>graph.entities.some(e=>e.id===id));row={trialThemeId:'trial-theme:'+hash(key).slice(0,24),entityId:explicit||'UNASSIGNED',stateId:'BASE',title:v.title,mediaType:v.mediaKind,displayState:'待审阅',reason:'独立候选保留原范围与版本，正式采用和实际输入另行确认。',versions:[]};groups.set(key,row);}
  row.versions.push({scopeId:v.sourceRef.scopeId,mediaId:v.familyId,versionId:v.sourceRef.versionId,sha256:v.sha256,lifecycle:v.lifecycleState});
 }
 return [...groups.values()].map(r=>{r.versions.sort((a,b)=>a.versionId.localeCompare(b.versionId,undefined,{numeric:true}));return r;});
}
