import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {hash,check} from '../server/shared/contracts.mjs';
let body='';for await(const chunk of process.stdin){body+=chunk;check(Buffer.byteLength(body)<=8*1024*1024,'INPUT_LIMIT','清单输入超过范围');}
const {request,outputDirectory}=JSON.parse(body),content=request.manifest.content;
check(path.isAbsolute(outputDirectory)&&hash(content)===request.manifest.manifestHash&&content.formalReviewCreated===false,'MANIFEST_PROTOCOL','清单协议无效');
const file='production-manifest.json';await writeFile(path.join(outputDirectory,file),JSON.stringify(content,null,2),{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({type:'answer',value:{outputs:[{file,mimeType:'application/json',title:'待审制作清单'}],observed:false}})+'\n');
