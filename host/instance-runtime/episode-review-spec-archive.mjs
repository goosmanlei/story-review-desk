import {canonicalJson,sha256} from './bytes.mjs';
import {assertEpisodeReviewSpecInheritance,hasEpisodeReviewSpecInheritance} from './episode-review-spec-inheritance.mjs';
const parse=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
const hash=value=>sha256(Buffer.from(canonicalJson(value)));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const check=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{code:'EPISODE_REVIEW_SPEC_ARCHIVE'});};
// Release summaries intern only configuration/binding data. No script, graph,
// full snapshot, or media body is retained. Legacy archives remain unchanged.
export function createEpisodeReviewSpecArchiveValidator(){
 const events=[],releases=[],models=new Map(),profiles=new Map(),configs=new Map();
 let instanceId,bytes=0,overflow=false,marked=false;
 return {accept(table,row,parsedSnapshot){
  if(table==='repository_meta')instanceId=row.instance_id;
  if(table==='domain_events'){
   const event=parse(row.event_bytes);marked||=hasEpisodeReviewSpecInheritance(event);
   if(event.eventKind==='creative-revision'&&event.subjectKind==='EPISODE_PLAN'||hasEpisodeReviewSpecInheritance(event)){
    bytes+=Buffer.byteLength(row.event_bytes);if(bytes>64*1024*1024){overflow=true;events.length=0;}else if(!overflow)events.push(event);
   }
  }
  if(table==='record_revisions'&&row.namespace==='settings'&&['instance-profile','system-configuration'].includes(row.record_key)){
   check(sha256(row.content_bytes)===row.content_sha256,'分集标准历史配置原始 SHA 不符');
   const value=parse(row.content_bytes);
   (row.record_key==='instance-profile'?profiles:configs).set(row.revision_id,{sha256:row.content_sha256,value:row.record_key==='instance-profile'?{instanceId:value.instanceId,episodePlanId:value.episodePlanId,configurationRef:value.configurationRef}:value.configuration});
  }
  if(table==='releases'){
   const snapshot=parsedSnapshot||parse(row.snapshot_bytes),model=snapshot.productionModel||{},recipes=parse(row.recipes_bytes);
   const compact={systemConfiguration:model.systemConfiguration,configurationCandidates:(model.configurationCandidates||[]).map(r=>({id:r.id,creativeRevisionId:r.creativeRevisionId,reviewSpec:r.reviewSpec,configurationBinding:r.configurationBinding})),episodePlanRevisions:(model.episodePlanRevisions||[]).map(r=>({planId:r.planId,scopeRole:r.scopeRole,reviewSpec:r.reviewSpec,configurationBinding:r.configurationBinding}))};
   const key=hash(compact);if(!models.has(key))models.set(key,compact);
   releases.push({key,snapshotId:snapshot.snapshotId,recipeSnapshotId:recipes.snapshotId,createdAt:row.created_at,releaseId:row.release_id,profileRevisionId:row.profile_revision_id,snapshotSha256:row.snapshot_sha256,recipesSha256:row.recipes_sha256,sourceRevisionIds:row.source_revision_ids_json,configurationRef:recipes.configurationRef,instanceIds:[snapshot.instance?.instanceId,model.instance?.instanceId].filter(x=>x!==undefined),bytesValid:sha256(row.snapshot_bytes)===row.snapshot_sha256&&sha256(row.recipes_bytes)===row.recipes_sha256});
  }
 },finish(){
  if(!marked)return;
  check(!overflow,'分集标准继承事件证据超出64MiB有界校验容量');
  for(const event of events.filter(hasEpisodeReviewSpecInheritance)){
   const prior=releases.filter(r=>r.createdAt<=event.recordedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),latest=prior[0];
   check(latest&&latest.createdAt<event.recordedAt,'继承候选缺少严格先前实际发布');
   const group=prior.filter(r=>r.createdAt===latest.createdAt);
   check(new Set(group.map(r=>hash({snapshotId:r.snapshotId,snapshotSha256:r.snapshotSha256,recipesSha256:r.recipesSha256,profileRevisionId:r.profileRevisionId,sourceRevisionIds:r.sourceRevisionIds}))).size===1,'继承候选最新历史发布不唯一');
   check(latest.bytesValid&&latest.snapshotId===event.creationSnapshotId&&event.snapshotId===event.creationSnapshotId&&latest.recipeSnapshotId===latest.snapshotId,'继承候选创建快照／配方不符');
   const profile=profiles.get(latest.profileRevisionId)?.value,model=models.get(latest.key);
   check(profile&&profile.instanceId===instanceId&&latest.instanceIds.every(id=>id===instanceId)&&profile.episodePlanId===event.subjectId,'继承候选历史实例或永久方案不符');
   const ref=profile.configurationRef,configuration=configs.get(ref?.revisionId);
   check(configuration&&configuration.sha256===ref.sha256&&same(model.systemConfiguration?.reference,ref)&&same(latest.configurationRef,ref)&&same(model.systemConfiguration.config,configuration.value),'继承候选历史配置实际修订／SHA／内容不符');
   assertEpisodeReviewSpecInheritance({event,model,events});
  }
 }};
}
