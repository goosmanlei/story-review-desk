import { createHash } from 'node:crypto';
import { errorResponse, hostedReadOnlyMode, HttpError, instanceRepository, jsonResponse, readInstanceDocument, readPublishedInstanceDocuments } from '../../v8/_store';
export async function GET(request: Request) {
  try {
    if(hostedReadOnlyMode()) throw new HttpError(405,'此目录仅在本地实例读取');
    const repo=await instanceRepository();
    if(!repo) throw new HttpError(503,'当前入口尚未启用独立实例');
    const id=new URL(request.url).searchParams.get('id');
    if(id){
      const record=await readInstanceDocument(id);
      if(!record||!['SOURCE_DOCUMENT','AUTHORING_DRAFT','INSTANCE_GUIDANCE'].includes(String(record.metadata.sourceRole)))throw new HttpError(404,'来源文档不可在此入口读取');
      const text=Buffer.from(record.bytes).toString('utf8');
      return jsonResponse({focusId:`document:${createHash('sha256').update(record.documentId).digest('hex')}`,documentId:record.documentId,revisionId:record.revisionId,title:record.metadata.title||record.aliases[0]||record.documentId,sha256:record.sha256,text:text.slice(0,200000),truncated:text.length>200000});
    }
    return jsonResponse({documents:(await readPublishedInstanceDocuments()).map(record=>({documentId:record.documentId,revisionId:record.revisionId,title:record.metadata.title||record.aliases[0]||record.documentId,sourceRole:record.metadata.sourceRole,sha256:record.sha256,byteSize:record.bytes.byteLength}))});
  }catch(error){return errorResponse(error,'实例文档读取失败');}
}
