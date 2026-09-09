import {canonicalJson,sha256} from './bytes.mjs';
import {defaultDomainConfiguration} from './domain-model.mjs';
import {refreshDirectoryProjection} from './directory-projection.mjs';
import {validateRequirementComposition} from './material-requirement-composition.mjs';
import {materialRequirementSelectionReasons} from './material-requirement-disposition.mjs';

export const SHOT_DESIGN_REQUIREMENT_BASIS_VERSION='3.0';
export const SHOT_DESIGN_REQUIREMENT_SEMANTIC_POLICY='SHOT_DESIGN_REQUIREMENT_SEMANTICS_V1';
const hash=value=>sha256(canonicalJson(value));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=(message,details={})=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT',reasonCode:'SHOT_DESIGN_REQUIREMENT_BASIS_INVALID',...details});};
const record=(value,name)=>{if(!value||typeof value!=='object'||Array.isArray(value))fail(name+'必须为对象');return value;};
const rows=(value,name)=>{if(!Array.isArray(value))fail(name+'必须为完整列表');return value;};
const identifier=(value,name)=>{if(typeof value!=='string'||!value.trim())fail(name+'身份缺失');return value;};
const exact=(collection,id,name)=>{const found=rows(collection,name).filter(r=>r.id===id);if(found.length!==1)fail(name+'未唯一解析',{bindingId:id});return found[0];};
const without=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.has(key)));
const sorted=values=>values.toSorted((a,b)=>a.id.localeCompare(b.id));
function assertJson(value,seen=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
 if(typeof value!=='object'||seen.has(value))fail('语义输入必须为无循环的完整 JSON，不得静默丢弃未知值');
 if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('语义输入必须为普通 JSON 对象');
 seen.add(value);for(const child of Object.values(value))assertJson(child,seen);seen.delete(value);
}
// These fields describe realization, not the authored demand. The coverage and
// current-shot fields are computed by _store.projectOperationalState and its
// shot-plan gate; keep their exact names here, never strip unknown metadata.
const implementationKeys=new Set(['assetFamilyRefs','materialWorkItemRef','plannedAssetFamilyId','formalAdoptionPerformed','currentVersionId','versionRefs','expectedOutputRefs','outputState','lifecycleState','canFlowDownstream','registrationState','availability','coverageSatisfied','bindingStale','coverageReasons','coveredByFamilyRefs','coveredByVersionRefs','materialWorkItemLifecycleState','currentShotIds','currentShotRelationState','compositionCoverage','materialUsageBindings']);
const derivedDomainKeys=new Set(['requirementHash','sourceRef','domainContext','currentDisposition','requirementReplacement']);
const domainContextKeys=new Set(['hashSchemaVersion','hash','representationIds','entityIds','relationIds']);
function requirementValue(requirement,domainManaged){
 if(requirement.domainContext&&Object.keys(requirement.domainContext).some(key=>!domainContextKeys.has(key)))fail('未识别的域上下文字段不能从语义基线排除',{requirementId:requirement.id});
 // Registry requirements keep their original opaque hash/source token. Only the
 // exact DOMAIN_GRAPH projection has a separately proven semantic source here.
 return without(requirement,new Set([...implementationKeys,...(domainManaged?derivedDomainKeys:['domainContext'])]));
}
const representationValue=value=>without(value,new Set(['assetFamilyIds']));
function graphShape(graph){
 record(graph,'域图');if(graph.schemaVersion!=='1.0'||Object.keys(graph).some(key=>!['schemaVersion','entities','states','representations','relations','requirements'].includes(key)))fail('不支持的域图结构不能隐式降级');
 for(const name of ['entities','states','representations','relations','requirements']){const ids=new Set();for(const row of rows(graph[name],name)){record(row,name);identifier(row.id,name);if(ids.has(row.id))fail('域图身份不唯一',{bindingId:row.id});ids.add(row.id);}}
 for(const rep of graph.representations){if(!Array.isArray(rep.assetFamilyIds)||rep.assetFamilyIds.some(id=>typeof id!=='string'))fail('表现的实现族必须为身份列表');}
}
function validateDomainRequirement(model,requirement,graph){
 const demand=exact(graph.requirements,requirement.id,'正式需求'),rep=exact(graph.representations,demand.representationId,'正式表现');
 if(!model.domainGraphRef?.revisionId||model.domainGraphRef.sha256!==hash(graph))fail('当前域图缺少精确修订和 SHA 证明');
 if(requirement.requirementHash!==hash({demand,representation:rep}))fail('当前需求投影与域图原始哈希不一致',{requirementId:requirement.id});
 const fields={title:demand.title,representationRef:rep.id,entityRef:rep.entityId,stateRef:rep.stateId,mediaType:demand.mediaType,category:demand.category,assetFamilyRefs:rep.assetFamilyIds,scopeBindings:demand.scope,reuseScope:demand.reuseScope,acceptanceCriteria:demand.acceptanceCriteria,sourceBindings:demand.evidence};
 for(const [key,value] of Object.entries(fields))if(!same(requirement[key],value))fail('当前需求语义投影与正式域图不一致',{requirementId:requirement.id,field:key});
 if(!same(requirement.composition,demand.composition))fail('当前需求组合投影与正式域图不一致',{requirementId:requirement.id});
 return {demand,rep};
}
function condition(graph,collection,id){
 if(!id)return null;const source=exact(graph[collection],id,collection),value=collection==='representations'?representationValue(source):structuredClone(source);
 return {id,hash:hash(value),value};
}
function sceneEpisodeId(model,sceneId,coverage){
 if(coverage.episodeNarrativeReleaseId){
  const release=exact(model.episodeNarrativeReleases||[],coverage.episodeNarrativeReleaseId,'本场独立分集发布');
  if(release.scopeRole!=='CURRENT'||release.sourceSyncState!=='SOURCE_CURRENT'||!release.episodeUid||release.contentHash!==hash(release.reviewInput)||coverage.episodeUid&&coverage.episodeUid!==release.episodeUid)fail('本场独立分集发布归属或内容证明不一致');
  const current=(model.episodeNarrativeReleases||[]).filter(row=>row.scopeRole==='CURRENT'&&row.reviewInput?.scenes?.some(scene=>scene.id===sceneId));
  if(current.length!==1||current[0].id!==release.id)fail('本场独立分集发布归属不唯一');
  exact(release.reviewInput.scenes,sceneId,'独立分集当前场');return release.episodeUid;
 }
 if((model.episodeNarrativeReleases||[]).some(row=>row.scopeRole==='CURRENT'&&row.reviewInput?.scenes?.some(scene=>scene.id===sceneId)))fail('已独立发布的本场意图缺少分集发布绑定');
 const episodeIds=new Set([
  ...(model.scenes||[]).filter(row=>row.id===sceneId&&(!row.scopeRole||row.scopeRole==='CURRENT')).map(row=>row.episodeUid).filter(Boolean),
  ...(model.episodes||[]).filter(row=>(!row.scopeRole||row.scopeRole==='CURRENT')&&row.sceneIds?.includes(sceneId)).map(row=>row.episodeUid||row.id).filter(Boolean),
 ]);
 if(episodeIds.size!==1)fail('关系集范围缺少本场唯一永久集归属');
 return [...episodeIds][0];
}
function relationAppliesToScene(model,edge,sceneId,coverage){
 const scope=rows(edge.scope,'关系适用范围');if(!scope.length)return true;
 const applies=scope.map(binding=>{
  record(binding,'关系范围');
  if(Object.keys(binding).some(key=>!['scopeType','scopeId','revisionId'].includes(key)))fail('未知关系范围条件不能推定本场适用性',{relationId:edge.id});
  identifier(binding.scopeId,'关系范围');if(binding.scopeType!=='PROJECT')identifier(binding.revisionId,'关系范围修订');
  if(binding.scopeType==='SCENE')return binding.scopeId===sceneId;
  if(binding.scopeType==='PROJECT'){
   const projectId=model.instance?.projectId||model.projectId;if(!projectId)fail('关系项目范围缺少当前永久项目归属',{relationId:edge.id});
   return binding.scopeId===projectId;
  }
  if(binding.scopeType==='EPISODE'){
   return sceneEpisodeId(model,sceneId,coverage)===binding.scopeId;
  }
  if(binding.scopeType==='SHOT'){
   const shot=exact(model.shots||[],binding.scopeId,'关系镜头范围');identifier(shot.sceneId,'关系镜头所属场');return shot.sceneId===sceneId;
  }
  fail('未知关系适用范围类型',{relationId:edge.id});
 });
 return applies.some(Boolean);
}
function semanticGraphClosure(model,graph,seeds,sceneId,coverage){
 const selected=new Map(),add=(kind,id)=>{if(!id)return;const collection={ENTITY:'entities',STATE:'states',REPRESENTATION:'representations'}[kind];if(!collection)fail('未知关系端点类型');const row=exact(graph[collection],id,collection);selected.set(kind+':'+id,{kind,row});};
 for(const [kind,id] of seeds)add(kind,id);
 const rootKeys=new Set(selected.keys());
 // refreshDirectoryProjection adds categorization edges from the registered
 // directory. They explicitly assert no story semantics and have no authored
 // scope. Do not reinterpret that absence as global scope; original DOMAIN
 // edges still require their full scope even if they carry directory markers.
 const authoredRelationIds=new Set((model.domainGraph?.relations||[]).map(edge=>edge.id));
 const directoryMetadata=edge=>!authoredRelationIds.has(edge.id)&&edge.directoryOnly===true&&edge.appliesTo==='DIRECTORY_METADATA_ONLY'&&edge.semanticEffect==='NONE';
 const relations=sorted(graph.relations.filter(edge=>!directoryMetadata(edge)&&[edge.from,edge.to].some(end=>rootKeys.has(end?.kind+':'+end?.id))&&relationAppliesToScene(model,edge,sceneId,coverage)));
 for(const edge of relations)for(const end of [edge.from,edge.to])add(end.kind,end.id);
 // Referenced endpoint bodies, including their own identity/state, are semantic
 // conditions too. Unrelated graph components are outside this scene's basis.
 for(const {kind,row} of [...selected.values()]){if(kind==='REPRESENTATION'){add('ENTITY',row.entityId);if(row.stateId)add('STATE',row.stateId);}if(kind==='STATE')add('ENTITY',row.entityId);}
 const config=model.systemConfiguration?.config?.domain||defaultDomainConfiguration();
 const policy=(id,overrides,key)=>{if(!id)return null;return structuredClone(Object.hasOwn(overrides||{},key)?overrides[key]:exact(config.referencePolicies,id,'参考策略'));};
 const representations=sorted([...selected.values()].filter(v=>v.kind==='REPRESENTATION').map(v=>v.row));
 const entities=sorted([...selected.values()].filter(v=>v.kind==='ENTITY').map(v=>v.row));
 const states=sorted([...selected.values()].filter(v=>v.kind==='STATE').map(v=>v.row));
 const pick=(collection,ids)=>[...new Set(ids)].sort().map(id=>structuredClone(exact(config[collection],id,collection)));
 // Directory state labels are retained verbatim in states/conditions, including
 // opaque dimensions absent from the formal domain taxonomy. Registered keys
 // still bind their definitions; authored STATE/REP keys never get this rule.
 const authoredStateIds=new Set((model.domainGraph?.states||[]).map(row=>row.id));
 const directoryState=row=>!authoredStateIds.has(row.id)&&row.directoryOnly===true&&row.appliesTo==='DIRECTORY_METADATA_ONLY'&&row.temporalAssertion==='NONE';
 const dimensions=[...representations.flatMap(row=>Object.keys(row.dimensions||{})),...states.flatMap(row=>Object.keys(row.dimensions||{}).filter(key=>!directoryState(row)||config.stateDimensions.some(definition=>definition.id===key)))];
 return {entities,states,representations:representations.map(representationValue),relations,
  referencePolicies:relations.filter(edge=>edge.referencePolicyId).map(edge=>({relationId:edge.id,policy:policy(edge.referencePolicyId,model.domainReferencePolicyBindings,edge.id)})),
  representationPolicies:representations.filter(rep=>['IDENTITY','VOICE_IDENTITY'].includes(rep.type)).map(rep=>({representationId:rep.id,policy:policy(rep.type==='IDENTITY'?'CLEAN_MASTER':'VOICE_MASTER',model.domainRepresentationPolicyBindings,rep.id)})),
  definitions:{entityTypes:pick('entityTypes',entities.map(r=>r.type)),representationTypes:pick('representationTypes',representations.map(r=>r.type)),relationTypes:pick('relationTypes',relations.map(r=>r.type)),stateDimensions:pick('stateDimensions',dimensions)}};
}

