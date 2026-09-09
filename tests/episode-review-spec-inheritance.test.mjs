import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfiguration,configHash} from '../host/instance-runtime/configuration-model.mjs';
import {episodeCandidateConfiguration,assertEpisodeReviewSpecInheritance} from '../host/instance-runtime/episode-review-spec-inheritance.mjs';
function fixture(){
 const config=defaultConfiguration(),model={systemConfiguration:{config}},common={subjectId:'plan:letters',criteriaVersion:'2.0'};
 const first=episodeCandidateConfiguration({model,events:[],...common,creativeRevisionId:'cr:first'});
 const parent={eventId:'event:first',eventKind:'creative-revision',eventSequence:1,subjectKind:'EPISODE_PLAN',creativeRevisionId:'cr:first',...common,...first};
 const events=[parent];const next=()=>episodeCandidateConfiguration({model,events,...common,creativeRevisionId:'cr:next'});
 const event=()=>({eventId:'event:next',eventKind:'creative-revision',eventSequence:2,subjectKind:'EPISODE_PLAN',creativeRevisionId:'cr:next',...common,...next()});
 return {model,events,parent,next,event,common};
}
const rehash=spec=>{delete spec.hash;spec.hash=configHash(spec);};
test('same subject retains whole frozen spec and all old configuration fields despite unrelated new defaults',()=>{
 const f=fixture(),old=structuredClone(f.parent);f.model.systemConfiguration.config.technical.delivery.platform='new platform';f.model.systemConfiguration.config.workflow.earlyAmbience=!f.model.systemConfiguration.config.workflow.earlyAmbience;
 const e=f.event();assert.deepEqual(e.reviewSpec,old.reviewSpec);assert.deepEqual(e.configurationBinding,{...old.configurationBinding,key:'candidate:cr:next',createdBy:'EPISODE_REVIEW_SPEC_INHERITANCE_V1'});assert.deepEqual(f.parent,old);assertEpisodeReviewSpecInheritance({event:e,model:f.model,events:[e,...f.events]});
 const fresh=episodeCandidateConfiguration({model:f.model,events:f.events,subjectId:'plan:other',creativeRevisionId:'cr:new',criteriaVersion:'2.0'});assert.notEqual(fresh.reviewSpec.hash,e.reviewSpec.hash);assert.equal(fresh.reviewSpecInheritance,undefined);
});
for(const field of ['question','label','required','allowNA','noteRequiredOnFail'])test('true criterion '+field+' change requires explicit upgrade',()=>{const f=fixture(),c=f.model.systemConfiguration.config.reviewProfiles.find(p=>p.id==='episode-plan').criteria[0];c[field]=typeof c[field]==='boolean'?!c[field]:'changed';assert.throws(f.next,/标准升级/);});
for(const field of ['firstQuestion','lastQuestion'])test('true '+field+' change requires explicit upgrade',()=>{const f=fixture();f.model.systemConfiguration.config.reviewProfiles.find(p=>p.id==='episode-plan')[field]='changed';assert.throws(f.next,/标准升级/);});
test('latest unreviewed successor, rather than earlier approved candidate, owns the frozen standard',()=>{const f=fixture(),second={...structuredClone(f.parent),eventId:'second',eventSequence:2,creativeRevisionId:'cr:second'};second.configurationBinding.key='candidate:cr:second';f.events.push(second);assert.equal(f.next().reviewSpecInheritance.parentEventId,'second');});
test('effective published binding supersedes the immutable original spec only with exactly matching current semantics',()=>{const f=fixture(),config=f.model.systemConfiguration.config;config.reviewProfiles.find(p=>p.id==='episode-plan').criteria[0].question='explicitly upgraded';const effective=episodeCandidateConfiguration({model:f.model,events:[],...f.common,creativeRevisionId:f.parent.creativeRevisionId});f.model.configurationCandidates=[{id:f.parent.creativeRevisionId,...effective}];assert.deepEqual(f.next().reviewSpec,effective.reviewSpec);assert.notEqual(f.next().reviewSpec.hash,f.parent.reviewSpec.hash);});
const faults={
 'missing original spec':f=>{delete f.parent.reviewSpec;},
 'missing complete binding':f=>{delete f.parent.configurationBinding;},
 'wrong binding key':f=>{f.parent.configurationBinding.key='candidate:foreign';},
 'different effective spec':f=>{f.parent.configurationBinding.reviewSpec={};},
 'wrong self hash':f=>{f.parent.reviewSpec.hash='0'.repeat(64);},
 'missing semantic flag':f=>{delete f.parent.reviewSpec.criteria[0].required;rehash(f.parent.reviewSpec);},
 'unknown semantic field':f=>{f.parent.reviewSpec.reviewRule='new';rehash(f.parent.reviewSpec);},
 'missing actual sequence':f=>{delete f.parent.eventSequence;},
 'duplicate sequence':f=>{f.events.push({...f.parent,eventId:'duplicate'});},
 'mixed criteria contract':f=>{f.parent.criteriaVersion='1.0';},
 'duplicate projected head':f=>{f.model.configurationCandidates=[{id:f.parent.creativeRevisionId},{id:f.parent.creativeRevisionId}];},
};
for(const [name,mutate]of Object.entries(faults))test(name+' fails closed',()=>{const f=fixture();mutate(f);assert.throws(f.next);});
for(const [name,mutate] of Object.entries({
 'stripped marker':(_f,e)=>{delete e.reviewSpecInheritance;},'missing parent':f=>{f.events=[];},'newer parent':f=>{f.events.push({...structuredClone(f.parent),eventId:'later',eventSequence:2});},'edited parent':f=>{f.parent.note='changed';},
 'unknown protocol':(_f,e)=>{e.reviewSpecInheritance.schemaVersion='NEXT';},'null marker':(_f,e)=>{e.reviewSpecInheritance=null;},'wrong source hash':(_f,e)=>{e.reviewSpecInheritance.parentEventSha256='0'.repeat(64);},'changed frozen spec':(_f,e)=>{e.reviewSpec.criteria[0].question='changed';rehash(e.reviewSpec);},'changed technical binding':(_f,e)=>{e.configurationBinding.technical.delivery.platform='changed';}
}))test('history '+name+' rejects exact reconstructed inheritance',()=>{const f=fixture(),e={...f.event(),eventSequence:3};mutate(f,e);assert.throws(()=>assertEpisodeReviewSpecInheritance({event:e,model:f.model,events:f.events}));});
test('old events lacking new marker remain byte-identical and are not reinterpreted',()=>{const event={eventKind:'creative-revision',schemaVersion:'2.0',reviewSpec:{old:'legacy'}};const before=JSON.stringify(event);assertEpisodeReviewSpecInheritance({event,model:{},events:[]});assert.equal(JSON.stringify(event),before);});
