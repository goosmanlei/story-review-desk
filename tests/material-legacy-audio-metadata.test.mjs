import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyAudioMasterBasis,legacyAudioMasterMetadata,assertLegacyAudioMasterMetadata,LEGACY_AUDIO_METADATA_SCHEMA} from '../host/instance-runtime/material-legacy-audio-metadata.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {executionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';

function fixture(){
 const entity={id:'character:fixture',type:'CHARACTER',name:'测试角色',description:'Original fictional identity.'};
 const representation={id:'representation:fixture',entityId:entity.id,type:'VOICE_IDENTITY',assetFamilyIds:['VOICE-FIXTURE'],requirementIds:['requirement:fixture']};
 const metadata={SUBJECT_ID:entity.id,VOICE_ID:'VOICE-IDENTITY-FIXTURE',PIPELINE_STAGE:'P06',SCENE:'S-OLD',TEST_LINE_ID:'S-OLD-L01',SCENE_SCOPE:'OLD_BATCH',SCRIPT_VERSION:'old script'};
 const sources=[{documentId:'source:fixture',revisionId:'revision:fixture',path:'fixture/voice.json',sha256:'a'.repeat(64)}];
 const requirement={id:'requirement:fixture',requirementHash:'b'.repeat(64),reuseScope:'SHOT_SET',sceneIds:['S-OLD'],episodeUids:['EP-OLD']};
 const previousDefinition={id:'CALL:OLD',definitionHash:'c'.repeat(64)},basis={requirementId:requirement.id,requirementHash:requirement.requirementHash,requirement,representation,revision:{familyId:'VOICE-FIXTURE',definitionId:previousDefinition.id,definitionHash:previousDefinition.definitionHash,parentVersionId:'VOICE-FIXTURE@V001',parentVersionSha256:'d'.repeat(64),sourceBindings:sources},voiceMasterMetadata:legacyAudioMasterBasis({graph:{entities:[entity]},representation,origin:{asset:{metadata}}})};
 const output={id:'EO:fixture-v2',familyId:'VOICE-FIXTURE',targetPath:'production/generated/05_audio/FIXTURE_V002.wav',plannedVersionLabel:'V002'},def={id:'LA-CALL-fixture',currentRevisionId:'LA-CALL-fixture:r1',pipelineStageCode:'MATERIAL_PREP',prompt:{main:'固定试音。第二遍有更明确的重音。',negative:'No contamination.'}};
 const args={basis,sourceBindings:sources,previousDefinition,definitionId:def.id,promptRevisionId:def.currentRevisionId,sourcePath:'fixture/revision-v2.json',output,prompt:def.prompt};
 const built=legacyAudioMasterMetadata(args),seedAsset={asset_id:output.familyId,model:'seed-audio-1.0',text_prompt:def.prompt.main,negative_prompt:def.prompt.negative,references:[],audio_config:{format:'wav',sample_rate:48000},delivery:{sample_rate:48000,channels:1,bit_depth:24,max_peak_dbfs:-3},watermark:{},output_path:output.targetPath,metadata:built.metadata};
 def.metadataBinding=built.binding;def.seedAssetSha256=domainHash(seedAsset);def.definitionHash=executionDefinitionHash(def);
 const plan={metadataSchemaVersion:LEGACY_AUDIO_METADATA_SCHEMA,basis,sourceBindings:sources,previousDefinition,sourcePath:args.sourcePath,expectedOutput:output,executionDefinition:def,seedAsset};return {plan,args,metadata};
}

test('voice master metadata has permanent subject/output scope without promoting old scene/test labels or usage rights',()=>{
 const {plan,args,metadata}=fixture(),before=structuredClone(args.basis);
 assertLegacyAudioMasterMetadata(plan);assert.equal(plan.seedAsset.metadata.SUBJECT_ID,'character:fixture');assert.equal(plan.seedAsset.metadata.VOICE_ID,'VOICE-IDENTITY-FIXTURE');
 for(const key of ['SCENE','LINE_ID','TEST_LINE_ID','SCRIPT_VERSION','CONTINUITY_VERSION'])assert.equal(plan.seedAsset.metadata[key],'NA');
 assert.equal(plan.seedAsset.metadata.PIPELINE_STAGE,'MATERIAL_PREP');assert.equal(plan.seedAsset.metadata.RIGHTS_STATUS,'UNKNOWN');assert.equal(plan.seedAsset.metadata.QA_STATUS,'TODO');
 assert.equal(JSON.stringify(plan.seedAsset.metadata).includes('S-OLD'),false);assert.equal(JSON.stringify(plan.seedAsset.metadata).includes('EP-OLD'),false);assert.equal(metadata.SCENE,'S-OLD');
 assert.deepEqual(plan.executionDefinition.metadataBinding.productionScope,{scopeType:'ASSET_FAMILY',scopeId:'VOICE-FIXTURE'});assert.deepEqual(plan.executionDefinition.metadataBinding.dialogueBindings,[]);assert.deepEqual(args.basis,before);assert.equal(args.basis.requirement.reuseScope,'SHOT_SET');
});
for(const [name,change] of [
 ['old scene copied back',p=>p.seedAsset.metadata.SCENE='S-OLD'],
 ['wrong subject',p=>p.seedAsset.metadata.SUBJECT_ID='character:another'],
 ['wrong parent SHA',p=>p.seedAsset.metadata.PARENT_VERSION_SHA256='0'.repeat(64)],
 ['wrong output identity',p=>p.executionDefinition.metadataBinding.output.familyId='VOICE-ANOTHER'],
 ['new scene usage binding',p=>p.executionDefinition.metadataBinding.dialogueBindings=[{sceneId:'scene:new'}]],
 ['changed model input',p=>p.seedAsset.audio_config.sample_rate=24000],
 ['missing new schema',p=>delete p.metadataSchemaVersion],
 ['wrong frozen scope',p=>p.basis.requirement.sceneIds=['scene:current']],
])test('new metadata preservation refuses '+name,()=>{const {plan}=fixture();change(plan);assert.throws(()=>assertLegacyAudioMasterMetadata(plan),{code:'DOMAIN_CONFLICT'});});

test('legacy no-marker source retains its original unchanged byte contract',()=>{const legacy={executionDefinition:{pipelineStageCode:'P06'},seedAsset:{metadata:{SCENE:'S-OLD'}}},before=structuredClone(legacy);assertLegacyAudioMasterMetadata(legacy);assert.deepEqual(legacy,before);});
test('voice identity context refuses a different subject or non-master representation',()=>{const {args,metadata}=fixture(),representation=args.basis.representation;for(const r of [{...representation,type:'SCENE_DIALOGUE'},{...representation,entityId:'character:another'}])assert.throws(()=>legacyAudioMasterBasis({graph:{entities:[{id:r.entityId}]},representation:r,origin:{asset:{metadata}}}),{code:'DOMAIN_CONFLICT'});});
test('full Seed spec and metadata are included in new definition hash',()=>{const {plan}=fixture(),old=plan.executionDefinition.definitionHash;plan.executionDefinition.seedAssetSha256='f'.repeat(64);assert.notEqual(executionDefinitionHash(plan.executionDefinition),old);});
