import {canonicalJson,sha256} from './bytes.mjs';

const own=(value,key)=>Object.hasOwn(value,key);
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const record=(value,path)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(`${path}必须是领域原始行对象`);
 return value;
};
const id=(value,path)=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,299}$/.test(value))fail(`${path}永久身份无效`);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const escape=key=>key.replace(/~/g,'~0').replace(/\//g,'~1');

// canonicalJson deliberately follows existing source hash rules. Reject values
// it would omit or coerce so an unknown field can never vanish from the proof.
function json(value,path,ancestors=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))fail(`${path}必须是可精确冻结的JSON数值`);return;}
 if(typeof value!=='object')fail(`${path}不是JSON值`);
 if(ancestors.has(value))fail(`${path}不能有循环引用`);
 if(Reflect.ownKeys(value).some(key=>typeof key==='symbol'))fail(`${path}不能有符号字段`);
 ancestors.add(value);
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertyNames(value).length!==value.length+1||Object.keys(value).length!==value.length)fail(`${path}不能是稀疏数组或带附加字段的数组`);
  for(let i=0;i<value.length;i++){
   const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
   if(!descriptor||!descriptor.enumerable||!own(descriptor,'value'))fail(`${path}数组项必须是实际JSON值`);
   json(descriptor.value,`${path}/${i}`,ancestors);
  }
 }else{
  record(value,path);
  for(const key of Object.getOwnPropertyNames(value)){
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!descriptor.enumerable||!own(descriptor,'value'))fail(`${path}/${escape(key)}不能是隐藏或动态字段`);
   json(descriptor.value,`${path}/${escape(key)}`,ancestors);
  }
 }
 ancestors.delete(value);
}
function identities(values,path,{one=false}={}){
 if(!Array.isArray(values)||!values.length||new Set(values).size!==values.length||(one&&values.length!==1))fail(`${path}须为${one?'唯一非空身份':'非空且不重复的身份列表'}`);
 values.forEach((value,index)=>id(value,`${path}/${index}`));
}
function scope(value,path){
 if(!Array.isArray(value))fail(`${path}必须是精确范围列表`);
 const seen=new Set();
 for(const [index,item]of value.entries()){
  record(item,`${path}/${index}`);
  if(!['PROJECT','EPISODE','SCENE','SHOT'].includes(item.scopeType))fail(`${path}/${index}范围类型无效`);
  id(item.scopeId,`${path}/${index}/scopeId`);
  if(item.scopeType!=='PROJECT'||own(item,'revisionId'))id(item.revisionId,`${path}/${index}/revisionId`);
  const key=canonicalJson(item);if(seen.has(key))fail(`${path}范围重复`);seen.add(key);
 }
}
function validate(value,label){
 record(value,label);json(value,label);
 if(Object.keys(value).sort().join(',')!=='demand,entity,representation,state')fail(`${label}必须且仅含demand、representation、entity、state`);
 const {demand,representation,entity,state}=value;
 for(const [key,row]of Object.entries({demand,representation,entity})){record(row,`${label}/${key}`);id(row.id,`${label}/${key}/id`);}
 for(const key of ['composition','replaces','requirementReplacement','currentDisposition'])if(own(demand,key))fail(`${label}/demand含组合或替代标记，不能按原子制作需求重基线`);
 id(demand.representationId,`${label}/demand/representationId`);
 if(demand.representationId!==representation.id)fail(`${label}需求与表现归属不一致`);
 if(!['IMAGE','AUDIO','VIDEO','TEXT'].includes(demand.mediaType))fail(`${label}需求媒介无效`);
 if(typeof demand.reuseScope!=='string'||!demand.reuseScope.trim())fail(`${label}缺少明确复用范围`);
 scope(demand.scope,`${label}/demand/scope`);
 id(representation.entityId,`${label}/representation/entityId`);
 id(representation.type,`${label}/representation/type`);
 id(entity.type,`${label}/entity/type`);
 if(representation.entityId!==entity.id)fail(`${label}表现与实体归属不一致`);
 identities(representation.assetFamilyIds,`${label}/representation/assetFamilyIds`,{one:true});
 identities(representation.requirementIds,`${label}/representation/requirementIds`);
 if(!representation.requirementIds.includes(demand.id))fail(`${label}表现未反向绑定当前需求`);
 if(representation.stateId===null||!own(representation,'stateId')){
  if(state!==null)fail(`${label}无状态表现必须绑定null状态`);
 }else{
  id(representation.stateId,`${label}/representation/stateId`);
  record(state,`${label}/state`);id(state.id,`${label}/state/id`);id(state.entityId,`${label}/state/entityId`);
  if(state.id!==representation.stateId||state.entityId!==entity.id)fail(`${label}状态与表现或实体归属不一致`);
  scope(state.scope,`${label}/state/scope`);
 }
}
function frozen(before,after,keys,path){
 for(const key of keys)if(own(before,key)!==own(after,key)||!same(before[key],after[key]))fail(`${path}/${key}不能在制作需求重基线时换绑`);
}
// A parent object is emitted for property addition/removal: absent and JSON null
// stay distinguishable without inventing a sentinel that could be real data.
function changes(before,after,path=''){
 if(same(before,after))return [];
 if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
  const a=Object.keys(before).sort(),b=Object.keys(after).sort();
  if(same(a,b))return a.flatMap(key=>changes(before[key],after[key],`${path}/${escape(key)}`));
 }
 return [{path,before:structuredClone(before),after:structuredClone(after)}];
}

/** Identity-only proof. The caller must resolve these raw rows from exact
 * published sources, validate both complete domain graphs and current selection,
 * and check incoming ALL/replacement edges; four rows cannot prove those facts.
 * No media, review, request, Run, owner or database authority is established here.
 */
export function materialProductionRebaseIdentity(input){
 record(input,'制作需求重基线');json(input,'制作需求重基线');
 if(Object.keys(input).sort().join(',')!=='after,before')fail('制作需求重基线必须且仅含before与after');
 const {before,after}=input;validate(before,'before');validate(after,'after');
 frozen(before.demand,after.demand,['id','representationId','mediaType','reuseScope','scope'],'demand');
 frozen(before.representation,after.representation,['id','entityId','stateId','type','assetFamilyIds','requirementIds'],'representation');
 frozen(before.entity,after.entity,['id','type'],'entity');
 if((before.state===null)!==(after.state===null))fail('state不能在制作需求重基线时换绑');
 if(before.state!==null)frozen(before.state,after.state,['id','entityId','scope'],'state');
 const diff=changes(before,after);
 if(!diff.length)fail('领域语义没有变化，不能创建显式制作需求重基线');
 return {beforeHash:sha256(canonicalJson(before)),afterHash:sha256(canonicalJson(after)),changes:diff};
}
