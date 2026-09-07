// Pure configuration presentation shared by the server and the draft editor.
// Stable business identities and frozen review specs are never changed by this catalog.
export const materialStandards = [
  ['identity','人物身份','CHARACTER_IDENTITY',['身份与外观','身份稳定','角色区分','参考与规格']],
  ['information-card','人物信息卡','CHARACTER_INFO_CARD',['文字准确','出现时机','版式可读','合成质量']],
  ['extras','群演身份','CAST_IDENTITY',['身份与外观','人物区分','画面质量','参考来源']],
  ['empty-location','地点空态','LOCATION_EMPTY',['空间布局','空态纯净','方位一致','合成条件']],
  ['location-state','地点状态','LOCATION_STATE_REFERENCE',['空间继承','状态准确','变化范围','前后衔接']],
  ['key-prop','关键道具','PROP_IDENTITY',['造型与用途','身份稳定','状态边界','制作质量']],
  ['prop-state','道具状态','PROP_STATE',['状态准确','变化合理','前后衔接','制作质量']],
  ['voice-identity','声音身份','VOICE_IDENTITY',['角色与口音','音色稳定','声音干净','参考与规格']],
  ['ambience-bed','环境底声','AMBIENCE_LOOP',['环境符合','内容纯净','循环自然','使用范围']],
  ['action-foley','动作拟音','ACTION_FOLEY',['材质与力度','动作同步','事件准确','分轨与来源']],
  ['original-music','原创配乐','ORIGINAL_MUSIC',['叙事作用','情绪与信息','原创来源','剪辑适配']],
  ['style-anchor','风格参考','STYLE_ANCHOR',['风格符合','身份隔离','材质与光线','画面质量']],
  ['head-proxy','首级代理','HEAD_PROXY',['身份与位置','容器状态','信息边界','尺度与来源']],
  ['body-state','尸身状态','BODY_STATE',['身份与状态','表现尺度','信息边界','连续性与来源']],
  ['religious-set-dressing','宗教陈设','RELIGIOUS_SET_DRESSING',['身份与位置','叙事用途','造型依据','连续性']],
];
export const productionGroups = [
  ['PREVIS','镜头方案与预演',[
    ['SHOT_PLAN_INPUT_LOCK','镜头设计与输入锁定',['SHOT_PLAN_SET']],
    ['STORYBOARD_DIALOGUE','粗分镜与对白并行',['STORYBOARD','DIALOGUE_DRY','STORYBOARD_DIALOGUE_PACKAGE']],
    ['ANIMATIC_LOCK','场级预演与锁时',['ANIMATIC_TIMING_LOCK','ANIMATIC']],
  ]],
  ['SHOT_FINISH','镜头成品',[
    ['KEYFRAMES','正式首尾帧',['START_FRAME','END_FRAME','SHOT_KEYFRAME_SET']],
    ['SHOT_VIDEO','镜头视频',['SHOT_VIDEO','MOTION_VIDEO','PRE_LIP_VIDEO','AUDIO_DRIVEN_VIDEO','NO_LIP_VIDEO']],
    ['SHOT_LOCK','单镜锁定',['LOCKED_SHOT','POST_LIP_VIDEO']],
  ]],
  ['SCENE_FINISH','场景成片',[
    ['PICTURE_LOCK','场剪辑与画面锁定',['SCENE_PICTURE_LOCK_EDL']],
    ['SOUND_MIX_SUBTITLES','场声音、混音与字幕',['SCENE_SOUND_MIX_SUBTITLES','SCENE_SOUND_POST','SUBTITLE_FILE','AUDIO_STEMS']],
    ['SCENE_QA','场级质量检查',['SCENE_QA_REPORT']],
  ]],
  ['EPISODE_FINISH','分集成片',[
    ['EPISODE_ASSEMBLY','分集组装',['EPISODE_MASTER','EPISODE_DELIVERY_MASTER']],
    ['EPISODE_REVIEW','分集审阅',['EPISODE_REVIEW_DECISION']],
    ['EPISODE_TECH_QC','分集技术检查',['EPISODE_TECH_QC_REPORT','TECHNICAL_REPORT']],
  ]],
  ['SERIES_DELIVERY','全剧交付',[
    ['SERIES_CONTINUITY','跨集连续性',['SERIES_CONTINUITY_REPORT','CONTINUITY_REPORT']],
    ['RIGHTS_SAFETY_TECH','权利、敏感内容与技术终检',['FINAL_RIGHTS_SAFETY_TECH_REPORT']],
    ['DELIVERY_ARCHIVE','交付归档',['DELIVERY_MANIFEST_ARCHIVE','PROJECT_DELIVERY_MANIFEST']],
  ]],
];
export const deliveryAliases = {
  ANIMATIC:'ANIMATIC_TIMING_LOCK', MOTION_VIDEO:'SHOT_VIDEO', PRE_LIP_VIDEO:'SHOT_VIDEO', AUDIO_DRIVEN_VIDEO:'SHOT_VIDEO', NO_LIP_VIDEO:'SHOT_VIDEO',
  SCENE_SOUND_POST:'SCENE_SOUND_MIX_SUBTITLES', EPISODE_DELIVERY_MASTER:'EPISODE_MASTER', PROJECT_DELIVERY_MANIFEST:'DELIVERY_MANIFEST_ARCHIVE',
};
export const deliveryLabels = Object.fromEntries([
  ...productionGroups.flatMap(([, , gates])=>gates.map(([, label, keys])=>[keys[0],label])),
  ['STORYBOARD','粗分镜'],['DIALOGUE_DRY','对白干声'],['STORYBOARD_DIALOGUE_PACKAGE','分镜与对白齐套'],
  ['START_FRAME','首帧'],['END_FRAME','尾帧'],['SHOT_KEYFRAME_SET','首尾帧齐套'],['LOCKED_SHOT','单镜锁定'],['POST_LIP_VIDEO','口型修正'],
  ['SCENE_SOUND_MIX_SUBTITLES','场声音与混音'],['SUBTITLE_FILE','字幕'],['AUDIO_STEMS','声音分轨'],
  ['TECHNICAL_REPORT','附加技术报告'],['CONTINUITY_REPORT','附加连续性报告'],['LOC_STATE','地点状态（旧制作标准）'],
]);
const materialLabel = new Map(materialStandards.map(([,label,legacy])=>[legacy,label]));
export function standardLabel(profile) {
  if (!profile) return '历史审阅标准';
  return materialLabel.get(profile.label) || (/[\u4e00-\u9fff]/.test(profile.label) ? profile.label : deliveryLabels[deliveryAliases[profile.deliverableKey] || profile.deliverableKey]) || '自定义审阅标准';
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const equal = (a,b) => JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export function reviewCatalog(configuration) {
  const profiles=configuration.reviewProfiles;
  const seen=new Set();
  const leaf=(p, label=standardLabel(p), peers=[p])=>{
    peers.forEach(x=>seen.add(x.id));
    return {id:p.id,label,profileIds:peers.map(x=>x.id),subjectKind:p.subjectKind,condition:p.deliverableKey==='POST_LIP_VIDEO'?'仅适用于需要后置口型修正的镜头':p.deliverableKey==='SHOT_VIDEO'?'所有镜头检查画面；有对白时按已锁定的音频驱动或后置口型分支继续验收':p.deliverableKey==='DIALOGUE_DRY'?'仅适用于有对白的镜头':'',children:[]};
  };
  const story=profiles.filter(p=>['EPISODE_PLAN','SCRIPT_SCENE'].includes(p.subjectKind)).map(p=>leaf(p));
  const materials=configuration.taxonomy.categories.map(cat=>({id:cat.id,label:cat.label,children:cat.types.flatMap(t=>{
    const p=profiles.find(p=>p.id===t.reviewProfileId);
    if(!p)return [];
    const entry=leaf(p,t.label);
    return [{...entry,id:`type:${t.id}`}];
  })}));
  const production=productionGroups.map(([id,label,gates])=>({id,label,children:gates.map(([id,label,keys])=>({id,label,children:keys.flatMap(key=>{
    const p=profiles.find(p=>p.deliverableKey===key);
    if(!p || seen.has(p.id))return [];
    const canonical=deliveryAliases[key] || key;
    const peers=profiles.filter(x=>(deliveryAliases[x.deliverableKey] || x.deliverableKey)===canonical && equal(x.criteria,p.criteria));
    return [leaf(p,standardLabel(p),peers)];
  })}))}));
  const common=profiles.filter(p=>p.subjectKind==='ASSET' && !seen.has(p.id) && !p.id.startsWith('material-legacy-')).map(p=>leaf(p));
  if(common.length)materials.push({id:'common-materials',label:'通用与自定义标准',children:common});
  const historical=profiles.filter(p=>!seen.has(p.id)).map(p=>leaf(p));
  if(historical.length)materials.push({id:'legacy-standards',label:'旧版与待归类标准',children:historical});
  return [{id:'story',label:'故事审阅',children:story},{id:'materials',label:'素材审阅',children:materials},{id:'production',label:'制作审阅',children:production}];
}
export function leafForProfile(nodes,id) {
  for(const node of nodes){if(node.profileIds?.includes(id))return node;const found=leafForProfile(node.children || [],id);if(found)return found;}
  return null;
}
