import {PresentationRead} from '../presentation/read-unit.mjs';
import {objectContext} from '../workspaces.mjs';
import {check,hash,identity,canonical} from '../shared/contracts.mjs';

const contextLimit=192*1024;
export async function assertSourceVersions(tx,versions){
  check(Array.isArray(versions)&&versions.length<=2000,'CONTEXT_LIMIT','助手依据范围过大');
  const ids=[...new Set(versions.map(v=>v.revisionId).filter(Boolean))];check(ids.length<=500,'CONTEXT_LIMIT','助手依据范围过大');
  const rows=(await tx.query('SELECT r.id,r.object_id,r.sha256,o.version,COALESCE(o.draft_revision_id,o.adopted_revision_id) AS head FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=ANY($1::text[])',[ids])).rows;
  const media=versions.some(v=>v.mediaSha256)?(await tx.query("SELECT a.revision_id,m.sha256 FROM asset_media a JOIN media m ON (m.id,m.version_id)=(a.media_id,a.media_version_id) WHERE a.revision_id=ANY($1::text[]) AND m.availability='PRESENT'",[ids])).rows:[];
  for(const source of versions){
    if(!source.revisionId)continue;
    const row=rows.find(r=>r.id===source.revisionId&&r.object_id===source.objectId);
    check(row&&row.sha256===source.sha256&&(!source.objectVersion||row.version===source.objectVersion&&row.head===source.revisionId),'CONTEXT_STALE','助手所依据的对象已改变；请重新核对当前内容',409);
    if(source.mediaSha256)check(media.some(m=>m.revision_id===source.revisionId&&m.sha256===source.mediaSha256),'CONTEXT_MEDIA_STALE','助手读取的原图已缺失或退役',409);
  }
}
export async function assistantContext(tx,input){
  const unit=new PresentationRead(tx),profile=await unit.profile(),focus=input.focus;
  check(focus&&focus.projectId===profile.projectId&&focus.snapshotId===await unit.namespace(),'CONTEXT_INSTANCE','助手讨论对象不属于当前实例或运行期',409);
  check(['PROJECT','SOURCE','EPISODE','SCENE','MATERIAL','WORK_ITEM','GUIDE'].includes(focus.subjectType)&&typeof focus.subjectId==='string'&&focus.subjectId.length<=300,'CONTEXT_FOCUS','请选择当前讨论对象');
  const draftTargets=input.draftTargets||[];
  check(Array.isArray(draftTargets)&&draftTargets.length<=8,'CONTEXT_DRAFTS','一次最多提供 8 个草稿字段');
  const seen=new Set();
  for(const target of draftTargets){
    check(target&&typeof target.id==='string'&&!seen.has(target.id)&&target.subjectId===focus.subjectId&&typeof target.value==='string'&&target.value.length<=16000&&target.baseHash===hash(target.value),'DRAFT_BINDING','草稿字段身份、版本或文本 SHA 不符',409);seen.add(target.id);
  }
  let objectId=focus.subjectId,revisionId;
  const wanted=focus.filters?.settingId||focus.selection?.entityId;
  if(wanted)objectId=wanted;
  const exact=(await tx.query('SELECT id FROM objects WHERE id=$1',[objectId])).rows[0];
  if(!exact){
    if(focus.subjectType==='WORK_ITEM'){
      const rows=(await tx.query("SELECT o.id FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.kind='CALL' AND r.content->>'workItemRef'=$1 AND NOT o.historical LIMIT 2",[objectId])).rows;
      check(rows.length===1,'CONTEXT_OBJECT','此工作项没有唯一的业务对象',409);objectId=rows[0].id;
    }else if(focus.subjectType==='SOURCE'){
      const rows=(await unit.rows(['SOURCE'],{excludeRoles:['NARRATIVE_SUPPORT','SPATIAL_CATALOG','ARCHIVED_EPISODE_PLAN']}));
      const sources=[];
      for(const row of rows){const doc=(await tx.query('SELECT content_bytes FROM source_documents WHERE revision_id=$1',[row.revisionId])).rows[0];sources.push({...row,text:doc?.content_bytes.toString('utf8')||row.content.text||''});}
      const timed=sources.filter(r=>/\[\d{2}:\d{2}:\d{2}\]/.test(r.text));
      const candidates=objectId==='outline'?sources.filter(r=>r.content.role==='SOURCE_DOCUMENT'&&!timed.includes(r)):timed;
      check(candidates.length===1,'CONTEXT_SOURCE','来源别名不能唯一对应已登记资料',409);objectId=candidates[0].id;
    }else if(focus.subjectType==='GUIDE'){
      const rows=await unit.rows(['GUIDANCE'],{content:false});check(rows.length,'CONTEXT_GUIDANCE','尚无已登记项目指引',409);objectId=rows[0].id;
    }else{
      const roots=await unit.rows(['STORY'],{content:false});check(roots.length===1,'CONTEXT_ROOT','请先登记本项目故事或来源对象',409);objectId=roots[0].id;
    }
  }
  if(focus.versionId){
    const candidate=(await tx.query('SELECT object_id FROM revisions WHERE id=$1',[focus.versionId])).rows[0];
    if(candidate?.object_id===objectId)revisionId=focus.versionId;
  }
  const context=await objectContext(tx,objectId,{revisionId});
  const details=[context.object,...context.primary,...(context.previewAsset?[context.previewAsset]:[])];
  if(focus.versionId){
    const version=(await tx.query('SELECT family_id FROM asset_versions WHERE object_id=$1',[focus.versionId])).rows[0];
    if(version){
      check(objectId===version.family_id||context.object.links.some(l=>l.id===version.family_id&&l.role==='FAMILY'),'CONTEXT_MATERIAL','所选版本不属于当前素材需求',409);
      const row=await unit.detail(focus.versionId);details.push(row);context.basis.push({objectId:row.id,revisionId:row.revision.id,sha256:row.revision.sha256,objectVersion:row.version});
    }
  }
  const references=focus.references||[];check(Array.isArray(references)&&references.length<=8,'CONTEXT_REFERENCES','一次最多补充 8 条资料');
  const missing=[];
  for(const reference of references){
    const id=typeof reference==='string'?reference:'';
    const found=(await tx.query('SELECT id FROM objects WHERE id=$1',[id])).rows[0];
    if(!found){missing.push('补充资料需通过已登记身份读取：'+id.slice(0,300));continue;}
    const row=await unit.detail(id);details.push(row);context.basis.push({objectId:row.id,revisionId:row.revision.id,sha256:row.revision.sha256,objectVersion:row.version});
  }
  const unique=[...new Map(details.map(d=>[d.revision.id,d])).values()];
  const resources=unique.map(row=>{
    const full=canonical(row.revision.content),partial=full.length>16000;
    const text=partial?canonical({id:row.id,kind:row.kind,title:row.title,revisionId:row.revision.id,sha256:row.revision.sha256,readRequired:true,fields:Object.keys(row.revision.content),instruction:'正文较长，本摘要未包含正文；请通过 read_object 或 read_source 读取。'}):full;
    const output=row.media?.find(m=>m.role==='OUTPUT'&&m.availability==='PRESENT');
    return {id:row.id,title:row.title,kind:row.kind,versionId:row.revision.id,sha256:row.revision.sha256,text,excerpt:partial?'完整正文按对象身份按需读取。':text.slice(0,300),href:'/?view='+({story:'story',settings:'settings',materials:'materials',production:'pipeline',project:'system'}[row.module]||'overview'),role:row.historical?'HISTORICAL':'CURRENT',relations:row.links.map(l=>l.id),...(output?{media:{kind:output.mime_type?.split('/')[0]||'unknown',sha256:output.sha256,previewUrl:'/api/v1/media/'+output.sha256}}:{})};
  });
  const sourceVersions=[...new Map(context.basis.map(b=>[b.revisionId,b])).values()].sort((a,b)=>a.revisionId.localeCompare(b.revisionId));
  const configurationVersions=unit.configurationVersions,dependencyHash=hash({sourceVersions,configurationVersions}),focusKey=hash(focus);
  const packet={focus,focusKey,dependencyHash,resources,draftTargets,missing,sourceVersions,configurationVersions,objectId,objectRevisionId:context.object.revision.id,objectVersion:context.object.version};
  check(Buffer.byteLength(canonical(packet))<=contextLimit,'CONTEXT_LIMIT','所选资料超过本轮上下文预算，请缩小到具体对象',413);
  const packetHash=hash(packet);return {...packet,packetHash,packetId:'context_'+packetHash.slice(0,32)};
}
export function publicContext(value){const {sourceVersions,configurationVersions,objectId,objectRevisionId,objectVersion,...context}=value;return {...context,resources:context.resources.map(({text,...r})=>r)};}
