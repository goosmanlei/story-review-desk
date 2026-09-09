/** Selection metadata is deliberately separate from asset adoption and rights. */
export const MATERIAL_REQUIREMENT_REPLACEMENT_PROTOCOL='MATERIAL_REQUIREMENT_REPLACEMENT_V1';
const list=v=>Array.isArray(v)?v:[];
const own=(v,k)=>!!v&&Object.hasOwn(v,k);
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const current=r=>r?.requirementClass==='REQUIRED'&&r.scopeRole!=='EVIDENCE_ONLY'&&r.activeInCurrentProduction!==false;
const scope=r=>list(r?.scopeBindings||r?.scope).map(stable).sort();
const marker=r=>own(r,'replaces')||own(r,'requirementReplacement')||own(r,'currentDisposition');
function rowsOf(model){return list(model?.materialRequirements);}
function analyze(model){
 const rows=rowsOf(model),byId=new Map(),errors=new Map(),successors=new Map(),claims=new Map(),related=new Set();
 const add=(id,reason)=>{if(typeof id!=='string'||!id)return;errors.set(id,[...new Set([...(errors.get(id)||[]),reason])]);};
 for(const row of rows){if(byId.has(row.id))add(row.id,'REQUIREMENT_ID_NOT_UNIQUE');else byId.set(row.id,row);}
 const graph=model?.domainGraph,demands=graph?list(graph.requirements):rows;
 const hasMarkers=demands.some(r=>own(r,'replaces'))||rows.some(marker);
 if(!hasMarkers)return {rows,byId,errors,successors,claims,related,hasMarkers};
 for(const demand of demands){
  if(!own(demand,'replaces'))continue;
  const r=byId.get(demand.id),replacement=demand.replaces,parentId=replacement?.requirementId,parent=byId.get(parentId);
  claims.set(demand.id,replacement);related.add(demand.id);if(parentId)related.add(parentId);
  const reasons=[];
  if(!replacement||typeof replacement!=='object'||Array.isArray(replacement)||Object.keys(replacement).sort().join(',')!=='requirementHash,requirementId'||typeof parentId!=='string'||!/^[a-f0-9]{64}$/.test(replacement.requirementHash||'')||parentId===demand.id)reasons.push('REPLACEMENT_DECLARATION_INVALID');
  if(!r||!parent)reasons.push('REPLACEMENT_REQUIREMENT_MISSING');
  if(r&&parent){
   if(!current(r)||!current(parent))reasons.push('REPLACEMENT_REQUIREMENT_NOT_CURRENT');
   if(r.sourceKind!=='DOMAIN_GRAPH'||parent.sourceKind!=='DOMAIN_GRAPH'||r.mediaType!=='IMAGE'||parent.mediaType!=='IMAGE')reasons.push('REPLACEMENT_DOMAIN_OR_MEDIA_CHANGED');
   if(parent.requirementHash!==replacement?.requirementHash)reasons.push('REPLACEMENT_PARENT_HASH_CHANGED');
   if(!r.entityRef||r.entityRef!==parent.entityRef||stable(scope(r))!==stable(scope(parent))||!scope(r).length)reasons.push('REPLACEMENT_SUBJECT_OR_SCOPE_CHANGED');
   if(r.composition?.schemaVersion!=='1.0'||r.composition.mode!=='ALL'||!list(r.composition.requiredComponents).length||list(r.assetFamilyRefs).length)reasons.push('REPLACEMENT_AGGREGATE_INVALID');
   if(graph&&(!own(r,'replaces')||stable(r.replaces)!==stable(replacement)||stable(r.composition)!==stable(demand.composition)))reasons.push('REPLACEMENT_PROJECTION_MISMATCH');
   const allScopes=[],visited=new Set();
   function component(id,path=[]){
    related.add(id);
    if(id===parentId||id===r.id||path.includes(id)){reasons.push('REPLACEMENT_COMPONENT_CYCLE');return;}
    if(visited.has(id))return;
    const child=byId.get(id);
    if(!child||!current(child)||child.sourceKind!=='DOMAIN_GRAPH'||child.mediaType!=='IMAGE'){reasons.push('REPLACEMENT_COMPONENT_UNAVAILABLE');return;}
    if(!scope(child).length||scope(child).some(s=>!scope(r).includes(s)))reasons.push('REPLACEMENT_COMPONENT_SCOPE_CHANGED');
    const raw=graph&&list(graph.requirements).find(d=>d.id===id);
    if(graph&&(!raw||stable(child.composition)!==stable(raw.composition)))reasons.push('REPLACEMENT_COMPONENT_PROJECTION_MISMATCH');
    if(child.composition){
     if(child.composition.schemaVersion!=='1.0'||child.composition.mode!=='ALL'||!list(child.composition.requiredComponents).length||list(child.assetFamilyRefs).length){reasons.push('REPLACEMENT_COMPONENT_AGGREGATE_INVALID');return;}
     for(const part of child.composition.requiredComponents)component(part.requirementId,[...path,id]);
    }else allScopes.push(...scope(child));
    visited.add(id);
   }
   for(const part of list(r.composition?.requiredComponents))component(part.requirementId);
   if(stable([...new Set(allScopes)].sort())!==stable(scope(r)))reasons.push('REPLACEMENT_COMPONENT_SCOPE_INCOMPLETE');
  }
  if(typeof parentId==='string'){const prior=successors.get(parentId);if(prior&&prior!==demand.id){add(prior,'REPLACEMENT_NOT_UNIQUE');reasons.push('REPLACEMENT_NOT_UNIQUE');}successors.set(parentId,demand.id);}
  for(const reason of reasons){add(demand.id,reason);add(parentId,reason);}
 }
 // A projected receipt cannot silently disappear when only a partial model is loaded.
 for(const r of rows){if(!own(r,'requirementReplacement')){if(own(r,'currentDisposition'))add(r.id,'REPLACEMENT_RECEIPT_MISSING');continue;}const receipt=r.requirementReplacement;
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||receipt.protocol!==MATERIAL_REQUIREMENT_REPLACEMENT_PROTOCOL||!['VALID','INVALID'].includes(receipt.status)||!Array.isArray(receipt.reasons)||!own(receipt,'replaces')||!own(receipt,'replacedByRequirementId')){add(r.id,'REPLACEMENT_RECEIPT_INVALID');continue;}
  if(receipt.replacedByRequirementId!==null&&(typeof receipt.replacedByRequirementId!=='string'||!receipt.replacedByRequirementId)||receipt.replaces!==null&&(!receipt.replaces||typeof receipt.replaces!=='object'||Array.isArray(receipt.replaces)||Object.keys(receipt.replaces).sort().join(',')!=='requirementHash,requirementId'||typeof receipt.replaces.requirementId!=='string'||!receipt.replaces.requirementId||!/^[a-f0-9]{64}$/.test(receipt.replaces.requirementHash||'')))add(r.id,'REPLACEMENT_RECEIPT_INVALID');
  if(receipt.status==='INVALID'||receipt.reasons.length)add(r.id,'REPLACEMENT_RECEIPT_INVALID');
  if(receipt.replaces||receipt.replacedByRequirementId)related.add(r.id);
  if(receipt.replacedByRequirementId&&successors.get(r.id)!==receipt.replacedByRequirementId)add(r.id,'REPLACEMENT_SUCCESSOR_MISSING');
  if(receipt.replaces&&stable(claims.get(r.id))!==stable(receipt.replaces))add(r.id,'REPLACEMENT_DECLARATION_MISSING');
 }
 const completed=new Set();function walk(id,path=[]){if(path.includes(id)){for(const p of path.slice(path.indexOf(id)))add(p,'REPLACEMENT_CYCLE');return;}if(completed.has(id))return;const next=successors.get(id);if(next)walk(next,[...path,id]);completed.add(id);}for(const id of successors.keys())walk(id);
 // Errors on a replacement cannot cause its predecessor to regain selection.
 for(let changed=true;changed;){changed=false;for(const [old,next]of successors){if(errors.has(next)&&!errors.has(old)){add(old,'REPLACEMENT_SUCCESSOR_INVALID');changed=true;}if(errors.has(old)&&!errors.has(next)){add(next,'REPLACEMENT_PREDECESSOR_INVALID');changed=true;}}}
 return {rows,byId,errors,successors,claims,related,hasMarkers};
}
function disposition(a,id){
 const row=a.byId.get(id),reasons=a.errors.get(id)||[],replacementOf=a.claims.get(id)||null,replacedByRequirementId=a.successors.get(id)||row?.requirementReplacement?.replacedByRequirementId||null;
 const isCurrent=a.related.has(id)?current(row):row?.requirementClass==='REQUIRED';
 const kind=!row?'INVALID_REPLACEMENT':reasons.length?'INVALID_REPLACEMENT':!isCurrent?'HISTORICAL':replacedByRequirementId?'REPLACED':row.composition?'CURRENT_AGGREGATE':'CURRENT_ATOMIC';
 return {kind,currentSelectable:kind==='CURRENT_ATOMIC'||kind==='CURRENT_AGGREGATE',countsAsAtomic:kind==='CURRENT_ATOMIC',replacedByRequirementId,replacementOf,reasons:row?reasons:['REQUIREMENT_MISSING']};
}
export function materialRequirementDisposition(model,requirementId){return disposition(analyze(model),requirementId);}
/** Callers fix use on the server; this never establishes source approval, rights or actual media existence. */
export function materialRequirementSelectionReasons(model,requirementId,{use='CURRENT_INPUT'}={}){
 if(['USAGE_SOURCE','ORIGINAL_ASSET_PROVENANCE','HISTORICAL_FROZEN'].includes(use))return [];
 if(!['CURRENT_TARGET','CURRENT_INPUT'].includes(use))return ['REQUIREMENT_SELECTION_USE_INVALID'];
 const a=analyze(model);if(!a.hasMarkers)return [];
 const d=disposition(a,requirementId);
 if(!a.errors.has(requirementId)&&!a.successors.has(requirementId)&&!a.claims.has(requirementId)&&!marker(a.byId.get(requirementId)))return [];
 return d.kind==='REPLACED'?['REQUIREMENT_REPLACED_FOR_CURRENT_SELECTION']:d.reasons;
}
export function currentMaterialRequirementRows(model,{atomicOnly=false}={}){const a=analyze(model);return a.rows.filter(r=>{const d=disposition(a,r.id);return atomicOnly?d.countsAsAtomic:d.currentSelectable;});}
/** Returns rows; does not mutate the model, source requirements, family or review contexts. */
export function projectMaterialRequirementDispositions(model){
 const a=analyze(model);if(!a.hasMarkers)return rowsOf(model);
 return a.rows.map(row=>{const d=disposition(a,row.id);return {...row,currentDisposition:d.kind,requirementReplacement:{protocol:MATERIAL_REQUIREMENT_REPLACEMENT_PROTOCOL,status:d.reasons.length?'INVALID':'VALID',replaces:d.replacementOf,replacedByRequirementId:d.replacedByRequirementId,reasons:d.reasons}};});
}
