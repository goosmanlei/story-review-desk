import test from 'node:test';
import assert from 'node:assert/strict';
import {directoryProjection,refreshDirectoryProjection} from '../host/instance-runtime/directory-projection.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
function setup(){
 const representation={id:'rep',entityId:'original',stateId:'original-state'};
 const model={materialRequirements:[{id:'req',requirementHash:'hash'}],domainGraph:{entities:[{id:'original'},{id:'target'},{id:'other'}],states:[],representations:[representation],relations:[],requirements:[]}};
 const content={directoryBindings:[{requirementId:'req',requirementHash:'hash',representationId:'rep',representationHash:domainHash(representation),entityId:'target',stateId:'target-state'}],newStates:[{id:'target-state',entityId:'target'}]};
 return{model,content};
}
test('directory overlay applies only with an exact target entity/state parent',()=>{const{model,content}=setup();const result=directoryProjection(model,content);assert.equal(result.graph.representations[0].entityId,'target');assert.deepEqual(result.staleIds,[]);assert.equal(model.domainGraph.representations[0].entityId,'original');});
test('canonical state reparenting invalidates the old directory binding without rewriting canonical ownership',()=>{const{model,content}=setup();model.domainGraph.states.push({id:'target-state',entityId:'other'});const result=directoryProjection(model,content);assert.deepEqual(result.staleIds,['req']);assert.deepEqual(result.bindings,[]);assert.equal(result.graph.representations[0].entityId,'original');assert.equal(result.graph.states[0].entityId,'other');});
test('missing entity or changed requirement cannot acquire a directory mapping',()=>{for(const kind of ['entity','requirement']){const{model,content}=setup();if(kind==='entity')model.domainGraph.entities=model.domainGraph.entities.filter(e=>e.id!=='target');else model.materialRequirements[0].requirementHash='new';assert.deepEqual(directoryProjection(model,content).staleIds,['req']);}});

test('a published directory is rebuilt from the new base, never keeps an old entity value',()=>{
 const {model,content}=setup();const before=structuredClone(model);
 before.materialDirectory={...directoryProjection(model,content),revisionId:'directory-one'};
 const next=structuredClone(before);next.domainGraph.entities.find(e=>e.id==='target').description='new exact description';
 const projected=refreshDirectoryProjection(next);
 assert.equal(projected.graph.entities.find(e=>e.id==='target').description,'new exact description');
 assert.equal(projected.graph.representations.find(r=>r.id==='rep').entityId,'target');
 assert.equal(projected.projectionBasis.domainGraphHash,domainHash(next.domainGraph));
 assert.equal(before.materialDirectory.graph.entities.find(e=>e.id==='target').description,undefined);
});
test('promoted directory-only identities are replaced by their authoritative current record',()=>{
 const {model,content}=setup();model.domainGraph.entities=model.domainGraph.entities.filter(e=>e.id!=='target');
 content.newEntities=[{id:'target',description:'directory old'}];
 const before={...model,materialDirectory:{...directoryProjection(model,content),revisionId:'one'}};
 before.domainGraph.entities.push({id:'target',description:'promoted current'});
 const result=refreshDirectoryProjection(before);
 assert.equal(result.graph.entities.filter(e=>e.id==='target').length,1);
 assert.equal(result.graph.entities.find(e=>e.id==='target').description,'promoted current');
 assert.equal(result.graph.entities.find(e=>e.id==='target').directoryOnly,undefined);
});
test('rejected binding definitions survive re-projection and remain disabled until exact hash returns',()=>{
 const {model,content}=setup(),original=structuredClone(model.domainGraph.representations[0]);
 model.domainGraph.representations[0].label='changed definition';
 model.materialDirectory={...directoryProjection(model,content),revisionId:'one'};
 assert.deepEqual(model.materialDirectory.staleIds,['req']);
 const stale=refreshDirectoryProjection(model);assert.equal(stale.bindings.length,0);assert.equal(stale.staleBindings[0].requirementId,'req');
 model.domainGraph.representations[0]=original;model.materialDirectory=stale;
 const restored=refreshDirectoryProjection(model);
 assert.deepEqual(restored.staleIds,[]);assert.equal(restored.bindings[0].requirementId,'req');
});
test('legacy stale IDs without source rows stay blocked until actual auxiliary data is supplied',()=>{
 const {model,content}=setup();model.materialDirectory={...directoryProjection(model,content),bindings:[],staleIds:['req'],revisionId:'one'};
 delete model.materialDirectory.staleBindings;
 assert.deepEqual(refreshDirectoryProjection(model).staleIds,['req']);
 assert.deepEqual(refreshDirectoryProjection(model,{content,revisionId:'one',sha256:'digest'}).staleIds,[]);
});
test('canonical entity deletion is not undone by copying an old directory graph',()=>{
 const {model,content}=setup();model.materialDirectory={...directoryProjection(model,content),revisionId:'one'};
 model.domainGraph.entities=model.domainGraph.entities.filter(e=>e.id!=='target');
 const next=refreshDirectoryProjection(model);assert.ok(!next.graph.entities.some(e=>e.id==='target'));assert.deepEqual(next.staleIds,['req']);
});
test('new native requirements and representations are included without a fabricated directory override',()=>{
 const {model,content}=setup();model.materialDirectory={...directoryProjection(model,content),revisionId:'one'};
 model.domainGraph.entities.push({id:'new-person',description:'current'});
 model.domainGraph.states.push({id:'new-state',entityId:'new-person'});
 model.domainGraph.representations.push({id:'new-rep',entityId:'new-person',stateId:'new-state'});
 model.domainGraph.requirements.push({id:'new-demand',representationId:'new-rep'});
 model.materialRequirements.push({id:'new-demand',requirementClass:'REQUIRED',requirementHash:'native-hash',representationRef:'new-rep'});
 const next=refreshDirectoryProjection(model);
 assert.equal(next.graph.requirements.find(r=>r.id==='new-demand').representationId,'new-rep');
 assert.equal(next.graph.entities.find(r=>r.id==='new-person').description,'current');
 assert.ok(!next.bindings.some(r=>r.requirementId==='new-demand'),'directory adoption is explicit, not guessed');
});
test('requirements that become evidence-only cannot keep a current directory binding',()=>{
 const {model,content}=setup();model.materialRequirements[0].requirementClass='EVIDENCE_ONLY';
 const next=directoryProjection(model,content);assert.deepEqual(next.staleIds,['req']);assert.equal(next.staleBindings.length,1);
});
