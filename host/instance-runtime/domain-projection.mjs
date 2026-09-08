import {refreshDirectoryProjection} from './directory-projection.mjs';
import { bindConfiguration } from './configuration-model.mjs';
import { domainHash, emptyDomainGraph, defaultDomainConfiguration } from './domain-model.mjs';


const STORY_FIELDS=new Set(['id','type','from','to','label','purpose','inherit','exclude','scope','authority','status','evidence','historicalOnly']);
function isPureStoryRelation(relation,graph,configuration){
 const kind=configuration.relationTypes?.find(type=>type.id===relation.type)?.class;
 if(kind!=='STORY'||relation.from?.kind!=='ENTITY'||relation.to?.kind!=='ENTITY'
  ||relation.referencePolicyId!=null||relation.status!=='CONFIRMED'||!['F','A','L'].includes(relation.authority)
  ||!Array.isArray(relation.inherit)||relation.inherit.length||Object.keys(relation).some(key=>!STORY_FIELDS.has(key)))return false;
 // A kinship assertion can be the explicit prerequisite of a real resemblance
 // reference. Keep that production dependency, including its exact evidence.
 if(relation.type==='KINSHIP'&&graph.relations.some(edge=>{
  if(edge.type!=='FAMILY_RESEMBLANCE'||edge.historicalOnly)return false;
  const from=graph.representations.find(rep=>rep.id===edge.from?.id)?.entityId;
  const to=graph.representations.find(rep=>rep.id===edge.to?.id)?.entityId;
  return [from,to].includes(relation.from.id)&&[from,to].includes(relation.to.id);
 }))return false;
 return true;
}
function contextFactory(graph,referencePolicies,representationPolicies,configuration){
 return ids=>{
  const representations=graph.representations.filter(rep=>ids.includes(rep.id)),entityIds=new Set(representations.map(rep=>rep.entityId));
  const states=graph.states.filter(state=>representations.some(rep=>rep.stateId===state.id));
  const entities=graph.entities.filter(entity=>entityIds.has(entity.id));
  const relations=graph.relations.filter(edge=>ids.includes(edge.from.id)||ids.includes(edge.to.id)||entityIds.has(edge.from.id)||entityIds.has(edge.to.id)||states.some(state=>[edge.from.id,edge.to.id].includes(state.id)));
  const productionRelations=relations.filter(relation=>!isPureStoryRelation(relation,graph,configuration));
  return {hashSchemaVersion:'3.0',representationIds:ids,entityIds:[...entityIds],relationIds:relations.map(relation=>relation.id),
   hash:domainHash({representations,states,entities,relations:productionRelations,
    referencePolicies:productionRelations.filter(relation=>relation.referencePolicyId).map(relation=>({relationId:relation.id,policy:referencePolicies[relation.id]})),
    representationPolicies:representations.filter(rep=>representationPolicies[rep.id]).map(rep=>({representationId:rep.id,policy:representationPolicies[rep.id]}))})};
 };
}
function previousRepresentationIds(graph,key,id){
 if(!graph)return [];
 return graph.representations.filter(rep=>key==='family'?(rep.assetFamilyIds||[]).includes(id):(rep.requirementIds||[]).includes(id)||graph.requirements.some(demand=>demand.id===id&&demand.representationId===rep.id)).map(rep=>rep.id);
}
function preserveEquivalentContext(old,next,before){
 // V1/V2 hashes are frozen compatibility tokens. Comparing old/new graphs
 // through ONE semantic function avoids schema-only invalidation and does not
 // rewrite historical bytes, review standards or an execution's bound hash.
 return old?.hash&&before&&before.hash===next.hash
  ?{...next,hash:old.hash,hashSchemaVersion:old.hashSchemaVersion}
  :next;
}

