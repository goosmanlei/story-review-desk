import {getConfiguration,previewConfiguration,publishConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {sha256,canonicalJson} from '../host/instance-runtime/bytes.mjs';
import {deflateSync} from 'node:zlib';
import {defaultConfiguration,reviewSpec} from '../host/instance-runtime/configuration-model.mjs';
import {defaultImagePurposeProfiles} from '../host/instance-runtime/image-technical-spec.mjs';
import {shotProductionPolicyMarkers} from '../host/instance-runtime/shot-production-stage-policy.mjs';
import {executionDefinitionHash,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA} from '../host/instance-runtime/execution-definition-hash.mjs';
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;}
export function pngChunk(type,body){const label=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(Buffer.concat([label,body])));return Buffer.concat([length,label,body,crc]);}
export function pngImage(width=17,height=9){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),pngChunk('IEND',Buffer.alloc(0))]);}
export function imageConfiguration(){const c=defaultConfiguration();c.schemaVersion='2.1';c.technical.imagePurposeProfiles=defaultImagePurposeProfiles();c.technical.picture={aspectRatio:'16:9',width:1920,height:1080,fps:24,confirmation:'CONFIRMED'};return c;}
export function imageProducer(purpose='BASE_REFERENCE'){
 const config=imageConfiguration(),requirement={id:'REQ',sourceKind:'DOMAIN_GRAPH',requirementClass:'REQUIRED',mediaType:'IMAGE',businessCategoryPrimary:'人物',businessCategorySecondary:'人物身份',acceptanceCriteria:['明确的中性测试身份']};
 const key=purpose==='PREVIS_STILL'?'STORYBOARD':'START_FRAME',work={id:'WORK',outputAssetRef:'FAMILY',...(purpose==='BASE_REFERENCE'?{materialProductionPlanId:'PLAN',requirementRef:'REQ'}:{shotProductionPlanId:'PLAN',deliverableKey:key,...shotProductionPolicyMarkers(key)})};
 const spec=reviewSpec(config,purpose==='BASE_REFERENCE'?'ASSET':'WORK_PRODUCT',purpose==='BASE_REFERENCE'?requirement:work),binding={technicalSpec:spec.technicalSpec,technicalSpecHash:spec.technicalSpecHash};
 work.configurationBinding={...binding,technical:config.technical,reviewSpec:spec};Object.assign(work,structuredClone(binding));
 const markers=purpose==='BASE_REFERENCE'?{}:shotProductionPolicyMarkers(key),family={id:'FAMILY',kind:'IMAGE',ownerRef:'WORK',expectedOutputRefs:['EO'],...markers,...structuredClone(binding)},output={id:'EO',familyId:'FAMILY',targetPath:'media/_review_pending/FAMILY/V001.png',executionDefinitionRef:'DEF',...markers,...structuredClone(binding)};
 const definition={id:'DEF',workItemRef:'WORK',executorKind:'MODEL_CALL',definitionHashSchemaVersion:SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA,output:{path:output.targetPath,mediaType:'IMAGE',assetFamilyRef:'FAMILY',expectedOutputRef:'EO'},...structuredClone(binding)};definition.definitionHash=executionDefinitionHash(definition);
 const model={assetFamilies:[family],expectedOutputs:[output],materialRequirements:[requirement],materialWorkItems:purpose==='BASE_REFERENCE'?[work]:[],workItems:purpose==='BASE_REFERENCE'?[]:[work],materialProductionPlans:purpose==='BASE_REFERENCE'?[{id:'PLAN',workItemId:'WORK',familyId:'FAMILY',requirementId:'REQ'}]:[],shotProductionPlans:purpose==='BASE_REFERENCE'?[]:[{id:'PLAN',content:{schemaVersion:'2.0',stagePolicy:'PREVIS_FIRST_V1'},workItemIds:['WORK']}]};
 return {config,requirement,work,family,output,definition,model,binding,input:{familyId:'FAMILY',expectedOutputId:'EO',definition}};
}

// The shared native fixture deliberately leaves its unrelated legacy taxonomy
// unspecified. Configuration tests declare it before the frozen comparison.
export async function prepareImageConfigurationFixture(f){
 await f.repo.writeTransaction(async tx=>{const view=await tx.readView(),snapshot=structuredClone(view.snapshot),legacy=snapshot.productionModel.materialRequirements.find(r=>r.id==='legacy-demand');legacy.businessCategoryPrimary='人物';legacy.businessCategorySecondary='人物身份';for(const work of [...snapshot.productionModel.workItems,...snapshot.productionModel.materialWorkItems].filter(w=>w.id==='legacy-work')){const body={legacy:true,profileId:'fixture-legacy',criteria:[],configurationHash:sha256('fixture-config')};work.reviewSpec={...body,hash:sha256(canonicalJson(body))};}await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});});await f.repo.writeTransaction(async tx=>{const c=await getConfiguration(tx),input={configuration:c.configuration,expectedReleaseId:c.releaseId,expectedConfigurationRevisionId:c.revisionId,upgradeKeys:[]};const preview=await previewConfiguration(tx,input);await publishConfiguration(tx,{...input,previewHash:preview.previewHash,requestId:crypto.randomUUID()});});return f;
}
