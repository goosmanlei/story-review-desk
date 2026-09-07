import {parseArgs} from 'node:util';
import {lstat,realpath} from 'node:fs/promises';
import {verifyBackup} from './instance-transfer.mjs';
import {packBackup,unpackBackup} from '../host/instance-runtime/backup-stream.mjs';
const {values}=parseArgs({options:{source:{type:'string'},output:{type:'string'},archive:{type:'string'},'instance-id':{type:'string'}}});
if(!values.source||!values.output||!values['instance-id'])throw Error('需要明确来源、全新目标及实例身份');
const stat=await lstat(values.source);if(stat.isSymbolicLink())throw Error('导入来源不能是符号链接');
const source=await realpath(values.source),archivePath=values.archive||values.output+'.review-backup.gz';
if(stat.isDirectory()){
 const proof=await verifyBackup(source);if(proof.instanceId!==values['instance-id'])throw Error('这是另一故事的备份，请在其独立项目中恢复');
 await packBackup(source,archivePath);await unpackBackup(archivePath,values.output);
}else if(stat.isFile()){
 await unpackBackup(source,values.output);
}else throw Error('请选择完整备份目录或 .review-backup.gz 文件');
const proof=await verifyBackup(values.output);if(proof.instanceId!==values['instance-id'])throw Error('这是另一故事的备份，未登记到本项目');
if(stat.isFile())await packBackup(values.output,archivePath);
console.log(JSON.stringify({...proof,archivePath,imported:true}));
