import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {canonicalSha256} from '../host/instance-runtime/archive-integrity.mjs';
import {APPLICATION_ID,SCHEMA_VERSION} from '../host/instance-runtime/schema.mjs';
import {BUSINESS_TABLES} from '../host/instance-runtime/postgres-schema.mjs';
import {validateArchive} from '../host/instance-runtime/postgres.mjs';
import {gitBusinessState,gitBusinessStateFromArchive,projectGitBusinessArchive} from '../host/instance-runtime/git-business-archive.mjs';
const encoded=value=>{const bytes=Buffer.from(typeof value==='string'?value:canonicalJson(value));return{value:{encoding:'base64',bytes:bytes.toString('base64')},sha:sha256(bytes)};};
function fixture(){
 const tables=Object.fromEntries(BUSINESS_TABLES.map(table=>[table,[]]));
 tables.repository_meta=[{singleton:1,instance_id:'instance-fixture',runtime_epoch:'epoch-one',repository_revision:5000,current_release_id:'release-one',created_at:'2026-01-01'}];
 function record(namespace,key,value,previous=null){const data=encoded(value),row={revision_id:namespace+':'+key+':'+(previous?2:1),namespace,record_key:key,revision_number:previous?2:1,previous_revision_id:previous?.revision_id||null,content_bytes:data.value,content_sha256:data.sha,media_type:'application/json',metadata_json:'{}',deleted:0,created_at:'2026-01-01'};tables.record_revisions.push(row);tables.record_heads=tables.record_heads.filter(head=>head.namespace!==namespace||head.record_key!==key);tables.record_heads.push({namespace,record_key:key,revision_id:row.revision_id});return row;}
 const profile=record('settings','instance-profile',{projectId:'story-fixture',instanceId:'instance-fixture'});
 const draft=record('aux:production-preparation','current',{sceneRole:'draft-one'});
 record('aux:assistant-public','health.json',{password:'a'.repeat(40),checkedAt:'initial'});
 const snapshot=encoded({snapshotId:'snapshot-one',productionModel:{}}),recipes=encoded({snapshotId:'snapshot-one'});
 tables.releases=[{release_id:'release-one',snapshot_id:'snapshot-one',snapshot_bytes:snapshot.value,snapshot_sha256:snapshot.sha,recipes_bytes:recipes.value,recipes_sha256:recipes.sha,source_revision_ids_json:'[]',profile_revision_id:profile.revision_id,created_at:'2026-01-01'}];
 const event=encoded({eventId:'event-one',eventKind:'review',idempotencyKeyHash:'e'.repeat(64)});
 tables.domain_events=[{storage_sequence:1,event_id:'event-one',authority_domain:'FORMAL',event_kind:'review',original_sequence:1,recorded_at:'2026-01-01',event_bytes:event.value,event_sha256:event.sha,idempotency_key_hash:'e'.repeat(64),request_hash:'f'.repeat(64),raw_request_hash:null,source_ref_json:'null'}];
 const archive=()=>{const body={schemaVersion:SCHEMA_VERSION,applicationId:APPLICATION_ID,instanceId:'instance-fixture',tables,sequence:[{name:'domain_events',seq:1}],mediaIncluded:false};return {...body,exportSha256:canonicalSha256(body)};};
 return{tables,archive,record,draft};
}
test('private assistant chains are excluded before credential scan; retained rows and formal history stay byte-exact',()=>{
 const f=fixture(),original=f.archive(),projected=projectGitBusinessArchive(original);validateArchive(projected.archive,'instance-fixture');
 assert.equal(projected.archive.tables.record_heads.some(row=>row.namespace.startsWith('aux:assistant-')),false);
 for(const row of original.tables.record_revisions.filter(row=>!row.namespace.startsWith('aux:assistant-')))assert.equal(projected.archive.tables.record_revisions.find(next=>next.revision_id===row.revision_id),row);
 assert.equal(projected.archive.tables.domain_events,original.tables.domain_events);assert.equal(projected.archive.tables.releases,original.tables.releases);
 assert.notEqual(projected.archive.tables.repository_meta[0].runtime_epoch,'epoch-one');
 assert.equal(projectGitBusinessArchive(projected.archive).archive.exportSha256,projected.archive.exportSha256,'projection is idempotent and import-verifiable');
});
test('heartbeat, assistant history and raw repository revision do not change the business fingerprint or Git archive',()=>{
 const f=fixture(),first=projectGitBusinessArchive(f.archive());
 f.tables.repository_meta[0].repository_revision++;f.tables.repository_meta[0].runtime_epoch='restored-epoch';
 f.record('aux:assistant-private','new-thread',{text:'private'});f.record('aux:instance-maintenance-runtime','heartbeat',{now:123});
 const next=projectGitBusinessArchive(f.archive());
 assert.equal(first.business.fingerprint,next.business.fingerprint);assert.equal(first.archive.exportSha256,next.archive.exportSha256);
});
test('unpublished draft saves change the fingerprint and preserve both revisions',()=>{
 const f=fixture(),before=projectGitBusinessArchive(f.archive());f.record('aux:production-preparation','current',{sceneRole:'draft-two'},f.draft);
 const after=projectGitBusinessArchive(f.archive());validateArchive(after.archive,'instance-fixture');
 assert.notEqual(before.business.fingerprint,after.business.fingerprint);assert.equal(after.archive.tables.record_revisions.filter(row=>row.namespace==='aux:production-preparation').length,2);
});
test('suspected credentials in retained history stop export instead of silently rewriting history',()=>{
 const f=fixture();f.record('documents','accidental-key',{api_key:'sensitive'.repeat(8)});
 assert.throws(()=>projectGitBusinessArchive(f.archive()),/credential/i);
 const bad=fixture();bad.tables.record_revisions[0].metadata_json=JSON.stringify({password:'secret'.repeat(8)});
 assert.throws(()=>projectGitBusinessArchive(bad.archive()),/credential/i);
});
test('light metadata fingerprint equals the frozen full archive without querying source/event payload bytes',async()=>{
 const f=fixture(),t=f.tables,queries=[];
 const tx={getMetadata:async()=>({instanceId:'instance-fixture',releaseId:'release-one',runtimeEpoch:'epoch-one',repositoryRevision:5000}),query:async(sql)=>{
  queries.push(sql);let rows;
  if(sql.includes('FROM releases'))rows=t.releases.map(({release_id,snapshot_id,snapshot_sha256,recipes_sha256,profile_revision_id,source_revision_ids_json})=>({release_id,snapshot_id,snapshot_sha256,recipes_sha256,profile_revision_id,source_revision_ids_json}));
  else if(sql.includes('FROM record_heads'))rows=t.record_heads.map(head=>({...head,content_sha256:t.record_revisions.find(row=>row.revision_id===head.revision_id).content_sha256,deleted:0}));
  else if(sql.includes('FROM domain_events'))rows=[{authority_domain:'FORMAL',event_kind:'review',count:'1',high_water:'1'}];
  else if(sql.includes('FROM media_versions'))rows=[];else if(sql.includes('FROM media_aliases'))rows=[];else if(sql.includes('FROM document_aliases'))rows=[];else throw Error(sql);
  return{rows};
 }};
 assert.equal((await gitBusinessState(tx)).fingerprint,gitBusinessStateFromArchive(f.archive()).fingerprint);
 assert.ok(queries.every(sql=>!/\b(?:content_bytes|event_bytes|snapshot_bytes|recipes_bytes)\b/.test(sql)));
});

test('fingerprinting cannot reorder original archive rows after its immutable checksum was computed',()=>{
 const f=fixture();f.record('documents','doc-one','original');f.tables.document_aliases=[{alias:'z',document_id:'doc-one'},{alias:'a',document_id:'doc-one'}];
 const original=f.archive(),before=canonicalJson(original);projectGitBusinessArchive(original);assert.equal(canonicalJson(original),before);validateArchive(original,'instance-fixture');
});