/** This projection adds relationships; it never rewrites an existing asset verdict. */
export function projectDomainGraph(snapshot,graph,reference,{initialization=null,eventVersions=[],preserveReferencePolicies=false,directorySource}={}){
 const result=structuredClone(snapshot);const model=result.productionModel;const previousGraph=model.domainGraph;
 model.domainGraph=structuredClone(graph);model.domainGraphRef=reference;
 const priorRequirements=model.materialRequirements||[];
 const occupied=new Set(priorRequirements.filter(r=>r.sourceKind!=='DOMAIN_GRAPH').map(r=>r.id));
 for(const demand of graph.requirements)if(occupied.has(demand.id))throw Object.assign(new Error('新需求不得覆盖既有需求；请使用表现的requirementIds关联：'+demand.id),{code:'DOMAIN_INVALID'});
 const config=model.systemConfiguration?.config;
 const previouslyFrozen=model.domainReferencePolicyBindings||Object.fromEntries((model.domainReferenceRules||[]).filter(r=>r.policy).map(r=>[r.relationId,r.policy]));
 const policyBindings=Object.fromEntries(graph.relations.filter(r=>r.referencePolicyId).map(r=>[r.id,preserveReferencePolicies&&previouslyFrozen[r.id]||structuredClone((config?.domain||defaultDomainConfiguration()).referencePolicies.find(p=>p.id===r.referencePolicyId)||null)]));model.domainReferencePolicyBindings=policyBindings;
 const priorRepresentationPolicies=model.domainRepresentationPolicyBindings||{};const representationPolicies=Object.fromEntries(graph.representations.filter(r=>['IDENTITY','VOICE_IDENTITY'].includes(r.type)).map(r=>[r.id,preserveReferencePolicies&&priorRepresentationPolicies[r.id]||structuredClone((config?.domain||defaultDomainConfiguration()).referencePolicies.find(p=>p.id===(r.type==='VOICE_IDENTITY'?'VOICE_MASTER':'CLEAN_MASTER'))||null)]));model.domainRepresentationPolicyBindings=representationPolicies;

 const introduced=graph.requirements.map(demand=>{const representation=graph.representations.find(r=>r.id===demand.representationId);const category=config?.taxonomy?.categories?.find(c=>[c.id,c.label].includes(demand.category)||c.types?.some(t=>[t.id,t.label].includes(demand.category)));const type=category?.types?.find(t=>[t.id,t.label].includes(demand.category));const row={id:demand.id,title:demand.title,requirementClass:'REQUIRED',sourceKind:'DOMAIN_GRAPH',domainManaged:true,representationRef:demand.representationId,entityRef:representation.entityId,stateRef:representation.stateId,mediaType:demand.mediaType,mediaKind:['IMAGE','VIDEO'].includes(demand.mediaType)?'VISUAL':demand.mediaType,category:demand.category,businessCategoryPrimary:category?.label||demand.category,businessCategorySecondary:type?.label||demand.category,assetFamilyRefs:[...representation.assetFamilyIds],sceneIds:demand.scope.filter(s=>s.scopeType==='SCENE').map(s=>s.scopeId),episodeUids:demand.scope.filter(s=>s.scopeType==='EPISODE').map(s=>s.scopeId),episodeIds:[],shotIds:demand.scope.filter(s=>s.scopeType==='SHOT').map(s=>s.scopeId),scopeBindings:demand.scope,reuseScope:demand.reuseScope,acceptanceCriteria:demand.acceptanceCriteria,sourceBindings:demand.evidence,sourceRef:'domain-graph:'+reference.revisionId+'#'+demand.id,productionLane:type?.productionLane||'MANUAL_OR_ASSISTED',acceptanceProfile:representation.type,formalAdoptionPerformed:false};return{...row,requirementHash:domainHash({demand,representation})};});
 model.materialRequirements=[...priorRequirements.filter(r=>r.sourceKind!=='DOMAIN_GRAPH'),...introduced];if(config&&introduced.length){const bindings=bindConfiguration(result,config);for(const demand of introduced){const prior=priorRequirements.find(r=>r.id===demand.id);demand.configurationBinding=prior?.configurationBinding||bindings['material:'+demand.id];demand.reviewSpec=demand.configurationBinding?.reviewSpec;}}

 if(initialization)model.initialization={...initialization,formalAdoptionPerformed:false};
 const byRequirement=new Map(),byFamily=new Map();
 for(const representation of graph.representations){for(const id of [...new Set([...(representation.requirementIds||[]),...graph.requirements.filter(r=>r.representationId===representation.id).map(r=>r.id)])])byRequirement.set(id,[...(byRequirement.get(id)||[]),representation.id]);for(const id of representation.assetFamilyIds||[])byFamily.set(id,[...(byFamily.get(id)||[]),representation.id]);}
 const configuration=config?.domain||defaultDomainConfiguration();
 const context=contextFactory(graph,policyBindings,representationPolicies,configuration);
 // When a legacy snapshot has no explicit policy map, compare against the
 // same effective baseline rather than treating a newly versioned hash as a
 // production edit. Existing frozen entries always win over current defaults.
 const beforePolicies={...policyBindings,...previouslyFrozen};
 const beforeRepresentationPolicies={...representationPolicies,...priorRepresentationPolicies};
 const previousContext=previousGraph?contextFactory(previousGraph,beforePolicies,beforeRepresentationPolicies,configuration):null;
 for(const requirement of model.materialRequirements||[]){
  const old=priorRequirements.find(row=>row.id===requirement.id)?.domainContext,next=context(byRequirement.get(requirement.id)||[]);
  const before=previousContext?.(previousRepresentationIds(previousGraph,'requirement',requirement.id));
  requirement.domainContext=preserveEquivalentContext(old,next,before);
 }
 model.domainInvalidations=[...(model.domainInvalidations||[])];
 for(const family of model.assetFamilies||[]){
  const old=family.domainContext,next=context(byFamily.get(family.id)||[]);
  const before=previousContext?.(previousRepresentationIds(previousGraph,'family',family.id));
  const adopted=preserveEquivalentContext(old,next,before);
  if(old?.hash&&old.hash!==adopted.hash){
   const invalidation={familyId:family.id,previousHash:old.hash,currentHash:adopted.hash,versionIds:[...new Set([...(model.assetVersions||[]),...eventVersions].filter(version=>version.familyId===family.id&&version.sha256).map(version=>version.versionId||version.id))]};
   if(invalidation.versionIds.length&&!model.domainInvalidations.some(row=>row.familyId===family.id&&row.previousHash===old.hash&&row.currentHash===adopted.hash))model.domainInvalidations.push(invalidation);
  }
  family.domainContext=adopted;
 }
 model.domainReferenceTargets=Object.fromEntries([...byFamily].map(([familyId,ids])=>{const reps=graph.representations.filter(r=>ids.includes(r.id));const entityIds=[...new Set(reps.map(r=>r.entityId))];return[familyId,{entityIds,entityTypes:[...new Set(graph.entities.filter(e=>entityIds.includes(e.id)).map(e=>e.type))],representationTypes:[...new Set(reps.map(r=>r.type))],unresolved:reps.some(r=>r.type==='UNRESOLVED')||reps.some(r=>['IDENTITY','APPEARANCE','HEAD','BODY','VOICE_IDENTITY'].includes(r.type))&&graph.entities.some(e=>entityIds.includes(e.id)&&(e.type==='UNRESOLVED'||e.authority==='U')),masterPolicy:representationPolicies[reps.find(r=>r.type==='VOICE_IDENTITY')?.id||reps.find(r=>r.type==='IDENTITY')?.id]||null}];}));
 model.domainReferenceRules=graph.relations.filter(r=>r.referencePolicyId&&!r.historicalOnly).flatMap(relation=>{const target=graph.representations.find(r=>r.id===relation.to.id),source=graph.representations.find(r=>r.id===relation.from.id);const policy=policyBindings[relation.id];return(target?.assetFamilyIds||[]).map(familyId=>({targetFamilyId:familyId,sourceFamilyIds:source?.assetFamilyIds||[],sourceRepresentationId:source?.id,relationId:relation.id,relationHash:domainHash(relation),policyId:relation.referencePolicyId,policy:policy||null,type:relation.type,sourceEntityId:source?.entityId,targetEntityId:target?.entityId,sourceRepresentationType:source?.type,inherit:relation.inherit,exclude:relation.exclude,purpose:relation.purpose,status:relation.status,authority:relation.authority}));});
 const directory=refreshDirectoryProjection(model,directorySource);if(directory)model.materialDirectory=directory;
 result.creativeLineage={...result.creativeLineage,domainGraphRef:reference};
 return result;
}
export function relationProjection(graph=emptyDomainGraph(),{requirementId,familyId,entityId}={}){
 if(!requirementId&&!familyId&&!entityId)return graph;
 const selected=graph.representations.filter(r=>entityId===r.entityId||r.requirementIds.includes(requirementId)||r.assetFamilyIds.includes(familyId));const repIds=new Set(selected.map(r=>r.id)),entityIds=new Set(selected.map(r=>r.entityId));
 const relations=graph.relations.filter(e=>repIds.has(e.from.id)||repIds.has(e.to.id)||entityIds.has(e.from.id)||entityIds.has(e.to.id));
 for(const edge of relations)for(const end of [edge.from,edge.to]){if(end.kind==='REPRESENTATION')repIds.add(end.id);if(end.kind==='ENTITY')entityIds.add(end.id);}
 const representations=graph.representations.filter(r=>repIds.has(r.id));for(const r of representations)entityIds.add(r.entityId);
 return {...graph,representations,relations,entities:graph.entities.filter(e=>entityIds.has(e.id)),states:graph.states.filter(s=>entityIds.has(s.entityId)),requirements:graph.requirements.filter(r=>repIds.has(r.representationId))};
}
export { domainReferenceEligibility } from './domain-reference.mjs';

