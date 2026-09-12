import type {CanvasIcon} from './free-canvas';
/** Shared by story settings and material directory; no business classification. */
const icons:Record<string,CanvasIcon>={CHARACTER:'person',PERSON:'person',LOCATION:'place',PROP:'object',OBJECT:'object',GROUP:'person',WORLD_RULE:'story',STYLE:'media',PRODUCTION_THEME:'process',UNRESOLVED:'unknown'};
export function entityCanvasIcon(type:string):CanvasIcon{return icons[type]||'object';}
