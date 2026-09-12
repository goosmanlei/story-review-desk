import {createHash} from 'node:crypto';
import {filterProductionMaterials,overlayProductionMaterialModel,projectProductionMaterials,productionMaterialKinds} from './production-materials.mjs';
const fields = ['search','familyId','workItemId','kind','mediaType','lifecycleState','gateId','episodeUid','sceneId','shotId'];
const digest = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const list=value=>Array.isArray(value)?value:[];
const refs=(rows,key)=>new Set(rows.flatMap(row=>list(row[key])));

export function parseProductionMaterialQuery(url,basis) {
  const filters=Object.fromEntries(fields.map(key=>[key,url.searchParams.get(key)||null]));
  for(const [key,value]of Object.entries(filters))if(value && (value.length>500 || key!=='search' && !/^[A-Za-z0-9][A-Za-z0-9:_.@-]*$/.test(value)))fail(400,'制作素材筛选参数无效：'+key);
  if(filters.kind&&!productionMaterialKinds.some(row=>row.id===filters.kind))fail(400,'未知制作素材种类');
  if(filters.mediaType&&!['IMAGE','AUDIO','VIDEO','TEXT','UNKNOWN'].includes(filters.mediaType))fail(400,'未知制作素材媒介');
  const rawLimit=url.searchParams.get('limit')||'50';
  if(!/^\d+$/.test(rawLimit)||Number(rawLimit)<1||Number(rawLimit)>100)fail(400,'分页大小须为1至100');
  const limit=Number(rawLimit),filterHash=digest(filters),version=digest(basis);let after=null;
  const encoded=url.searchParams.get('cursor');
  if(encoded){
    let cursor;try{cursor=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{fail(400,'制作素材分页游标无效');}
    if(cursor.v!==1||cursor.resource!=='production-materials'||typeof cursor.after!=='string')fail(400,'制作素材分页游标无效');
    if(cursor.version!==version||cursor.filterHash!==filterHash)fail(409,'制作素材的发布、运行状态或筛选条件已变化，请重新读取');
    after=cursor.after;
  }
  const versionId=url.searchParams.get('versionId')||null;
  if(versionId&&(!filters.familyId||!/^[A-Za-z0-9][A-Za-z0-9:_.@-]*$/.test(versionId)))fail(400,'版本深链须绑定精确素材族');
  return{filters,limit,filterHash,version,after,versionId,summary:url.searchParams.get('detail')==='summary'};
}

/** Shared local/hosted query. Cursor binds the actual operation watermark, not
 * merely the software snapshot. Family ownership never derives from a filename. */
export function queryProductionMaterialPage(sourceModel,projection,query) {
  const model=overlayProductionMaterialModel(sourceModel,projection),catalog=projectProductionMaterials(model);
  const matched=filterProductionMaterials(catalog.rows,query.filters);
  if(query.filters.familyId&&!matched.length)fail(404,'当前制作素材不存在或归属无法精确核验');
  const selected=matched.filter(row=>!query.after||row.id>query.after).slice(0,query.filters.familyId?1:query.limit);
  if(query.versionId&&(!selected[0]||!selected[0].versionIds.includes(query.versionId)&&!selected[0].expectedOutputIds.includes(query.versionId)))fail(404,'该版本不属于当前制作素材');
  const last=selected.at(-1)?.id,hasMore=Boolean(last&&matched.some(row=>row.id>last));
  const packageIds=new Set(selected.map(row=>row.workPackageId));
  const workPackages=list(model.workPackages).filter(row=>packageIds.has(row.id));
  const itemIds=new Set([...selected.map(row=>row.workItemId),...refs(workPackages,'workItemRefs'),...refs(workPackages,'workItemIds')]);
  const workItems=list(model.workItems).filter(row=>itemIds.has(row.id));
  const familyIds=new Set([...selected.map(row=>row.familyId),...workItems.map(row=>row.outputAssetRef),...refs(workItems,'inputAssetRefs'),...refs(workItems,'additionalOutputAssetRefs')]);
  const assetFamilies=list(model.assetFamilies).filter(row=>familyIds.has(row.id));
  const versionIds=query.summary?new Set(assetFamilies.map(row=>row.currentVersionId)):refs(assetFamilies,'versionRefs');
  const assetVersions=list(model.assetVersions).filter(row=>familyIds.has(row.familyId)&&versionIds.has(row.id));
  const expectedOutputIds=refs(assetFamilies,'expectedOutputRefs');
  const expectedOutputs=query.summary?[]:list(model.expectedOutputs).filter(row=>familyIds.has(row.familyId)&&expectedOutputIds.has(row.id));
  const shotIds=new Set([...refs(workPackages,'shotIds'),...refs(selected,'shotIds')]);
  const sceneIds=new Set([...refs(selected,'sceneIds'),...workPackages.map(row=>row.sceneId)]);
  const episodeUids=refs(selected,'episodeUids');
  const reviewContextIds=new Set([...workItems.map(row=>row.reviewContextRef),...workPackages.map(row=>row.reviewContextRef)]);
  return{
    schemaVersion:'1.0',entries:selected,total:matched.length,count:selected.length,hasMore,
    nextCursor:hasMore?Buffer.from(JSON.stringify({v:1,resource:'production-materials',version:query.version,filterHash:query.filterHash,after:last})).toString('base64url'):null,
    appliedFilters:query.filters,detailState:query.summary?'SUMMARY':'COMPLETE',issues:catalog.issues,
    facets:{kinds:productionMaterialKinds.map(kind=>({...kind,count:catalog.rows.filter(row=>row.kind===kind.id).length})),
      lifecycleStates:[...new Set(catalog.rows.map(row=>row.lifecycleState))].sort(),
      episodeUids:[...new Set(catalog.rows.flatMap(row=>row.episodeUids))].sort(),sceneIds:[...new Set(catalog.rows.flatMap(row=>row.sceneIds))].sort()},
    page:query.summary?{}:{workItems,workPackages,assetFamilies,assetVersions,expectedOutputs,
      shots:list(model.shots).filter(row=>shotIds.has(row.id)),scenes:list(model.scenes).filter(row=>sceneIds.has(row.id)),
      episodes:list(model.episodes).filter(row=>episodeUids.has(row.episodeUid)),
      reviewContexts:list(model.reviewContexts).filter(row=>reviewContextIds.has(row.id))},
  };
}
