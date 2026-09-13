import {check,hash} from '../shared/contracts.mjs';
export async function productionWindow(unit,params,{catalog=false}={}){
 const limit=Number(params.get('limit')||50);check(Number.isSafeInteger(limit)&&limit>0&&limit<=100,'PAGE_LIMIT','分页大小须为 1 至 100');
 const filters=Object.fromEntries(['phaseId','gateId','scopeType','scopeId'].map(k=>[k,params.get(k)||null]));
 check(Object.values(filters).every(v=>v===null||v.length<=500),'PAGE_FILTER','筛选条件过长');
 check(!filters.scopeType||['SHOT','SCENE','EPISODE','PROJECT'].includes(filters.scopeType),'PAGE_FILTER','范围类型无效');
 const rows=(await unit.tx.query(`SELECT o.id,o.version,r.id AS revision_id FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
  WHERE o.kind='EXPECTED_OUTPUT' AND NOT o.historical AND r.content ? 'workItemId' AND r.content ? 'workPackageId'
  AND COALESCE(r.content->>'expectationState','')<>'RETIRED'
  AND ($1::text IS NULL OR r.content->>'phaseId'=$1) AND ($2::text IS NULL OR r.content->>'gateId'=$2)
  AND ($3::text IS NULL OR $4::text IS NULL OR $3='PROJECT' OR $3='SCENE' AND r.content->>'sceneId'=$4 OR $3='SHOT' AND r.content->>'shotId'=$4
    OR $3='EPISODE' AND EXISTS(SELECT 1 FROM episode_scenes es WHERE es.episode_id=$4 AND es.scene_id=r.content->>'sceneId'))
  ORDER BY o.id`,[filters.phaseId,filters.gateId,filters.scopeType,filters.scopeId])).rows;
 const version=hash(rows),filterHash=hash(filters);let after='';
 if(!catalog&&params.has('cursor')){let c;try{c=JSON.parse(Buffer.from(params.get('cursor'),'base64url').toString());}catch{check(false,'PAGE_CURSOR','分页游标无效');}
  check(c?.resource==='production'&&typeof c.after==='string','PAGE_CURSOR','分页游标无效');check(c.version===version&&c.filters===filterHash,'VERSION_CONFLICT','制作目录或筛选条件已改变，请重新读取',409);after=c.after;
 }
 const selected=rows.filter(r=>r.id>after).slice(0,catalog?rows.length:limit),last=selected.at(-1)?.id,hasMore=!!last&&rows.some(r=>r.id>last);
 return {ids:selected.map(r=>r.id),readVersion:version,count:selected.length,total:rows.length,hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({resource:'production',version,filters:filterHash,after:last})).toString('base64url'):null,appliedFilters:filters};
}
