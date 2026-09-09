import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sha256,canonicalJson} from '../host/instance-runtime/bytes.mjs';
import {defaultConfiguration,validateConfiguration,reviewSpec,bindConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {inspectPngImage,readImageTechnicalFacts,assertImageTechnicalApproval,resolveImageTechnicalSpec,createImageTechnicalSpec} from '../host/instance-runtime/image-technical-spec.mjs';
import {inspectExecutionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {compileShotRecipePreview} from '../host/instance-runtime/shot-production-recipes.mjs';
import {imageConfiguration,imageProducer,pngImage,pngChunk} from './image-technical-fixture.mjs';

test('typed configuration is opt-in, exact and does not change old frozen standards or project canvas',()=>{
 const c=imageConfiguration(),old=defaultConfiguration(),f=imageProducer(),snapshot={productionModel:{materialRequirements:[f.requirement]}};
 const oldBindings=bindConfiguration(snapshot,old),bytes=canonicalJson(oldBindings);
 validateConfiguration(c,old);assert.deepEqual(bindConfiguration(snapshot,c,oldBindings),oldBindings);assert.equal(canonicalJson(oldBindings),bytes);
 assert.deepEqual(c.technical.picture,{aspectRatio:'16:9',width:1920,height:1080,fps:24,confirmation:'CONFIRMED'});
 const next=bindConfiguration(snapshot,c,oldBindings,['material:REQ'])['material:REQ'];assert.equal(next.technicalSpec.purpose,'BASE_REFERENCE');assert.notEqual(next.reviewSpec.hash,oldBindings['material:REQ'].reviewSpec.hash);assert.equal(next.technicalSpecHash,next.reviewSpec.technicalSpecHash);
 assert.match(next.reviewSpec.criteria.at(-1).question,/原生 PNG/);assert.doesNotMatch(next.reviewSpec.criteria.at(-1).question,/1920/);
 for(const change of [v=>v.technical.imagePurposeProfiles.BASE_REFERENCE.skipDimensions=true,v=>v.technical.imagePurposeProfiles.PRODUCTION_FRAME.dimensionPolicy='NATIVE_ORIGINAL',v=>delete v.technical.imagePurposeProfiles,v=>v.schemaVersion='2.0']){const bad=structuredClone(c);change(bad);assert.throws(()=>validateConfiguration(bad));}
});
test('legacy and explicit non-image/fixed-object contracts do not acquire new purposes',()=>{
 const {requirement}=imageProducer(),old=defaultConfiguration();assert.equal(createImageTechnicalSpec(old,'ASSET',requirement),null);
 for(const object of [{...requirement,mediaType:'AUDIO'},{...requirement,sourceKind:'LEGACY'},{...requirement,composition:{operator:'ALL',requirementIds:['child']}}])assert.equal(createImageTechnicalSpec(imageConfiguration(),'ASSET',object),null);
 const c=imageConfiguration(),category=c.taxonomy.categories.find(c=>c.types.some(t=>t.id==='information-card')),type=category.types.find(t=>t.id==='information-card');type.reviewProfileId='custom-fixed';c.reviewProfiles.push({id:'custom-fixed',subjectKind:'ASSET',label:'固定画幅',criteria:[{id:'technical-quality',label:'固定规格',question:'220×600 像素',required:true,allowNA:false,noteRequiredOnFail:true}]});
 const custom={...requirement,businessCategoryPrimary:category.label,businessCategorySecondary:type.label,businessCategorySecondaryId:type.id};assert.equal(reviewSpec(c,'ASSET',custom).technicalSpec,undefined);assert.match(reviewSpec(c,'ASSET',custom).criteria[0].question,/220×600/);
 const f=imageProducer();Object.assign(f.requirement,custom);for(const row of [f.work,f.family,f.output,f.definition,f.work.configurationBinding,f.work.configurationBinding.reviewSpec]){delete row.technicalSpec;delete row.technicalSpecHash;}f.work.configurationBinding.reviewSpec=reviewSpec(c,'ASSET',custom);f.requirement.configurationBinding=structuredClone(f.work.configurationBinding);assert.equal(resolveImageTechnicalSpec(f.model,f.input),null);
});
test('custom content review profiles retain typed base purpose and cannot bypass missing producer markers',()=>{
 const f=imageProducer(),c=f.config,type=c.taxonomy.categories[0].types[0];type.reviewProfileId='material-instance-neutral';c.reviewProfiles.push({id:type.reviewProfileId,subjectKind:'ASSET',label:'自定义内容',criteria:[{id:'content-identity',label:'身份',question:'保留原主体与状态',required:true,allowNA:false,noteRequiredOnFail:true}]});
 const spec=reviewSpec(c,'ASSET',f.requirement),binding={technicalSpec:spec.technicalSpec,technicalSpecHash:spec.technicalSpecHash};assert.equal(spec.technicalSpec.purpose,'BASE_REFERENCE');assert.equal(spec.profileId,'material-instance-neutral');assert.match(spec.criteria[0].question,/保留原主体与状态/);assert.match(spec.criteria[0].question,/原生 PNG/);
 for(const row of [f.work,f.family,f.output,f.definition,f.work.configurationBinding])Object.assign(row,structuredClone(binding));f.work.configurationBinding.reviewSpec=spec;f.requirement.configurationBinding=structuredClone(f.work.configurationBinding);assert.deepEqual(resolveImageTechnicalSpec(f.model,f.input),binding);
 for(const row of [f.work,f.family,f.output,f.definition,f.work.configurationBinding,f.work.configurationBinding.reviewSpec,f.requirement.configurationBinding,f.requirement.configurationBinding.reviewSpec]){delete row.technicalSpec;delete row.technicalSpecHash;}assert.throws(()=>resolveImageTechnicalSpec(f.model,f.input),/缺少冻结/);
});
test('PNG facts prove actual native dimensions and SHA, with no invented image fps',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'typed-image-facts-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'actual.png'),bytes=pngImage(1672,941);await writeFile(file,bytes);
 const facts=await readImageTechnicalFacts(file,{sha256:sha256(bytes),byteSize:bytes.length});assert.deepEqual(facts,{schemaVersion:'IMAGE_TECHNICAL_FACTS_V1',sha256:sha256(bytes),byteSize:bytes.length,format:'PNG',width:1672,height:941,frameCount:1});
 await assert.rejects(readImageTechnicalFacts(file,{sha256:'0'.repeat(64)}),/已变化/);await assert.rejects(readImageTechnicalFacts(file,{sha256:sha256(bytes),byteSize:bytes.length+1}),/大小/);
 await writeFile(file,pngImage(1,1));await assert.rejects(readImageTechnicalFacts(file,{sha256:sha256(bytes)}),/已变化/);
});
test('truncated, forged IHDR, corrupt CRC, animation and incomplete pixel streams are rejected',()=>{
 const good=pngImage(),badCrc=Buffer.from(good);badCrc[20]^=1;
 const wrongPixels=Buffer.concat([good.subarray(0,33),pngImage(1,1).subarray(33)]),animated=Buffer.concat([good.subarray(0,33),pngChunk('acTL',Buffer.alloc(8)),good.subarray(33)]);
 for(const bytes of [good.subarray(0,33),badCrc,wrongPixels,animated,Buffer.concat([good,Buffer.from('trailing')]),Buffer.from('not an image')])assert.throws(()=>inspectPngImage(bytes));
 assert.deepEqual(inspectPngImage(good),{format:'PNG',width:17,height:9,frameCount:1});
});
for(const purpose of ['BASE_REFERENCE','PREVIS_STILL','PRODUCTION_FRAME'])test(purpose+' is resolved from frozen original producer and retains historical ownership',()=>{
 const f=imageProducer(purpose);assert.deepEqual(resolveImageTechnicalSpec(f.model,f.input),f.binding);
 f.work.scopeRole='EVIDENCE_ONLY';f.work.activeInCurrentProduction=false;assert.deepEqual(resolveImageTechnicalSpec(f.model,f.input),f.binding,'historical producer is not rewritten by today pointer');
 assert.equal(inspectExecutionDefinitionHash(f.definition).valid,true);const bad=structuredClone(f.definition);bad.technicalSpec.purpose='BASE_REFERENCE';if(purpose!=='BASE_REFERENCE')assert.equal(inspectExecutionDefinitionHash(bad).valid,false);
});
test('partial markers, forged purpose, wrong EO, original producer and review hash fail closed',()=>{
 const mutations=[f=>delete f.input.definition,f=>delete f.work.technicalSpec,f=>delete f.output.technicalSpecHash,f=>f.definition.technicalSpecHash='0'.repeat(64),f=>f.family.ownerRef='OTHER',f=>f.output.familyId='OTHER',f=>f.definition.output.expectedOutputRef='OTHER',f=>f.model.materialProductionPlans[0].workItemId='OTHER',f=>f.model.materialRequirements[0].sourceKind='LEGACY',f=>f.work.configurationBinding.reviewSpec.criteria[0].question+='forged'];
 for(const mutate of mutations){const f=imageProducer();mutate(f);assert.throws(()=>resolveImageTechnicalSpec(f.model,f.input));}
 const stripped=imageProducer();for(const row of [stripped.work,stripped.family,stripped.output,stripped.definition,stripped.work.configurationBinding,stripped.work.configurationBinding.reviewSpec]){delete row.technicalSpec;delete row.technicalSpecHash;}assert.throws(()=>resolveImageTechnicalSpec(stripped.model,stripped.input),/缺少冻结/);
 const f=imageProducer('PREVIS_STILL');f.model.shotProductionPlans[0].content.schemaVersion='1.0';assert.throws(()=>resolveImageTechnicalSpec(f.model,f.input));
 const old={assetFamilies:[{id:'LEGACY',kind:'IMAGE'}]};assert.equal(resolveImageTechnicalSpec(old,{familyId:'LEGACY'}),null);
});
test('base native facts may pass the technical gate but formal keyframes require exact confirmed canvas',()=>{
 const facts={schemaVersion:'IMAGE_TECHNICAL_FACTS_V1',sha256:'a'.repeat(64),byteSize:500,format:'PNG',width:1672,height:941,frameCount:1};
 for(const p of ['BASE_REFERENCE','PREVIS_STILL'])assert.doesNotThrow(()=>assertImageTechnicalApproval(imageProducer(p).binding,facts));
 const final=imageProducer('PRODUCTION_FRAME').binding;assert.throws(()=>assertImageTechnicalApproval(final,facts),/项目画幅/);assert.doesNotThrow(()=>assertImageTechnicalApproval(final,{...facts,width:1920,height:1080}));
 assert.throws(()=>assertImageTechnicalApproval(final,null),/实际/);
 for(const change of [c=>c.width=1672,c=>c.fps='UNKNOWN',c=>c.confirmation='UNKNOWN']){const c=imageConfiguration();change(c.technical.picture);const b=createImageTechnicalSpec(c,'WORK_PRODUCT',imageProducer('PRODUCTION_FRAME').work);assert.throws(()=>assertImageTechnicalApproval(b,{...facts,width:1920,height:1080}),/项目画幅/);}
});
test('another project can freeze real 4K/25fps while spec-only canvas changes cannot bypass the original binding',()=>{
 const c=imageConfiguration();c.technical.picture={aspectRatio:'16:9',width:3840,height:2160,fps:25,confirmation:'CONFIRMED'};validateConfiguration(c);
 const b=createImageTechnicalSpec(c,'WORK_PRODUCT',imageProducer('PRODUCTION_FRAME').work),bytes=pngImage(3840,2160),facts={schemaVersion:'IMAGE_TECHNICAL_FACTS_V1',sha256:sha256(bytes),byteSize:bytes.length,...inspectPngImage(bytes)};assert.doesNotThrow(()=>assertImageTechnicalApproval(b,facts));
 for(const change of [s=>s.canvas.fps=25,s=>s.canvas.width=1672,s=>s.canvas.confirmation='UNKNOWN']){const f=imageProducer('PRODUCTION_FRAME'),changed=structuredClone(f.binding.technicalSpec);change(changed);const replacement={technicalSpec:changed,technicalSpecHash:sha256(canonicalJson(changed))};for(const row of [f.work,f.family,f.output,f.definition,f.work.configurationBinding,f.work.configurationBinding.reviewSpec])Object.assign(row,structuredClone(replacement));const {hash:old,...body}=f.work.configurationBinding.reviewSpec;void old;f.work.configurationBinding.reviewSpec.hash=sha256(canonicalJson(body));assert.throws(()=>resolveImageTechnicalSpec(f.model,f.input),/冻结的项目画面配置/);}
});
test('new shot recipe source and definition hash freeze the spec; source work is unchanged',()=>{
 const f=imageProducer('PREVIS_STILL'),before=structuredClone(f);f.output.plannedVersionLabel='V001';const c={...f,view:{releaseId:'release'},state:{assetFamiliesById:{FAMILY:f.family},assetVersionsById:{}},settings:{handles:{}},inputs:[],basis:{},basisHash:sha256('{}')};
 const result=compileShotRecipePreview(c,{model:'image-provider',prompt:'Neutral storyboard fixture',negativePrompt:'',parameters:{}},{draftRevisionId:'draft'});
 assert.deepEqual(result.definition.technicalSpec,f.binding.technicalSpec);assert.equal(inspectExecutionDefinitionHash(result.definition).valid,true);assert.deepEqual(f.work,before.work);
 f.output.technicalSpecHash='b'.repeat(64);assert.throws(()=>compileShotRecipePreview(c,{model:'image-provider',prompt:'Fixture',negativePrompt:'',parameters:{}},{draftRevisionId:'draft'}));
});
