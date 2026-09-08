import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfiguration,validateConfiguration,reviewSpec,exportConfigurationTemplate} from '../host/instance-runtime/configuration-model.mjs';
import {reviewCatalog,productionGroups,deliveryAliases} from '../host/instance-runtime/review-standard-catalog.mjs';
import {reorganizeStandards} from '../host/instance-runtime/review-standard-defaults.mjs';
const flatten=nodes=>nodes.flatMap(n=>[n,...flatten(n.children || [])]);
test('catalog retains all fifteen future gates, groups aliases and never loses a configurable profile',()=>{
 const c=defaultConfiguration(), tree=reviewCatalog(c),nodes=flatten(tree);
 assert.deepEqual(tree.map(n=>n.label),['故事审阅','素材审阅','制作审阅']);
 for(const [, , gates] of productionGroups)for(const [id] of gates)assert(nodes.some(n=>n.id===id));
 const represented=new Set(nodes.flatMap(n=>n.profileIds || []));
 assert.equal(represented.size,c.reviewProfiles.length);
 const video=nodes.filter(n=>n.profileIds?.includes('production-shot_video'));
 assert.equal(video.length,1);assert.equal(video[0].profileIds.length,1);
 assert(!nodes.some(n=>/^[A-Z_]+$/.test(n.label)));
 assert.equal(productionGroups.flatMap(([, , gates])=>gates).length,15);
});
test('production outputs have distinct purposes and no generic navigation-shot questions',()=>{
 const c=defaultConfiguration();
 for(const key of ['TECHNICAL_REPORT','SUBTITLE_FILE','AUDIO_STEMS','EPISODE_TECH_QC_REPORT']){
  const p=c.reviewProfiles.find(p=>p.deliverableKey===key);
  assert(p.criteria.length>=3);assert(!JSON.stringify(p.criteria).includes('本镜目的'));assert(!p.criteria.some(c=>c.id==='scope-identity'));
 }
 assert.notDeepEqual(c.reviewProfiles.find(p=>p.deliverableKey==='EPISODE_MASTER').criteria,c.reviewProfiles.find(p=>p.deliverableKey==='EPISODE_REVIEW_DECISION').criteria);
 for(const [alias,key] of Object.entries(deliveryAliases)){assert(!c.reviewProfiles.some(p=>p.deliverableKey===alias));assert.equal(reviewSpec(c,'WORK_PRODUCT',{deliverableKey:alias}).profileId,`production-${key.toLowerCase()}`);}
});
test('migration carries instance-specific requirements, preserves frozen specs and retires only mapped templates',()=>{
 const original=defaultConfiguration();original.template.version='1.0';
 const legacy={id:'material-legacy-custom',label:'CHARACTER_IDENTITY',subjectKind:'ASSET',criteria:[{id:'material-01',label:'具体人物要求',question:'服装保留已批准的深蓝外衣',required:true,allowNA:true,noteRequiredOnFail:false}]};
 original.reviewProfiles.push(legacy);
 const frozen=reviewSpec(original,'ASSET',{mediaType:'IMAGE',businessCategoryPrimary:'人物',businessCategorySecondary:'人物身份',acceptanceCriteria:['旧版本原始要求']},{legacy:true});
 const before=structuredClone(frozen);
 const {configuration:c,audit}=reorganizeStandards(original,defaultConfiguration(),[frozen]);
 validateConfiguration(c,original);
 assert.deepEqual(frozen,before);
 assert.equal(audit.length,original.reviewProfiles.length);
 assert(!c.reviewProfiles.some(p=>p.id===legacy.id));
 const type=c.taxonomy.categories[0].types.find(t=>t.id==='identity');
 const p=c.reviewProfiles.find(p=>p.id===type.reviewProfileId);
 assert.equal(p.criteria[0].question,'服装保留已批准的深蓝外衣');
 assert(!JSON.stringify(exportConfigurationTemplate(c)).includes('深蓝外衣'));
 validateConfiguration(exportConfigurationTemplate(c).configuration);
 // A user-authored unrelated template must remain even without current objects.
 original.reviewProfiles.push({...legacy,id:'material-custom-unique',label:'特殊视觉参考'});
 assert(reorganizeStandards(original,defaultConfiguration()).configuration.reviewProfiles.some(p=>p.id==='material-custom-unique'));
});
test('a customized alias is not silently co-edited with another video standard',()=>{
 const c=defaultConfiguration();const branch=structuredClone(c.reviewProfiles.find(p=>p.deliverableKey==='SHOT_VIDEO'));branch.id='production-audio_driven_video';branch.deliverableKey='AUDIO_DRIVEN_VIDEO';branch.criteria[0].question='定制的音频驱动表达要求';c.reviewProfiles.push(branch);
 const nodes=flatten(reviewCatalog(c));
 const common=nodes.find(n=>n.profileIds?.includes('production-shot_video'));
 assert(!common.profileIds.includes('production-audio_driven_video'));
 assert(nodes.some(n=>n.profileIds?.includes('production-audio_driven_video')));
});

test('legacy delivery metadata is not injected into new review questions',()=>{
 const c=defaultConfiguration();
 c.technical.delivery={platform:'抖音',audience:'测试受众',codec:'H.264',color:'Rec.709',loudness:'-14 LUFS',confirmation:'SUGGESTED'};
 const spec=reviewSpec(c,'WORK_PRODUCT',{deliverableKey:'EPISODE_TECH_QC_REPORT'});
 const text=spec.criteria.map(row=>row.question).join('\n');
 assert.match(text,/本对象制作基线/);
 assert(!text.includes('抖音'));assert(!text.includes('测试受众'));assert(!text.includes('-14 LUFS'));
});

test('necessary canonical standards cannot be deleted from a current template',()=>{
 const c=defaultConfiguration();c.reviewProfiles=c.reviewProfiles.filter(p=>p.id!=='production-shot_video');assert.throws(()=>validateConfiguration(c),/缺少必要/);
});
