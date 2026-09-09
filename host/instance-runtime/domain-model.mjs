import { canonicalJson, sha256 } from './bytes.mjs';
import {validateRequirementCompositions} from './material-requirement-composition.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'DOMAIN_INVALID' }); };
const object = (v, name) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${name}必须是对象`); return v; };
const text = (v, name, max = 10000) => { if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${name}必须是非空文本（最多${max}字）`); return v; };
const identifier = (v, name) => { text(v,name,300); if (!/^[A-Za-z0-9][A-Za-z0-9:_.@-]*$/.test(v)) fail(`${name}不是有效的永久身份`); return v; };
const list = (v, name, max = 20000) => { if (!Array.isArray(v) || v.length > max) fail(`${name}必须是列表`); return v; };
const strings = (v,name) => list(v,name,1000).forEach(s=>text(s,name));
const keys = (v,allowed,name) => { if(Object.keys(v).some(k=>!allowed.includes(k))) fail(`${name}包含不支持的字段`); };
const unique = (rows,name) => { const ids=new Set(); for(const row of rows){object(row,name);identifier(row.id,`${name}.id`);if(ids.has(row.id))fail(`${name}身份重复：${row.id}`);ids.add(row.id);}return ids; };
const authorities=new Set(['F','A','L','U']);
export const domainHash = value => sha256(canonicalJson(value));
export { defaultDomainConfiguration, emptyDomainGraph } from './domain-defaults.mjs';
import { defaultDomainConfiguration } from './domain-defaults.mjs';
export function validateDomainConfiguration(input){
 const v=object(input,'素材关系配置');keys(v,['entityTypes','relationTypes','representationTypes','stateDimensions','referencePolicies'],'素材关系配置');
 for(const name of ['entityTypes','relationTypes','representationTypes','stateDimensions','referencePolicies']){list(v[name],name,100);unique(v[name],name);for(const row of v[name])text(row.label,`${name}.label`,200);}
 const dims=new Set(v.stateDimensions.map(r=>r.id));
 for(const r of v.relationTypes){if(!['STORY','CONTINUITY','REFERENCE','COMPOSITION'].includes(r.class)||typeof r.directed!=='boolean'||typeof r.acyclic!=='boolean')fail('关系类型的方向与用途无效');if(r.class==='REFERENCE'&&(!r.directed||!r.acyclic))fail('生产参考必须有方向且无环');}
 for(const r of v.representationTypes){if(!['IMAGE','AUDIO','VIDEO','TEXT'].includes(r.mediaType))fail('表现媒介无效');strings(r.dimensions,'表现维度');if(r.dimensions.some(d=>!dims.has(d)))fail('表现维度未定义');}
 for(const r of v.referencePolicies){strings(r.purposes,'参考用途');if(r.requireApprovedVersion!==true||r.allowIdentityTransfer!==false||!Number.isInteger(r.maxDerivedGenerations)||r.maxDerivedGenerations<0||r.maxDerivedGenerations>2)fail('参考策略不得取消获批版本、身份隔离或母版代际上限');}
 return structuredClone(v);
}
function evidence(v,bindings){
 list(v,'来源依据',1000);for(const e of v){object(e,'来源依据');identifier(e.sourceId,'sourceId');identifier(e.revisionId,'revisionId');if(!/^[a-f0-9]{64}$/.test(e.sha256))fail('来源SHA无效');if(e.quote!==undefined)text(e.quote,'引用',20000);if(e.locator!==undefined)text(e.locator,'定位',2000);if(bindings&&!bindings.some(b=>b.sourceId===e.sourceId&&b.revisionId===e.revisionId&&b.sha256===e.sha256))fail(`依据未绑定当前来源：${e.sourceId}`);}
}
function fact(row,bindings){if(!authorities.has(row.authority))fail('必须区分事实、改编、制作锁定与未知');evidence(row.evidence,bindings);if(row.authority==='F'&&!row.evidence.length)fail('事实必须有精确来源依据');}
function scopes(v){list(v,'适用范围',1000);for(const s of v){object(s,'范围');if(!['PROJECT','EPISODE','SCENE','SHOT'].includes(s.scopeType))fail('范围类型无效');identifier(s.scopeId,'scopeId');if(s.scopeType!=='PROJECT'&&!s.revisionId)fail('场、集、镜范围必须绑定不可变修订，不能只用显示编号');if(s.revisionId)identifier(s.revisionId,'范围revisionId');}}
function dimensions(v,config){object(v,'状态维度');const known=new Set(config.stateDimensions.map(d=>d.id));for(const [k,value] of Object.entries(v)){if(!known.has(k))fail(`未定义状态维度：${k}`);text(value,`状态.${k}`,4000);}}
export function validateDomainGraph(input,options={}){
 const g=structuredClone(object(input,'关系图'));keys(g,['schemaVersion','entities','states','representations','relations','requirements'],'关系图');if(g.schemaVersion!=='1.0')fail('不支持的关系图版本');
 const c=validateDomainConfiguration(options.configuration||defaultDomainConfiguration());
 for(const name of ['entities','states','representations','relations','requirements']){list(g[name],name);unique(g[name],name);}
 const entityIds=new Set(g.entities.map(r=>r.id)),stateById=new Map(g.states.map(r=>[r.id,r])),repById=new Map(g.representations.map(r=>[r.id,r]));
 for(const e of g.entities){if(!c.entityTypes.some(t=>t.id===e.type))fail(`实体类型无效：${e.type}`);text(e.name,'对象名称',300);strings(e.aliases,'对象别名');if(typeof e.description!=='string')fail('对象说明须为文本');fact(e,options.sourceBindings);}
 for(const s of g.states){if(!entityIds.has(s.entityId))fail(`状态主体不存在：${s.entityId}`);text(s.label,'状态名称',300);dimensions(s.dimensions,c);scopes(s.scope);fact(s,options.sourceBindings);}
 for(const r of g.representations){if(!entityIds.has(r.entityId))fail(`表现主体不存在：${r.entityId}`);if(r.stateId&&stateById.get(r.stateId)?.entityId!==r.entityId)fail('表现状态不属于同一主体');if(!c.representationTypes.some(t=>t.id===r.type))fail(`表现类型无效：${r.type}`);text(r.label,'表现名称',300);dimensions(r.dimensions,c);strings(r.assetFamilyIds,'资产族');strings(r.requirementIds,'需求');if(options.knownFamilyIds&&r.assetFamilyIds.some(id=>!options.knownFamilyIds.includes(id)))fail('表现绑定不存在的资产族');if(options.knownRequirementIds&&r.requirementIds.some(id=>!options.knownRequirementIds.includes(id)&&!g.requirements.some(q=>q.id===id)))fail('表现绑定不存在的素材需求');if(r.unresolved!==undefined)strings(r.unresolved,'未确认关联');fact(r,options.sourceBindings);}
 const nodes={ENTITY:entityIds,STATE:new Set(stateById.keys()),REPRESENTATION:new Set(repById.keys())};const adjacent=new Map();
 for(const r of g.relations){const t=c.relationTypes.find(t=>t.id===r.type);if(!t)fail(`关系类型无效：${r.type}`);for(const end of [r.from,r.to]){object(end,'关系端点');if(!nodes[end.kind]?.has(end.id))fail(`关系端点不存在：${end.id}`);}if(r.from.kind===r.to.kind&&r.from.id===r.to.id)fail('关系不能指向自身');text(r.label,'关系名称',300);if(typeof r.purpose!=='string')fail('参考用途须为文本');strings(r.inherit,'继承属性');strings(r.exclude,'排除属性');scopes(r.scope);fact(r,options.sourceBindings);if(!['PROPOSED','CONFIRMED','UNKNOWN'].includes(r.status))fail('关系状态无效');if(t.class==='STORY'&&r.from.kind!=='ENTITY'||t.class==='STORY'&&r.to.kind!=='ENTITY')fail('故事关系必须连接故事对象');if(t.class==='REFERENCE'){if(r.from.kind!=='REPRESENTATION'||r.to.kind!=='REPRESENTATION')fail('生产参考必须连接表现');if(!r.purpose.trim()||!r.referencePolicyId||!c.referencePolicies.some(p=>p.id===r.referencePolicyId))fail('生产参考必须声明用途与参考策略');if(!c.referencePolicies.find(p=>p.id===r.referencePolicyId).purposes.includes(r.purpose))fail('参考用途不在所选策略允许范围');if(r.type==='SAME_IDENTITY'&&repById.get(r.from.id).entityId!==repById.get(r.to.id).entityId)fail('同一身份参考不得跨人物主体');if(r.type==='FAMILY_RESEMBLANCE'){const a=repById.get(r.from.id).entityId,b=repById.get(r.to.id).entityId;if(!g.relations.some(k=>k.type==='KINSHIP'&&k.status==='CONFIRMED'&&k.authority!=='U'&&k.evidence.length>0&&((k.from.id===a&&k.to.id===b)||(k.from.id===b&&k.to.id===a))))fail('亲缘参考必须有独立的亲缘关系依据');}}
  if(t.acyclic&&!r.historicalOnly){const a=`${t.class}:${r.from.kind}:${r.from.id}`,b=`${t.class}:${r.to.kind}:${r.to.id}`;adjacent.set(a,[...(adjacent.get(a)||[]),b]);}}
 const done=new Set(),active=new Set();function visit(id){if(active.has(id))fail('生产参考或有向状态依赖存在循环');if(done.has(id))return;active.add(id);for(const n of adjacent.get(id)||[])visit(n);active.delete(id);done.add(id);}for(const id of adjacent.keys())visit(id);
 for(const r of g.requirements){text(r.title,'需求名称',300);if(!repById.has(r.representationId))fail('需求表现不存在');if(!['IMAGE','AUDIO','VIDEO','TEXT'].includes(r.mediaType))fail('需求媒介无效');text(r.category,'需求类型',300);text(r.reuseScope,'复用范围',1000);scopes(r.scope);evidence(r.evidence,options.sourceBindings);strings(r.acceptanceCriteria,'验收要求');if(!r.acceptanceCriteria.length)fail('素材需求必须有验收要求');}
 validateRequirementCompositions(g.requirements,{knownRequirementIds:options.knownCompositionRequirementIds||options.knownRequirementIds||[]});
 validateRequirementReplacements(g);
 if(options.previousGraph)validateRequirementReplacementTransition(options.previousGraph,g);
 return g;
}
export function validateInitializationContent(input){const v=object(input,'初始化草稿');keys(v,['schemaVersion','title','summary','configuration','graph','uncertainties','sourceBindings'],'初始化草稿');if(v.schemaVersion!=='1.0')fail('初始化草稿版本无效');text(v.title,'故事名称',300);if(typeof v.summary!=='string'||v.summary.length>100000)fail('故事说明无效');strings(v.uncertainties,'待确认问题');list(v.sourceBindings,'来源绑定',5000);for(const b of v.sourceBindings)evidence([b],null);object(v.configuration,'系统配置');validateDomainGraph(v.graph,{configuration:v.configuration.domain||defaultDomainConfiguration(),sourceBindings:v.sourceBindings});return structuredClone(v);}
export function graphImpact(previous,next){const a=new Map(),b=new Map();for(const k of ['entities','states','representations','relations','requirements']){for(const x of previous[k])a.set(`${k}:${x.id}`,domainHash(x));for(const x of next[k])b.set(`${k}:${x.id}`,domainHash(x));}const changedIds=new Set([...b.keys()].filter(id=>a.get(id)!==b.get(id)).map(id=>id.split(':').slice(1).join(':')));return {added:[...b.keys()].filter(k=>!a.has(k)).length,changed:[...b.keys()].filter(k=>a.has(k)&&a.get(k)!==b.get(k)).length,removed:[...a.keys()].filter(k=>!b.has(k)).length,affectedRepresentationIds:next.representations.filter(r=>changedIds.has(r.id)||changedIds.has(r.entityId)||changedIds.has(r.stateId)||next.relations.some(e=>changedIds.has(e.id)&&[e.from.id,e.to.id].includes(r.id))).map(r=>r.id),referenceCount:next.relations.filter(r=>r.referencePolicyId).length,unknownCount:next.relations.filter(r=>r.authority==='U'||r.status==='UNKNOWN').length};}

