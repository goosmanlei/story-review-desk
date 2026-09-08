import { deliveryAliases, deliveryLabels, materialStandards, reviewCatalog } from './review-standard-catalog.mjs';
const criteria=(rows)=>rows.map(([id,label,question])=>({id,label,question,required:true,allowNA:false,noteRequiredOnFail:true}));
const production={
 SHOT_PLAN_SET:[['coverage','节拍覆盖','镜头安排是否完整覆盖已确认的场级镜头意图，且每镜都有明确作用？'],['shootability','可执行性','景别、机位、动作、对白与空间安排是否能实际制作并连贯剪辑？'],['input-readiness','输入齐备','每镜需要的人物、地点、道具和声音输入是否明确，缺项是否已说明？']],
 STORYBOARD:[['narrative-fit','画面表达','画面是否准确表达本镜行动和观众应获得的信息？'],['identity-space','人物与空间','人物身份、人数、站位、机位和轴线是否符合已锁定依据？'],['action-continuity','动作与衔接','动作、视线和道具状态是否能接住前后镜？'],['image-quality','画面质量','是否没有影响理解的肢体错误、镜像、乱码或身份漂移？']],
 DIALOGUE_DRY:[['line-match','台词准确','对白是否符合已锁定文本，没有增词、漏词或改词？'],['voice-performance','角色与表演','音色、口音、情绪和停顿是否符合说话者与当前处境？'],['audio-quality','清楚干净','咬字是否清楚，没有底噪、爆音、截断或多余背景声？']],
 STORYBOARD_DIALOGUE_PACKAGE:[['coverage','内容齐套','所需粗分镜和适用对白是否全部经过各自验收？'],['alignment','相互对应','画面节拍与对白顺序、说话者和反应位置是否一一对应？']],
 ANIMATIC_TIMING_LOCK:[['narrative-fit','场景表达','完整预演是否实现本场叙事任务，信息清楚且没有提前揭晓？'],['scene-continuity','前后衔接','动作、视线、空间和道具状态是否连贯？'],['timing','节奏与对白','逐镜时长、对白入出点、反应余量和转场是否自然？'],['timing-lock','锁时条件','当前预演是否足以作为后续画面与声音制作的共同时间基线？']],
 START_FRAME:[['frame-role','动作起点','首帧是否呈现动作开始前的正确状态，没有提前出现结果？'],['identity-space','人物与空间','人物、服装、地点、机位与关键道具是否符合已采用参考？'],['motion-room','运动余量','构图、遮挡和肢体姿态是否支持向尾帧自然运动？'],['image-quality','画面质量','画面是否清晰完整，没有身份漂移、手部错误、镜像或意外文字？']],
 END_FRAME:[['frame-role','动作终点','尾帧是否呈现本镜动作结束后的正确状态？'],['frame-continuity','首尾一致','身份、服装、空间、光线和固定物件是否与首帧一致，仅发生允许的变化？'],['next-handoff','下镜衔接','结束姿态、视线和道具状态是否能接入下一镜？'],['image-quality','画面质量','画面是否清晰完整，没有身份漂移、肢体错误或意外文字？']],
 SHOT_KEYFRAME_SET:[['pair-completeness','首尾齐套','首帧与尾帧是否分别通过验收，并对应同一镜头和时间范围？'],['motion-feasibility','运动可达','首尾之间的动作变化是否可实现，没有空间或状态跳变？']],
 SHOT_VIDEO:[['narrative-fit','镜头表达','动作、表情与镜头运动是否实现已确认的镜头意图？'],['identity-space-motion','身份与运动','人物、空间、方向及运动轨迹是否稳定，并符合首尾帧？'],['timing-performance','时长与节奏','动作节奏、停顿和表演是否符合锁定时长及人物处境？'],['frame-handoff','起止衔接','开始与结束状态是否准确承接已确认首尾帧？'],['video-quality','视频质量','是否没有滑步、畸变、闪烁、异常口动、字幕或水印？']],
 LOCKED_SHOT:[['picture-complete','镜头完整','本镜画面是否完成应有表达，起止状态可接入剪辑？'],['continuity','连续一致','采用的画面和适用声音是否符合本镜已锁定输入？'],['lip-branch','对白与口型','需要口型时，是否已完成对应分支检查；无需口型时是否保持自然口部状态？']],
 POST_LIP_VIDEO:[['speaker-sync','口型同步','说话者的口型是否与锁定干声的句首、句尾、停顿和发音同步？'],['other-faces','其他人物稳定','非说话者是否没有抢口型或异常面部运动？'],['picture-preservation','画面保持','口型处理是否保留已通过的身份、动作、空间、时长和画质？']],
 SCENE_PICTURE_LOCK_EDL:[['scene-expression','场景表达','场剪辑是否实现本场任务，行动、信息与情绪清晰？'],['scene-continuity','剪辑连续','动作、视线、空间、道具状态和镜头衔接是否连贯？'],['edit-list','剪辑表准确','剪辑表是否逐项对应实际画面，包含准确的镜头、版本和入出点？'],['picture-lock','画面可锁定','镜头顺序、时长及人物信息卡是否已确定，足以开始同步声音制作？']],
 SCENE_SOUND_MIX_SUBTITLES:[['dialogue','对白清晰','完整场景中对白是否自然清楚，不被其他声音遮蔽？'],['sync','声音同步','拟音、事件声和声源方向是否与锁定画面准确对应？'],['acoustics','空间与层次','环境、混响、远近和配乐层次是否符合场景且过渡自然？'],['mix-quality','混音质量','音量与动态是否适合已确认规格，没有爆音、截断或突变？']],
 SUBTITLE_FILE:[['text-match','文字准确','字幕是否符合锁定对白与已确认写法，没有错漏、擅改或提前剧透？'],['subtitle-sync','时间同步','字幕入出点是否与对白匹配，持续时间是否便于阅读？'],['layout','排版可读','断行、字体、位置与安全区是否清晰，并避开人物信息卡和关键画面？'],['output-quality','文件可用','字幕编码、格式和时间基线是否符合交付要求，能与对应成片正确加载？']],
 AUDIO_STEMS:[['content','分轨内容','对白、环境、拟音和配乐是否按要求独立导出，没有漏声或混入其他轨道？'],['alignment','时间对齐','各轨起点、时长和同步事件是否与锁定画面及最终混音一致？'],['audio-quality','声音质量','采样、声道与音量是否符合已确认规格，没有爆音、截断或异常静音？']],
 SCENE_QA_REPORT:[['picture-sound-text','音画字幕','完整场景的画面、声音和字幕是否匹配且可正常观看？'],['continuity','场景连续','动作、空间、人物和道具状态是否连贯，问题是否已有处理结论？'],['report-evidence','结论与证据','检查范围、所审版本、发现的问题和处理结果是否清楚且有对应证据？']],
 EPISODE_MASTER:[['scene-completeness','场景齐套','当前分集方案要求的场景是否齐全且采用已放行版本？'],['assembly-order','组装顺序','场次顺序、入出点与集边界是否符合当前分集方案？'],['assembly-handoff','连接完整','场间音画是否正确连接，没有缺段、重段、黑帧或异常静音？']],
 EPISODE_REVIEW_DECISION:[['episode-purpose','本集表达','成片是否实现本集任务，并兑现应有的阶段回报？'],['rhythm','节奏与表演','事件推进、表演和情绪变化是否自然，是否存在拖沓或理解困难？'],['information','信息与因果','人物行动、观众知情顺序和线索回收是否清楚、自洽？'],['boundaries','开场与结尾','开场承接和结尾停点是否有效；首集能否独立建立，末集能否完成收束？']],
 EPISODE_TECH_QC_REPORT:[['picture-technical','画面规格','画幅、尺寸和帧率是否符合当前画面基线，编码与色彩是否已对实际文件完成检查？'],['audio-technical','声音规格','声道、采样、响度和峰值是否已对实际文件完成检查并记录结果？'],['playback','播放与同步','完整文件是否可正常解码播放，音画及字幕是否同步？'],['report-evidence','检查证据','报告是否对应实际交付文件，并清楚记录检查结果和未解决问题？']],
 TECHNICAL_REPORT:[['target','检查对象','报告是否明确检查的对象、文件版本及适用技术要求？'],['measurements','实测证据','检查结果是否有实际测量或工具输出支持，未检查项是否明确标为待确认？'],['conclusion','结论完整','通过项、异常项及处理结果是否清楚，结论是否与证据一致？']],
 SERIES_CONTINUITY_REPORT:[['story-continuity','剧情连续','跨集人物关系、时间线、事件因果和结局是否一致？'],['visual-continuity','画面连续','人物、地点、道具及关键状态是否在跨集衔接处一致？'],['information','信息衔接','跨集线索、知情顺序、铺垫与回收是否成立？'],['issues','问题闭合','连续性问题是否定位到具体集与时间段，并已有处理结论？']],
 CONTINUITY_REPORT:[['scope','检查范围','报告是否明确对象和前后衔接范围？'],['continuity','连续性依据','人物、动作、空间和状态的检查是否有实际画面或权威资料支持？'],['issues','问题与结论','问题位置、影响范围和处理结果是否清楚，结论是否与证据一致？']],
 FINAL_RIGHTS_SAFETY_TECH_REPORT:[['rights','发行权利','全部采用内容是否具备目标发行用途的权利依据，项目内部确认是否仍与发行授权分开？'],['safety','内容尺度','敏感内容和人物表现是否符合已确认的平台、受众与尺度要求？'],['technical','技术终检','发行规格和技术检查是否齐备，未确认或未通过事项是否继续阻断交付？']],
 DELIVERY_MANIFEST_ARCHIVE:[['completeness','交付齐套','分集母版、字幕、分轨和所需报告是否按最终清单齐全交付？'],['version-match','版本对应','清单是否逐项对应实际交付文件及其已批准版本？'],['traceability','来源可追溯','文件校验值、采用依据、审阅记录和必要制作资料是否足以追溯交付来源？']],
};
const materialQuestions={
 identity:['年龄、身份和成年外观是否符合角色设定？','脸型、体态、发式和服装是否稳定，能作为后续身份参考？','是否没有误复制其他无亲缘角色的面部特征？','参考来源、身份隔离和实际文件规格是否满足当前要求？'],
 'information-card':['文字是否逐字符合已登记内容，没有错漏或扩写？','出现时机是否符合首次清晰出场或已确认变体，不提前剧透？','版式、字号与对比度是否便于短时阅读，并继承已采用模板？','透明边缘和输出质量是否满足合成要求，没有水印或多余人物肖像？'],
 extras:['年龄、职业与外观是否符合群体设定？','人物是否有必要区分，没有重复人脸或误用主要角色身份？','服装、人数、动作与画面质量是否满足使用要求？','参考来源与授权事实是否可追溯？'],
 'empty-location':['门向、区域、机位和固定物件是否符合空间依据？','是否保持空态，没有混入单场人物或临时状态？','方位和轴线是否一致，没有镜像？','尺寸、构图和固定物件是否支持后续合成？'],
 'location-state':['空间布局是否继承已采用地点空态？','人物、关键物件及事件状态是否符合当前冻结时点？','是否仅改变当前时点允许变化的元素？','状态是否可以准确接入使用场次及前后镜？'],
 'key-prop':['造型、时代、材质、尺寸和用途是否符合当前依据？','关键特征是否清楚且可以跨镜识别？','是否未混入其他时间点或场次的状态？','细节、画质与合成条件是否满足实际使用？'],
 'prop-state':['当前状态是否符合已确认事件和使用时点？','变化是否符合物理关系和已采用道具母版？','前后状态是否连续，没有新增无依据的信息？','细节和画面质量是否支持后续合成？'],
 'voice-identity':['年龄、身份、性格和口音是否符合角色设定？','音色是否自然、稳定、清楚且不模仿未经授权的真人？','是否没有多余台词、背景声或异常表演？','参考授权与技术规格是否满足当前要求？'],
 'ambience-bed':['地点、时辰、天气和空间声学是否符合已锁定设定？','是否没有动作同步事件、对白或可识别音乐？','循环接缝是否自然，声音质量是否满足要求？','是否适合作为可复用底声，且没有被当作最终混音？'],
 'action-foley':['动作材质与力度是否符合锁定画面？','同步点、远近和声源方向是否准确？','是否没有添加画面中不存在的事件？','分轨、技术规格和参考来源是否符合要求？'],
 'original-music':['配乐是否服务当前段落的叙事作用？','是否没有提前揭晓悬念或持续遮蔽对白与表演？','旋律、演奏和声音来源是否原创且可追溯？','分轨、循环或收束是否适合锁定剪辑？'],
 'style-anchor':['时代、季节、色调和摄影质感是否符合当前风格设定？','是否没有可误认作剧情身份的无关人脸？','服化材质和光线是否足以稳定复用？','是否没有乱码、镜像或其他明显生成瑕疵？'],
};
export function standardDefaults(configuration) {
 const c=structuredClone(configuration);
 c.template.version='1.1';
 c.reviewProfiles=c.reviewProfiles.filter(p=>p.deliverableKey!=='LOC_STATE' && !deliveryAliases[p.deliverableKey]).map(p=>{
  if(p.subjectKind!=='WORK_PRODUCT')return p;
  const key=deliveryAliases[p.deliverableKey] || p.deliverableKey;
  return production[key]?{...p,label:deliveryLabels[key] || p.label,criteria:criteria(production[key])}:p;
 });
 for(const [id,label,,titles] of materialStandards){
  if(!materialQuestions[id])continue; // Story-specific types are authored by the instance migration.
  c.reviewProfiles.push({id:`material-type-${id}`,label,subjectKind:'ASSET',criteria:criteria(materialQuestions[id].map((question,i)=>[`check-${i+1}`,titles[i],question]))});
 }
 for(const cat of c.taxonomy.categories)for(const t of cat.types){
  if(c.reviewProfiles.some(p=>p.id===`material-type-${t.id}`))t.reviewProfileId=`material-type-${t.id}`;
 }
 return c;
}
// An explicit draft transformation. Publishing still uses the normal CAS/preview transaction.
export function reorganizeStandards(configuration, defaults, frozenSpecs=[]) {
 const c=structuredClone(configuration), audit=[];
 const replacements=new Map();
 for(const p of c.reviewProfiles){
  const base=defaults.reviewProfiles.find(x=>x.id===(deliveryAliases[p.deliverableKey] ? `production-${deliveryAliases[p.deliverableKey].toLowerCase()}` : p.id));
  if(base && p.subjectKind==='WORK_PRODUCT' && production[deliveryAliases[p.deliverableKey] || p.deliverableKey]){
   p.label=base.label;p.criteria=structuredClone(base.criteria);
  }
 }
 for(const [id,label,legacyLabel,titles] of materialStandards){
  const previous=c.reviewProfiles.find(p=>p.label===legacyLabel);
  if(!previous)continue;
  const profile={...structuredClone(previous),id:`material-instance-${id}`,label,criteria:previous.criteria.map((r,i)=>({...r,label:titles[i] || `检查 ${i+1}`,question:r.question.replaceAll('UNKNOWN','待确认').replaceAll('G1尺度','已确认的内容尺度').replaceAll('G1表现边界','已确认的表现尺度').replaceAll('QA','质量检查').replaceAll('card_spec','已登记卡片内容').replaceAll('Animatic','场级预演').replaceAll('LOC、ZONE、CAM','地点、区域、机位')}))};
  // Do not replace a pre-existing customized current type on rerun.
  if(!c.reviewProfiles.some(x=>x.id===profile.id))c.reviewProfiles.push(profile);
  const categoryType=c.taxonomy.categories.flatMap(cat=>cat.types).find(t=>t.label===label || t.label===(label==='风格参考'?'风格锚点':label));
  if(categoryType)categoryType.reviewProfileId=profile.id;
  replacements.set(previous.id,profile.id);
 }
 // Fill only missing type defaults. Existing bespoke profiles remain authoritative.
 for(const cat of c.taxonomy.categories)for(const t of cat.types){
  const base=defaults.reviewProfiles.find(p=>p.id===`material-type-${t.id}`);
  if(base && /^material-(image|audio|video|text)$/.test(t.reviewProfileId)){
   if(!c.reviewProfiles.some(p=>p.id===base.id))c.reviewProfiles.push(structuredClone(base));
   t.reviewProfileId=base.id;
  }
 }
 const activeRefs=new Set(c.taxonomy.categories.flatMap(cat=>cat.types.map(t=>t.reviewProfileId)));
 for(const p of configuration.reviewProfiles){
  const canonical=deliveryAliases[p.deliverableKey];
  const replacement=replacements.get(p.id) || (canonical ? `production-${canonical.toLowerCase()}` : null);
  const retire=(replacement || p.deliverableKey==='LOC_STATE') && !activeRefs.has(p.id);
  const historical=frozenSpecs.filter(s=>s.profileId===p.id).length;
  if(retire)c.reviewProfiles=c.reviewProfiles.filter(x=>x.id!==p.id);
  audit.push({profileId:p.id,label:p.label,action:retire?'RETIRED':p.subjectKind==='WORK_PRODUCT'?'GROUPED_AND_REFINED':replacement?'SPECIALIZED':'RETAINED',replacementProfileId:replacement || (p.deliverableKey==='LOC_STATE' ? c.taxonomy.categories.flatMap(cat=>cat.types).find(t=>t.label==='地点状态')?.reviewProfileId || null : null),frozenReferenceCount:historical,reason:retire?'专属内容已归位；旧配置及冻结标准保留':p.subjectKind==='WORK_PRODUCT'?'按门禁归组，保留独立验收身份':'保留必要标准'});
 }
 c.template.version='1.1';
 const tree=reviewCatalog(c);
 const pathFor=(nodes,id,path=[])=>{for(const n of nodes){if(n.profileIds?.includes(id))return [...path,n.label];const found=pathFor(n.children || [],id,[...path,n.label]);if(found)return found;}return null;};
 for(const row of audit)row.destinationPath=pathFor(tree,row.replacementProfileId || row.profileId) || ['历史配置'];
 return {configuration:c,audit};
}
