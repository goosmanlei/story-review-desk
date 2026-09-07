import {queryObjects,updateOperationalProjection,objectSummary} from '../../../../host/instance-runtime/query-model.mjs';
import {instanceRepository,operationalSnapshot,reviewData,HttpError,stableObjectHash,jsonResponse} from '../_store';
import {parseUiPageRequest} from './_pagination';
const projectionWrites=new Map<string,Promise<void>>();
type Row=Record<string,unknown> & {id?:string};
const strings=(v:unknown):string[]=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'):[];
const refs=(rows:Row[],key:string)=>[...new Set(rows.flatMap(r=>strings(r[key])))];
const oneRefs=(rows:Row[],key:string)=>[...new Set(rows.flatMap(r=>typeof r[key]==='string'?[r[key] as string]:[]))];
export async function postgresMaterialPage(request:Request,data:Awaited<ReturnType<typeof reviewData>>,operations:Awaited<ReturnType<typeof operationalSnapshot>>,validateFilters:(data:Awaited<ReturnType<typeof reviewData>>,filters:ReturnType<typeof parseUiPageRequest>['filters'])=>void) {
  const repo=await instanceRepository();if(repo?.backend!=='postgres')return null;
  const url=new URL(request.url),summary=url.searchParams.get('detail')==='summary',requirementId=url.searchParams.get('requirementId');
  const mode=url.searchParams.get('mode')||'requirements';
  if(mode!=='requirements')throw new HttpError(mode==='ledger'?410:400,'素材目录仅提供当前素材需求');
  if(url.searchParams.has('familyId'))throw new HttpError(400,'请通过素材需求打开详情');
  const metadata=await repo.getMetadata();if(!metadata.releaseId)throw new HttpError(503,'当前实例尚无发布');
  const releaseId=metadata.releaseId,version=`${releaseId}:${metadata.eventSequence}:${operations.operationRevision}`;
  let projection=projectionWrites.get(version);
  if(!projection){
    projection=repo.writeTransaction(async tx=>{
      const current=await tx.getMetadata();
      if(current.releaseId!==releaseId||current.eventSequence!==metadata.eventSequence)throw new HttpError(409,'素材状态已更新，请重新读取');
      // The caller may have read operations before metadata advanced. Rebuild
      // under the repository write lock; never label stale state with a new sequence.
      const lockedOperations=await operationalSnapshot();
      if(lockedOperations.snapshotId!==data.snapshotId||lockedOperations.operationRevision!==operations.operationRevision)throw new HttpError(409,'素材状态已更新，请重新读取');
      await updateOperationalProjection(tx,{releaseId,eventSequence:metadata.eventSequence,stateProjection:lockedOperations.stateProjection});
    }).finally(()=>{if(projectionWrites.get(version)===projection)projectionWrites.delete(version);});projectionWrites.set(version,projection);
  }
  await projection;
  const clean=new URL(url);clean.searchParams.delete('cursor');
  const parsed=parseUiPageRequest(new Request(clean),'materials:requirements',data.snapshotId);
  validateFilters(data,parsed.filters);
  let after:string|undefined;
  if(url.searchParams.get('cursor')){
    let cursor:Record<string,unknown>;
    try{cursor=JSON.parse(Buffer.from(url.searchParams.get('cursor')!,'base64url').toString());}catch{throw new HttpError(400,'分页游标无效');}
    if(cursor.v!==2||cursor.resource!=='materials'||cursor.version!==version||cursor.filterHash!==parsed.filterHash||typeof cursor.after!=='string')throw new HttpError(409,'素材分页依据已变化，请重新读取');
    after=cursor.after;
  }
  return repo.readTransaction(async tx=>{
    const current=await tx.getMetadata();if(current.releaseId!==releaseId||current.eventSequence!==metadata.eventSequence)throw new HttpError(409,'素材状态已更新，请重新读取');
    let ids=requirementId?[requirementId]:undefined;
    if(parsed.filters.phaseId||parsed.filters.gateId){
      const valid=new Set(data.productionModel.workItems.filter(w=>w.activeInCurrentProduction===true&&(!parsed.filters.phaseId||w.phaseId===parsed.filters.phaseId)&&(!parsed.filters.gateId||w.gateId===parsed.filters.gateId)).map(w=>w.id));
      ids=(data.productionModel.materialRequirements||[]).filter(r=>(!ids||ids.includes(r.id))&&strings(r.consumerWorkItemRefs).some(id=>valid.has(id))).map(r=>r.id);
    }
    const result=await queryObjects(tx,{releaseId,collection:'materialRequirements',ids,required:true,scopeType:parsed.filters.scopeType,scopeId:parsed.filters.scopeId,after,limit:requirementId?1:parsed.limit,summary});
    if(requirementId&&!result.items.length)throw new HttpError(404,'当前素材需求不存在');
    const requirements=result.items,requirementIds=oneRefs(requirements,'id');
    const work=await queryObjects(tx,{releaseId,collection:'materialWorkItems',requirementIds,limit:1000,summary});
    const familyIds=[...new Set([...refs(requirements,'assetFamilyRefs'),...refs(requirements,'coveredByFamilyRefs'),...oneRefs(requirements,'plannedAssetFamilyId'),...oneRefs(work.items,'outputAssetRef'),...refs(work.items,'additionalOutputAssetRefs'),...(!summary?refs(work.items,'inputAssetRefs'):[])])];
    const families=await queryObjects(tx,{releaseId,collection:'assetFamilies',ids:familyIds,limit:1000,summary});
    const versionIds=oneRefs(families.items,'currentVersionId');
    const versions=await queryObjects(tx,{releaseId,collection:'assetVersions',...(summary?{ids:versionIds}:{familyIds}),limit:1000,summary});
    const expected=summary?{items:[]}:await queryObjects(tx,{releaseId,collection:'expectedOutputs',familyIds,limit:1000});
    const more=!requirementId&&requirements.length===parsed.limit&&Boolean(result.lastId)&&Boolean((await queryObjects(tx,{releaseId,collection:'materialRequirements',ids,required:true,scopeType:parsed.filters.scopeType,scopeId:parsed.filters.scopeId,after:result.lastId!,limit:1,summary:true})).items.length);
    const payload={schemaVersion:'1.0',snapshotId:data.snapshotId,operationRevision:operations.operationRevision,appliedMode:'requirements',detailState:summary?'SUMMARY':'COMPLETE',page:{materialRequirements:requirements,materialWorkItems:work.items,assetFamilies:families.items,assetVersions:versions.items,expectedOutputs:expected.items},count:requirements.length,total:result.total,nextCursor:more?Buffer.from(JSON.stringify({v:2,resource:'materials',version,filterHash:parsed.filterHash,after:result.lastId})).toString('base64url'):null,hasMore:more,appliedFilters:parsed.filters};
    const etag='"materials:'+stableObjectHash([version,parsed.filters,after,requirementId,summary])+'"';
    if(request.headers.get('If-None-Match')===etag)return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'private, no-cache'}});
    return jsonResponse(payload,{headers:{ETag:etag,'Cache-Control':'private, no-cache'}});
  });
}
export function summarizeMaterialPage<T extends {page:Record<string,unknown>}>(payload:T):T {
  return {...payload,page:Object.fromEntries(Object.entries(payload.page).map(([key,value])=>[key,Array.isArray(value)?value.map(r=>objectSummary(r)):value]))};
}
