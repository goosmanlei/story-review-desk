import {open} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {canonicalJson,sha256} from './bytes.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const hash=value=>sha256(canonicalJson(value));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
const one=(rows,label)=>{if(rows.length!==1)fail('图像规格归属不唯一：'+label);return rows[0];};
export const IMAGE_TECHNICAL_SPEC_SCHEMA='IMAGE_TECHNICAL_SPEC_V1';
export function defaultImagePurposeProfiles(){return {schemaVersion:IMAGE_TECHNICAL_SPEC_SCHEMA,BASE_REFERENCE:{dimensionPolicy:'NATIVE_ORIGINAL',formats:['PNG']},PREVIS_STILL:{dimensionPolicy:'NATIVE_ORIGINAL',formats:['PNG']},PRODUCTION_FRAME:{dimensionPolicy:'EXACT_PROJECT_CANVAS',formats:['PNG']}};}
export function validateImagePurposeProfiles(value){if(!same(value,defaultImagePurposeProfiles()))fail('图像用途配置必须使用完整、受支持的固定规格合同');return value;}

/** Authoring classification; runtime resolution additionally proves the original producer. */
export function imageTechnicalPurpose(kind,object){
 if(kind==='ASSET'&&object?.sourceKind==='DOMAIN_GRAPH'&&object.mediaType==='IMAGE'&&object.requirementClass==='REQUIRED'&&!object.composition)return 'BASE_REFERENCE';
 if(kind==='WORK_PRODUCT'&&object?.shotProductionPlanId&&object.productionSchemaVersion==='2.0'&&object.stagePolicy==='PREVIS_FIRST_V1'){
  if(object.deliverableKey==='STORYBOARD')return 'PREVIS_STILL';
  if(['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(object.deliverableKey))return 'PRODUCTION_FRAME';
 }
 return null;
}
export function createImageTechnicalSpec(config,kind,object){
 if(config?.schemaVersion!=='2.1')return null;
 validateImagePurposeProfiles(config.technical?.imagePurposeProfiles);
 const purpose=imageTechnicalPurpose(kind,object);if(!purpose)return null;
 if(kind==='ASSET'){
  const primary=object.businessCategoryPrimaryId||object.businessCategoryPrimary,secondary=object.businessCategorySecondaryId||object.businessCategorySecondary;
  const category=(config.taxonomy?.categories||[]).find(c=>c.id===primary||c.label===primary||(c.aliases||[]).includes(primary));
  const type=(category?.types||[]).find(t=>t.id===secondary||t.label===secondary||(t.aliases||[]).includes(secondary));
  if(type?.id==='information-card')return null;
 }
 const canvas=purpose==='PRODUCTION_FRAME'?structuredClone(config.technical.picture):null;
 const technicalSpec={schemaVersion:IMAGE_TECHNICAL_SPEC_SCHEMA,purpose,mediaType:'IMAGE',...structuredClone(config.technical.imagePurposeProfiles[purpose]),intrinsicFps:'NOT_APPLICABLE',frameCount:1,canvas};
 return {technicalSpec,technicalSpecHash:hash(technicalSpec)};
}
export function imageTechnicalReviewText(spec){
 if(spec.purpose==='PRODUCTION_FRAME'){const c=spec.canvas;return `正式帧须为 ${c.aspectRatio}、${c.width}×${c.height} 像素（${c.confirmation}），用于 ${c.fps} fps 时间线。静态 PNG 本身无帧率。须核验实际原件、完整画面与可用质量。`;}
 return `${spec.purpose==='PREVIS_STILL'?'粗分镜仅用于预演表达和锁时':'基础参考用于身份、造型、状态或空间输入'}；保留原生 PNG 尺寸，记录实际原件的宽高与 SHA，不要求归一为成片画幅。静态图本身无帧率。主体、边缘、必要细节须清楚完整，并分别满足该需求所有内容与权利条件。`;
}
export function imageTechnicalBinding(binding){
 const marked=own(binding,'technicalSpec')||own(binding,'technicalSpecHash');if(!marked)return null;
 const spec=binding.technicalSpec;
 if(!spec||spec.schemaVersion!==IMAGE_TECHNICAL_SPEC_SCHEMA||!['BASE_REFERENCE','PREVIS_STILL','PRODUCTION_FRAME'].includes(spec.purpose))fail('图像技术规格缺失或协议不支持');
 const expected={schemaVersion:IMAGE_TECHNICAL_SPEC_SCHEMA,purpose:spec.purpose,mediaType:'IMAGE',...defaultImagePurposeProfiles()[spec.purpose],intrinsicFps:'NOT_APPLICABLE',frameCount:1,canvas:spec.purpose==='PRODUCTION_FRAME'?spec.canvas:null};
 if(!same(spec,expected)||binding.technicalSpecHash!==hash(spec))fail('图像技术规格内容或 SHA 不匹配');
 if(spec.purpose==='PRODUCTION_FRAME'){
  const c=spec.canvas;if(!c||Object.keys(c).sort().join(',')!=='aspectRatio,confirmation,fps,height,width')fail('正式帧缺少冻结画幅');
  if(binding.technical&&!same(binding.technical.picture,c))fail('正式帧规格偏离该对象冻结的项目画面配置');
 }
 return {technicalSpec:structuredClone(spec),technicalSpecHash:binding.technicalSpecHash};
}

/** No current global default can rewrite an old object. Any partial marker fails closed. */
export function resolveImageTechnicalSpec(model,{familyId,workItemId,expectedOutputId,definition}={}){
 const families=(model?.assetFamilies||[]).filter(f=>f.id===familyId),family=families[0];
 const works=[...(model?.materialWorkItems||[]),...(model?.workItems||[])].filter(w=>w.id===(workItemId||family?.ownerRef));
 const outputs=(model?.expectedOutputs||[]).filter(o=>o.id===(expectedOutputId||definition?.output?.expectedOutputRef));
 const items=[...families,...works,...outputs,definition,...works.map(w=>w.configurationBinding),...works.map(w=>w.configurationBinding?.reviewSpec)];
 const typedProducer=works.some(w=>{
  const b=w.configurationBinding;if(!b?.technical?.imagePurposeProfiles)return false;validateImagePurposeProfiles(b.technical.imagePurposeProfiles);
  const requirements=(model.materialRequirements||[]).filter(r=>r.id===w.requirementRef),r=requirements.length===1?requirements[0]:null;
  // Content-review profile names do not define technical purpose. The only
  // excluded fixed-object type is proved by the original requirement binding.
  const fixedCard=r?.sourceKind==='DOMAIN_GRAPH'&&r.businessCategorySecondaryId==='information-card'&&same(r.configurationBinding,b);
  return Boolean(w.materialProductionPlanId&&family?.kind==='IMAGE'&&!fixedCard)||Boolean(imageTechnicalPurpose('WORK_PRODUCT',w));
 });
 if(!typedProducer&&!items.some(i=>own(i,'technicalSpec')||own(i,'technicalSpecHash')))return null;
 one(families,'family');const work=one(works,'producer'),output=one(outputs,'ExpectedOutput');
 if(family.kind!=='IMAGE'||family.ownerRef!==work.id||work.outputAssetRef!==family.id||output.familyId!==family.id||!(family.expectedOutputRefs||[]).includes(output.id))fail('图像规格的作品、素材族或产物绑定不一致');
 const frozen=imageTechnicalBinding(work.configurationBinding);if(!frozen)fail('作品缺少冻结图像规格');
 for(const row of [work,family,output,work.configurationBinding.reviewSpec])if(!same(imageTechnicalBinding(row),frozen))fail('图像规格在作品、族、产物或审阅标准之间不一致');
 const review=work.configurationBinding.reviewSpec;const {hash:reviewHash,...reviewBody}=review;if(reviewHash!==hash(reviewBody))fail('图像审阅标准 SHA 不匹配');
 let purpose;
 if(work.materialProductionPlanId){
  const plan=one((model.materialProductionPlans||[]).filter(p=>p.id===work.materialProductionPlanId),'material plan');
  if(plan.workItemId!==work.id||plan.familyId!==family.id||plan.requirementId!==work.requirementRef)fail('基础参考原始制作计划归属不一致');
  const requirement=one((model.materialRequirements||[]).filter(r=>r.id===work.requirementRef),'requirement');
  purpose=imageTechnicalPurpose('ASSET',requirement);
 }else{
  const plan=one((model.shotProductionPlans||[]).filter(p=>p.id===work.shotProductionPlanId),'shot plan');
  if(plan.content?.schemaVersion!=='2.0'||plan.content.stagePolicy!=='PREVIS_FIRST_V1'||!(plan.workItemIds||[]).includes(work.id))fail('镜头图像缺少原始 V2 制作计划');
  purpose=imageTechnicalPurpose('WORK_PRODUCT',work);
  const expectedPurpose=purpose==='PREVIS_STILL'?'PREVIS_ONLY':'FINAL_PRODUCTION';
  if(work.productionPurpose!==expectedPurpose||family.productionPurpose!==expectedPurpose||output.productionPurpose!==expectedPurpose||work.allowedUse!==(purpose==='PREVIS_STILL'?'PREVIS_TIMING':'PRODUCTION'))fail('图像生产用途与原始阶段不一致');
 }
 if(!purpose||purpose!==frozen.technicalSpec.purpose)fail('图像规格用途与原始生产者不一致');
 if(output.executionDefinitionRef&&!definition)fail('图像审批或登记缺少精确已发布调用包');
 if(definition){
  if(definition.workItemRef!==work.id||definition.output?.assetFamilyRef!==family.id||definition.output?.expectedOutputRef!==output.id||definition.output?.path!==output.targetPath||definition.output?.mediaType!=='IMAGE'||output.executionDefinitionRef!==definition.id||!same(imageTechnicalBinding(definition),frozen))fail('图像调用包与冻结规格或产物不一致');
 }
 return frozen;
}

// Decode enough PNG structure to prove dimensions, staticity and complete pixel
// scanlines. Neither an untrusted MIME label nor an IHDR-only file is evidence.
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function inspectPngImage(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<45||bytes.length>64*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail('图像原件须为完整、有限大小的 PNG');
 let offset=8,header=null,ended=false,seenData=false,dataEnded=false,palette=false;const data=[];
 while(offset<bytes.length){
  if(offset+12>bytes.length)fail('PNG 区块不完整');
  const n=bytes.readUInt32BE(offset),end=offset+12+n;if(end>bytes.length)fail('PNG 区块长度错误');
  const type=bytes.toString('ascii',offset+4,offset+8),body=bytes.subarray(offset+8,offset+8+n);
  if(!/^[A-Za-z]{4}$/.test(type)||crc32(bytes.subarray(offset+4,offset+8+n))!==bytes.readUInt32BE(offset+8+n))fail('PNG 区块 CRC 错误');
  if(!header&&type!=='IHDR')fail('PNG 缺少首部');
  if(['acTL','fcTL','fdAT'].includes(type))fail('本图像合同不接受动画 PNG');
  if(type==='IHDR'){
   if(header||n!==13)fail('PNG 首部重复或错误');
   const width=body.readUInt32BE(0),height=body.readUInt32BE(4),depth=body[8],color=body[9],channels={0:1,2:3,3:1,4:2,6:4}[color];
   if(!width||!height||width>16384||height>16384||width*height>33554432||!channels||!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]}[color].includes(depth))||body[10]||body[11]||body[12]>1)fail('PNG 像素结构不支持或超限');
   header={width,height,depth,color,channels,interlace:body[12]};
  }else if(type==='PLTE'){if(seenData||palette||!n||n%3||n>768)fail('PNG 调色板错误');palette=true;}
  else if(type==='IDAT'){if(dataEnded)fail('PNG 像素区块顺序错误');seenData=true;data.push(body);}
  else if(type==='IEND'){if(n||!seenData||end!==bytes.length)fail('PNG 尾部错误');ended=true;}
  else if(type[0]===type[0].toUpperCase())fail('PNG 包含不支持的关键区块');
  if(seenData&&type!=='IDAT')dataEnded=true;offset=end;
 }
 if(!ended||header.color===3&&!palette)fail('PNG 图像不完整');
 const {width,height,depth,channels,interlace}=header;
 const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
 const scans=passes.map(([x,y,dx,dy])=>{const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));return w&&h?{h,stride:1+Math.ceil(w*depth*channels/8)}:{h:0,stride:0};});
 const expected=scans.reduce((n,s)=>n+s.h*s.stride,0);if(expected>128*1024*1024)fail('PNG 解码数据超限');
 let pixels;try{const compressed=Buffer.concat(data),decoded=inflateSync(compressed,{maxOutputLength:expected+1,info:true});if(decoded.engine.bytesWritten!==compressed.length)fail('PNG 像素流含多余数据');pixels=decoded.buffer;}catch{fail('PNG 像素流无法完整解码');}
 if(pixels.length!==expected)fail('PNG 实际像素数据长度不匹配');
 let pos=0;for(const s of scans)for(let row=0;row<s.h;row++){if(pixels[pos]>4)fail('PNG 像素过滤器错误');pos+=s.stride;}
 return {format:'PNG',width,height,frameCount:1};
}
export async function readImageTechnicalFacts(filePath,{sha256:expectedSha,byteSize}={}){
 if(!/^[a-f0-9]{64}$/.test(expectedSha||''))fail('原件事实核验必须固定 SHA');
 const file=await open(filePath,'r');try{
  const before=await file.stat();if(!before.isFile()||before.size>64*1024*1024||byteSize!==undefined&&before.size!==byteSize)fail('原件大小或类型不匹配');
  const bytes=await file.readFile(),after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||sha256(bytes)!==expectedSha)fail('图像原件已变化');
  return {schemaVersion:'IMAGE_TECHNICAL_FACTS_V1',sha256:expectedSha,byteSize:bytes.length,...inspectPngImage(bytes)};
 }finally{await file.close();}
}
export function assertImageTechnicalApproval(binding,facts){
 const frozen=imageTechnicalBinding(binding);if(!frozen)return;
 if(!facts||facts.schemaVersion!=='IMAGE_TECHNICAL_FACTS_V1'||facts.format!=='PNG'||facts.frameCount!==1||!Number.isSafeInteger(facts.width)||facts.width<1||!Number.isSafeInteger(facts.height)||facts.height<1||!Number.isSafeInteger(facts.byteSize)||facts.byteSize<45||!/^[a-f0-9]{64}$/.test(facts.sha256||''))fail('审批缺少实际图像原件事实');
 const spec=frozen.technicalSpec;if(spec.purpose==='PRODUCTION_FRAME'){
  const c=spec.canvas,ratio=typeof c.aspectRatio==='string'&&/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(c.aspectRatio)?c.aspectRatio.split(':').map(Number):[];
  if(c.confirmation!=='CONFIRMED'||!Number.isSafeInteger(c.width)||!Number.isSafeInteger(c.height)||c.width<1||c.height<1||c.width>16384||c.height>16384||!Number.isFinite(c.fps)||c.fps<=0||c.fps>240||ratio.length!==2||ratio[0]<=0||ratio[1]<=0||Math.abs(c.width/c.height-ratio[0]/ratio[1])>0.001||facts.width!==c.width||facts.height!==c.height)fail('正式帧实际像素必须满足该对象冻结且已确认的项目画幅和时间线规格');
 }
}
