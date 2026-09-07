import path from 'node:path';
import {mkdir,lstat,realpath} from 'node:fs/promises';
export const uploadIdPattern=/^upload_[a-f0-9-]{36}$/;
export async function maintenanceUploadDirectory(root){
 root=await realpath(root);const target=path.join(root,'scratch','maintenance-imports');
 await mkdir(target,{recursive:true,mode:0o700});if(await realpath(target)!==target||(await lstat(target)).isSymbolicLink())throw Error('导入暂存目录不安全');return target;
}
export async function maintenanceImportSource(root,input){
 if(input.uploadId){if(!uploadIdPattern.test(input.uploadId))throw Error('导入文件身份无效');return path.join(await maintenanceUploadDirectory(root),input.uploadId+'.review-backup.gz');}
 if(!path.isAbsolute(input.sourcePath||''))throw Error('备份目录必须使用项目内绝对路径');
 const source=await realpath(input.sourcePath),project=await realpath(path.resolve(root,'../..'));
 if(source!==input.sourcePath||!source.startsWith(project+path.sep))throw Error('仅可导入当前项目内的备份；其他位置请上传备份文件');
 return source;
}
