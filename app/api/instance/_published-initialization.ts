// Hosted reads expose only the confirmed initialization summary and source metadata.
// Drafts, extracted source text, media bytes, paths and task records stay local.
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function select(value:unknown,keys:readonly string[]){const input=record(value);return Object.fromEntries(keys.filter(key=>input[key]!==undefined).map(key=>[key,input[key]]));}
const sourceKeys=['id','title','role','format','sha256','revisionId','documentRevisionId','documentSha256','status','observation','textAvailable','filename','byteSize'] as const;
export function publishedInitializationProjection(productionModel:unknown){
 const model=record(productionModel),initialization=record(model.initialization),content=record(initialization.content);
 const ready=initialization.state==='READY'&&typeof initialization.revisionId==='string';
 const sources=ready&&Array.isArray(initialization.sources)?initialization.sources.map(source=>select(source,sourceKeys)):[];
 const published=ready?{revisionId:initialization.revisionId,content:{...select(content,['schemaVersion','title','summary','graphRef','configurationRef','confirmedAt','formalAdoptionPerformed']),uncertainties:Array.isArray(content.uncertainties)?content.uncertainties.filter(item=>typeof item==='string'):[],sourceBindings:Array.isArray(content.sourceBindings)?content.sourceBindings.map(binding=>select(binding,['sourceId','revisionId','sha256'])):[]}}:null;
 return{state:ready?'READY':'NOT_STARTED',sourceCount:sources.length,sources,published};
}
