import {instanceLocalStorage} from './client-storage';

const key='material-browse-v1';
const fields=['materialCatalog','processQ','processKind','processMedia','processState','processGate','processEpisode','processScene','processShot','entity','materialEntityType','materialMedia','materialPrimary','materialCategory','materialEpisode','materialScene','materialCreatorStage','materialCoverage','materialQ'] as const;
export function saveMaterialBrowseLocation(url:URL) {
  if(url.searchParams.get('view')!=='materials')return;
  try{instanceLocalStorage.setItem(key,JSON.stringify(Object.fromEntries(fields.flatMap(field=>url.searchParams.has(field)?[[field,url.searchParams.get(field)]]:[]))));}catch{/* Reading remains available without device storage. */}
}
export function restoreMaterialBrowseLocation(url:URL,force=false) {
  if(url.searchParams.get('view')!=='materials')return false;
  if(!force&&[...fields,'productionMaterial','productionMaterialVersion','materialPanel','material','family','version','asset','materialState','materialRelation','materialTrial','materialTrialVersion','materialDefinitionId','materialDefinitionKind','materialDefinitionTab','materialRepresentation'].some(field=>url.searchParams.has(field)))return false;
  try{const saved=JSON.parse(instanceLocalStorage.getItem(key)||'{}');for(const field of fields){if(force)url.searchParams.delete(field);if(typeof saved[field]==='string'&&saved[field].length<2000)url.searchParams.set(field,saved[field]);}}catch{/* Invalid or unavailable saved state is ignored. */}
  for(const field of ['productionMaterial','productionMaterialVersion','material','family','version','asset','materialState','materialRelation','materialTrial','materialTrialVersion','materialDefinitionId','materialDefinitionKind','materialRepresentation'])url.searchParams.delete(field);
  url.searchParams.set('materialPanel','closed');
  return true;
}
