import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDomainInvalidations} from '../host/instance-runtime/domain-invalidation.mjs';
test('changing an information card invalidates its composite and episode, while preserving the clean image, rights and immutable verdict',()=>{
 const version=(id,familyId,inputs=[])=>({id,familyId,sha256:id.repeat(64).slice(0,64),inputVersionBindings:inputs,reviewDecision:'RELEASED',lifecycleState:'RELEASED',canFlowDownstream:true,projectRightsGate:'UNKNOWN'});
 const card=version('a','card'),clean=version('b','clean'),composite=version('c','composite',[{versionId:card.id,sha256:card.sha256},{versionId:clean.id,sha256:clean.sha256}]),episode=version('d','episode',[{versionId:composite.id,sha256:composite.sha256}]);
 const sibling=version('e','card'),other=version('f','other',[{versionId:sibling.id,sha256:sibling.sha256}]);
 const versions=new Map([card,clean,composite,episode,sibling,other].map(v=>[v.id,v]));
 const before=structuredClone([...versions]);
 assert.deepEqual(applyDomainInvalidations([{familyId:'card',versionIds:[card.id]}],versions),['a','c','d']);
 for(const id of ['a','c','d']){assert.equal(versions.get(id).canFlowDownstream,false);assert.equal(versions.get(id).reviewDecision,'RELEASED');assert.equal(versions.get(id).projectRightsGate,'UNKNOWN');}
 for(const id of ['b','e','f'])assert.deepEqual(versions.get(id),new Map(before).get(id));
});
test('a domain change cannot relax a rights hold or prohibited-use verdict',()=>{
 const versions=new Map([['a',{id:'a',familyId:'f',lifecycleState:'DO_NOT_USE',canFlowDownstream:false}],['b',{id:'b',familyId:'f',lifecycleState:'RIGHTS_HOLD',canFlowDownstream:false}]]);
 applyDomainInvalidations([{familyId:'f',versionIds:['a','b']}],versions);
 assert.equal(versions.get('a').lifecycleState,'DO_NOT_USE');assert.equal(versions.get('b').lifecycleState,'RIGHTS_HOLD');
});

function recoveryFixture(){
 const version=(id,familyId,inputs=[])=>({id,familyId,sha256:id.repeat(64),lifecycleState:'RELEASED',canFlowDownstream:true,flowBlockReasons:[],inputVersionBindings:inputs});
 const root=version('a','root'),sibling=version('b','root'),child=version('c','child',[{versionId:root.id,sha256:root.sha256}]);
 const versions=new Map([root,sibling,child].map(v=>[v.id,v]));
 const domainContextHash='f'.repeat(64),invalidations=[{familyId:'root',previousHash:'d'.repeat(64),currentHash:'e'.repeat(64),versionIds:['a','b']},{familyId:'root',previousHash:'e'.repeat(64),currentHash:domainContextHash,versionIds:['a','b']}];
 const options={currentDomainHashes:new Map([['root',domainContextHash]]),reviewedDomainBindings:new Map([['a',{familyId:'root',sha256:root.sha256,domainContextHash}]])};
 return{versions,invalidations,options};
}
test('exact re-review resolves only its recorded root, preserving sibling versions and the original descendant closure',()=>{
 const f=recoveryFixture(),history=structuredClone(f.invalidations),before=structuredClone(f.versions.get('a'));
 assert.deepEqual(applyDomainInvalidations(f.invalidations,f.versions,f.options),['b','c']);
 assert.deepEqual(f.versions.get('a'),before);assert.deepEqual(f.invalidations,history);
 for(const id of ['b','c'])assert.equal(f.versions.get(id).canFlowDownstream,false);
});
for(const [name,mutate]of [
 ['wrong version SHA',f=>{f.options.reviewedDomainBindings.get('a').sha256='0'.repeat(64);}],
 ['wrong family',f=>{f.options.reviewedDomainBindings.get('a').familyId='other';}],
 ['old domain',f=>{f.options.reviewedDomainBindings.get('a').domainContextHash='e'.repeat(64);}],
 ['missing current domain',f=>{f.options.currentDomainHashes.clear();}],
 ['invalidation head differs',f=>{f.invalidations.at(-1).currentHash='0'.repeat(64);}],
 ['unresolved exact parent',f=>{f.versions.get('a').inputVersionBindings=[{versionId:'b',sha256:'b'.repeat(64)}];}],
 ['unknown input version',f=>{f.versions.get('a').inputVersionBindings=[{versionId:'missing',sha256:'b'.repeat(64)}];}],
 ['parent rights hold',f=>{f.invalidations.forEach(r=>r.versionIds=['a']);f.versions.get('b').canFlowDownstream=false;f.versions.get('b').lifecycleState='RIGHTS_HOLD';f.versions.get('a').inputVersionBindings=[{versionId:'b',sha256:'b'.repeat(64)}];}],
])test('root recovery refuses '+name,()=>{const f=recoveryFixture();mutate(f);assert.ok(applyDomainInvalidations(f.invalidations,f.versions,f.options).includes('a'));});
test('even a resolution binding cannot automatically recover an unrecorded descendant',()=>{
 const f=recoveryFixture();f.options.currentDomainHashes.set('child','f'.repeat(64));f.options.reviewedDomainBindings.set('c',{familyId:'child',sha256:'c'.repeat(64),domainContextHash:'f'.repeat(64)});
 assert.ok(applyDomainInvalidations(f.invalidations,f.versions,f.options).includes('c'));
});