/** Only this new declaration is strict; unchanged pre-replacement graphs keep their contract. */
export function validateRequirementReplacements(graph){
 const replacements=graph.requirements.filter(r=>Object.hasOwn(r,'replaces'));if(!replacements.length)return graph;
 const demands=new Map(graph.requirements.map(r=>[r.id,r])),reps=new Map(graph.representations.map(r=>[r.id,r])),successors=new Map();
 const scopeSet=row=>{if(!Array.isArray(row.scope)||!row.scope.length)fail('替代需求必须有精确适用范围');const values=row.scope.map(s=>{keys(s,['scopeType','scopeId','revisionId'],'替代范围');return canonicalJson(s);});if(new Set(values).size!==values.length)fail('替代需求范围不能重复');return values.sort();};
 for(const r of replacements){
  const replacement=object(r.replaces,'需求替代');if(Object.keys(replacement).sort().join(',')!=='requirementHash,requirementId')fail('需求替代必须且仅包含requirementId与requirementHash');identifier(replacement.requirementId,'被替代需求');if(!/^[a-f0-9]{64}$/.test(replacement.requirementHash))fail('被替代需求SHA无效');
  const old=demands.get(replacement.requirementId),rep=reps.get(r.representationId),oldRep=reps.get(old?.representationId);
  if(!old||old.id===r.id||!rep||!oldRep)fail('替代必须指向另一个已存在的领域需求');
  if(successors.has(old.id))fail('同一需求不能有多个当前替代者');successors.set(old.id,r.id);
  if(r.mediaType!=='IMAGE'||old.mediaType!=='IMAGE')fail('当前替代合同仅支持IMAGE需求');
  if(!r.composition||r.composition.schemaVersion!=='1.0'||r.composition.mode!=='ALL'||!r.composition.requiredComponents?.length||rep.assetFamilyIds.length)fail('替代者必须是无生产族的ALL汇总需求');
  if(rep.entityId!==oldRep.entityId)fail('替代需求不得改变原主体');
  if(domainHash({demand:old,representation:oldRep})!==replacement.requirementHash)fail('被替代需求与精确原哈希不一致');
  const allowed=scopeSet(old);if(canonicalJson(scopeSet(r))!==canonicalJson(allowed))fail('替代需求不得改变原永久适用范围');
  const seen=new Set(),visiting=new Set(),leafScopes=[];
  function component(id){if(id===old.id||id===r.id)fail('替代组件不能引用旧宽泛需求或替代者自身');if(visiting.has(id))fail('替代组件存在循环');if(seen.has(id))return;visiting.add(id);const child=demands.get(id);if(!child||child.mediaType!=='IMAGE')fail('替代组件必须是已有精确IMAGE领域需求');const cs=scopeSet(child);if(cs.some(s=>!allowed.includes(s)))fail('替代组件超出原永久适用范围');if(child.composition){for(const c of child.composition.requiredComponents)component(c.requirementId);}else leafScopes.push(...cs);visiting.delete(id);seen.add(id);}
  for(const c of r.composition.requiredComponents)component(c.requirementId);
  if(canonicalJson([...new Set(leafScopes)].sort())!==canonicalJson(allowed))fail('替代组件未完整覆盖原适用范围');
 }
 const done=new Set(),active=new Set();function visit(id){if(active.has(id))fail('需求替代存在循环');if(done.has(id))return;active.add(id);const next=successors.get(id);if(next)visit(next);active.delete(id);done.add(id);}for(const id of successors.keys())visit(id);
 return graph;
}
/** An applied replacement is append-only. Deleting it must never resurrect the old green row. */
export function validateRequirementReplacementTransition(previous,next){
 const oldClaims=(previous?.requirements||[]).filter(r=>Object.hasOwn(r,'replaces')),newClaims=(next?.requirements||[]).filter(r=>Object.hasOwn(r,'replaces'));
 if(!oldClaims.length&&!newClaims.length)return next;
 validateRequirementReplacements(next);
 for(const old of oldClaims){const fresh=next.requirements.find(r=>r.id===old.id);if(!fresh||canonicalJson(fresh.replaces)!==canonicalJson(old.replaces))fail('已发布的需求替代声明不得删除或重新绑定');}
 for(const claim of newClaims){
  if(oldClaims.some(r=>r.id===claim.id))continue;
  if((previous?.requirements||[]).some(r=>r.id===claim.id))fail('需求替代必须使用新ALL身份，不得改绑既有需求');
  const old=(previous?.requirements||[]).find(r=>r.id===claim.replaces.requirementId),fresh=next.requirements.find(r=>r.id===claim.replaces.requirementId);
  if(!old||canonicalJson(old)!==canonicalJson(fresh))fail('首次替代必须保留已发布原需求字节，不能同批创建或修改父定义');
  const rep=previous.representations.find(r=>r.id===old.representationId),newRep=next.representations.find(r=>r.id===old.representationId);
  if(!rep||canonicalJson(rep)!==canonicalJson(newRep))fail('首次替代必须保留原表现字节');
  for(const [collection,id]of [['entities',rep.entityId],['states',rep.stateId]])if(id&&canonicalJson(previous[collection].find(r=>r.id===id))!==canonicalJson(next[collection].find(r=>r.id===id)))fail('首次替代不得同时改变原主体或状态');
 }
 return next;
}
