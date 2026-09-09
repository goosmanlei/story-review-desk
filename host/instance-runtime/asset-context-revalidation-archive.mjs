import {sha256} from './bytes.mjs';
import {ASSET_CONTEXT_EVENT,ASSET_CONTEXT_SOURCE,contextCheck,contextHash,assetContextPublicationFacts,assertAssetContextPublicationFacts,validateAssetContextLedger} from './asset-context-revalidation-model.mjs';
const parse=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
const sorted=refs=>[...refs].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
const marker=e=>e.eventKind===ASSET_CONTEXT_EVENT||e.subjectType==='ASSET_CONTEXT'||Object.hasOwn(e,'revalidationRevisionId');
/** Bounded compact companion to the complete archive scanner. Historical
 * snapshot/recipe bodies are inspected once and never retained. Source byte
 * buffers are content-deduplicated; caller still validates every original row. */
export function createAssetContextArchiveValidator(){
 const documents=[],aliases=new Map(),releases=new Map(),events=[],manifest=[],buffers=new Map(),history=new Map(),profiles=new Map(),aux=new Map();let instanceId,currentReleaseId,total=0,sourceLimitExceeded=false;
 return{accept(table,row,parsedSnapshot){
  if(table==='repository_meta'){instanceId=row.instance_id;currentReleaseId=row.current_release_id;}
  if(table==='document_aliases'){const values=aliases.get(row.document_id)||[];values.push(row.alias);aliases.set(row.document_id,values);}
  if(table==='record_revisions'&&['aux:domain-graph','settings'].includes(row.namespace)){
   const value=parse(row.content_bytes);contextCheck(sha256(row.content_bytes)===row.content_sha256,'复核历史AUX/profile实际SHA不符');
   aux.set(row.revision_id,{sha256:row.content_sha256,hash:contextHash(value),configurationHash:value.configuration?contextHash(value.configuration):null});
   if(row.namespace==='settings'&&row.record_key==='instance-profile')profiles.set(row.revision_id,value);
  }
  if(table==='record_revisions'&&row.namespace==='documents'){
   let bytes=buffers.get(row.content_sha256);if(!bytes){bytes=Buffer.from(row.content_bytes);total+=bytes.length;if(total>128*1024*1024){sourceLimitExceeded=true;bytes=null;}else buffers.set(row.content_sha256,bytes);}
   documents.push({documentId:row.record_key,revisionId:row.revision_id,sha256:row.content_sha256,bytes,metadata:JSON.parse(row.metadata_json),deleted:Boolean(row.deleted)});
  }
  if(table==='domain_events'){const e=parse(row.event_bytes);manifest.push({eventId:e.eventId,eventSequence:e.eventSequence,sha256:contextHash(e)});if(marker(e)||e.eventKind==='review'&&e.subjectType==='ASSET'||['execution-request','run','asset-version'].includes(e.eventKind))events.push(e);}
  if(table==='releases'){
   const snapshot=parsedSnapshot||parse(row.snapshot_bytes),recipes=parse(row.recipes_bytes),refs=snapshot.productionModel?.assetContextRevalidationLedger;
   if(refs!==undefined)contextCheck(Array.isArray(refs),'归档复核ledger不是数组');
   for(const ref of refs||[]){const previous=history.get(ref.id);contextCheck(!previous||previous===contextHash(ref),'历史复核ledger被换绑');history.set(ref.id,contextHash(ref));}
   const release={releaseId:row.release_id,snapshotId:snapshot.snapshotId,snapshotSha256:row.snapshot_sha256,recipesSha256:row.recipes_sha256,profileRevisionId:row.profile_revision_id,createdAt:row.created_at,sourceRevisionIds:JSON.parse(row.source_revision_ids_json)};
   contextCheck(sha256(row.snapshot_bytes)===release.snapshotSha256&&sha256(row.recipes_bytes)===release.recipesSha256,'归档历史发布实际SHA不符');
   releases.set(release.releaseId,{release,facts:assetContextPublicationFacts({snapshot,recipes}),refHashes:(refs||[]).map(contextHash),ledgerHash:contextHash(sorted(refs||[])),count:(refs||[]).length,pinned:(refs||[]).every(r=>release.sourceRevisionIds.includes(r.sourceRevisionId))});
  }
 },finish(){
  for(const d of documents)d.aliases=aliases.get(d.documentId)||[];
  const contextDocuments=documents.filter(d=>d.metadata.sourceRole===ASSET_CONTEXT_SOURCE||d.aliases.some(a=>a.startsWith('story/asset-context-revalidations/'))),selected=events.filter(marker);
  if(!selected.length&&!contextDocuments.length&&!history.size)return;
  contextCheck(!sourceLimitExceeded,'复核归档固定来源超过128MiB有界验证容量');
  const current=releases.get(currentReleaseId);contextCheck(current&&current.pinned&&current.facts.instanceIds.every(id=>id===instanceId),'当前复核归档发布/实例/来源不符');
  const refs=selected.map(e=>({id:e.revalidationRevisionId,revalidationId:e.revalidationId,eventId:e.eventId,sourceRef:e.sourceRef,sourceRevisionId:e.sourceRevisionId,sourceSha256:e.sourceSha256}));
  contextCheck(current.count===refs.length&&current.ledgerHash===contextHash(sorted(refs)),'当前复核ledger丢失或多出历史事件');
  for(const [id,digest]of history)contextCheck(refs.some(r=>r.id===id&&contextHash(r)===digest),'当前复核ledger丢失历史成员');
  const beforeManifest=event=>manifest.filter(e=>e.eventSequence==null||e.eventSequence<event.eventSequence).sort((a,b)=>a.eventId.localeCompare(b.eventId)).map(({eventId,sha256})=>({eventId,sha256}));
  validateAssetContextLedger({snapshot:{instance:{instanceId},productionModel:{assetContextRevalidationLedger:refs}},documents,events,eventManifest:beforeManifest,validatePublication(body,event){
   const exactRef={id:event.revalidationRevisionId,revalidationId:event.revalidationId,eventId:event.eventId,sourceRef:event.sourceRef,sourceRevisionId:event.sourceRevisionId,sourceSha256:event.sourceSha256};
   for(const tied of releases.values())if(tied.release.createdAt===event.recordedAt)contextCheck(tied.refHashes.includes(contextHash(exactRef))&&tied.release.sourceRevisionIds.includes(event.sourceRevisionId),'同毫秒发布不是该精确复核事件的后置产物');
   const possible=[...releases.values()].filter(r=>Date.parse(r.release.createdAt)<Date.parse(event.recordedAt)).sort((a,b)=>Date.parse(b.release.createdAt)-Date.parse(a.release.createdAt)),latest=possible[0];
   contextCheck(latest&&latest.release.releaseId===body.baseReleaseId&&!possible.some((r,i)=>i&&r.release.createdAt===latest.release.createdAt),'复核归档基线并非事件之前唯一最新实际发布');
   contextCheck(latest.facts.instanceIds.every(id=>id===body.basis.instanceId)&&body.basis.instanceId===instanceId,'复核历史实际实例错误');
   const profile=profiles.get(latest.release.profileRevisionId);contextCheck(profile?.instanceId===instanceId,'复核原发布profile实际实例不可核');
   const graph=latest.facts.domainGraphRef;if(graph)contextCheck(aux.get(graph.revisionId)?.sha256===graph.sha256&&aux.get(graph.revisionId)?.hash===latest.facts.domainGraphHash,'复核历史DOMAIN AUX与实际快照不符');
   const config=latest.facts.configuration;if(profile.configurationRef){const ref=profile.configurationRef;contextCheck(config&&contextHash(config.reference)===contextHash(ref)&&contextHash(config.recipesRef)===contextHash(ref)&&aux.get(ref.revisionId)?.sha256===ref.sha256&&aux.get(ref.revisionId)?.configurationHash===config.configHash,'复核历史配置闭包不符');}
   for(const id of latest.release.sourceRevisionIds){const docs=documents.filter(d=>d.revisionId===id);contextCheck(docs.length===1&&!docs[0].deleted&&sha256(docs[0].bytes)===docs[0].sha256,'复核原发布完整来源缺失或SHA错误');}
   return assertAssetContextPublicationFacts(body,latest.release,latest.facts,documents);
  }});
  buffers.clear();documents.length=0;releases.clear();
 }};
}
