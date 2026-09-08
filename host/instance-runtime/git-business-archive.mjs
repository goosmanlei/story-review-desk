import {canonicalJson,sha256} from './bytes.mjs';
import {canonicalSha256,archiveRowHashes} from './archive-integrity.mjs';
import {POSTGRES_SCHEMA,BUSINESS_TABLES} from './postgres-schema.mjs';
import {APPLICATION_ID,SCHEMA_VERSION} from './schema.mjs';
import {createArchiveStreamValidator,encodeArchiveRow} from './postgres.mjs';
import {hashArchiveRows,ARCHIVE_FILE_FORMAT} from './archive-file.mjs';
import {DEFAULT_ARCHIVE_MAX_ROW_BYTES} from './archive-file-reader.mjs';
import {MAX_DECLARED_ARCHIVE_BYTES} from './archive-stream-validation.mjs';
import {RETIREMENT_NAMESPACES} from './media-retirement.mjs';
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

const retirementNames=new Set(Object.values(RETIREMENT_NAMESPACES).map(name=>'aux:'+name));
const releaseFields=['release_id','snapshot_id','snapshot_sha256','recipes_sha256','profile_revision_id','source_revision_ids_json'];
const countedTables=new Set(['record_revisions','releases','domain_events','media_versions']);
/** A new iterator factory is required for each complete pass. hashArchiveRows
 * orders tables canonically: repository_meta follows all four counted tables. */
function projectedRows(iterate,sourceValidator){
 let count=0;
 return async function*(table){
  for await(const original of iterate(table)){
   sourceValidator?.accept(table,original);
   if((table==='record_revisions'||table==='record_heads')&&!includedNamespace(original.namespace))continue;
   if(countedTables.has(table)){count++;if(!Number.isSafeInteger(count))throw Error('Git archive counter exceeds safe range');}
   const row=table==='repository_meta'?{...original,runtime_epoch:'GIT_BUSINESS_SNAPSHOT_NOT_A_RUNNING_INSTANCE',repository_revision:count}:original;
   refuseCredentialBytes(row);yield row;
  }
  sourceValidator?.finishTable(table);
 };
}

/** Complete source and projected semantics, hashes and business proof, retaining
 * identity/hash metadata and retirement evidence only (never release bodies).
 * For a file source the caller must ALSO check its original logical export SHA;
 * a projection hash alone must not hide excluded rows inserted into that file. */
export async function projectGitBusinessRows({header,tableNames,iterate},{expectedMeta,maxBytes=MAX_DECLARED_ARCHIVE_BYTES,maxRowBytes=DEFAULT_ARCHIVE_MAX_ROW_BYTES,maxRows=1000000}={}){
 for(const [value,ceiling]of[[maxBytes,MAX_DECLARED_ARCHIVE_BYTES],[maxRowBytes,DEFAULT_ARCHIVE_MAX_ROW_BYTES],[maxRows,1000000]])if(!Number.isSafeInteger(value)||value<=0||value>ceiling)throw Error('Git stream capacity must be within the complete-reader limits');
 const {exportSha256:_sourceSha,...bodyHeader}=header,instanceId=bodyHeader.instanceId;
 const sourceValidator=createArchiveStreamValidator(bodyHeader,tableNames,instanceId,{expectedMeta});
 const projectedValidator=createArchiveStreamValidator(bodyHeader,tableNames,instanceId);
 const index=Object.fromEntries(BUSINESS_TABLES.map(table=>[table,[]]));
 const frozenTables={repository_meta:[],record_revisions:[],record_heads:[],media_versions:[],media_aliases:[]};
 const rowHashes=Object.fromEntries([...BUSINESS_TABLES].filter(table=>table!=='repository_meta').sort().map(table=>[table,[]]));
 let archiveBytes=Buffer.byteLength(canonicalJson({format:ARCHIVE_FILE_FORMAT,header:{...bodyHeader,exportSha256:'0'.repeat(64)},tableNames:[...tableNames].sort()}))+1,rowCount=0;
 if(archiveBytes-1>Math.min(maxRowBytes,1024*1024)||archiveBytes>maxBytes)throw Error('Git archive header exceeds complete-reader capacity');
 const proof=await hashArchiveRows(bodyHeader,tableNames,projectedRows(iterate,sourceValidator),{
  onRow(table,row){
   projectedValidator.accept(table,row);
   const rowBytes=Buffer.byteLength(canonicalJson({table,row}));rowCount++;archiveBytes+=rowBytes+1;
   if(rowBytes>maxRowBytes||rowCount>maxRows||archiveBytes>maxBytes)throw Error('Git archive exceeds complete-reader capacity');
   if(table!=='repository_meta')rowHashes[table].push(canonicalSha256(row));
   if(table==='record_revisions')index[table].push({revision_id:row.revision_id,content_sha256:row.content_sha256,deleted:row.deleted});
   else if(table==='releases')index[table].push(Object.fromEntries(releaseFields.map(key=>[key,row[key]])));
   else if(table==='domain_events')index[table].push({authority_domain:row.authority_domain,event_kind:row.event_kind,storage_sequence:row.storage_sequence});
   else index[table].push(row);
   if(table==='record_revisions'||table==='record_heads'){if(retirementNames.has(row.namespace))frozenTables[table].push(row);}
   else if(Object.hasOwn(frozenTables,table))frozenTables[table].push(row);
  },onTableEnd:table=>projectedValidator.finishTable(table),
 });
 sourceValidator.finish();projectedValidator.finish();
 archiveBytes+=Buffer.byteLength(canonicalJson({end:true,rows:rowCount}))+1;if(archiveBytes>maxBytes)throw Error('Git archive exceeds complete-reader capacity');
 for(const hashes of Object.values(rowHashes))Object.freeze(hashes.sort());Object.freeze(rowHashes);
 const tableDigests=Object.fromEntries(Object.entries(rowHashes).map(([table,hashes])=>[table,{rows:hashes.length,sha256:sha256(canonicalJson(hashes))}]));
 const metadata=index.repository_meta[0],business=gitBusinessStateFromArchive({instanceId,tables:index});
 return {header:bodyHeader,tableNames:[...tableNames].sort(),...proof,archiveBytes,rowHashes,tableDigests,business,metadata,
  media:frozenTables.media_versions,frozenRetirement:{instanceId,tables:frozenTables},
  createIterator:()=>projectedRows(iterate),excludedNamespaces:[...GIT_EXCLUDED_NAMESPACES],originalRetainedRowBytesPreserved:true,normalizedRuntimeMetadata:true};
}

/** Caller owns one read-only transaction until the second-pass file is sealed. */
export async function scanGitBusinessArchive(tx){
 if(tx.writable!==false||typeof tx.iterateArchiveRows!=='function')throw Error('Git archive requires one read-only PostgreSQL transaction');
 const meta=encodeArchiveRow(await tx.meta()),sequence=await tx.one('SELECT COALESCE(max(storage_sequence),0) AS n FROM domain_events'),seq=Number(sequence.n);
 if(!Number.isSafeInteger(seq)||seq<0)throw Error('Git event sequence exceeds safe range');
 const header={schemaVersion:SCHEMA_VERSION,applicationId:APPLICATION_ID,instanceId:meta.instance_id,sequence:[{name:'domain_events',seq}],mediaIncluded:false};
 return projectGitBusinessRows({header,tableNames:BUSINESS_TABLES,iterate:table=>tx.iterateArchiveRows(table)},{expectedMeta:meta});
}