/** Reapply the exact confirmed graph after a story compiler; missing IDs stay audit-only. */
export function preserveDomainProjection({snapshot,baseSnapshot,events=[]}){
 const prior=baseSnapshot.productionModel||{},model=snapshot.productionModel||{};
 if(!prior.domainGraphRef&&!prior.genericAuthoring)return snapshot;
 const next=structuredClone(snapshot);next.productionModel.genericAuthoring=structuredClone(prior.genericAuthoring);
 if(prior.initialization)next.productionModel.initialization=structuredClone(prior.initialization);
 // Directory placement is navigation metadata, not a replacement for frozen inputs.
 // Keep it through compilation; readers revalidate each exact requirement/representation hash.
 for(const key of ['materialDirectory','productionReset'])if(prior[key])next.productionModel[key]=structuredClone(prior[key]);
 if(!prior.domainGraphRef){const directory=refreshDirectoryProjection(next.productionModel);if(directory)next.productionModel.materialDirectory=directory;return next;}
 if(!prior.domainGraph||domainHash(prior.domainGraph)!==prior.domainGraphRef.sha256)throw Object.assign(new Error('已确认素材关系与精确修订SHA不一致'),{code:'DOMAIN_CONFLICT'});
 next.productionModel.domainOwnership=structuredClone(prior.domainOwnership||{});next.productionModel.domainRepresentationPolicyBindings=structuredClone(prior.domainRepresentationPolicyBindings||{});next.productionModel.domainInvalidations=structuredClone(prior.domainInvalidations||[]);next.productionModel.domainReferencePolicyBindings=structuredClone(prior.domainReferencePolicyBindings||Object.fromEntries((prior.domainReferenceRules||[]).filter(r=>r.policy).map(r=>[r.relationId,r.policy])));
 const previousFamilies=new Map((prior.assetFamilies||[]).map(f=>[f.id,f]));
 for(const family of next.productionModel.assetFamilies||[])if(previousFamilies.get(family.id)?.domainContext)family.domainContext=structuredClone(previousFamilies.get(family.id).domainContext);
 // Independently registered requirements are persistent instance data, outside legacy compiler ownership.
 const authored=(prior.materialRequirements||[]).filter(r=>r.sourceKind==='DOMAIN_GRAPH');
 next.productionModel.materialRequirements=[...(model.materialRequirements||[]).filter(r=>!authored.some(a=>a.id===r.id)),...structuredClone(authored)];
 const result=projectDomainGraph(next,prior.domainGraph,prior.domainGraphRef,{eventVersions:events.filter(e=>e.eventKind==='asset-version'),preserveReferencePolicies:true});
 const familyIds=new Set((result.productionModel.assetFamilies||[]).map(f=>f.id)),requirementIds=new Set((result.productionModel.materialRequirements||[]).map(r=>r.id));
 result.productionModel.domainRelationAudit=prior.domainGraph.representations.flatMap(r=>[...r.assetFamilyIds.filter(id=>!familyIds.has(id)).map(id=>({representationId:r.id,kind:'ASSET_FAMILY',id,status:'HISTORICAL_UNBOUND'})),...r.requirementIds.filter(id=>!requirementIds.has(id)).map(id=>({representationId:r.id,kind:'MATERIAL_REQUIREMENT',id,status:'HISTORICAL_UNBOUND'}))]);
 for(const demand of result.productionModel.materialRequirements||[])if(demand.sourceKind==='DOMAIN_GRAPH'&&demand.scopeBindings.some(s=>s.scopeType==='SCENE'&&!(result.productionModel.sceneScriptRevisions||[]).some(r=>r.sceneId===s.scopeId&&r.id===s.revisionId)||s.scopeType==='EPISODE'&&!(result.productionModel.episodePlanRevisions||[]).some(r=>r.id===s.revisionId&&r.episodes?.some(e=>e.episodeUid===s.scopeId)))){demand.requirementClass='EVIDENCE_ONLY';demand.domainScopeStatus='STALE_SCOPE_REQUIRES_EXPLICIT_REBIND';}
 const directory=refreshDirectoryProjection(result.productionModel);if(directory)result.productionModel.materialDirectory=directory;
 return result;
}
