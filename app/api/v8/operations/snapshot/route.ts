import { errorResponse, jsonResponse, operationalSnapshot } from '../../_store';

export async function GET(request:Request) {
  try {
    const snapshot = await operationalSnapshot();
    const summary=new URL(request.url).searchParams.get('summary')==='1';
    return jsonResponse(summary?{snapshotId:snapshot.snapshotId,operationRevision:snapshot.operationRevision,etag:snapshot.etag,mutationEtag:snapshot.mutationEtag}:snapshot, { headers: { ETag: snapshot.etag } });
  } catch (reason) {
    return errorResponse(reason, 'operational snapshot is unavailable');
  }
}
