import {createAssetContextArchiveValidator} from './asset-context-revalidation-archive.mjs';
import {canonicalJson,sha256} from './bytes.mjs';
import {MATERIAL_USAGE_EVENT,MATERIAL_USAGE_SOURCE,validateMaterialUsageLedger} from './material-usage-model.mjs';

const fail=message=>{throw Object.assign(Error(message),{code:'MATERIAL_USAGE_ARCHIVE'});};
const parse=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
const hash=value=>sha256(canonicalJson(value));
const sorted=rows=>[...rows].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
/** Small semantic companion to the existing complete byte/row scan. Retains
 * usage source bytes and adoption events, never historical snapshot bodies. */
function createMaterialUsageOnlyArchiveValidator(){
  const documents=[],events=[],aliases=new Map(),releases=new Map(),historicalRefs=new Map();let currentReleaseId=null,instanceId=null,sourceBytes=0;
  return {
    accept(table,row,parsedSnapshot){
      if(table==='repository_meta'){currentReleaseId=row.current_release_id;instanceId=row.instance_id;}
      if(table==='document_aliases'){
        const values=aliases.get(row.document_id)||[];values.push(row.alias);aliases.set(row.document_id,values);
      }
      if(table==='record_revisions'&&row.namespace==='documents'){
        const metadata=JSON.parse(row.metadata_json);
        if(metadata.sourceRole===MATERIAL_USAGE_SOURCE){
          sourceBytes+=row.content_bytes.length;if(sourceBytes>64*1024*1024)fail('用途固定来源超出独立语义校验容量');
          documents.push({documentId:row.record_key,revisionId:row.revision_id,sha256:row.content_sha256,bytes:row.content_bytes,metadata,deleted:Boolean(row.deleted)});
        }
      }
      if(table==='domain_events'){
        const event=parse(row.event_bytes);
        if(event.eventKind===MATERIAL_USAGE_EVENT||event.subjectType==='MATERIAL_USAGE'||Object.hasOwn(event,'usageRevisionId')||event.eventKind==='review'&&event.subjectType==='ASSET')events.push(event);
      }
      if(table==='releases'){
        const snapshot=parsedSnapshot||parse(row.snapshot_bytes),ledger=snapshot.productionModel?.materialUsageLedger;
        if(ledger!==undefined&&!Array.isArray(ledger))fail('发布用途ledger格式无效');
        const refs=ledger||[],sources=new Set(JSON.parse(row.source_revision_ids_json));
        for(const ref of refs){const previous=historicalRefs.get(ref.id),digest=hash(ref);if(previous&&previous!==digest)fail('历史发布用途ledger被原位换绑');historicalRefs.set(ref.id,digest);}
        // One compact digest per release avoids keeping repeated multi-MiB
        // snapshots. It is compared to the exact source/event-derived closure,
        // not used as an authorization to manufacture missing ledger rows.
        const instanceIds=[];
        // Legacy releases may omit snapshot identity and use their pinned
        // profile. An explicit identity, however, must never be ignored.
        if(snapshot.instance!==undefined)instanceIds.push(snapshot.instance?.instanceId);
        if(snapshot.productionModel?.instance!==undefined)instanceIds.push(snapshot.productionModel.instance?.instanceId);
        releases.set(row.release_id,{ledgerHash:hash(sorted(refs)),count:refs.length,pinned:refs.every(r=>sources.has(r.sourceRevisionId)),instanceIds});
      }
    },
    finish(){
      for(const doc of documents)doc.aliases=aliases.get(doc.documentId)||[];
      for(const [id,values] of aliases)if(values.some(a=>a.startsWith('story/material-usages/'))&&!documents.some(d=>d.documentId===id))fail('用途来源路径缺少正确角色的原修订');
      const usageEvents=events.filter(e=>e.eventKind===MATERIAL_USAGE_EVENT||e.subjectType==='MATERIAL_USAGE'||Object.hasOwn(e,'usageRevisionId'));
      if(!documents.length&&!usageEvents.length&&![...releases.values()].some(r=>r.count))return;
      const current=releases.get(currentReleaseId);if(!current||!current.pinned)fail('当前用途ledger没有完整已发布来源');
      if(current.instanceIds.some(id=>id!==instanceId))fail('当前用途发布快照的实际实例身份不符');
      const refs=usageEvents.map(event=>({id:event.usageRevisionId,usageId:event.usageId,eventId:event.eventId,sourceRef:event.sourceRef,sourceRevisionId:event.sourceRevisionId,sourceSha256:event.sourceSha256}));
      if(current.count!==refs.length||current.ledgerHash!==hash(sorted(refs)))fail('当前发布用途ledger不等于完整原事件/来源闭包');
      const currentRefs=new Map(refs.map(r=>[r.id,hash(r)]));for(const [id,digest] of historicalRefs)if(currentRefs.get(id)!==digest)fail('当前用途ledger丢失或改写历史发布成员');
      const rows=validateMaterialUsageLedger({snapshot:{instance:{instanceId},productionModel:{materialUsageLedger:refs}},documents,events});
      for(const row of rows){
        const base=releases.get(row.body.baseReleaseId);
        if(row.body.basis.instanceId!==instanceId||!base||base.instanceIds.some(id=>id!==instanceId))fail('用途来源的实例或实际发布基线缺失或不符');
      }
    },
  };
}
/** SQLite/object import uses the same semantic closure before target creation. */
export function validateMaterialUsageArchive(archive,{encoded=true}={}){
  const validator=createMaterialUsageArchiveValidator();
  for(const table of ['repository_meta','document_aliases','record_revisions','domain_events','releases'])for(const row of archive.tables?.[table]||[]){
    const decoded=encoded?Object.fromEntries(Object.entries(row).map(([key,value])=>{
      if(value===null||typeof value!=='object')return [key,value];
      if(value.encoding!=='base64'||typeof value.bytes!=='string')fail('用途归档字节编码无效');
      const bytes=Buffer.from(value.bytes,'base64');if(bytes.toString('base64')!==value.bytes)fail('用途归档原字节无效');return [key,bytes];
    })):row;
    validator.accept(table,decoded);
  }
  validator.finish();
}

export function createMaterialUsageArchiveValidator(){
 const usage=createMaterialUsageOnlyArchiveValidator(),context=createAssetContextArchiveValidator();
 return {accept(...args){usage.accept(...args);context.accept(...args);},finish(){usage.finish();context.finish();}};
}