/** Explicit V3 authoring only. Never call this to reinterpret a frozen V1/V2 set.
 * Exact implementation hashes are checked but are not copied into the returned
 * immutable semantic object. Actual media/rights/space locks remain independent.
 */
export function deriveShotDesignRequirementBasisV3(model,sceneId){
 record(model,'制作模型');identifier(sceneId,'场');
 const coverages=rows(model.sceneCoveragePlanRevisions||[],'场级意图').filter(row=>row.scopeId===sceneId&&row.scopeRole==='CURRENT'&&row.revisionState==='CURRENT'&&row.isCurrent===true);
 if(coverages.length!==1)fail('本场必须有唯一当前已采用镜头意图');
 const coverage=coverages[0];assertJson(coverage.content);
 if(!coverage.id||!Array.isArray(coverage.content?.beats)||!coverage.content.beats.length||hash(coverage.content)!==coverage.contentHash)fail('已采用镜头意图内容或哈希不完整');
 const refs=[...new Set(coverage.content.beats.flatMap(beat=>{if(!Array.isArray(beat.materialRequirementRefs)||beat.materialRequirementRefs.some(id=>typeof id!=='string'||!id.trim()))fail('已采用镜头意图需求引用不完整');return beat.materialRequirementRefs;}))].sort();
 const rawGraph=model.domainGraph||{schemaVersion:'1.0',entities:[],states:[],representations:[],relations:[],requirements:[]};assertJson(rawGraph);graphShape(rawGraph);
 const directory=refreshDirectoryProjection(model),graph=directory?.graph||rawGraph;assertJson(graph);graphShape(graph);
 const active=new Set(),resolved=new Map();
 function bindingFor(requirementId){
  if(active.has(requirementId))fail('镜头设计需求组合存在循环',{requirementId});
  if(resolved.has(requirementId))return resolved.get(requirementId);
  active.add(requirementId);
  const requirement=exact(model.materialRequirements||[],requirementId,'素材需求');assertJson(requirement);
  if(materialRequirementSelectionReasons(model,requirementId,{use:'CURRENT_INPUT'}).length)fail('本镜意图引用了已拆分或异常的素材需求，须显式采用新的具体用途',{requirementId});
  if(requirement.requirementClass!=='REQUIRED'||!/^[a-f0-9]{64}$/.test(requirement.requirementHash||'')||directory?.staleIds.includes(requirementId))fail('需求缺失、失效或无精确哈希',{requirementId});
  const owners=(directory?.bindings||[]).filter(row=>row.requirementId===requirementId);if(owners.length>1)fail('需求目录归属不唯一',{requirementId});
  const owner=owners[0];if(owner)assertJson(owner);
  const domainManaged=requirement.sourceKind==='DOMAIN_GRAPH';
  const domain=domainManaged?validateDomainRequirement(model,requirement,rawGraph):null;
  const representationId=owner?.representationId||requirement.representationRef||null,entityId=owner?.entityId||requirement.entityRef||null,stateId=owner?.stateId||requirement.stateRef||null;
  if(owner&&owner.requirementHash!==requirement.requirementHash)fail('目录与当前需求哈希不一致',{requirementId});
  const conditions={entityId,entity:condition(graph,'entities',entityId),state:condition(graph,'states',stateId),representation:condition(graph,'representations',representationId)};
  if(conditions.state&&conditions.state.value.entityId!==entityId||conditions.representation&&(conditions.representation.value.entityId!==entityId||(conditions.representation.value.stateId||null)!==stateId))fail('有效主体、状态与表现归属不一致',{requirementId});
  const seeds=[['ENTITY',entityId],['STATE',stateId],['REPRESENTATION',representationId]];
  if(domain)seeds.push(['ENTITY',domain.rep.entityId],['STATE',domain.rep.stateId],['REPRESENTATION',domain.rep.id]);
  const semantic={requirement:requirementValue(requirement,domainManaged),demand:domain?structuredClone(domain.demand):null,conditions,
   directoryOwnership:owner?without(owner,new Set(['requirementHash','representationHash'])):null,
   graphClosure:semanticGraphClosure(model,graph,seeds,sceneId,coverage)};
  if(Object.hasOwn(requirement,'composition')){
   let composition;try{composition=validateRequirementComposition(requirement.composition);}catch(error){fail(error.message,{requirementId});}
   semantic.requiredComponents=composition.requiredComponents.map(component=>({...component,binding:bindingFor(component.requirementId)}));
  }
  const binding={requirementId,requirementSemanticHash:hash(semantic),acceptanceCriteria:structuredClone(requirement.acceptanceCriteria||[]),authority:requirement.authorityClass||requirement.authority||'UNKNOWN',...semantic};
  active.delete(requirementId);resolved.set(requirementId,binding);return binding;
 }
 const bindings=refs.map(bindingFor);
 const value={schemaVersion:SHOT_DESIGN_REQUIREMENT_BASIS_VERSION,semanticPolicy:SHOT_DESIGN_REQUIREMENT_SEMANTIC_POLICY,sceneId,coverageRevisionId:coverage.id,coverageContentHash:coverage.contentHash,bindings};
 assertJson(value);return {id:'MATERIAL-REQUIREMENT-SET:'+sceneId,...value,contentHash:hash(value)};
}

/** Exact frozen-schema dispatch only; an absent or unknown marker is rejected. */
export function shotDesignRequirementBasisSchema(frozen){
 record(frozen,'冻结需求基线');if(frozen.schemaVersion==='2.0')return '2.0';
 if(frozen.schemaVersion==='3.0'&&frozen.semanticPolicy===SHOT_DESIGN_REQUIREMENT_SEMANTIC_POLICY)return '3.0';
 fail('冻结需求基线版本未知，不得按新版默认解释');
}

export function assertShotDesignRequirementBasisV3Current(model,sceneId,frozen){
 if(shotDesignRequirementBasisSchema(frozen)!=='3.0')fail('旧基线必须继续使用其原严格比较器');
 const current=deriveShotDesignRequirementBasisV3(model,sceneId);
 if(!same(frozen,current))fail('镜头设计语义需求基线已变化',{currentBindingHash:current.contentHash});
 return current;
}
