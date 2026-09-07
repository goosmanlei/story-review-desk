export const BACKUP_STREAM_FORMAT:string;
export function packBackup(root:string,destination:string):Promise<{format:string;path:string;manifestSha256:string}>;
export function unpackBackup(archive:string,destination:string):Promise<{output:string;manifestSha256:string;instanceId:string}>;
