import {canonicalJson,sha256} from './bytes.mjs';
import {canonicalSha256} from './archive-integrity.mjs';
import {hashArchiveRows,ARCHIVE_FILE_FORMAT} from './archive-file.mjs';
import {RETIREMENT_NAMESPACES} from './media-retirement.mjs';
import {openArchiveRowsFile} from './archive-file-reader.mjs';
const fail=(message,code='EXPORT_HASH_MISMATCH')=>{throw Object.assign(new Error(message),{code});};
const ensure=(condition,message,code)=>{if(!condition)fail(message,code);};
const namespaces=new Set(Object.values(RETIREMENT_NAMESPACES).map(n=>'aux:'+n));
const integer=n=>{const result=Number(n);ensure(Number.isSafeInteger(result),'Archive integer exceeds safe range','INTEGER_RANGE');return result;};
export const MAX_DECLARED_ARCHIVE_BYTES=16*1024**3;
export function assertArchiveFileBinding(binding){ensure(typeof binding?.sha256==='string'&&/^[a-f0-9]{64}$/.test(binding.sha256),'Invalid complete archive file SHA','ARCHIVE_HASH');ensure(Number.isSafeInteger(binding.bytes)&&binding.bytes>0&&binding.bytes<=MAX_DECLARED_ARCHIVE_BYTES,'Declared archive byte size exceeds bounded streaming capacity','ARCHIVE_LIMIT');}
/** An optional exact physical binding increases only the indexed stream limit;
 * unbound/default readers keep4GiB. Never changes legacy object/JSON limits. */
export async function openArchiveRowsWithBinding(filename,binding={}){
 const declared=binding.sha256!==undefined||binding.bytes!==undefined;let options={};
 if(declared){assertArchiveFileBinding(binding);options={expectedFileSha256:binding.sha256,maxBytes:binding.bytes};}
 const reader=await openArchiveRowsFile(filename,options);
 try{if(declared)ensure(reader.file.bytes===binding.bytes&&reader.file.sha256===binding.sha256,'Actual archive file differs from exact physical binding','ARCHIVE_HASH');return reader;}
 catch(error){await reader.close().catch(()=>{});throw error;}
}
export function decodeArchiveRow(row){return Object.fromEntries(Object.entries(row).map(([key,value])=>{if(value===null||typeof value!=='object')return[key,value];ensure(value.encoding==='base64'&&typeof value.bytes==='string','Invalid archive byte encoding','EXPORT_BYTES_MISMATCH');const bytes=Buffer.from(value.bytes,'base64');ensure(bytes.toString('base64')===value.bytes,'Invalid archive base64','EXPORT_BYTES_MISMATCH');return[key,bytes];}));}

/** Complete logical/semantic scan, retaining only identity metadata, per-row
 * SHA multisets and optional retirement authority. No general body is kept.
 * The validator factory is injected to avoid a postgres-module import cycle. */
export async function validateArchiveRows(reader,{instanceId,createValidator,onRow,collectRetirement=true}={}){
 ensure(reader?.format===ARCHIVE_FILE_FORMAT&&typeof reader.iterate==='function'&&typeof reader.assertUnchanged==='function','Indexed archive reader required','EXPORT_READER_REQUIRED');
 ensure(typeof createValidator==='function','Complete archive validator required','EXPORT_VALIDATOR_REQUIRED');
 assertArchiveFileBinding(reader.file);
 await reader.assertUnchanged();
 const {exportSha256,...header}=reader.header,tableNames=[...reader.tableNames];
 ensure(/^[a-f0-9]{64}$/.test(exportSha256),'Archive lacks an exact export SHA');
 const file={...reader.file},validator=createValidator(header,tableNames,instanceId),rowHashes=Object.fromEntries(tableNames.filter(t=>t!=='repository_meta').sort().map(t=>[t,[]]));
 const tables=collectRetirement?{repository_meta:[],record_heads:[],record_revisions:[],media_versions:[],media_aliases:[]}:null;
 let meta=null,metaCount=0,high=0;for(const entry of header.sequence||[])high=Math.max(high,integer(entry.seq));
 const result=await hashArchiveRows(header,tableNames,t=>reader.iterate(t),{
  onRow:async(table,row)=>{
   validator.accept(table,row);
   if(table==='repository_meta'){metaCount++;meta=structuredClone(row);}
   else rowHashes[table].push(canonicalSha256(row));
   if(table==='domain_events')high=Math.max(high,integer(row.storage_sequence));
   if(tables&&Object.hasOwn(tables,table)&&(!['record_heads','record_revisions'].includes(table)||namespaces.has(row.namespace)))tables[table].push(structuredClone(row));
   if(onRow)await onRow(table,row);
  },onTableEnd:table=>validator.finishTable(table),
 });
 validator.finish();
 ensure(metaCount===1&&meta.instance_id===instanceId,'Archive metadata identity differs','INSTANCE_MISMATCH');
 ensure(result.exportSha256===exportSha256&&result.rows===reader.rows,'Archive logical hash or row count differs');
 await reader.assertUnchanged();ensure(canonicalJson(reader.file)===canonicalJson(file),'Reader file binding changed','ARCHIVE_CHANGED');
 for(const hashes of Object.values(rowHashes)){hashes.sort();Object.freeze(hashes);}
 return Object.freeze({header:Object.freeze(header),tableNames:Object.freeze(tableNames),exportSha256,rows:result.rows,metadata:Object.freeze(meta),sequenceHigh:high,rowHashes:Object.freeze(rowHashes),rowHashesSha256:sha256(canonicalJson(rowHashes)),file:Object.freeze(file),frozenRetirement:tables?{instanceId,tables}:null});
}

/** Precommit proof for the second semantic/row-import pass. File raw SHA is the
 * initial complete reader scan; inode+size+mtimeNs+ctimeNs are rechecked each
 * pass, while the complete logical export SHA and all row hashes are recomputed. */
export function assertArchiveRowsUnchanged(before,after){
 for(const key of ['header','tableNames','exportSha256','rows','metadata','sequenceHigh','rowHashes','file'])ensure(canonicalJson(before[key])===canonicalJson(after[key]),'Archive changed between validation and import: '+key,'ARCHIVE_CHANGED');
}
