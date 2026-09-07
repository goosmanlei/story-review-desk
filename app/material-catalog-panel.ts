/** UI navigation only: this never changes a story relation, requirement or state. */
export type MaterialPanelKind='closed'|'entity'|'state'|'material'|'relation';
export type MaterialDefinitionTarget={collection:'states'|'representations'|'requirements'|'relations';id:string};
export type MaterialPanelIntent={kind:MaterialPanelKind;id:string;entityId:string;familyId:string;versionId:string;trial:boolean;error:string;legacy:boolean;definition?:MaterialDefinitionTarget};
const kinds:MaterialPanelKind[]=['closed','entity','state','material','relation'];
export function materialPanelIntent(params:URLSearchParams):MaterialPanelIntent{
 // The page resolver accepts this old exact family alias before normalizing
 // its URL. Capture the same intent on the drawer's first mount.
 const requested=params.get('materialPanel'),entityId=params.get('entity')||'',stateId=params.get('materialState')||'',materialId=params.get('material')||'',trialId=params.get('materialTrial')||'',familyId=params.get('family')||params.get('asset')||'',versionId=params.get(trialId?'materialTrialVersion':'version')||(trialId?params.get('version'):'')||'',relationId=params.get('materialRelation')||'';
 const empty={kind:'closed' as const,id:'',entityId,familyId,versionId,trial:false,error:'',legacy:requested===null};
 // Existing exact definition links predate the drawer. This one documented
 // legacy spelling is allowed only with a validated collection and identity.
 const definitionId=params.get('materialDefinitionId')||params.get('materialRepresentation'),collection=params.get('materialDefinitionKind')||'representations';
 if(requested!=='closed'&&definitionId&&(requested===null||requested==='definitions')){
  if(!['states','representations','requirements','relations'].includes(collection))return {...empty,error:'素材定义类型未登记，未猜测维护对象。'};
  return {...empty,kind:collection==='states'?'state':collection==='relations'?'relation':'material',id:definitionId,legacy:true,definition:{collection:collection as MaterialDefinitionTarget['collection'],id:definitionId}};
 }
 if(requested&&!kinds.includes(requested as MaterialPanelKind))return {...empty,error:'素材详情面板类型未登记。已保留原链接，未猜测或打开其他对象。'};
 if(requested==='closed')return empty;
 const kind=(requested|| (relationId?'relation':stateId?'state':materialId||trialId||familyId||versionId?'material':entityId?'entity':'closed')) as MaterialPanelKind;
 const id=kind==='entity'?entityId:kind==='state'?stateId:kind==='relation'?relationId:kind==='material'?trialId||materialId:'';
 if((materialId||familyId)&&trialId&&kind==='material')return {...empty,error:'链接同时指定正式需求或素材族与独立试制，已拒绝猜测目标。'};
 if(kind!=='closed'&&!id&&!(kind==='material'&&familyId))return {...empty,error:'详情链接缺少明确的永久身份，未回退到默认对象。'};
 return {...empty,kind,id,trial:Boolean(trialId&&kind==='material')};
}
export function materialPanelLocation(params:URLSearchParams,kind:MaterialPanelKind,id:string,entityId:string,{trial=false}:{trial?:boolean}={}):URLSearchParams{
 const next=new URLSearchParams(params);next.set('materialPanel',kind);
 for(const key of ['materialState','materialRelation','materialTrial','materialTrialVersion','materialDefinitionId','materialDefinitionKind','materialRepresentation'])next.delete(key);
 if(entityId)next.set('entity',entityId);
 if(kind==='state')next.set('materialState',id);
 if(kind==='relation')next.set('materialRelation',id);
 if(kind==='material'){if(trial){next.set('materialTrial',id);for(const key of ['material','family','version'])next.delete(key);}else next.set('material',id);}
 return next;
}
/** Exact IDs win. A public display alias is accepted only if unambiguous. */
export function exactMaterialPanelMatch<T>(rows:T[],id:string,identity:(row:T)=>string,alias:(id:string)=>string):T|undefined{
 const exact=rows.filter(row=>identity(row)===id);if(exact.length)return exact.length===1?exact[0]:undefined;
 const aliases=rows.filter(row=>alias(identity(row))===id);return aliases.length===1?aliases[0]:undefined;
}
