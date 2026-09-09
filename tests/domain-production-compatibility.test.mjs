import test from 'node:test';
import assert from 'node:assert/strict';
import {domainHash,validateDomainGraph,defaultDomainConfiguration} from '../host/instance-runtime/domain-model.mjs';
import {domainProductionSlice,projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {executionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {applyDomainInvalidations} from '../host/instance-runtime/domain-invalidation.mjs';
import {classifyDomainProductionCompatibility as classify,validateDomainProductionCompatibilityRecord as validate,buildDomainProductionCompatibilityIndex as index,domainCompatibilityExceptions,findCompatibleRequirementBinding as current,findHistoricalCompatibleRequirementBinding as historical,findCompatibleReviewBinding as review} from '../host/instance-runtime/domain-production-compatibility.mjs';
import {makeCompatibilityFixture as fixture,copy,sealCompatibility as seal} from './fixtures/domain-production-compatibility.mjs';
const classifyFixture=f=>classify(f.record.beforeSlice,f.record.afterSlice,{metadataApprovals:f.record.metadataApprovals});
const inspect=f=>validate(f.record,{...f.options,model:f.model});
const rootId='version:root',childId='version:child';

test('precise metadata approval accepts only the authorized original entity record pair without mutation',()=>{
 const f=fixture(),before=JSON.stringify(f);assert.equal(classifyFixture(f).kind,'REVIEWED_NARRATIVE_METADATA_ONLY');
 assert.equal(inspect(f).currentVersionBindings.length,2);assert.equal(JSON.stringify(f),before);
 assert.equal(index(f.model,f.options).byVersion.size,2);assert.equal(domainCompatibilityExceptions(index(f.model,f.options)).size,2);
});
for(const [name,mutate] of [
 ['missing explicit approval',f=>{f.record.metadataApprovals=[];}],
 ['unconfirmed approval',f=>{f.record.metadataApprovals[0].confirmed=false;}],
 ['wrong original entity hash',f=>{f.record.metadataApprovals[0].beforeRecordHash='0'.repeat(64);}],
 ['missing authorization source',f=>{delete f.record.metadataApprovals[0].authorizationRef;}],
 ['wider authorization scope',f=>{f.record.metadataApprovals[0].scope='ALL_DESCRIPTION_CHANGES';}],
 ['changed character identity',f=>{f.record.afterSlice.entities[1].name='new identity';}],
 ['changed representation dimensions',f=>{f.record.afterSlice.representations[0].dimensions.appearance='new physical shape';}],
 ['changed state dimensions',f=>{f.record.afterSlice.states[0].dimensions.appearance='new physical shape';}],
 ['changed production relation',f=>{f.record.afterSlice.relations.push({id:'new-relation'});}],
 ['changed reference policy',f=>{f.record.afterSlice.referencePolicies.push({relationId:'new-relation',policy:'NEW'});}],
 ['changed representation policy',f=>{f.record.afterSlice.representationPolicies.push({representationId:'rep:root',policy:'NEW'});}],
 ['removed entity',f=>{f.record.afterSlice.entities.pop();}],
 ['reordered entities',f=>{f.record.afterSlice.entities.reverse();}],
 ['extra slice field',f=>{f.record.afterSlice.extra=[];}],
 ['unused metadata approval',f=>{f.record.afterSlice.entities[0]=copy(f.record.beforeSlice.entities[0]);}],
])test('classification refuses '+name,()=>{const f=fixture();mutate(f);assert.equal(classifyFixture(f).compatible,false);seal(f.record);assert.equal(inspect(f),null);});

test('nonempty original state and demand scopes may append precise new scopes with new evidence',()=>{
 const f=fixture({scopeExtension:true});assert.equal(classifyFixture(f).kind,'SCOPE_EXTENSION');assert.equal(inspect(f).currentRequirementBindings.length,1);assert.equal(current(f.model,f.query).eligibility,'CURRENT');
});
for(const [name,mutate] of [
 ['empty means unrestricted, not first scoped permission',f=>{f.record.beforeSlice.requirements[0].scope=[];}],
 ['removed old scope',f=>{f.record.afterSlice.requirements[0].scope.shift();}],
 ['changed old scene revision',f=>{f.record.afterSlice.requirements[0].scope[0].revisionId='another';}],
 ['duplicate scene identity at another revision',f=>{f.record.afterSlice.requirements[0].scope[1].scopeId='scene:old';}],
 ['reordered original scope',f=>{f.record.afterSlice.requirements[0].scope.reverse();}],
 ['changed acceptance',f=>{f.record.afterSlice.requirements[0].acceptanceCriteria=['new production condition'];}],
 ['changed reuse mode',f=>{f.record.afterSlice.requirements[0].reuseScope='PROJECT';}],
 ['no new evidence',f=>{f.record.afterSlice.requirements[0].evidence.pop();}],
 ['old evidence changed',f=>{f.record.afterSlice.requirements[0].evidence[0].quote='new claim';}],
 ['evidence append without scope append',f=>{f.record.afterSlice.requirements[0].scope.pop();}],
 ['scope lacking exact revision',f=>{delete f.record.afterSlice.requirements[0].scope[1].revisionId;}],
 ['evidence lacking source SHA',f=>{delete f.record.afterSlice.requirements[0].evidence[1].sha256;}],
 ['scope evidence appended to a representation instead',f=>{f.record.afterSlice.representations[0].scope=[{scopeType:'PROJECT',scopeId:'project'}];}],
])test('scope proof refuses '+name,()=>{const f=fixture({scopeExtension:true});mutate(f);assert.equal(classifyFixture(f).compatible,false);});

test('empty occurrence sets support a demand-only native bridge and never create version or Review exemptions',()=>{
 const f=fixture({scopeExtension:true,requirementOnly:true}),x=index(f.model,f.options);
 assert.equal(x.byRequirement.size,1);assert.equal(x.byVersion.size,0);assert.equal(domainCompatibilityExceptions(x).size,0);assert.equal(current(f.model,f.query).links.length,1);
});
test('restore epoch retains business evidence; new mutations explicitly fail on a different epoch',()=>{
 const f=fixture();assert.ok(validate(f.record,{...f.options,model:f.model,runtimeEpoch:'restored'}));
 assert.equal(validate(f.record,{...f.options,model:f.model,runtimeEpoch:'restored',requireCurrentEpoch:true}),null);
 assert.equal(validate(f.record,{...f.options,model:f.model,instanceId:'other'}),null);
});
for(const [name,mutate] of [
 ['tampered hash',f=>{f.record.approval.reason+='changed';}],
 ['unknown record field',f=>{f.record.allowAll=true;seal(f.record);}],
 ['wrong occurrence bytes',f=>{f.record.occurrences[0].hash='0'.repeat(64);seal(f.record);}],
 ['wrong occurrence family',f=>{f.record.occurrences[0].familyId='other';seal(f.record);}],
 ['missing occurrence',f=>{f.model.domainInvalidations=[];}],
 ['duplicate occurrence',f=>{f.record.occurrences.push(copy(f.record.occurrences[0]));seal(f.record);}],
 ['unbound occurrence index',f=>{f.record.versionBindings[0].occurrenceIndexes=[9];seal(f.record);}],
 ['missing version domain hash',f=>{delete f.record.versionBindings[0].domainContextHash;seal(f.record);}],
 ['partial review identity',f=>{delete f.record.versionBindings[0].reviewEventHash;seal(f.record);}],
 ['partial execution identity',f=>{f.record.versionBindings[0].executionDefinitionId='def';seal(f.record);}],
 ['self-referential input',f=>{f.record.versionBindings[0].inputBindings=[{familyId:'family:root',versionId:rootId,sha256:'a'.repeat(64)}];seal(f.record);}],
])test('record validation fails closed on '+name,()=>{const f=fixture();mutate(f);assert.equal(inspect(f),null);});

for(const [name,mutate] of [
 ['wrong version map identity',f=>{f.versions.get(rootId).id='different-version';}],
 ['different media SHA',f=>{f.versions.get(rootId).sha256='0'.repeat(64);}],
 ['different family',f=>{f.versions.get(rootId).familyId='other';}],
 ['different actual input set',f=>{f.versions.get(rootId).inputVersionBindings=[{familyId:'family:child',versionId:childId,sha256:'b'.repeat(64)}];}],
 ['changed current local production condition',f=>{f.model.domainGraph.states[0].dimensions.appearance='new';}],
 ['changed current demand',f=>{f.model.domainGraph.requirements[0].acceptanceCriteria.push('new');}],
 ['changed current local policy',f=>{f.model.domainRepresentationPolicyBindings['rep:root']={referenceRole:'NEW'};}],
 ['new A-B-A occurrence even at the same current hash',f=>{const old=copy(f.model.domainInvalidations[0]);f.model.domainInvalidations.push({...old,previousHash:old.currentHash,currentHash:'0'.repeat(64)},{...old,previousHash:'0'.repeat(64)});}],
])test('precise current version lookup rejects '+name,()=>{const f=fixture();mutate(f);assert.ok(inspect(f));assert.equal(index(f.model,f.options).byVersion.has(rootId),false);});

test('modern version definition verification uses only explicit authoritative definitions and a unique exact hash',()=>{
 const f=fixture(),b=f.record.versionBindings[0],definition={id:'definition:root',prompt:{main:'fixed'},output:{assetFamilyRef:'family:root'}};definition.definitionHash=executionDefinitionHash(definition);
 b.executionDefinitionId=definition.id;b.executionDefinitionHash=definition.definitionHash;f.versions.get(rootId).executionDefinitionRef=b.executionDefinitionId;seal(f.record);
 f.model.executionDefinitions=[definition];
 assert.equal(index(f.model,f.options).byVersion.has(rootId),false);
 f.options.executionDefinitions=copy(f.model.executionDefinitions);assert.equal(index(f.model,f.options).byVersion.has(rootId),true);
 f.options.executionDefinitions.push(copy(f.options.executionDefinitions[0]));assert.equal(index(f.model,f.options).byVersion.has(rootId),false);
 f.options.executionDefinitions=[{id:b.executionDefinitionId,definitionHash:'f'.repeat(64)}];assert.equal(index(f.model,f.options).byVersion.has(rootId),false);
 f.options.executionDefinitions=[{...definition,prompt:{main:'silently changed'}}];assert.equal(index(f.model,f.options).byVersion.has(rootId),false);
 f.options.executionDefinitions=[definition];delete b.executionDefinitionId;delete b.executionDefinitionHash;seal(f.record);assert.equal(index(f.model,f.options).byVersion.has(rootId),false);
});
test('review aliases require exact event ID, event hash, old context, family and original bytes',()=>{
 const f=fixture(),b=f.record.versionBindings[0],q={familyId:b.familyId,versionId:b.versionId,sha256:b.sha256,reviewEventId:b.reviewEventId,reviewContextHash:b.reviewContextHash,reviewEventHash:b.reviewEventHash},x=index(f.model,f.options);
 assert.equal(review(x,q).eligibility,'CURRENT');
 for(const key of Object.keys(q))assert.equal(review(x,{...q,[key]:'wrong'}),null,key);
 assert.equal(review(index(f.model,{instanceId:f.model.instanceId}),q),null);
});

function chainFixture(){
 const f=fixture({scopeExtension:true,requirementOnly:true}),second=copy(f.record),last=f.afterGraph.requirements[0];
 second.compatibilityId='compatibility:two';second.beforeGraphRef=copy(second.afterGraphRef);second.beforeSlice=copy(second.afterSlice);
 last.scope.push({scopeType:'SCENE',scopeId:'scene:third',revisionId:'scene-revision:third'});last.evidence.push({sourceId:'source:third',revisionId:'document:third',sha256:'3'.repeat(64)});
 second.afterGraphRef={revisionId:'graph:third',sha256:domainHash(f.afterGraph)};second.afterSlice=copy(domainProductionSlice(f.afterGraph,['rep:root','rep:child']));
 const b=second.requirementBindings[0];b.beforeHash=b.afterHash;b.beforeDemand=copy(b.afterDemand);b.afterDemand=copy(last);b.afterHash=domainHash({demand:last,representation:f.afterGraph.representations[0]});
 f.model.materialRequirements[0].requirementHash=b.afterHash;seal(second);f.model.domainProductionCompatibilities.push(second);
 return {f,second};
}
test('a unique 0-to-1-to-2 demand chain preserves exact links and reads 0-to-1 history after current 2',()=>{
 const {f,second}=chainFixture(),q={...f.query,afterHash:second.requirementBindings[0].afterHash},bridge=current(f.model,q);
 assert.equal(bridge.links.length,2);assert.equal(bridge.beforeHash,f.query.beforeHash);assert.deepEqual(bridge.beforeDemand,f.record.requirementBindings[0].beforeDemand);
 assert.equal(historical(f.model,f.query).eligibility,'HISTORICAL_ONLY');assert.equal(current(f.model,f.query),null);
 f.model.domainGraph.requirements[0].acceptanceCriteria.push('real change');assert.equal(current(f.model,q),null);assert.ok(historical(f.model,f.query));
});
test('immutable recipe link selectors remain precise even when another valid record repeats the same transition',()=>{
 const f=fixture({scopeExtension:true,requirementOnly:true}),duplicate=copy(f.record);duplicate.compatibilityId='compatibility:duplicate';seal(duplicate);f.model.domainProductionCompatibilities.push(duplicate);
 assert.equal(current(f.model,f.query),null);assert.equal(historical(f.model,f.query),null);
 const q={...f.query,compatibilityId:f.record.compatibilityId,proofHash:f.record.proofHash};assert.ok(historical(f.model,q));
 assert.equal(historical(f.model,{...q,proofHash:duplicate.proofHash}),null);assert.equal(current(f.model,q),null);
});
test('broken native demand or representation bytes cannot be repaired by recomputing a proof hash',()=>{
 for(const key of ['beforeDemand','afterDemand']){const f=fixture({scopeExtension:true,requirementOnly:true});f.record.requirementBindings[0][key].acceptanceCriteria=['fake'];seal(f.record);assert.equal(inspect(f),null);}
 const f=fixture({scopeExtension:true,requirementOnly:true});f.record.requirementBindings[0].representationHash='0'.repeat(64);seal(f.record);assert.equal(inspect(f),null);
});
test('duplicate compatibility identities fail closed rather than choosing file order',()=>{
 const f=fixture();f.model.domainProductionCompatibilities.push(copy(f.record));assert.equal(index(f.model,f.options).records.length,0);
});

function kinshipFixture(){
 const configuration=defaultDomainConfiguration(),evidence={sourceId:'source:kinship',revisionId:'revision:kinship',sha256:'1'.repeat(64),quote:'explicit kinship'};
 const graph=validateDomainGraph({schemaVersion:'1.0',entities:['parent','child'].map(id=>({id,type:'CHARACTER',name:id,aliases:[],description:'original',authority:'A',evidence:[]})),states:[],
  representations:['parent','child'].map(id=>({id:'rep:'+id,entityId:id,stateId:null,type:'IDENTITY',label:id,dimensions:{age:'adult'},assetFamilyIds:['family:'+id],requirementIds:[],authority:'A',evidence:[]})),requirements:[],
  relations:[
   {id:'kinship',type:'KINSHIP',from:{kind:'ENTITY',id:'parent'},to:{kind:'ENTITY',id:'child'},label:'kinship',purpose:'story',inherit:[],exclude:[],scope:[],authority:'A',evidence:[copy(evidence)],status:'CONFIRMED'},
   {id:'reference',type:'FAMILY_RESEMBLANCE',from:{kind:'REPRESENTATION',id:'rep:parent'},to:{kind:'REPRESENTATION',id:'rep:child'},label:'family resemblance',purpose:'family-resemblance',referencePolicyId:'LIMITED_KINSHIP',inherit:['family-resemblance'],exclude:['identity'],scope:[],authority:'A',evidence:[copy(evidence)],status:'CONFIRMED'},
  ]});
 const versions=new Map(['parent','child'].map((id,i)=>{const v={id:'version:'+id,familyId:'family:'+id,sha256:(i?'b':'a').repeat(64),lifecycleState:'RELEASED',canFlowDownstream:true,inputVersionBindings:i?[{familyId:'family:parent',versionId:'version:parent',sha256:'a'.repeat(64)}]:[]};return[v.id,v];}));
 const raw={productionModel:{systemConfiguration:{config:{domain:configuration}},assetFamilies:['parent','child'].map(id=>({id:'family:'+id})),assetVersions:copy([...versions.values()]),materialRequirements:[]}};
 const before=projectDomainGraph(raw,graph,{revisionId:'graph:before',sha256:domainHash(graph)}),next=copy(graph);next.entities[1].description='corrected narrative only';validateDomainGraph(next);
 const after=projectDomainGraph(before,next,{revisionId:'graph:after',sha256:domainHash(next)}),model=after.productionModel;
 const slice=m=>copy(domainProductionSlice(m.domainGraph,['rep:child'],{referencePolicies:m.domainReferencePolicyBindings,representationPolicies:m.domainRepresentationPolicyBindings,configuration}));
 const record=seal({schemaVersion:'DOMAIN_PRODUCTION_COMPATIBILITY_V1',compatibilityId:'compatibility:kinship',instanceId:'instance:kinship',runtimeEpoch:'epoch:original',beforeGraphRef:before.productionModel.domainGraphRef,afterGraphRef:model.domainGraphRef,beforeSlice:slice(before.productionModel),afterSlice:slice(model),
  metadataApprovals:[{entityId:'child',beforeRecordHash:domainHash(graph.entities[1]),afterRecordHash:domainHash(next.entities[1]),confirmed:true,reason:'exact approved narrative-only clarification',authorizationRef:'authorized',scope:'NARRATIVE_DESCRIPTION_ONLY'}],
  occurrences:model.domainInvalidations.map((o,index)=>({index,hash:domainHash(o),familyId:o.familyId,previousHash:o.previousHash,currentHash:o.currentHash})),requirementBindings:[],
  versionBindings:[{familyId:'family:child',versionId:'version:child',sha256:'b'.repeat(64),domainContextHash:model.assetFamilies[1].domainContext.hash,occurrenceIndexes:[0],inputBindings:copy(versions.get('version:child').inputVersionBindings)}],approval:{confirmed:true,reason:'same production semantics'}});
 model.domainProductionCompatibilities=[record];return{after,model,record,versions,options:{instanceId:record.instanceId,versions}};
}
function heldKinship(f){return applyDomainInvalidations(f.model.domainInvalidations,f.versions,{currentDomainHashes:new Map(f.model.assetFamilies.map(r=>[r.id,r.domainContext.hash])),compatibilityExceptions:domainCompatibilityExceptions(index(f.model,f.options))});}
test('a valid KINSHIP production dependency survives local selection without reclassification on an incomplete graph',()=>{
 const f=kinshipFixture();assert.deepEqual(f.record.afterSlice.representations.map(r=>r.id),['rep:child']);assert.deepEqual(f.record.afterSlice.relations.map(r=>r.id),['kinship','reference']);
 assert.equal(inspect(f).currentVersionBindings.length,1);assert.deepEqual(heldKinship(f),[]);assert.equal(f.versions.get('version:child').canFlowDownstream,true);
});
test('a later actual parent appearance change still blocks the compatible child through its full input occurrence closure',()=>{
 const f=kinshipFixture(),next=copy(f.model.domainGraph);next.representations[0].dimensions.age='elderly appearance';validateDomainGraph(next);
 f.model=projectDomainGraph(f.after,next,{revisionId:'graph:parent-appearance',sha256:domainHash(next)}).productionModel;
 assert.ok(f.model.domainInvalidations.some(r=>r.familyId==='family:parent'));assert.ok(heldKinship(f).includes('version:child'));assert.equal(f.versions.get('version:child').canFlowDownstream,false);
});
for(const [name,mutate]of [
 ['actual relationship evidence',f=>{f.model.domainGraph.relations[0].evidence[0].quote='changed kinship evidence';}],
 ['actual relation policy',f=>{f.model.domainReferencePolicyBindings.reference.maxDerivedGenerations=0;}],
 ['representation master policy',f=>{f.model.domainRepresentationPolicyBindings['rep:child'].maxDerivedGenerations=0;}],
])test('preclassified expected relations still reject '+name,()=>{
 const f=kinshipFixture();mutate(f);validateDomainGraph(f.model.domainGraph);
 assert.equal(inspect(f).currentVersionBindings.length,0);assert.ok(heldKinship(f).includes('version:child'));
});
