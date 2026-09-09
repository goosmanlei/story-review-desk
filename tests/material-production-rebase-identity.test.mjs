import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash,validateDomainGraph} from '../host/instance-runtime/domain-model.mjs';
import {materialProductionRebaseIdentity} from '../host/instance-runtime/material-production-rebase-identity.mjs';

function fixture(){
 const scope=[{scopeType:'SCENE',scopeId:'scene-neutral',revisionId:'scene-revision'}];
 const before={demand:{id:'demand-neutral',title:'中性原子状态',representationId:'rep-neutral',mediaType:'IMAGE',category:'prop',reuseScope:'SCENE',scope,evidence:[],acceptanceCriteria:['原几何及可见状态明确。']},representation:{id:'rep-neutral',entityId:'entity-neutral',stateId:'state-neutral',type:'PROP_STATE',label:'原子表现',dimensions:{storyState:'empty'},assetFamilyIds:['family-neutral'],requirementIds:['demand-neutral'],authority:'A',evidence:[]},entity:{id:'entity-neutral',type:'PROP',name:'中性对象',aliases:[],description:'测试实体',authority:'A',evidence:[]},state:{id:'state-neutral',entityId:'entity-neutral',label:'空态',dimensions:{storyState:'empty'},scope,authority:'A',evidence:[]}};
 const after=structuredClone(before);after.demand.acceptanceCriteria=['原几何及可见状态明确。','新增局部可见区域验收。'];
 return {before,after};
}
const conflict=fn=>assert.throws(fn,e=>e.code==='DOMAIN_CONFLICT');

test('same-identity revision hashes complete valid DOMAIN rows, preserves source bytes and returns exact differences',()=>{
 const f=fixture(),bytes=canonicalJson(f);
 for(const rows of [f.before,f.after])validateDomainGraph({schemaVersion:'1.0',entities:[rows.entity],states:[rows.state],representations:[rows.representation],relations:[],requirements:[rows.demand]});
 const p=materialProductionRebaseIdentity(f);
 assert.equal(p.beforeHash,domainHash(f.before));assert.equal(p.afterHash,sha256(canonicalJson(f.after)));assert.notEqual(p.beforeHash,p.afterHash);
 assert.deepEqual(p.changes,[{path:'/demand/acceptanceCriteria',before:f.before.demand.acceptanceCriteria,after:f.after.demand.acceptanceCriteria}]);assert.equal(canonicalJson(f),bytes);
 p.changes[0].after.push('mutated returned proof');assert.equal(canonicalJson(f),bytes);
});

test('unknown nested fields on every raw row participate in full hash and path-safe diff',()=>{
 const f=fixture();f.before.demand.extension={'slash/key':{'~label':'原文'}};f.after=structuredClone(f.before);f.after.demand.extension['slash/key']['~label']='修订';
 for(const row of ['representation','entity','state']){f.before[row].unknown={nested:['旧值',1]};f.after[row].unknown={nested:['新值',1]};}
 const p=materialProductionRebaseIdentity(f);assert.equal(p.changes.length,4);assert.ok(p.changes.some(c=>c.path==='/demand/extension/slash~1key/~0label'));assert.equal(p.beforeHash,domainHash(f.before));assert.equal(p.afterHash,domainHash(f.after));
});

test('field addition/removal keeps absent distinct from null by diffing the nearest common object',()=>{
 for(const addition of [true,false]){
  const f=fixture();f.after=structuredClone(f.before);(addition?f.after:f.before).entity.newField=null;
  const p=materialProductionRebaseIdentity(f);assert.equal(p.changes.length,1);assert.equal(p.changes[0].path,'/entity');assert.notEqual(Object.hasOwn(p.changes[0].before,'newField'),Object.hasOwn(p.changes[0].after,'newField'));
 }
});

test('explicit no-state and legacy omitted stateId are allowed but their exact representation bytes cannot be normalized',()=>{
 for(const omitted of [false,true]){const f=fixture();for(const r of [f.before,f.after]){r.state=null;if(omitted)delete r.representation.stateId;else r.representation.stateId=null;}assert.ok(materialProductionRebaseIdentity(f).changes.length);}
 const f=fixture();for(const r of [f.before,f.after])r.state=null;f.before.representation.stateId=null;delete f.after.representation.stateId;conflict(()=>materialProductionRebaseIdentity(f));
});

test('PROJECT scope and unchanged legal empty DOMAIN scope are not widened or reinterpreted',()=>{
 for(const scope of [[{scopeType:'PROJECT',scopeId:'project-neutral'}],[]]){const f=fixture();for(const r of [f.before,f.after]){r.demand.scope=structuredClone(scope);r.state.scope=structuredClone(scope);}assert.ok(materialProductionRebaseIdentity(f).afterHash);}
});

