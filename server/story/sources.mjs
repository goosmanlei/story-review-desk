import {check,hash,identity} from '../shared/contracts.mjs';
import {PresentationRead} from '../presentation/read-unit.mjs';
const roles=['PRIMARY','DERIVED','AUXILIARY'];
export function validateSourceInput(input){
 check(typeof input.title==='string'&&input.title.trim()&&input.title.length<=300,'SOURCE_TITLE','请填写资料名称，至多 300 字');
 check(roles.includes(input.role),'SOURCE_ROLE','请选择原始依据、派生整理或辅助资料');
}
export async function planSourceRegistration(tx,input,operationId){
 validateSourceInput(input);
 check(typeof input.text==='string'&&input.text.trim()&&Buffer.byteLength(input.text,'utf8')<=8*1024*1024,'SOURCE_TEXT','来源文字为空或超过 8 MiB');
 const sourceId=input.id||'source:'+hash(operationId).slice(0,32);identity(sourceId);
 const unit=new PresentationRead(tx),project=await unit.profile();
 check(input.instanceId===undefined||input.instanceId===project.instanceId,'INSTANCE_CONFLICT','来源目标实例不一致',409);
 const sha256=hash(Buffer.from(input.text,'utf8'));
 return {commands:[{type:'save',id:sourceId,kind:'SOURCE',title:input.title.trim(),expectedVersion:0,content:{role:input.role,authority:input.role==='PRIMARY'?'F':'U',text:input.text,sha256,mimeType:'text/plain',originalFilename:null,observation:'TEXT_AVAILABLE',sourceRegistration:true}}],response:results=>({source:{id:sourceId,revisionId:results[0].revisionId,sha256,title:input.title.trim(),textAvailable:true},formalAdoptionPerformed:false})};
}
export function sourceUploadRequest(file,input,binding){
 validateSourceInput(input);
 check(typeof input.originalFilename==='string'&&input.originalFilename.length<=300&&!/[\u0000-\u001f/\\]/.test(input.originalFilename),'SOURCE_FILENAME','原始文件名无效');
 check(file.bytes<=128*1024*1024,'SOURCE_SIZE','单份来源文件至多 128 MiB',413);
 const mimeType=/^[a-z]+\/[a-z0-9.+-]+$/i.test(input.mimeType||'')?input.mimeType.toLowerCase():'application/octet-stream';
 return {...binding,...file,kind:'SOURCE_IMPORT',title:input.title.trim(),role:input.role,originalFilename:input.originalFilename,mimeType,mediaId:'source-media:'+file.sha256,versionId:file.sha256};
}
export function sourceObjectCommand(request,text){
 return {type:'save',id:'source:'+hash(request.operationId).slice(0,32),kind:'SOURCE',title:request.title,expectedVersion:0,content:{role:request.role,authority:request.role==='PRIMARY'?'F':'U',text:text??'',sha256:request.sha256,mimeType:request.mimeType,originalFilename:request.originalFilename,originalMediaSha256:request.sha256,byteSize:request.bytes,observation:text===null?'ORIGINAL_UNOBSERVED':'TEXT_AVAILABLE',sourceRegistration:true},media:[{id:request.mediaId,versionId:request.versionId,sha256:request.sha256,role:'SOURCE'}]};
}
