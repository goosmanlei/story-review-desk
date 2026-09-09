import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';

export const LEGACY_AUDIO_METADATA_SCHEMA='VOICE_IDENTITY_MASTER_METADATA_V1';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const text=value=>typeof value==='string'&&Boolean(value.trim());
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** A master identifies a voice, never a current dialogue or shot. The original
 * requirement/directory usage restrictions remain untouched in the main basis.
 * Source metadata is audit data: Seed's model inputs are preserved separately. */
export function legacyAudioMasterBasis({graph,representation,origin}){
 const entities=(graph.entities||[]).filter(e=>e.id===representation.entityId);
 if(representation.type!=='VOICE_IDENTITY'||entities.length!==1||origin.asset.metadata?.SUBJECT_ID!==representation.entityId||!text(origin.asset.metadata?.VOICE_ID))fail('旧声音新元数据仅支持当前唯一声音身份母版及已发布声音身份');
 return {schemaVersion:LEGACY_AUDIO_METADATA_SCHEMA,entity:structuredClone(entities[0]),voiceId:origin.asset.metadata.VOICE_ID};
}

export function legacyAudioMasterMetadata({basis,sourceBindings,previousDefinition,definitionId,promptRevisionId,sourcePath,output,prompt}){
 const master=basis.voiceMasterMetadata,r=basis.revision,representation=basis.representation,requirement=basis.requirement;
 if(master?.schemaVersion!==LEGACY_AUDIO_METADATA_SCHEMA||!master.entity||master.entity.id!==representation.entityId||representation.type!=='VOICE_IDENTITY'
  ||!text(master.voiceId)||requirement.id!==basis.requirementId||requirement.requirementHash!==basis.requirementHash
  ||!same(representation.assetFamilyIds,[r.familyId])||!same(representation.requirementIds,[requirement.id])
  ||!hash(r.parentVersionSha256)||!text(r.parentVersionId)||!text(definitionId)||promptRevisionId!==definitionId+':r1'
  ||output.familyId!==r.familyId||!/^V\d{3,}$/.test(output.plannedVersionLabel||'')||!text(output.targetPath)
  ||!Array.isArray(sourceBindings)||!sourceBindings.length||!same(sourceBindings,r.sourceBindings)
  ||previousDefinition.id!==r.definitionId||previousDefinition.definitionHash!==r.definitionHash)fail('声音母版新元数据的主体、范围、父版本或来源闭包不完整');
 const binding={schemaVersion:LEGACY_AUDIO_METADATA_SCHEMA,objectKind:'VOICE_IDENTITY_MASTER',
  productionScope:{scopeType:'ASSET_FAMILY',scopeId:r.familyId},usageAssignment:'UNCHANGED_REQUIREMENT_AND_DIRECTORY',
  requirementId:requirement.id,requirementHash:basis.requirementHash,requirementRecordHash:domainHash(requirement),
  representationId:representation.id,representationHash:domainHash(representation),entityId:master.entity.id,entityHash:domainHash(master.entity),voiceId:master.voiceId,
  parentVersionId:r.parentVersionId,parentVersionSha256:r.parentVersionSha256,
  output:{familyId:output.familyId,expectedOutputId:output.id,plannedVersionLabel:output.plannedVersionLabel,plannedVersionId:output.familyId+'@'+output.plannedVersionLabel,path:output.targetPath},
  prompt:{definitionId,revisionId:promptRevisionId,sourcePath,mainSha256:sha256(prompt.main),negativeSha256:sha256(prompt.negative)},
  provenance:{previousDefinitionId:previousDefinition.id,previousDefinitionHash:previousDefinition.definitionHash,sourceBindings:structuredClone(sourceBindings)},
  textRole:'VOICE_MASTER_TEST',dialogueBindings:[],shotBindings:[]};
 // No spread of old metadata: historical scene/episode/line labels live only in
 // the immutable previous source and requirement, not in the new active tags.
 const metadata={METADATA_SCHEMA_VERSION:LEGACY_AUDIO_METADATA_SCHEMA,PIPELINE_STAGE:'MATERIAL_PREP',ASSET_TYPE:'VOICE',ASSET_VARIANT:'VOICE-MASTER',SUBJECT_ID:master.entity.id,
  SCENE:'NA',SEGMENT:'NA',SHOT:'NA',LOC:'NA',MACRO_STATE_FROM:'NA',MACRO_STATE_TO:'NA',SNAPSHOT_FROM:'NA',SNAPSHOT_TO:'NA',ZONE:'NA',CAM:'NA',FREEZE_ID_FROM:'NA',FREEZE_ID_TO:'NA',LINE_ID:'NA',
  VOICE_ID:master.voiceId,PARENT_ASSETS:[r.parentVersionId],PARENT_VERSION_SHA256:r.parentVersionSha256,RIGHTS_STATUS:'UNKNOWN',QA_STATUS:'TODO',
  SCRIPT_VERSION:'NA',CONTINUITY_VERSION:'NA',PROMPT_SOURCE:sourcePath,PROMPT_VERSION:promptRevisionId,EXECUTION_GATE:'READY_TO_START',
  SCENE_SCOPE:'VOICE_IDENTITY_MASTER',VOICE_PROFILE_STATUS:'NOT_YET_REVIEWED',SHOT_BINDING_STATUS:'NOT_APPLICABLE_VOICE_MASTER',TEST_LINE_ID:'NA',PRODUCTION_BINDING:binding};
 return {binding,metadata};
}

/** Historical plans without this marker keep their original byte contract.
 * New plans must preserve the complete server-derived metadata and Seed spec. */
export function assertLegacyAudioMasterMetadata(plan){
 const def=plan.executionDefinition;
 const marked=plan.basis?.voiceMasterMetadata!==undefined||plan.metadataSchemaVersion!==undefined||def?.metadataBinding!==undefined||def?.seedAssetSha256!==undefined||plan.seedAsset?.metadata?.METADATA_SCHEMA_VERSION!==undefined;
 if(!marked)return;
 if(plan.metadataSchemaVersion!==LEGACY_AUDIO_METADATA_SCHEMA||def?.pipelineStageCode!=='MATERIAL_PREP')fail('声音母版新元数据规格或制作阶段被替换');
 const expected=legacyAudioMasterMetadata({basis:plan.basis,sourceBindings:plan.sourceBindings,previousDefinition:plan.previousDefinition,definitionId:def.id,promptRevisionId:def.currentRevisionId,sourcePath:plan.sourcePath,output:plan.expectedOutput,prompt:def.prompt});
 if(!same(def.metadataBinding,expected.binding)||!same(plan.seedAsset.metadata,expected.metadata)||def.seedAssetSha256!==domainHash(plan.seedAsset))fail('声音母版元数据、完整 Seed 规格与新定义哈希不一致');
}
