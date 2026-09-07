export const uploadIdPattern:RegExp;
export function maintenanceUploadDirectory(root:string):Promise<string>;
export function maintenanceImportSource(root:string,input:{uploadId?:string;sourcePath?:string}):Promise<string>;
