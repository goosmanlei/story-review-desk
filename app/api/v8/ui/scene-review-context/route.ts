import {errorResponse,jsonResponse,reviewData,operationalSnapshot,HttpError,stableObjectHash} from '../../_store';
import {resolveSceneNarrativeContext} from '../../_scene-narrative';
export async function GET(request: Request) {
  try {
    const url=new URL(request.url), sceneId=url.searchParams.get('sceneId'), revisionId=url.searchParams.get('revisionId');
    if(!sceneId || !revisionId) throw new HttpError(400,'必须指定方案版本和永久场ID');
    const [data,operations]=await Promise.all([reviewData(),operationalSnapshot()]);
    const context=resolveSceneNarrativeContext(data,operations,sceneId,revisionId);
    const scene=data.creativeLineage?.scenes?.find(row=>row.id===sceneId) as unknown as {id:string;title:string;displayId?:string;authoringEntry?:string;scriptBlocks?:NonNullable<typeof context.sceneDocument>['scriptBlocks'];sourceBindings?:NonNullable<typeof context.sceneDocument>['sourceBindings']}|undefined;
    if(scene?.authoringEntry==='GENERIC_AUTHORING_DRAFT'){
      if(!scene.scriptBlocks?.length||stableObjectHash(scene.scriptBlocks)!==context.sceneContentHash)throw new HttpError(409,'本场正文与受审版本哈希不一致');
      context.sceneDocument={id:scene.id,title:scene.title,displayId:scene.displayId||scene.id,contentHash:context.sceneContentHash,scriptBlocks:scene.scriptBlocks,sourceBindings:scene.sourceBindings||[]};
    }
    return jsonResponse({context});
  } catch(error){return errorResponse(error,'本场承接材料读取失败');}
}
