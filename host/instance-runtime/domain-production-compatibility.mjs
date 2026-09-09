import {canonicalJson,sha256} from './bytes.mjs';
import {domainProductionSlice} from './domain-projection.mjs';
import {inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';

const hash=v=>sha256(canonicalJson(v));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4000;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const list=(v,max=20000)=>Array.isArray(v)&&v.length<=max;
const keys=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
const unique=(rows,key='id')=>list(rows)&&rows.every(r=>object(r)&&text(r[key]))&&new Set(rows.map(r=>r[key])).size===rows.length;
const row=(rows,id)=>{const found=(rows||[]).filter(r=>r.id===id);return found.length===1?found[0]:null;};
const SLICE_KEYS=['entities','states','representations','requirements','relations','referencePolicies','representationPolicies'];
const RECORD_KEYS=['schemaVersion','compatibilityId','instanceId','runtimeEpoch','beforeGraphRef','afterGraphRef','beforeSlice','afterSlice','metadataApprovals','occurrences','requirementBindings','versionBindings','approval','proofHash','createdAt','contractAudit'];
function json(v,depth=0,active=new Set()){
 if(depth>64)return false;
 if(v===null||typeof v==='string'||typeof v==='boolean')return true;
 if(typeof v==='number')return Number.isFinite(v);
 if(!Array.isArray(v)&&!object(v)||active.has(v))return false;
 active.add(v);const valid=Object.values(v).every(x=>json(x,depth+1,active));active.delete(v);return valid;
}
const scope=s=>keys(s,['scopeType','scopeId','revisionId'])&&['PROJECT','EPISODE','SCENE','SHOT'].includes(s.scopeType)&&text(s.scopeId)&&(s.scopeType==='PROJECT'||text(s.revisionId));
const evidence=e=>object(e)&&text(e.sourceId)&&text(e.revisionId)&&digest(e.sha256)&&(e.locator===undefined||text(e.locator))&&(e.quote===undefined||typeof e.quote==='string');
function distinct(rows){return new Set(rows.map(canonicalJson)).size===rows.length;}
function appended(before,after,validate){
 return list(before,1000)&&list(after,1000)&&before.every(validate)&&after.every(validate)&&distinct(before)&&distinct(after)
  &&after.length>=before.length&&before.every((v,i)=>same(v,after[i]));
}
function scopeExtension(before,after){
 if(!object(before)||!object(after))return false;
 const {scope:bs,evidence:be,...b}=before,{scope:as,evidence:ae,...a}=after;
 if(!same(b,a)||!appended(bs,as,scope)||!bs.length||!appended(be,ae,evidence)||as.length<=bs.length)return false;
 // Adding a second revision for an existing scope is a rebind, not an extension.
 const ids=as.map(s=>s.scopeType+':'+s.scopeId);
 return new Set(ids).size===ids.length&&ae.length>be.length;
}
function validSlice(slice){
 if(!keys(slice,SLICE_KEYS)||!SLICE_KEYS.every(k=>Object.hasOwn(slice,k))||!json(slice))return false;
 if(Buffer.byteLength(canonicalJson(slice))>16*1024*1024)return false;
 for(const k of SLICE_KEYS.slice(0,5))if(!unique(slice[k]))return false;
 return unique(slice.referencePolicies,'relationId')&&unique(slice.representationPolicies,'representationId');
}
/** Classifies only structural compatibility. The host must authenticate the
 * explicit metadata authorization and read its exact historical sources. */
export function classifyDomainProductionCompatibility(beforeSlice,afterSlice,{metadataApprovals=[]}={}){
 const fail=(kind,reason)=>({compatible:false,kind,changes:[],reasons:[reason]});
 if(!validSlice(beforeSlice)||!validSlice(afterSlice)||!list(metadataApprovals,1000))return fail('UNKNOWN','INVALID_SLICE');
 if(!unique(metadataApprovals,'entityId')||metadataApprovals.some(a=>!keys(a,['entityId','beforeRecordHash','afterRecordHash','confirmed','reason','authorizationRef','scope'])||a.confirmed!==true||!text(a.reason)||!text(a.authorizationRef)||a.scope!=='NARRATIVE_DESCRIPTION_ONLY'||!digest(a.beforeRecordHash)||!digest(a.afterRecordHash)))return fail('UNKNOWN','INVALID_METADATA_APPROVAL');
 const changes=[],used=new Set();
 for(const collection of SLICE_KEYS){
  const before=beforeSlice[collection],after=afterSlice[collection],key=collection==='referencePolicies'?'relationId':collection==='representationPolicies'?'representationId':'id';
  if(before.length!==after.length)return fail('PRODUCTION_CHANGED','MEMBERSHIP_CHANGED:'+collection);
  // Preserve order too: policy and representation ordering is part of existing hashes.
  for(let i=0;i<before.length;i++){
   const b=before[i],a=after[i];if(b[key]!==a[key])return fail('PRODUCTION_CHANGED','ORDER_OR_ID_CHANGED:'+collection);
   if(same(b,a))continue;
   if(['states','requirements'].includes(collection)&&scopeExtension(b,a)){changes.push({collection,id:a.id,kind:'SCOPE_EXTENSION',beforeHash:hash(b),afterHash:hash(a)});continue;}
   if(collection==='entities'){
    const {description:bd,...br}=b,{description:ad,...ar}=a,approval=metadataApprovals.find(v=>v.entityId===a.id);
    if(typeof bd==='string'&&typeof ad==='string'&&same(br,ar)&&approval?.beforeRecordHash===hash(b)&&approval.afterRecordHash===hash(a)){
     used.add(a.id);changes.push({collection,id:a.id,kind:'REVIEWED_NARRATIVE_METADATA_ONLY',beforeHash:hash(b),afterHash:hash(a)});continue;
    }
   }
   return fail('PRODUCTION_CHANGED','UNPROVEN_CHANGE:'+collection+':'+a[key]);
  }
 }
 if(used.size!==metadataApprovals.length)return fail('UNKNOWN','UNUSED_METADATA_APPROVAL');
 const kinds=new Set(changes.map(c=>c.kind));
 return {compatible:true,kind:!changes.length?'EXACT':kinds.size>1?'MIXED_COMPATIBLE':changes[0].kind,beforeSliceHash:hash(beforeSlice),afterSliceHash:hash(afterSlice),changes,reasons:[]};
}

export function domainProductionCompatibilityProofHash(record){const {proofHash,...body}=record;return hash(body);}
function graphRef(ref){return keys(ref,['revisionId','sha256'])&&text(ref.revisionId)&&digest(ref.sha256);}
function inputs(bindings){
 if(!list(bindings,1000))return null;
 const result=[];
 for(const b of bindings){
  if(!object(b))return null;
  if(b.familyId&&b.assetFamilyRef&&b.familyId!==b.assetFamilyRef||b.versionId&&b.assetVersionRef&&b.versionId!==b.assetVersionRef)return null;
  const v={familyId:b.familyId||b.assetFamilyRef,versionId:b.versionId||b.assetVersionRef,sha256:b.sha256};
  if(!text(v.familyId)||!text(v.versionId)||!digest(v.sha256))return null;result.push(v);
 }
 return new Set(result.map(b=>b.versionId)).size===result.length?result:null;
}
function validRequirements(record){
 if(!unique(record.requirementBindings,'requirementId'))return false;
 for(const b of record.requirementBindings){
  if(!keys(b,['requirementId','beforeHash','afterHash','representationId','representationHash','beforeDemand','afterDemand'])||![b.beforeHash,b.afterHash,b.representationHash].every(digest)||!text(b.representationId))return false;
  const before=row(record.beforeSlice.requirements,b.requirementId),after=row(record.afterSlice.requirements,b.requirementId),rep=row(record.afterSlice.representations,b.representationId),oldRep=row(record.beforeSlice.representations,b.representationId);
  if(!before||!after||!rep||!same(before,b.beforeDemand)||!same(after,b.afterDemand)||before.representationId!==b.representationId||after.representationId!==b.representationId||!same(rep,oldRep)||hash(rep)!==b.representationHash)return false;
  if(hash({demand:before,representation:rep})!==b.beforeHash||hash({demand:after,representation:rep})!==b.afterHash||!same(before,after)&&!scopeExtension(before,after))return false;
 }
 return true;
}
function currentFamily(model,id){return row(model.assetFamilies,id)?.domainContext?.hash;}
function sliceOptions(model){return {referencePolicies:model.domainReferencePolicyBindings||{},representationPolicies:model.domainRepresentationPolicyBindings||{},configuration:model.systemConfiguration?.config?.domain};}
function localPreclassifiedSlice(slice,ids){
 // The host already classified these relations using the complete historical
 // graph. A local slice may omit the other endpoint's representation, so it
 // cannot safely reclassify production KINSHIP as a pure-story relation.
 const representations=slice.representations.filter(r=>ids.includes(r.id)),entityIds=new Set(representations.map(r=>r.entityId));
 const states=slice.states.filter(s=>representations.some(r=>r.stateId===s.id)),stateIds=new Set(states.map(s=>s.id));
 const relations=slice.relations.filter(r=>[r.from.id,r.to.id].some(id=>ids.includes(id)||entityIds.has(id)||stateIds.has(id))),relationIds=new Set(relations.map(r=>r.id));
 return {representations,states,entities:slice.entities.filter(e=>entityIds.has(e.id)),requirements:slice.requirements.filter(r=>ids.includes(r.representationId)),relations,
  referencePolicies:slice.referencePolicies.filter(r=>relationIds.has(r.relationId)),representationPolicies:slice.representationPolicies.filter(r=>ids.includes(r.representationId))};
}
function currentSliceMatches(model,record,ids){
 if(!ids.length||!model.domainGraph)return false;
 const expected=localPreclassifiedSlice(record.afterSlice,ids);
 const actual=domainProductionSlice(model.domainGraph,ids,sliceOptions(model));
 return same(expected,actual);
}
function latestOccurrence(model,familyId){let last=-1;for(let i=0;i<(model.domainInvalidations||[]).length;i++)if(model.domainInvalidations[i].familyId===familyId)last=i;return last;}
function occurrenceCurrent(model,record,index){
 const o=record.occurrences.find(o=>o.index===index);return !!o&&currentFamily(model,o.familyId)===o.currentHash
  &&latestOccurrence(model,o.familyId)===Math.max(...record.occurrences.filter(x=>x.familyId===o.familyId).map(x=>x.index));
}
function currentRequirement(model,record,b){
 const requirement=row(model.materialRequirements,b.requirementId),g=model.domainGraph,rep=row(g?.representations,b.representationId),demand=row(g?.requirements,b.requirementId);
 if(!requirement||requirement.requirementHash!==b.afterHash||!demand||!same(demand,b.afterDemand)||!rep||hash(rep)!==b.representationHash)return false;
 if(!currentSliceMatches(model,record,[rep.id]))return false;
 const familyIds=rep.assetFamilyIds||[];
 return familyIds.every(id=>{const occurrences=record.occurrences.filter(o=>o.familyId===id);return !occurrences.length||occurrences.every(o=>occurrenceCurrent(model,record,o.index));});
}
function executionMatches(executionDefinitions,b,current){
 const id=current.executionDefinitionId||current.executionDefinitionRef;
 if(current.executionDefinitionId&&current.executionDefinitionRef&&current.executionDefinitionId!==current.executionDefinitionRef)return false;
 if(b.executionDefinitionId===undefined)return !id;
 const definition=row(executionDefinitions,b.executionDefinitionId);
 return id===b.executionDefinitionId&&!!definition&&definition.definitionHash===b.executionDefinitionHash&&inspectExecutionDefinitionHash(definition).valid;
}
/** Validates a host-published business record, never authenticates client proof.
 * Epoch equality is opt-in for NEW mutations; restored historical approvals
 * retain business meaning without granting an old worker execution authority. */
export function validateDomainProductionCompatibilityRecord(record,{model,instanceId,runtimeEpoch,requireCurrentEpoch=false,versions,executionDefinitions}={}){
 try{
  if(!model||!text(instanceId)||!keys(record,RECORD_KEYS)||!json(record)||!list(record.metadataApprovals,1000)||record.schemaVersion!=='DOMAIN_PRODUCTION_COMPATIBILITY_V1'||!text(record.compatibilityId)||record.instanceId!==instanceId||!text(record.runtimeEpoch)||requireCurrentEpoch&&record.runtimeEpoch!==runtimeEpoch)return null;
  if(!graphRef(record.beforeGraphRef)||!graphRef(record.afterGraphRef)||!digest(record.proofHash)||record.proofHash!==domainProductionCompatibilityProofHash(record)||!keys(record.approval,['confirmed','reason'])||record.approval.confirmed!==true||!text(record.approval.reason))return null;
  const classification=classifyDomainProductionCompatibility(record.beforeSlice,record.afterSlice,{metadataApprovals:record.metadataApprovals});
  if(!classification.compatible||classification.kind==='EXACT'||!list(record.occurrences,20000)||!unique(record.versionBindings,'versionId')||!validRequirements(record)||!record.versionBindings.length&&!record.requirementBindings.length)return null;
  if(new Set(record.occurrences.map(o=>o.index)).size!==record.occurrences.length)return null;
  for(const o of record.occurrences){
   if(!keys(o,['index','hash','familyId','previousHash','currentHash'])||!Number.isSafeInteger(o.index)||o.index<0||![o.hash,o.previousHash,o.currentHash].every(digest)||!text(o.familyId))return null;
   const actual=model.domainInvalidations?.[o.index];if(!actual||hash(actual)!==o.hash||actual.familyId!==o.familyId||actual.previousHash!==o.previousHash||actual.currentHash!==o.currentHash)return null;
  }
  const currentVersionBindings=[];
  for(const b of record.versionBindings){
   if(!keys(b,['familyId','versionId','sha256','domainContextHash','occurrenceIndexes','inputBindings','executionDefinitionId','executionDefinitionHash','reviewEventId','reviewContextHash','reviewEventHash'])||!text(b.familyId)||!digest(b.sha256)||!digest(b.domainContextHash)||!list(b.occurrenceIndexes,20000)||!b.occurrenceIndexes.length||new Set(b.occurrenceIndexes).size!==b.occurrenceIndexes.length||b.occurrenceIndexes.some(i=>!record.occurrences.some(o=>o.index===i)))return null;
   const normalized=inputs(b.inputBindings);if(!normalized||normalized.some(i=>i.versionId===b.versionId))return null;
   if((b.executionDefinitionId!==undefined||b.executionDefinitionHash!==undefined)&&(!text(b.executionDefinitionId)||!digest(b.executionDefinitionHash)))return null;
   if([b.reviewEventId,b.reviewContextHash,b.reviewEventHash].some(v=>v!==undefined)&&(!text(b.reviewEventId)||!digest(b.reviewContextHash)||!digest(b.reviewEventHash)))return null;
   const current=versions?.get(b.versionId);
   const repIds=record.afterSlice.representations.filter(r=>r.assetFamilyIds?.includes(b.familyId)).map(r=>r.id);
   if(current&&current.id===b.versionId&&current.familyId===b.familyId&&current.sha256===b.sha256&&same(inputs(current.inputVersionBindings||[]),normalized)&&executionMatches(executionDefinitions,b,current)&&currentFamily(model,b.familyId)===b.domainContextHash&&currentSliceMatches(model,record,repIds)&&b.occurrenceIndexes.every(i=>occurrenceCurrent(model,record,i)))currentVersionBindings.push({...b,inputBindings:normalized});
  }
  return {record,classification,requirementBindings:record.requirementBindings,currentRequirementBindings:record.requirementBindings.filter(b=>currentRequirement(model,record,b)),versionBindings:record.versionBindings,currentVersionBindings};
 }catch{return null;}
}

export function buildDomainProductionCompatibilityIndex(model,options={}){
 const records=[],byVersion=new Map(),byRequirement=new Map();
 const source=model?.domainProductionCompatibilities||[];
 if(!list(source,10000)||!unique(source,'compatibilityId'))return {records,byVersion,byRequirement};
 for(const record of source){const valid=validateDomainProductionCompatibilityRecord(record,{...options,model});if(!valid)continue;records.push(valid);
  for(const b of valid.currentVersionBindings)byVersion.set(b.versionId,[...(byVersion.get(b.versionId)||[]),{...b,compatibilityId:record.compatibilityId,proofHash:record.proofHash,occurrences:record.occurrences}]);
  for(const b of valid.currentRequirementBindings)byRequirement.set(b.requirementId,[...(byRequirement.get(b.requirementId)||[]),{...b,compatibilityId:record.compatibilityId,proofHash:record.proofHash,eligibility:'CURRENT'}]);
 }
 return {records,byVersion,byRequirement};
}
function bridge(model,query,historical){
 if(!digest(query.beforeHash)||!digest(query.afterHash)||!digest(query.representationHash)||query.beforeHash===query.afterHash)return null;
 if((query.compatibilityId!==undefined||query.proofHash!==undefined)&&(!historical||!text(query.compatibilityId)||!digest(query.proofHash)))return null;
 const index=buildDomainProductionCompatibilityIndex(model,{instanceId:query.instanceId,runtimeEpoch:query.runtimeEpoch});
 const edges=index.records.filter(v=>query.compatibilityId===undefined||v.record.compatibilityId===query.compatibilityId&&v.record.proofHash===query.proofHash).flatMap(v=>v.requirementBindings.filter(b=>b.requirementId===query.requirementId&&b.representationId===query.representationId&&b.representationHash===query.representationHash).map(b=>({...b,compatibilityId:v.record.compatibilityId,proofHash:v.record.proofHash,current:v.currentRequirementBindings.includes(b)})));
 // A duplicate transition is ambiguous authorization, not a reason to select
 // whichever record happens to be last. Cycles and excessive chains fail closed.
 const paths=[],byBefore=new Map();let expansions=0,exhausted=false;
 for(const e of edges)byBefore.set(e.beforeHash,[...(byBefore.get(e.beforeHash)||[]),e]);
 function visit(hashValue,links,seen){
  if(paths.length>1||links.length>=64)return;
  if(++expansions>20000){exhausted=true;return;}
  for(const e of byBefore.get(hashValue)||[]){
   if(exhausted)return;
   if(seen.has(e.afterHash)||links.length&&!same(links.at(-1).afterDemand,e.beforeDemand))continue;
   const next=[...links,e];if(e.afterHash===query.afterHash){if(historical||e.current)paths.push(next);}else visit(e.afterHash,next,new Set([...seen,e.afterHash]));
  }
 }
 visit(query.beforeHash,[],new Set([query.beforeHash]));if(exhausted||paths.length!==1)return null;
 const links=paths[0],first=links[0],last=links.at(-1);
 return {...last,beforeHash:first.beforeHash,beforeDemand:first.beforeDemand,links:links.map(({current,...r})=>r),eligibility:historical?'HISTORICAL_ONLY':'CURRENT'};
}
export const findCompatibleRequirementBinding=(model,query)=>bridge(model,query,false);
export const findHistoricalCompatibleRequirementBinding=(model,query)=>bridge(model,query,true);

export function domainCompatibilityExceptions(index){
 const result=new Map();
 for(const [id,rows]of index.byVersion){
  const first=rows[0];if(rows.some(r=>r.familyId!==first.familyId||r.sha256!==first.sha256||r.domainContextHash!==first.domainContextHash||!same(r.inputBindings,first.inputBindings)))continue;
  const occurrenceHashes=new Map();let conflict=false;
  for(const r of rows)for(const i of r.occurrenceIndexes){const o=r.occurrences.find(o=>o.index===i);if(occurrenceHashes.has(i)&&occurrenceHashes.get(i)!==o.hash)conflict=true;occurrenceHashes.set(i,o.hash);}
  if(!conflict)result.set(id,{familyId:first.familyId,versionId:id,sha256:first.sha256,domainContextHash:first.domainContextHash,inputBindings:first.inputBindings,occurrenceHashes,compatibilityIds:[...new Set(rows.map(r=>r.compatibilityId))]});
 }
 return result;
}
export function findCompatibleReviewBinding(index,query){
 const matches=(index.byVersion.get(query.versionId)||[]).filter(b=>b.familyId===query.familyId&&b.sha256===query.sha256&&b.reviewEventId===query.reviewEventId&&b.reviewContextHash===query.reviewContextHash&&b.reviewEventHash===query.reviewEventHash);
 if(!matches.length||!text(query.reviewEventId)||!digest(query.reviewContextHash)||!digest(query.reviewEventHash))return null;
 const unique=new Map(matches.map(r=>[r.proofHash,r]));return unique.size===1?{...unique.values().next().value,eligibility:'CURRENT'}:null;
}
