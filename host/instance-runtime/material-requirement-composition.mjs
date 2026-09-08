import {materialRequirementSelectionReasons} from './material-requirement-disposition.mjs';
import {canonicalJson,sha256} from './bytes.mjs';
import {effectiveRequirementFamilyIds} from './material-usage-model.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_INVALID'});};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,299}$/.test(value);
const unique=values=>[...new Set(values)];
const current=row=>row?.requirementClass==='REQUIRED'&&row.scopeRole!=='EVIDENCE_ONLY'&&row.activeInCurrentProduction!==false;

export function validateRequirementComposition(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='mode,requiredComponents,schemaVersion'||value.schemaVersion!=='1.0'||value.mode!=='ALL')fail('素材需求组合须为版本1.0的显式ALL合同');
 if(!Array.isArray(value.requiredComponents)||!value.requiredComponents.length||value.requiredComponents.length>200)fail('素材需求组合须有1至200个必需组件');
 const ids=new Set(),requirements=new Set();
 for(const component of value.requiredComponents){
  if(!component||typeof component!=='object'||Array.isArray(component)||Object.keys(component).sort().join(',')!=='id,requirementId'||!identifier(component.id)||!identifier(component.requirementId))fail('素材需求组件须有精确组件ID和需求ID');
  if(ids.has(component.id)||requirements.has(component.requirementId))fail('素材需求组件或子需求不能重复');
  ids.add(component.id);requirements.add(component.requirementId);
 }
 return structuredClone(value);
}

export function validateRequirementCompositions(rows,{knownRequirementIds=[]}={}){
 const byId=new Map(rows.map(row=>[row.id,row])),known=new Set([...knownRequirementIds,...byId.keys()]);
 for(const row of rows){
  if(!Object.hasOwn(row,'composition'))continue;
  for(const component of validateRequirementComposition(row.composition).requiredComponents){
   if(component.requirementId===row.id)fail('素材需求组合不能包含自身');
   if(!known.has(component.requirementId))fail('素材需求组合引用不存在的子需求：'+component.requirementId);
  }
 }
 const done=new Set(),active=new Set();
 const visit=id=>{
  if(active.has(id))fail('素材需求组合存在循环');
  if(done.has(id))return;
  active.add(id);for(const component of byId.get(id)?.composition?.requiredComponents||[])visit(component.requirementId);active.delete(id);done.add(id);
 };
 for(const id of byId.keys())visit(id);
}

