import {check,hash} from '../shared/contracts.mjs';
import {idsFor} from './read-unit.mjs';

export async function evidenceRecord(unit,params){
 const ref=params.get('ref');check(typeof ref==='string'&&ref.length>0&&ref.length<=2048,'EVIDENCE_REF','请选择精确依据');
 const requested=params.get('sourceRevisionId'),narrative=ref.match(/^NARRATIVE:(.+):([a-f0-9]{64})$/);
 let row,source,locator='',format='MARKDOWN',body='',title='来源依据',sceneIds=[],episodeIds=[];
 if(narrative){
  const matches=(await unit.tx.query("SELECT id,sha256 FROM revisions WHERE object_id=$1 AND (sha256=$2 OR content->>'contentHash'=$2) ORDER BY number DESC",[narrative[1],narrative[2]])).rows;
  check(matches.length&&new Set(matches.map(r=>r.sha256)).size===1,'EVIDENCE_VERSION','叙事依据没有唯一的原修订，未套用当前稿',409);
  row=await unit.detail(narrative[1],matches[0].id);sceneIds=[row.id];title=row.title;body=(row.revision.content.blocks||row.revision.content.scriptBlocks||[]).map(b=>[b.speaker,b.text].filter(Boolean).join('：')).join('\n\n')||row.revision.content.text||'';locator=row.revision.id;
 }else{
  const documentRef=ref.split('#')[0],lineMatch=documentRef.match(/^(.*):(\d+)(?:-(\d+))?$/),logicalPath=lineMatch?lineMatch[1]:documentRef;
  locator=ref.includes('#')?ref.slice(ref.indexOf('#')+1):lineMatch?'L'+lineMatch[2]+(lineMatch[3]?'-L'+lineMatch[3]:''):'';
  const sourceHash=ref.match(/^(?:source_|sha256:)([a-f0-9]{64})$/)?.[1];
  const matches=(await unit.tx.query("SELECT s.*,r.object_id FROM source_documents s JOIN revisions r ON r.id=s.revision_id WHERE ($1::text IS NOT NULL AND (s.revision_id=$1 OR s.original_revision_id=$1)) OR ($1::text IS NULL AND (s.logical_path=$2 OR s.revision_id=$3 OR s.original_revision_id=$3 OR s.original_sha256=$4)) ORDER BY s.revision_id LIMIT 101",[requested||null,logicalPath,ref,sourceHash||null])).rows;
  if(matches.length){
   const unique=new Map(matches.map(r=>[r.original_sha256,r]));
   check(unique.size===1,'EVIDENCE_VERSION_REQUIRED','此逻辑来源有多个历史版本，请选择原引用的精确修订',409,{versions:matches.map(r=>({revisionId:r.revision_id,sha256:r.original_sha256,path:r.logical_path}))});
   source=matches[0];check(!requested||source.logical_path===logicalPath||source.original_sha256===sourceHash||[source.revision_id,source.original_revision_id].includes(ref),'EVIDENCE_BINDING','所选版本不属于此来源引用',409);check(hash(source.content_bytes)===source.original_sha256,'SOURCE_SHA','原件 SHA 不符',409);row=await unit.detail(source.object_id,source.revision_id);title=source.logical_path;body=source.content_bytes.toString('utf8');format=source.mime_type==='application/json'?'JSON':'MARKDOWN';
   if(lineMatch){const lines=body.split('\n'),start=Number(lineMatch[2]),end=Number(lineMatch[3]||start);check(start>=1&&end>=start&&start<=lines.length,'EVIDENCE_LOCATOR','原件中没有此行范围',409);body=lines.slice(start-1,end).join('\n');}
  }else{
   const match=(await unit.tx.query('SELECT object_id,id FROM revisions WHERE id=$1 UNION SELECT id,COALESCE(draft_revision_id,adopted_revision_id) FROM objects WHERE id=$1',[ref])).rows;
   check(match.length===1,'EVIDENCE_NOT_FOUND','未登记此精确依据',404);row=await unit.detail(match[0].object_id,match[0].id);title=row.title;const c=row.revision.content;body=c.text||JSON.stringify(c,null,2);format=c.text?'MARKDOWN':'JSON';locator=row.revision.id;
  }
  sceneIds=idsFor(row,'SCENE');episodeIds=idsFor(row,'EPISODE');
 }
 const truncated=body.length>100000,excerpt=truncated?body.slice(0,100000):body;
 return {data:{ref,sourceKind:row.kind,displayFormat:truncated?'MARKDOWN':format,title,path:source?.logical_path||row.id,locator,excerpt,sourceSha256:source?.original_sha256||row.revision.sha256,excerptSha256:hash(Buffer.from(excerpt,'utf8')),readingContext:null,reviewUse:'精确来源修订 '+row.revision.id+(truncated?'；正文超过当前阅读窗口，仅显示前 100000 字符。':''),sceneIds,episodeIds,internalHref:null,internalLabel:null}};
}
