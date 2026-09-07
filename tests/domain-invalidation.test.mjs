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