for(const [label,change]of[
 ['demand identity',r=>r.demand.id='other'],['representation binding',r=>r.demand.representationId='other'],['media',r=>r.demand.mediaType='AUDIO'],['reuse scope',r=>r.demand.reuseScope='PROJECT'],
 ['scope revision',r=>r.demand.scope[0].revisionId='later'],['scope identity',r=>r.demand.scope[0].scopeId='other'],['scope unknown field',r=>r.demand.scope[0].restriction='new'],['scope widening',r=>r.demand.scope.push({scopeType:'SCENE',scopeId:'other',revisionId:'r2'})],
 ['rep identity',r=>r.representation.id='other'],['rep entity',r=>r.representation.entityId='other'],['rep state',r=>r.representation.stateId='other'],['rep type',r=>r.representation.type='IDENTITY'],['rep family',r=>r.representation.assetFamilyIds=['other']],['rep other requirement',r=>r.representation.requirementIds.push('other')],
 ['entity identity',r=>r.entity.id='other'],['entity type',r=>r.entity.type='CHARACTER'],['state identity',r=>r.state.id='other'],['state entity',r=>r.state.entityId='other'],['state scope',r=>r.state.scope=[]],
 ['coordinated new permanent entity',r=>{r.entity.id='other';r.representation.entityId='other';r.state.entityId='other';}],['coordinated new permanent state',r=>{r.state.id='other';r.representation.stateId='other';}],['coordinated new demand',r=>{r.demand.id='other';r.representation.requirementIds=['other'];}],
])test('refuses identity/scope drift: '+label,()=>{const f=fixture();change(f.after);conflict(()=>materialProductionRebaseIdentity(f));});

for(const side of ['before','after'])for(const [label,change]of[
 ['empty family',r=>r.representation.assetFamilyIds=[]],['multiple families',r=>r.representation.assetFamilyIds.push('second')],['duplicate family',r=>r.representation.assetFamilyIds.push('family-neutral')],['duplicate requirements',r=>r.representation.requirementIds.push(r.demand.id)],['no reverse requirement binding',r=>r.representation.requirementIds=['different']],
 ['missing demand',r=>delete r.demand],['extra row',r=>r.extra={}],['state null mismatch',r=>r.state=null],['missing permanent entity type',r=>delete r.entity.type],['scope missing revision',r=>delete r.demand.scope[0].revisionId],['scope duplicate',r=>r.demand.scope.push(structuredClone(r.demand.scope[0]))],
])test(side+' invalid closure: '+label,()=>{const f=fixture();change(f[side]);conflict(()=>materialProductionRebaseIdentity(f));});

for(const side of ['before','after'])for(const field of ['composition','replaces','requirementReplacement','currentDisposition'])for(const value of [null,{}])test(`${side} rejects even empty ${field} markers (${value===null?'null':'object'})`,()=>{const f=fixture();f[side].demand[field]=value;conflict(()=>materialProductionRebaseIdentity(f));});

test('no semantic change and key insertion order alone cannot create a rebase',()=>{const f=fixture();f.after=Object.fromEntries(Object.entries(f.before).reverse());conflict(()=>materialProductionRebaseIdentity(f));});

test('source binding changes remain explicit semantic input, never stripped from the hashes',()=>{const f=fixture();f.after=structuredClone(f.before);f.after.demand.evidence=[{sourceId:'source-neutral',revisionId:'revision-next',sha256:'f'.repeat(64),locator:'block-neutral'}];const p=materialProductionRebaseIdentity(f);assert.deepEqual(p.changes.map(c=>c.path),['/demand/evidence']);});

test('scope and permanent reference ordering are exact frozen bytes',()=>{const f=fixture();for(const r of [f.before,f.after]){r.demand.scope.push({scopeType:'SCENE',scopeId:'second',revisionId:'second-revision'});r.representation.requirementIds.push('second-demand');}f.after.demand.scope.reverse();conflict(()=>materialProductionRebaseIdentity(f));f.after.demand.scope=structuredClone(f.before.demand.scope);f.after.representation.requirementIds.reverse();conflict(()=>materialProductionRebaseIdentity(f));});

for(const [label,invalid]of[['undefined',undefined],['NaN',NaN],['Infinity',Infinity],['negative zero',-0],['bigint',1n],['function',()=>{}],['Date',new Date()],['sparse array',new Array(2)],['array extra property',Object.assign([], {extra:true})]])test('lossy non-JSON unknown field fails closed: '+label,()=>{const f=fixture();f.after.entity.unknown=invalid;conflict(()=>materialProductionRebaseIdentity(f));});

test('cycles, symbols, hidden keys and getters never disappear or execute during hashing',()=>{
 for(const modify of [r=>r.entity.unknown=r.entity,r=>r.entity[Symbol('hidden')]=true,r=>Object.defineProperty(r.entity,'hidden',{value:1,enumerable:false}),r=>Object.defineProperty(r.entity,'getter',{get(){assert.fail('must not execute getter');},enumerable:true})]){const f=fixture();modify(f.after);conflict(()=>materialProductionRebaseIdentity(f));}
});


test('top-level dynamic fields and hidden array metadata are rejected before access or hash coercion',()=>{
 const f=fixture();const input={after:f.after};Object.defineProperty(input,'before',{get(){assert.fail('must not execute before getter');},enumerable:true});conflict(()=>materialProductionRebaseIdentity(input));
 const g=fixture();g.after.entity.unknown=[];Object.defineProperty(g.after.entity.unknown,'hidden',{value:'must be frozen'});conflict(()=>materialProductionRebaseIdentity(g));
});
