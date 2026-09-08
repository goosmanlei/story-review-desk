// Only new, explicitly versioned production objects use these standards.
// Existing configuration profiles and frozen work-item review hashes are unchanged.
export function shotPrevisReviewProfile(work){
 if(work?.productionSchemaVersion!=='2.0'||work.stagePolicy!=='PREVIS_FIRST_V1')return null;
 const profiles={
  STORYBOARD:['粗分镜预演',[
   ['narrative-fit','画面表达','画面是否表达本镜目的、行动与观众所得，遵守当前正文的信息释放顺序？'],
   ['previs-composition','构图与动作','景别、人物位置、视线、动作方向和前后镜关系是否清楚，并符合当前镜头设计？'],
   ['previs-boundary','依据与未知','是否遵守已确认的身份和空间事实；尚未确定的正式母版、局部空间是否仍明确为待确认？'],
   ['previs-legibility','预演可读性','实际原图是否足以在预演中辨认主体和动作，没有影响理解的遮挡、变形或误导？'],
   ['previs-use','使用范围','实际选用参考是否具备项目内使用依据；本产物是否仅供预演锁时，不作为正式身份、关键帧或交付画面？'],
  ]],
  DIALOGUE_TEMP:['临时对白',[
   ['line-match','台词与说话者','实际声音是否逐字符合本句文本并对应正确说话者，没有增词、漏词或改词？'],
   ['timing-performance','表演与节奏','语气、停顿、重音与情绪是否足以验证本句和接话节奏？'],
   ['audio-quality','完整可懂','实际音频是否完整、清楚，没有截断、爆音或妨碍锁时的多余声音？'],
   ['previs-use','来源与用途','原创或参考声音的使用依据是否明确；是否仅用于预演锁时，不作为正式声纹或最终对白？'],
  ]],
  SHOT_INPUT_LOCK:['本镜正式视觉输入',[
   ['input-versions','实际视觉输入','本镜必需视觉素材是否完整绑定已采用的族、版本、SHA及实际注册文件？'],
   ['space-binding','空间与状态','本镜地点、状态、区域、机位和冻结时点是否与已发布空间依据精确一致？'],
   ['input-use','用途与权利','这些实际输入是否具备本镜正式关键帧使用资格，并排除仅供预演的素材？'],
  ]],
 };
 const value=profiles[work.deliverableKey];if(!value)return null;
 return {id:`production-${work.deliverableKey.toLowerCase()}-previs-v1`,label:value[0],subjectKind:'WORK_PRODUCT',deliverableKey:work.deliverableKey,criteria:value[1].map(([id,label,question])=>({id,label,question,required:true,allowNA:false,noteRequiredOnFail:true}))};
}
