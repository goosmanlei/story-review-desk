import {canonicalJson,sha256} from './bytes.mjs';
import {QUERY_MODEL_VERSION} from './query-model.mjs';
const TABLES=['read_operational_objects','read_memberships','read_objects','read_sections','read_projection_versions'];
const fail=message=>{throw Object.assign(Error(message),{code:'READ_MODEL_CLEANUP_CONFLICT'});};
const hash=value=>sha256(canonicalJson(value));
async function fingerprint(tx,table,where='',args=[]){
 const result=await tx.query(`SELECT count(*) AS count,encode(sha256(convert_to(COALESCE(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS sha256 FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM ${table} t ${where}) rows`,args);
 return {count:Number(result.rows[0].count),sha256:result.rows[0].sha256};
}
async function facts(tx,releaseIds){const result={};for(const table of TABLES)result[table]=await fingerprint(tx,table,'WHERE release_id=ANY($1::text[])',[releaseIds]);return result;}
async function staleIds(tx,current){return (await tx.query('SELECT DISTINCT release_id FROM ('+TABLES.map(table=>'SELECT release_id FROM '+table).join(' UNION ALL ')+') all_rows WHERE release_id<>$1 ORDER BY release_id',[current])).rows.map(row=>row.release_id);}
async function authority(tx){
 // Digests bind original bytes through their immutable registered SHA, without copying large blobs.
 const sources={
 repository_meta:'repository_meta',record_heads:'record_heads',document_aliases:'document_aliases',media_versions:'media_versions',media_aliases:'media_aliases',
 record_revisions:'(SELECT revision_id,namespace,record_key,revision_number,previous_revision_id,content_sha256,media_type,metadata_json,deleted,created_at FROM record_revisions)',
 releases:'(SELECT release_id,snapshot_id,snapshot_sha256,recipes_sha256,source_revision_ids_json,profile_revision_id,created_at FROM releases)',
 domain_events:'(SELECT storage_sequence,event_id,authority_domain,event_kind,original_sequence,recorded_at,event_sha256,idempotency_key_hash,request_hash,raw_request_hash,source_ref_json FROM domain_events)',
 };
 const result={};for(const [name,source]of Object.entries(sources))result[name]=await fingerprint(tx,source);return result;
}
async function context(tx,instance){
 if(tx.backend!=='postgres'||!instance.database?.volume)fail('只支持精确 PostgreSQL 实例');
 const metadata=await tx.getMetadata();
 if(metadata.instanceId!==instance.instanceId||!metadata.releaseId)fail('实例身份不符');
 const marker=(await tx.query('SELECT projection_version,event_sequence FROM read_projection_versions WHERE release_id=$1',[metadata.releaseId])).rows[0];
 if(Number(marker?.projection_version)!==QUERY_MODEL_VERSION||Number(marker.event_sequence)!==metadata.eventSequence)fail('请先使用新版素材 API 完整重建当前读模型');
 return {instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,currentReleaseId:metadata.releaseId,volume:instance.database.volume,queryModelVersion:QUERY_MODEL_VERSION};
}
export async function planReadModelCleanup(tx,instance,backupManifestSha256){
 if(!/^[a-f0-9]{64}$/.test(backupManifestSha256||''))fail('需要已核验备份的精确清单 SHA');
 const binding=await context(tx,instance),releaseIds=await staleIds(tx,binding.currentReleaseId);
 const body={schemaVersion:'1.0',kind:'STALE_READ_MODEL_ONLY',...binding,backupManifestSha256,staleReleaseIds:releaseIds,stale:await facts(tx,releaseIds),current:await facts(tx,[binding.currentReleaseId])};
 return {...body,planSha256:hash(body)};
}
export async function applyReadModelCleanup(tx,instance,plan){
 const {planSha256,...body}=plan||{};
 if(!planSha256||hash(body)!==planSha256||body.kind!=='STALE_READ_MODEL_ONLY')fail('清理清单已变化');
 const binding=await context(tx,instance);
 for(const [key,value]of Object.entries(binding))if(body[key]!==value)fail('清理基线已变化：'+key);
 if(!Array.isArray(body.staleReleaseIds)||new Set(body.staleReleaseIds).size!==body.staleReleaseIds.length||body.staleReleaseIds.includes(binding.currentReleaseId))fail('清理目标包含当前发布或重复身份');
 const nowIds=await staleIds(tx,binding.currentReleaseId),remaining=await facts(tx,body.staleReleaseIds);
 if(TABLES.every(table=>remaining[table].count===0)&&body.staleReleaseIds.length)return {status:'ALREADY_CLEANED',meaning:'本清单目标已不存在；未删除或重新推断其他缓存',planSha256,...binding,deleted:Object.fromEntries(TABLES.map(table=>[table,0])),remainingStaleReleaseIds:nowIds,remainingStale:await facts(tx,nowIds)};
 if(hash(nowIds)!==hash(body.staleReleaseIds)||hash(remaining)!==hash(body.stale))fail('旧缓存内容或目标集合已变化');
 const current=await facts(tx,[binding.currentReleaseId]);
 if(hash(current)!==hash(body.current))fail('当前投影已变化，请重新核对清理清单');
 const protectedBefore=await authority(tx),deleted={};
 for(const table of TABLES){
  const result=await tx.query('DELETE FROM '+table+' WHERE release_id=ANY($1::text[]) AND release_id<>$2',[body.staleReleaseIds,binding.currentReleaseId]);
  deleted[table]=result.rowCount;
  if(result.rowCount!==body.stale[table].count)fail('删除行数不匹配');
 }
 if(hash(await facts(tx,[binding.currentReleaseId]))!==hash(current)||hash(await authority(tx))!==hash(protectedBefore))fail('当前投影或正式数据发生非预期变化');
 return {status:'STALE_READ_MODEL_CLEANED',planSha256,...binding,deleted,currentPreserved:true,authorityPreserved:true,authority:protectedBefore};
}
