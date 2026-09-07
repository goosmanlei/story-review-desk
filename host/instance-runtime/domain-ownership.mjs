import {domainHash, defaultDomainConfiguration} from './domain-model.mjs';

export const domainCollections = ['entities','states','representations','relations','requirements'];
export const domainOwners = ['SETTINGS','MATERIAL'];
export const objectKey = (collection,id) => `${collection}:${id}`;

/** Navigation metadata, deliberately outside canonical content and asset hashes. */
export function domainOwnership(graph, configuration = defaultDomainConfiguration(), registered = {}) {
  const result = {};
  const put = (collection,row,owner,reason) => {
    const key=objectKey(collection,row.id), previous=registered[key];
    result[key]=previous?.recordHash===domainHash(row) ? previous : {owner,reason,recordHash:domainHash(row)};
  };
  for(const row of graph.entities) {
    const composite=graph.relations.some(r=>r.to.id===row.id&&configuration.relationTypes.find(t=>t.id===r.type)?.class==='COMPOSITION');
    put('entities',row,row.type==='UNRESOLVED'?'UNCERTAIN':composite?'UNCERTAIN':'SETTINGS',composite?'组合或群体主体的业务归属待核':row.type==='UNRESOLVED'?'主体尚未唯一确认':'独立主体或共用制作主题');
  }
  for(const row of graph.states) {
    put('states',row,'MATERIAL','实体状态与连续性统一在素材管理维护；状态声明不代表已生成素材');
  }
  for(const collection of ['representations','requirements']) for(const row of graph[collection]) put(collection,row,'MATERIAL','素材表现或需求');
  const nodeOwner=node=>result[objectKey(({ENTITY:'entities',STATE:'states',REPRESENTATION:'representations'})[node.kind],node.id)]?.owner;
  for(const row of graph.relations) {
    const kind=configuration.relationTypes.find(t=>t.id===row.type)?.class;
    let owner='UNCERTAIN',reason='关系用途需核对，未按类型推断故事事实';
    if(kind==='REFERENCE'||row.from.kind==='REPRESENTATION'||row.to.kind==='REPRESENTATION') {owner='MATERIAL';reason='素材参考或组合';}
    else if(kind==='STORY') {owner='SETTINGS';reason='已登记故事关系';}
    else if(kind==='CONTINUITY'&&nodeOwner(row.from)===nodeOwner(row.to)) {owner=nodeOwner(row.from)||'UNCERTAIN';reason='跟随两端状态的维护归属';}
    put('relations',row,owner,reason);
  }
  return result;
}

export function applyDomainChanges(graph, changes, owner, ownership) {
  if(!domainOwners.includes(owner)||!Array.isArray(changes)||changes.length>20000) throw Object.assign(new Error('维护范围或变更集无效'),{code:'DOMAIN_INVALID'});
  const next=structuredClone(graph),seen=new Set(),nextOwnership={...ownership};
  for(const change of changes) {
    const {collection,id,beforeHash,value}=change||{};
    if(!domainCollections.includes(collection)||typeof id!=='string'||!Object.hasOwn(change,'beforeHash')||!Object.hasOwn(change,'value')||Object.keys(change).some(k=>!['collection','id','beforeHash','value'].includes(k))) throw Object.assign(new Error('对象变更格式无效'),{code:'DOMAIN_INVALID'});
    const key=objectKey(collection,id),index=next[collection].findIndex(r=>r.id===id),previous=index>=0?next[collection][index]:null;
    if(seen.has(key)||beforeHash!==(previous?domainHash(previous):null)) throw Object.assign(new Error('对象版本已变化，请保留修改并重新核对'),{code:'DOMAIN_CONFLICT'});
    seen.add(key);
    if(previous&&ownership[key]?.owner!==owner) throw Object.assign(new Error('只能修改本模块维护的对象；待核归属须先明确确认'),{code:'DOMAIN_INVALID'});
    if(value===null){if(!previous)throw Object.assign(new Error('不能移除不存在的对象'),{code:'DOMAIN_INVALID'});next[collection].splice(index,1);delete nextOwnership[key];continue;}
    if(!value||value.id!==id) throw Object.assign(new Error('永久身份不能在编辑中变更'),{code:'DOMAIN_INVALID'});
    if(previous)next[collection][index]=structuredClone(value);else next[collection].push(structuredClone(value));
    nextOwnership[key]={owner,recordHash:domainHash(value),reason:previous?ownership[key].reason:'在所属业务模块显式登记'};
  }
  return {graph:next,ownership:nextOwnership};
}
