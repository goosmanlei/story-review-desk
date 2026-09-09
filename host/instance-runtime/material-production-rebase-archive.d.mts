export type MaterialProductionRebaseArchiveValidator={
 accept(table:string,row:Record<string,unknown>,parsedSnapshot?:unknown):void;
 finish():void;
};
/** Compact semantic companion; consumes actual decoded archive rows. */
export function createMaterialProductionRebaseArchiveValidator():MaterialProductionRebaseArchiveValidator;
/** Throws MATERIAL_PRODUCTION_REBASE_ARCHIVE or source-closure conflict. */
export function validateMaterialProductionRebaseArchive(archive:{tables?:Record<string,Array<Record<string,unknown>>>},options?:{encoded?:boolean}):void;
