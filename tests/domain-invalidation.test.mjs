import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDomainInvalidations} from '../host/instance-runtime/domain-invalidation.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {buildDomainProductionCompatibilityIndex,domainCompatibilityExceptions} from '../host/instance-runtime/domain-production-compatibility.mjs';
import {makeCompatibilityFixture,copy} from './fixtures/domain-production-compatibility.mjs';
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
test('a previously directly invalidated child keeps its ancestor invalidation after only the parent is re-reviewed',()=>{
 const f=recoveryFixture(),hash='f'.repeat(64);
 f.invalidations.unshift({familyId:'child',previousHash:'d'.repeat(64),currentHash:hash,versionIds:['c']});
 f.options.currentDomainHashes.set('child',hash);f.options.reviewedDomainBindings.set('c',{familyId:'child',sha256:'c'.repeat(64),domainContextHash:hash});
 const stale=applyDomainInvalidations(f.invalidations,f.versions,f.options);
 assert.ok(!stale.includes('a'));assert.ok(stale.includes('c'));assert.equal(f.versions.get('a').canFlowDownstream,true);assert.equal(f.versions.get('c').canFlowDownstream,false);
});

function compatibilityFixture(options){
 const f=makeCompatibilityFixture(options);f.invalidations=f.model.domainInvalidations;
 f.applyOptions={currentDomainHashes:new Map(f.model.assetFamilies.map(r=>[r.id,r.domainContext.hash])),compatibilityExceptions:domainCompatibilityExceptions(buildDomainProductionCompatibilityIndex(f.model,f.options))};return f;
}
test('exact compatibility removes only the covered original version occurrences and does not modify history or base usability',()=>{
 const f=compatibilityFixture(),before=copy(f.versions),history=copy(f.invalidations),record=copy(f.record);
 assert.deepEqual(applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions),[]);
 assert.deepEqual(f.versions,before);assert.deepEqual(f.invalidations,history);assert.deepEqual(f.record,record);
});
test('a root-only compatible confirmation never releases its unlisted old child or same-family sibling',()=>{
 const f=compatibilityFixture({includeChild:false}),sibling={...copy(f.versions.get('version:root')),id:'version:sibling'};
 f.versions.set(sibling.id,sibling);f.invalidations[0].versionIds.push(sibling.id);
 // Reflect the host-confirmed precise occurrence while retaining root-only coverage.
 f.applyOptions.compatibilityExceptions.get('version:root').occurrenceHashes.set(0,domainHash(f.invalidations[0]));
 const held=applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions);
 assert.deepEqual(new Set(held),new Set(['version:sibling','version:child']));assert.equal(f.versions.get('version:root').canFlowDownstream,true);
});
test('a compatibility-only Review alias is never a fresh producer recovery barrier',()=>{
 const f=compatibilityFixture({includeChild:false}),root=f.versions.get('version:root'),child=f.versions.get('version:child');
 f.applyOptions.reviewedDomainBindings=new Map([[root.id,{familyId:root.familyId,sha256:root.sha256,domainContextHash:f.applyOptions.currentDomainHashes.get(root.familyId),reviewEventId:'original:review',reviewEventSequence:5,compatibilityOnly:true}]]);
 f.applyOptions.freshProductionProofs=new Map([[child.id,{authorizedSequence:10,submittedSequence:12,candidateSequence:14,inputs:copy(child.inputVersionBindings)}]]);
 assert.deepEqual(applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions),[child.id]);assert.equal(root.canFlowDownstream,true);assert.equal(child.canFlowDownstream,false);
});
for(const [name,mutate] of [
 ['wrong root SHA',f=>{f.applyOptions.compatibilityExceptions.get('version:root').sha256='0'.repeat(64);}],
 ['wrong root family',f=>{f.applyOptions.compatibilityExceptions.get('version:root').familyId='other';}],
 ['wrong root local hash',f=>{f.applyOptions.compatibilityExceptions.get('version:root').domainContextHash='0'.repeat(64);}],
 ['wrong occurrence hash',f=>{f.applyOptions.compatibilityExceptions.get('version:root').occurrenceHashes.set(0,'0'.repeat(64));}],
 ['missing inherited occurrence',f=>{f.applyOptions.compatibilityExceptions.get('version:child').occurrenceHashes.clear();}],
 ['changed child input',f=>{f.applyOptions.compatibilityExceptions.get('version:child').inputBindings[0].sha256='0'.repeat(64);}],
 ['new same-hash occurrence',f=>{f.invalidations.push(copy(f.invalidations[0]));}],
 ['missing exact parent',f=>{f.versions.delete('version:root');}],
])test('compatibility keeps the child held with '+name,()=>{
 const f=compatibilityFixture();mutate(f);
 if(!f.versions.has('version:root'))f.invalidations.push({familyId:'family:child',versionIds:['version:child']});
 assert.ok(applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions).includes('version:child'));
});
test('own direct and inherited invalidations both require exact occurrence coverage',()=>{
 const f=compatibilityFixture(),child=f.versions.get('version:child'),direct={familyId:child.familyId,previousHash:'f'.repeat(64),currentHash:f.applyOptions.currentDomainHashes.get(child.familyId),versionIds:[child.id]};
 f.invalidations.push(direct);assert.ok(applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions).includes(child.id));
 const full=compatibilityFixture();full.invalidations.push(direct);full.applyOptions.compatibilityExceptions.get(child.id).occurrenceHashes.set(1,domainHash(direct));
 assert.deepEqual(applyDomainInvalidations(full.invalidations,full.versions,full.applyOptions),[]);
});
test('every changed parent of a multi-input original child needs its own exact compatible closure',()=>{
 const f=compatibilityFixture(),root=copy(f.versions.get('version:root')),child=f.versions.get('version:child');
 root.id='version:other';root.familyId='family:other';root.sha256='9'.repeat(64);f.versions.set(root.id,root);
 const input={familyId:root.familyId,versionId:root.id,sha256:root.sha256};child.inputVersionBindings.push(input);f.applyOptions.compatibilityExceptions.get(child.id).inputBindings.push(copy(input));
 f.invalidations.push({familyId:root.familyId,previousHash:'8'.repeat(64),currentHash:'7'.repeat(64),versionIds:[root.id]});
 f.applyOptions.compatibilityExceptions.get(child.id).occurrenceHashes.set(1,domainHash(f.invalidations[1]));
 assert.ok(applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions).includes(child.id));
});
for(const state of ['RIGHTS_HOLD','DO_NOT_USE','REVIEW_PENDING'])test('compatibility preserves '+state+' and cannot manufacture downstream eligibility',()=>{
 const f=compatibilityFixture(),root=f.versions.get('version:root');root.lifecycleState=state;root.canFlowDownstream=false;root.flowBlockReasons=['existing-independent-gate'];const before=copy(root);
 const held=applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions);assert.deepEqual(root,before);assert.ok(held.includes('version:child'));assert.equal(f.versions.get('version:child').canFlowDownstream,false);
});
test('a covered candidate remains pending without manufacturing a formal Review',()=>{
 const f=compatibilityFixture(),child=f.versions.get('version:child');child.lifecycleState='REVIEW_PENDING';child.canFlowDownstream=false;child.reviewDecision=null;const before=copy(child);
 assert.deepEqual(applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions),[]);assert.deepEqual(child,before);
});
test('cycles cannot acquire a compatible root through mutual references',()=>{
 const f=compatibilityFixture(),root=f.versions.get('version:root'),child=f.versions.get('version:child');
 root.inputVersionBindings=[{familyId:child.familyId,versionId:child.id,sha256:child.sha256}];f.applyOptions.compatibilityExceptions.get(root.id).inputBindings=copy(root.inputVersionBindings);
 assert.deepEqual(new Set(applyDomainInvalidations(f.invalidations,f.versions,f.applyOptions)),new Set([root.id,child.id]));
});
