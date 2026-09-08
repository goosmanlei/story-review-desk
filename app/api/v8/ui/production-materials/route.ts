import {parseProductionMaterialQuery,queryProductionMaterialPage} from '../../../../../host/instance-runtime/production-material-query.mjs';
import {errorResponse,HttpError,jsonResponse,operationalSnapshot,reviewData,stableObjectHash} from '../../_store';
import {jsonByteLength,UI_PAGE_MAX_BYTES} from '../_pagination';

export async function GET(request:Request) {
  try {
    const [data,operations]=await Promise.all([reviewData(),operationalSnapshot()]);
    if(operations.snapshotId!==data.snapshotId)throw new HttpError(409,'制作素材与当前快照不一致，请重新读取');
    const query=parseProductionMaterialQuery(new URL(request.url),{snapshotId:data.snapshotId,operationRevision:operations.operationRevision});
    let page=queryProductionMaterialPage(data.productionModel,operations.stateProjection,query);
    while(jsonByteLength(page)>UI_PAGE_MAX_BYTES && query.limit>1 && !query.filters.familyId){query.limit=Math.max(1,Math.floor(query.limit/2));page=queryProductionMaterialPage(data.productionModel,operations.stateProjection,query);}
    if(jsonByteLength(page)>UI_PAGE_MAX_BYTES)throw new HttpError(413,'制作素材详情超出单页上限，请按镜头与独立产物拆分');
    const latest=await operationalSnapshot();
    if(latest.snapshotId!==operations.snapshotId||latest.operationRevision!==operations.operationRevision)throw new HttpError(409,'制作素材状态读取期间已更新，请重新读取');
    const etag='"production-materials:'+stableObjectHash([query.version,query.filterHash,query.after,query.limit,query.versionId,query.summary])+'"';
    if(request.headers.get('If-None-Match')===etag)return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'private, no-cache'}});
    return jsonResponse({...page,snapshotId:data.snapshotId,operationRevision:operations.operationRevision},{headers:{ETag:etag,'Cache-Control':'private, no-cache'}});
  }catch(error){
    if(error instanceof Error && 'status' in error && typeof error.status==='number' && !(error instanceof HttpError))return errorResponse(new HttpError(error.status,error.message));
    return errorResponse(error);
  }
}