/** Second pass over actual operational coverage, never free-text inference or adoption. */
export function applyRequirementCompositionCoverage(rows,{usageBindings=[]}={}){
 const selectable=row=>current(row)&&!materialRequirementSelectionReasons({materialRequirements:rows},row.id,{use:'CURRENT_INPUT'}).length;
 const byId=new Map(),duplicateIds=new Set();
 for(const row of rows){if(byId.has(row.id))duplicateIds.add(row.id);byId.set(row.id,row);}
 const resolved=new Map(),active=new Set();
 const blocked=(row,reason)=>({...row,coverageSatisfied:false,coverageReasons:unique([...(row.coverageReasons||[]),reason])});
 const visit=id=>{
  const row=byId.get(id);
  if(!row)return null;
  if(duplicateIds.has(id))return blocked(row,'COMPOSITION_REQUIREMENT_ID_AMBIGUOUS');
  if(active.has(id))return blocked(row,'COMPOSITION_CYCLE');
  if(resolved.has(id))return resolved.get(id);
  if(!Object.hasOwn(row,'composition')){
   // Legacy evidence-only rows retain their historical projection; they cannot
   // satisfy a required component. An empty REQUIRED leaf is never delivered.
   const hasExactUsage=usageBindings.some(b=>b.eligible===true&&b.requirementId===row.id&&b.requirementHash===row.requirementHash&&b.versionId&&b.familyId&&/^[a-f0-9]{64}$/.test(b.sha256||''));
   const result=row.requirementClass!=='EVIDENCE_ONLY'&&!(row.assetFamilyRefs||[]).length&&!hasExactUsage
    ?blocked(row,'CURRENT_ASSET_VERSION_UNRESOLVED'):row;
   resolved.set(id,result);return result;
  }
  let composition;
  try{composition=validateRequirementComposition(row.composition);}catch{
   const result=blocked(row,'REQUIREMENT_COMPOSITION_INVALID');resolved.set(id,result);return result;
  }
  active.add(id);
  const components=composition.requiredComponents.map(component=>{
   const child=visit(component.requirementId),eligible=selectable(child),covered=eligible&&child.coverageSatisfied===true&&child.bindingStale!==true;
   return {...component,requirementHash:child?.requirementHash||null,coverageSatisfied:covered,
    reasons:!child?['COMPONENT_REQUIREMENT_MISSING']:!eligible?['COMPONENT_REQUIREMENT_NOT_CURRENT_REQUIRED']:covered?[]:unique([...(child.coverageReasons||[]),...(child.bindingStale?['REQUIREMENT_HASH_VERSION_BINDING_STALE']:[]),'COMPONENT_NOT_COVERED']),
    coveredByFamilyRefs:child?.coveredByFamilyRefs||[],coveredByVersionRefs:child?.coveredByVersionRefs||[]};
  });
  active.delete(id);
  const covered=selectable(row)&&row.bindingStale!==true&&components.every(component=>component.coverageSatisfied);
  // The parent's own media is not an implicit component. Only the explicit
  // child contract covers the aggregate; a separate file is not mandatory.
  const result={...row,coverageSatisfied:covered,
   coverageReasons:unique([...(row.bindingStale?['REQUIREMENT_HASH_VERSION_BINDING_STALE']:[]),...(!selectable(row)?['COMPOSITION_REQUIREMENT_NOT_CURRENT_REQUIRED']:[]),...components.filter(c=>!c.coverageSatisfied).map(c=>'UNCOVERED_COMPONENT:'+c.id)]),
   coveredByFamilyRefs:unique(components.flatMap(c=>c.coveredByFamilyRefs)),coveredByVersionRefs:unique(components.flatMap(c=>c.coveredByVersionRefs)),
   compositionCoverage:{schemaVersion:'1.0',mode:'ALL',compositionHash:sha256(canonicalJson(composition)),requiredCount:components.length,coveredCount:components.filter(c=>c.coverageSatisfied).length,components}};
  resolved.set(id,result);return result;
 };
 return rows.map(row=>visit(row.id));
}

/** Adopted input expansion for explicit ALL aggregates. The parent's own file
 * never substitutes for its children; every child needs current exact coverage. */
export function requirementInputFamilyIds(model,state,requirement){
 const active=new Set();
 const visit=row=>{
  if(!row||!current(row)||materialRequirementSelectionReasons(model,row.id,{use:'CURRENT_INPUT'}).length||active.has(row.id))return [];
  if(!Object.hasOwn(row,'composition'))return effectiveRequirementFamilyIds(state,row);
  let composition;try{composition=validateRequirementComposition(row.composition);}catch{return [];}
  const projected=state.materialRequirementsById?.[row.id];
  if(!projected||projected.requirementHash!==row.requirementHash||projected.coverageSatisfied!==true||projected.bindingStale===true||projected.compositionCoverage?.compositionHash!==sha256(canonicalJson(composition)))return [];
  active.add(row.id);const families=[];
  for(const component of composition.requiredComponents){
   const matches=(model.materialRequirements||[]).filter(child=>child.id===component.requirementId),child=matches[0],coverage=state.materialRequirementsById?.[child?.id];
   if(matches.length!==1||!current(child)||materialRequirementSelectionReasons(model,child.id,{use:'CURRENT_INPUT'}).length||coverage?.requirementHash!==child.requirementHash||coverage?.coverageSatisfied!==true||coverage?.bindingStale===true){active.delete(row.id);return [];}
   const ids=visit(child);if(!ids.length){active.delete(row.id);return [];}families.push(...ids);
  }
  active.delete(row.id);return unique(families);
 };
 return visit(requirement);
}
