import {canonicalJson,sha256} from './bytes.mjs';
import {canonicalSha256,archiveRowHashes} from './archive-integrity.mjs';
import {POSTGRES_SCHEMA,BUSINESS_TABLES} from './postgres-schema.mjs';
export const GIT_BUSINESS_PROTOCOL='REVIEW_GIT_BUSINESS_SNAPSHOT_1';
export const GIT_EXCLUDED_NAMESPACES=Object.freeze([
 'aux:assistant-public','aux:assistant-private','aux:assistant-runtime-history',
 'aux:instance-maintenance-runtime','aux:instance-maintenance-operations','aux:instance-maintenance-requests',
 'aux:worker-comment-polish','aux:worker-material-review','aux:media-retirement-claims','aux:media-maintenance-gates',
]);
export const includedNamespace=namespace=>typeof namespace==='string'&&!GIT_EXCLUDED_NAMESPACES.includes(namespace)&&!namespace.startsWith('aux:assistant-');
const normalizeRows=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,['count','high_water','byte_size'].includes(key)&&value!==null?Number(value):value])));
const ordering=rows=>[...rows].sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:canonicalJson(a)>canonicalJson(b)?1:0);
const schemaHash=sha256(POSTGRES_SCHEMA);
function descriptor({instanceId,currentRelease,heads,eventWatermarks,media,mediaAliases,documentAliases}){
 return {protocol:GIT_BUSINESS_PROTOCOL,schemaHash,instanceId,currentRelease,
  heads:ordering(heads.filter(row=>includedNamespace(row.namespace)).map(({namespace,record_key,revision_id,content_sha256,deleted})=>({namespace,record_key,revision_id,content_sha256,deleted}))),
  eventWatermarks:ordering(normalizeRows(eventWatermarks)),media:ordering(normalizeRows(media)),mediaAliases:ordering(mediaAliases),documentAliases:ordering(documentAliases)};
}
export async function gitBusinessState(tx){
 if(typeof tx.query!=='function')throw Error('Git business snapshots require the PostgreSQL owner');
 const metadata=await tx.getMetadata();
 const read=async(sql,params=[])=>[...(await tx.query(sql,params)).rows];
 const [release,heads,eventWatermarks,media,mediaAliases,documentAliases]=await Promise.all([
  read('SELECT release_id,snapshot_id,snapshot_sha256,recipes_sha256,profile_revision_id,source_revision_ids_json FROM releases WHERE release_id=$1',[metadata.releaseId]),
  read('SELECT h.namespace,h.record_key,h.revision_id,r.content_sha256,r.deleted FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE NOT (h.namespace=ANY($1::text[])) AND h.namespace NOT LIKE $2',[GIT_EXCLUDED_NAMESPACES,'aux:assistant-%']),
  read('SELECT authority_domain,event_kind,count(*) AS count,max(storage_sequence) AS high_water FROM domain_events GROUP BY authority_domain,event_kind'),
  read('SELECT media_id,version_id,relative_path,sha256,byte_size,availability,metadata_json FROM media_versions'),
  read('SELECT alias,media_id,version_id FROM media_aliases'),read('SELECT alias,document_id FROM document_aliases'),
 ]);
 if(release.length!==1)throw Error('A current published release is required before checkpoint');
 const basis=descriptor({instanceId:metadata.instanceId,currentRelease:release[0],heads,eventWatermarks,media,mediaAliases,documentAliases});
 return {protocol:GIT_BUSINESS_PROTOCOL,instanceId:metadata.instanceId,releaseId:metadata.releaseId,fingerprint:sha256(canonicalJson(basis)),schemaHash,
  sourceRuntimeEpoch:metadata.runtimeEpoch,sourceRepositoryRevision:metadata.repositoryRevision};
}
export function gitBusinessStateFromArchive(archive){
 const t=archive.tables,meta=t.repository_meta[0],current=t.releases.find(row=>row.release_id===meta.current_release_id);
 if(!current)throw Error('Current release missing');
 const revisions=new Map(t.record_revisions.map(row=>[row.revision_id,row])),groups=new Map();
 for(const row of t.domain_events){const key=canonicalJson([row.authority_domain,row.event_kind]);const value=groups.get(key)||{authority_domain:row.authority_domain,event_kind:row.event_kind,count:0,high_water:0};value.count++;value.high_water=Math.max(value.high_water,Number(row.storage_sequence));groups.set(key,value);}
 const fields=['release_id','snapshot_id','snapshot_sha256','recipes_sha256','profile_revision_id','source_revision_ids_json'];
 const basis=descriptor({instanceId:archive.instanceId,currentRelease:Object.fromEntries(fields.map(key=>[key,current[key]])),
  heads:t.record_heads.map(row=>({...row,content_sha256:revisions.get(row.revision_id)?.content_sha256,deleted:revisions.get(row.revision_id)?.deleted})),
  eventWatermarks:[...groups.values()],media:t.media_versions.map(({media_id,version_id,relative_path,sha256,byte_size,availability,metadata_json})=>({media_id,version_id,relative_path,sha256,byte_size,availability,metadata_json})),mediaAliases:t.media_aliases,documentAliases:t.document_aliases});
 return {protocol:GIT_BUSINESS_PROTOCOL,instanceId:archive.instanceId,releaseId:meta.current_release_id,fingerprint:sha256(canonicalJson(basis)),schemaHash};
}
function refuseCredentialText(text){
 if(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|"(?:api_?key|access_?token|refresh_?token|client_?secret|password)"\s*:\s*"[A-Za-z0-9._/+==-]{24,}"/i.test(text))throw Error('Potential credential material blocks Git export; review privately, never redact immutable history silently');
}
function refuseCredentialBytes(value){
 if(typeof value==='string'){refuseCredentialText(value);return;}
 if(value&&typeof value==='object'){
  if(value.encoding==='base64'&&typeof value.bytes==='string')refuseCredentialText(Buffer.from(value.bytes,'base64').toString('utf8'));
  else for(const nested of Object.values(value))refuseCredentialBytes(nested);
 }
}
export function projectGitBusinessArchive(original){
 const {exportSha256,...originalBody}=original;
 if(canonicalSha256(originalBody)!==exportSha256)throw Error('Input archive checksum differs');
 if(Object.keys(original.tables).sort().join(',')!==[...BUSINESS_TABLES].sort().join(','))throw Error('Unknown archive table set');
 const tables={...original.tables,
  record_revisions:original.tables.record_revisions.filter(row=>includedNamespace(row.namespace)),
  record_heads:original.tables.record_heads.filter(row=>includedNamespace(row.namespace))};
 // Entire excluded record chains are omitted; retained historical rows and hashes
 // are never rewritten. Runtime-only counters and epoch cannot trigger commits.
 tables.repository_meta=original.tables.repository_meta.map(row=>({...row,runtime_epoch:'GIT_BUSINESS_SNAPSHOT_NOT_A_RUNNING_INSTANCE',repository_revision:tables.record_revisions.length+tables.releases.length+tables.domain_events.length+tables.media_versions.length}));
 for(const name of BUSINESS_TABLES)for(const row of tables[name])refuseCredentialBytes(row);
 const body={...originalBody,tables},archive={...body,exportSha256:canonicalSha256(body)};
 const hashes=archiveRowHashes(archive),tableDigests=Object.fromEntries(Object.entries(hashes).map(([table,rows])=>[table,{rows:rows.length,sha256:sha256(canonicalJson(rows))}]));
 const business=gitBusinessStateFromArchive(archive);
 return {archive,business,tableDigests,excludedNamespaces:[...GIT_EXCLUDED_NAMESPACES],originalRetainedRowBytesPreserved:true,normalizedRuntimeMetadata:true};
}
