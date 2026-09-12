import {check,hash} from '../shared/contracts.mjs';

const labels={description:'档案说明',text:'正文',blocks:'正文段落',purpose:'用途',slugline:'场景标题',storyTime:'故事时间',viewpoint:'视角',audienceKnown:'观众已知',audienceWithheld:'暂不揭示',transition:'衔接',openingHook:'开场钩子',coreAdvance:'核心推进',endingCliffhanger:'结尾悬念',reviewQuestion:'审阅问题',aliases:'别名',dimensions:'特征',acceptanceCriteria:'验收要求',notes:'说明',note:'说明',summary:'摘要',content:'内容',shots:'镜头',scenes:'场次',speaker:'说话人',performanceNote:'表演提示',type:'类型',name:'名称',label:'名称'};
const allowed={
 ENTITY:['description','aliases','dimensions'],STATE:['description','dimensions'],REPRESENTATION:['description','dimensions'],SPACE:['description'],RELATION:['description','purpose','inherit','exclude'],
 SCENE:['blocks','slugline','purpose','storyTime','viewpoint','audienceKnown','audienceWithheld','transition'],EPISODE:['openingHook','coreAdvance','endingCliffhanger','reviewQuestion'],
 PREPARATION:['sceneRole','audienceTakeaway','informationBoundary','beats','visualIntent','soundAndDialogueIntent','entityStateRequirements','timeAndSpace','materialGaps','nextPreparationAction','reviewFocus'],SHOT_DESIGN:['text','description','summary','notes','shots'],
 REQUIREMENT:['description','acceptanceCriteria','notes'],MATERIAL:['description','notes'],PROMPT:['text'],COMMENT:['text'],
};
const equal=(a,b)=>hash(a??null)===hash(b??null);
function readable(value){if(value===undefined||value===null)return '（空）';if(typeof value!=='object')return String(value);if(Array.isArray(value))return value.map(readable).join('\n');return Object.entries(value).map(([k,v])=>(labels[k]||k)+'：'+readable(v)).join('\n');}
export function normalizeChangePreview(request,object,value){
 if(request.assistant.mode!=='EXECUTE'){value.patch={};value.purpose='ASSISTANT_DISCUSSION';return;}
 const keys=Object.keys(value.patch),fields=[];
 check(keys.every(k=>allowed[object.kind]?.includes(k)),'ASSISTANT_PATCH_SCOPE','建议包含当前对象不可直接编辑的字段，请在对应编辑页处理');
 for(const key of keys){const before=object.revision.content[key],after=value.patch[key];if(!equal(before,after))fields.push({label:labels[key]||key,before:readable(before),after:readable(after)});}
 check(fields.length<=50&&Buffer.byteLength(JSON.stringify(fields))<=160000,'ASSISTANT_PREVIEW_LIMIT','修改过多，请按对象或段落分批预览');
 value.changePreview={objectId:object.id,title:object.title,expectedVersion:object.version,revisionId:object.revision.id,fields};
 value.configurationVersions=request.assistant.context.configurationVersions;
 value.purpose='ASSISTANT_DRAFT_CHANGE';
}
