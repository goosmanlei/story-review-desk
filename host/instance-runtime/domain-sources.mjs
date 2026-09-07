import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { canonicalJson, sha256 } from './bytes.mjs';

const error = (message, code='DOMAIN_INVALID') => { throw Object.assign(new Error(message),{code}); };
const parse = record => record ? JSON.parse(record.bytes) : null;
const roles = new Set(['PRIMARY','DERIVED','AUXILIARY']);
const formats = {'.txt':'TEXT','.md':'TEXT','.json':'TEXT','.csv':'TEXT','.yaml':'TEXT','.yml':'TEXT','.docx':'DOCX','.pdf':'PDF','.mp3':'AUDIO','.wav':'AUDIO','.m4a':'AUDIO','.flac':'AUDIO','.ogg':'AUDIO','.mp4':'VIDEO','.mov':'VIDEO','.webm':'VIDEO'};
function run(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let out='',err='',size=0;const decoder=new StringDecoder('utf8');const timer=setTimeout(()=>child.kill('SIGKILL'),30000);child.on('error',reject);child.stdout.on('data',b=>{size+=b.length;if(size>32*1024*1024)child.kill('SIGKILL');else out+=decoder.write(b);});child.stderr.on('data',b=>{err=(err+b.toString()).slice(-2000);});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(out+decoder.end());else reject(Object.assign(new Error(`资料文本提取失败：${err||command+'不可用或超时'}`),{code:'SOURCE_EXTRACTION_FAILED'}));});});}
async function safeRoot(root){const resolved=await realpath(path.resolve(root));if((await lstat(resolved)).isSymbolicLink())error('实例目录不安全');return resolved;}
async function blob(root,bytes,extension){const hash=sha256(bytes),relativePath=`media/blobs/${hash}${extension}`,target=path.join(root,relativePath);await mkdir(path.dirname(target),{recursive:true,mode:0o700});if(await realpath(path.dirname(target))!==path.dirname(target))error('媒体目录不得经过符号链接');try{await writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||sha256(await readFile(target))!==hash)error('已登记原件字节冲突','DOMAIN_CONFLICT');}return {sha256:hash,relativePath,byteSize:bytes.length};}
export async function prepareSourceImport(input,instanceRoot){
 if(!input||typeof input!=='object')error('资料导入请求无效');
 if(typeof input.title!=='string'||!input.title.trim()||input.title.length>300)error('请填写资料标题');if(!roles.has(input.role))error('请选择原始、整理或辅助资料');
 const filename=input.filename||'source.txt';if(typeof filename!=='string'||path.basename(filename)!==filename||filename.length>240)error('文件名无效');const extension=path.extname(filename).toLowerCase(),format=formats[extension];if(!format)error('支持文本、DOCX、PDF以及原始音视频文件');
 const bytes=input.bytes instanceof Uint8Array?Buffer.from(input.bytes):typeof input.contentBase64==='string'?Buffer.from(input.contentBase64,'base64'):typeof input.text==='string'?Buffer.from(input.text,'utf8'):null;
 if(!bytes?.length||bytes.length>128*1024*1024)error('资料文件须在1字节至128MiB之间');if(input.contentBase64&&bytes.toString('base64')!==input.contentBase64)error('文件编码无效');
 if(!instanceRoot)error('未选择实例目录');const root=await safeRoot(instanceRoot);let extractedText=null;
 if(format==='TEXT'){if(bytes.length>32*1024*1024)error('文本资料不能超过32MiB');extractedText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 if(['PDF','DOCX'].includes(format)){
  const scratchRoot=path.join(root,'scratch');await mkdir(scratchRoot,{recursive:true,mode:0o700});if(await realpath(scratchRoot)!==scratchRoot)error('临时目录不安全');const temporary=await mkdtemp(path.join(scratchRoot,'source-'));const local=path.join(temporary,filename);
  try{await writeFile(local,bytes,{flag:'wx',mode:0o600});if(format==='PDF')extractedText=await run('pdftotext',['-layout','-enc','UTF-8',local,'-']);else extractedText=await run('python3',['-c',"import sys,zipfile,xml.etree.ElementTree as ET\nwith zipfile.ZipFile(sys.argv[1]) as z:\n i=z.getinfo('word/document.xml')\n if i.file_size>33554432: raise ValueError('document XML too large')\n root=ET.fromstring(z.read(i))\n ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}\n print('\\n'.join(''.join(p.itertext()) for p in root.findall('.//w:p',ns)))",local]);}
  finally{await rm(temporary,{recursive:true,force:true});}
 }
 const stored=await blob(root,bytes,extension);
 return {id:`source_${stored.sha256}`,title:input.title.trim(),role:input.role,filename,format,...stored,extractedText,observation:['AUDIO','VIDEO'].includes(format)?'ORIGINAL_UNOBSERVED':format==='PDF'&&!extractedText?.trim()?'TEXT_UNAVAILABLE_NO_OCR':'EXTRACTED_TEXT_ONLY',extraction:{method:format==='TEXT'?'UTF8':format==='PDF'?'PDFTOTEXT':format==='DOCX'?'OOXML_TEXT':'NOT_ANALYZED',rawSha256:stored.sha256,textSha256:extractedText===null?null:sha256(Buffer.from(extractedText))},expectedReleaseId:input.expectedReleaseId};
}
export async function importSource(tx,prepared){
 const release=await tx.readRelease();
 const existing=await tx.getAux('domain-sources',prepared.id);if(existing){const old=parse(existing);if(old.sha256!==prepared.sha256||old.role!==prepared.role||old.title!==prepared.title)error('相同原件已经登记，请在既有资料中核对标题与来源级别','DOMAIN_CONFLICT');return {source:{...old,revisionId:old.documentRevisionId,registryRevisionId:existing.revisionId},releaseId:release.releaseId,replayed:true};}
 if(!release||release.releaseId!==prepared.expectedReleaseId)error('当前发布已变化，请刷新资料列表','DOMAIN_CONFLICT');
 await tx.registerMedia({mediaId:prepared.id,versionId:'ORIGINAL',relativePath:prepared.relativePath,sha256:prepared.sha256,byteSize:prepared.byteSize,aliases:[`sources/${prepared.id}/${prepared.filename}`],metadata:{sourceRole:'ORIGINAL_SOURCE',observation:prepared.observation,title:prepared.title,mediaKind:prepared.format},availability:'PRESENT'});
 const sourceDocument=await tx.putDocument({documentId:`document:${prepared.id}`,bytes:Buffer.from(prepared.extractedText===null?canonicalJson({title:prepared.title,format:prepared.format,originalSha256:prepared.sha256,observation:prepared.observation}):prepared.extractedText),aliases:[`story/sources/${prepared.id}.${prepared.extractedText===null?'json':'txt'}`],expectedRevisionId:null,mediaType:prepared.extractedText===null?'application/json':'text/plain',metadata:{sourceRole:'SOURCE_DOCUMENT',title:prepared.title,sourceId:prepared.id,evidenceRole:prepared.role,originalMediaId:prepared.id,originalSha256:prepared.sha256,observation:prepared.observation,authoringEntry:'DOMAIN_SOURCE_IMPORT',reviewState:'REFERENCE'}});
 const source={schemaVersion:'1.0',id:prepared.id,title:prepared.title,role:prepared.role,filename:prepared.filename,format:prepared.format,sha256:prepared.sha256,byteSize:prepared.byteSize,documentId:sourceDocument.documentId,documentRevisionId:sourceDocument.revisionId,documentSha256:sourceDocument.sha256,extraction:prepared.extraction,status:'REGISTERED',observation:prepared.observation,importedAt:new Date().toISOString(),textAvailable:prepared.extractedText!==null&&Boolean(prepared.extractedText.trim())};
 const saved=await tx.putAux({namespace:'domain-sources',key:prepared.id,bytes:Buffer.from(canonicalJson(source)),expectedRevisionId:null,mediaType:'application/json'});
 const published=await tx.publishRelease({snapshotBytes:release.snapshotBytes,recipesBytes:release.recipesBytes,sourceRevisionIds:[...release.sourceRevisionIds,sourceDocument.revisionId],expectedReleaseId:release.releaseId});
 return {source:{...source,revisionId:sourceDocument.revisionId,registryRevisionId:saved.revisionId},releaseId:published.releaseId,replayed:false};
}
export async function listDomainSources(tx,{includeText=false}={}){
 const metadata=await tx.getMetadata();if(!metadata.releaseId)error('实例尚无已发布资料');const published=new Set((await tx.listPublishedDocumentMetadata()).map(r=>r.revisionId));const records=await tx.listAux('domain-sources');const sources=[];
 for(const record of records){const source=parse(record);if(!published.has(source.documentRevisionId))continue;const result={...source,revisionId:source.documentRevisionId,registryRevisionId:record.revisionId,evidenceSha256:source.documentSha256};if(includeText&&source.textAvailable){const doc=await tx.readDocumentRevision(source.documentRevisionId);if(!doc||doc.sha256!==source.documentSha256)error('来源正文绑定已失效','DOMAIN_CONFLICT');result.text=Buffer.from(doc.bytes).toString('utf8');}sources.push(result);}
 return {releaseId:metadata.releaseId,sources,readOnly:false};
}
/** Explicit migration of an existing published reference; never adopts a document head. */
export async function registerPublishedSource(tx,input){
 if(!roles.has(input.role)||typeof input.title!=='string'||!input.title.trim()||input.title.length>300||typeof input.alias!=='string')error('现有资料登记参数无效');
 const metadata=await tx.getMetadata();if(metadata.releaseId!==input.expectedReleaseId)error('当前发布已变化','DOMAIN_CONFLICT');let doc=await tx.getPublishedDocument(input.alias);const media=!doc?await tx.resolveMedia(input.alias):null;if(!doc&&!media)error('资料不在当前已发布版本或已登记原件中');
 const format=formats[path.extname(input.alias).toLowerCase()]||(doc?.mediaType?.startsWith('audio/')?'AUDIO':doc?.mediaType?.startsWith('video/')?'VIDEO':doc?.mediaType?.startsWith('text/')||doc?.mediaType?.includes('json')?'TEXT':'BINARY');
 const isText=Boolean(doc)&&['TEXT'].includes(format)&&(!doc?.mediaType||doc.mediaType.startsWith('text/')||doc.mediaType.includes('json'));
 let publishedReleaseId=metadata.releaseId;
 if(media){if(media.availability!=='PRESENT')error('已登记原件目前不可用');const sourceId=`source_${media.sha256}`;const existing=await tx.getAux('domain-sources',sourceId);if(existing)return{source:parse(existing),releaseId:metadata.releaseId,replayed:true};const release=await tx.readRelease();doc=await tx.putDocument({documentId:`source-metadata:${media.mediaId}:${media.versionId}`,aliases:[`story/sources/${sourceId}.json`],expectedRevisionId:null,bytes:canonicalJson({sourceId,mediaId:media.mediaId,versionId:media.versionId,sha256:media.sha256,alias:input.alias,format,observation:'ORIGINAL_UNOBSERVED'}),mediaType:'application/json',metadata:{sourceRole:'SOURCE_DOCUMENT',evidenceRole:input.role,observation:'ORIGINAL_UNOBSERVED',originalMediaId:media.mediaId,originalVersionId:media.versionId,originalSha256:media.sha256}});const published=await tx.publishRelease({snapshotBytes:release.snapshotBytes,recipesBytes:release.recipesBytes,sourceRevisionIds:[...release.sourceRevisionIds,doc.revisionId],expectedReleaseId:release.releaseId});publishedReleaseId=published.releaseId;}
 const sourceId=`source_${media?.sha256||doc.sha256}`,old=await tx.getAux('domain-sources',sourceId);if(old)return{source:parse(old),releaseId:publishedReleaseId,replayed:true};
 const source={schemaVersion:'1.0',id:sourceId,title:input.title.trim(),role:input.role,filename:path.posix.basename(input.alias),format,sha256:media?.sha256||doc.sha256,byteSize:media?.byteSize||doc.bytes.length,documentId:doc.documentId,documentRevisionId:doc.revisionId,documentSha256:doc.sha256,status:'REGISTERED',observation:isText?'PUBLISHED_TEXT_ONLY':'ORIGINAL_UNOBSERVED',importedAt:new Date().toISOString(),textAvailable:isText,legacyAlias:input.alias};
 await tx.putAux({namespace:'domain-sources',key:sourceId,bytes:canonicalJson(source),expectedRevisionId:null,mediaType:'application/json'});return{source,releaseId:publishedReleaseId,replayed:false};
}
export async function sourceBindingsFor(tx){const result=await listDomainSources(tx);return result.sources.map(s=>({sourceId:s.id,revisionId:s.documentRevisionId,sha256:s.documentSha256}));}
export async function verifySourceBindings(tx,bindings,{allowLegacy=false}={}){
 const published=new Map((await tx.listPublishedDocumentMetadata()).map(r=>[r.revisionId,r]));const records=await tx.listAux('domain-sources');const known=new Map(records.map(r=>{const v=parse(r);return[v.id,v];}));
 for(const b of bindings){const source=known.get(b.sourceId);if(!source&&!allowLegacy)error('来源未登记','DOMAIN_CONFLICT');const document=published.get(b.revisionId);if(!document||document.sha256!==b.sha256||source&&source.documentRevisionId!==b.revisionId||!source&&b.sourceId!==`source_${document.sha256}`)error(`来源已变化：${b.sourceId}`,'DOMAIN_CONFLICT');}
 return true;
}
export function newSourceRequestId(){return `source-request_${randomUUID()}`;}
