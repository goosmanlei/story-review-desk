import {CREATOR_PRODUCTION_STAGES} from './creator-production-workflow.mjs';

// One ownership catalogue for work status, help and assistant metadata. It never
// changes frozen canonical gate identities, review decisions or input bindings.
export const WORKSPACE_MODULES = Object.freeze([
 {id:'STORY_CREATION',label:'故事创作',href:'?view=story&storyMode=source',responsibility:'来源资料、故事结构、分集候选与正文评论；审阅输入、正式裁决和受控源同步分别留痕。'},
 {id:'STORY_SETTINGS',label:'故事设定',href:'?view=settings',responsibility:'主体档案、空间与关系共用永久身份。Codex按明确选择的当前资料抽取建议，经保存、预览和确认维护设定。'},
 {id:'WORLD_AND_MATERIALS',label:'素材管理',href:'?view=materials&materialMode=classification',responsibility:'按实体、集和场组织素材需求、生产资料、实际版本与正式审阅；关联不代表放行。'},
 {id:'FULL_PRODUCTION',label:'全剧制作',href:'?view=pipeline',responsibility:'镜头制作、场景剪辑、分集成片；设计采用、精确输入锁定和实际生成分别判断。'},
].map(Object.freeze));
const rows=value=>Array.isArray(value)?value:[];
const unique=(value,key='id')=>Array.isArray(value)?new Set(value.map(row=>row?.[key]).filter(value=>typeof value==='string'&&value)).size:null;
const numeric=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const count=(id,label,value,boundary)=>({id,label,value:numeric(value),boundary});
export const WORKSPACE_BOUNDARIES = Object.freeze([
 '本地实例的已发布数据库修订是业务权威；读取投影可重建，旧物理文档不是第二套当前源。',
 '正文评论、审阅输入、正式 ReviewEvent、受控源同步、生成授权和实际产物是独立事实；准备稿或候选不能成为正式分母。',
 '设计可以准备或按明确授权采用；实际生成仍需精确素材版本、SHA、权利和本轮授权全部成立。',
 'UNKNOWN 不填猜测。原图、音频和视频未实际观察就不声称已看、已听或已验证。',
 'Web 只提交受控请求；模型调用、媒体操作与正式源同步由所属主机工作器执行。结果未知先核查，不自动重试。',
 '只读镜像仅展示已发布状态，不接受正式审阅、候选登记、生产执行或源同步写入。',
]);

/** Inputs are the canonical narrative resolver result and the operationally
 * validated episode release projection. Raw candidate/review events are not
 * sufficient evidence of either currentness or a completed source sync.
 * @param {any} resolvedPlan
 * @param {any} releasesByUid
 * @param {string|null} [resolutionError]
 */
export function projectStoryProgress(resolvedPlan,releasesByUid,resolutionError=null){
 const unknown={schemaVersion:'1.0',state:resolutionError?'UNAVAILABLE':'UNKNOWN',sourceRole:null,revisionId:null,contentHash:null,
  episodeCount:null,sceneCount:null,releasedEpisodeCount:null,releasedSceneCount:null,releaseIds:[],formalDenominatorState:'UNKNOWN',
  headline:resolutionError?'当前分集候选不可读取；不回退历史库存':null,nextAction:null};
 if(!resolvedPlan||!['CANDIDATE','CURRENT','PROPOSAL'].includes(resolvedPlan.sourceRole))return unknown;
 const episodes=rows(resolvedPlan.content?.episodes),uids=episodes.map(episode=>episode.episodeUid),sceneIds=episodes.flatMap(episode=>rows(episode.sceneIds));
 const validId=value=>typeof value==='string'&&value.length>0;
 if(!validId(resolvedPlan.revisionId)||!episodes.length||!uids.every(validId)||new Set(uids).size!==uids.length
  ||!sceneIds.length||!sceneIds.every(validId)||new Set(sceneIds).size!==sceneIds.length
  ||episodes.some(episode=>!Array.isArray(episode.sceneIds)||!episode.sceneIds.length))return {...unknown,state:'UNAVAILABLE'};
 const byUid=new Map(episodes.map(episode=>[episode.episodeUid,episode]));
 const releaseProjectionAvailable=releasesByUid&&typeof releasesByUid==='object'&&!Array.isArray(releasesByUid);
 const released=Object.entries(releaseProjectionAvailable?releasesByUid:{}).filter(([uid,release])=>{
  const episode=byUid.get(uid),actual=rows(release?.reviewInput?.scenes).map(scene=>scene.id);
  return episode&&release?.episodeUid===uid&&release.state==='READY'&&release.canFlowDownstream===true
   &&release.scopeRole==='CURRENT'&&release.sourceSyncState==='SOURCE_CURRENT'
   &&validId(release.id)&&validId(release.reviewEventId)&&validId(release.sourceOperationId)
   &&actual.length===episode.sceneIds.length&&actual.every((id,index)=>id===episode.sceneIds[index]);
 }).map(([,release])=>release);
 const releasedEpisodeCount=releaseProjectionAvailable?released.length:null;
 const releasedSceneCount=releaseProjectionAvailable?new Set(released.flatMap(release=>release.reviewInput.scenes.map(scene=>scene.id))).size:null;
 const sourceLabel=resolvedPlan.sourceRole==='CANDIDATE'?'当前候选':resolvedPlan.sourceRole==='PROPOSAL'?'当前方案提案':'当前已发布方案';
 const releaseLabel=releasedEpisodeCount===null?'逐集发布状态待核':`${releasedEpisodeCount} 集已独立正式通过并完成源同步`;
 return {...unknown,state:'AVAILABLE',sourceRole:resolvedPlan.sourceRole,revisionId:resolvedPlan.revisionId,contentHash:resolvedPlan.contentHash||null,
  episodeCount:episodes.length,sceneCount:sceneIds.length,releasedEpisodeCount,releasedSceneCount,releaseIds:released.map(release=>release.id),
  headline:`${sourceLabel} ${episodes.length} 集 / ${sceneIds.length} 场；${releaseLabel}。候选规模不等于全剧采用或正式制作分母。`,
  nextAction:releasedEpisodeCount===null?'先核对逐集发布证据，再继续正文审阅。':releasedEpisodeCount<episodes.length
   ?'继续未放行集的正文阅读、六项判断与本集确认；已同步集可独立准备镜头制作，无需等待全剧。'
   :'逐集放行不代替全剧方案采用或 PROJECT 出口核验；按本集精确输入继续制作准备。'};
}

export function projectWorkspaceModules({model={},queue=null,operations=null,metadata=null,readOnly=false,preparation=null,snapshotId=null}={}){
 const domains=rows(queue?.workspaceSummary?.domains),graph=model.domainGraph||{},story=queue?.storyProgress;
 const storyLabel=story?.sourceRole==='CURRENT'?'当前已发布方案':story?.sourceRole==='PROPOSAL'?'当前方案提案':'当前候选';
 const facts={
  STORY_CREATION:[
   count('current-episodes',storyLabel+'集数',story?.episodeCount,'来自正文页同一精确方案解析；候选规模不是正式采用分母。'),
   count('current-scenes',storyLabel+'场数',story?.sceneCount,'按当前方案永久集／场身份读取，不由旧快照库存推断。'),
   count('released-episodes','独立正式通过且已同步集',story?.releasedEpisodeCount,'来自本集正式 Review 与受控源同步的有效投影；不是六项输入数或全剧采用。'),
   count('released-episode-scenes','已同步集覆盖场数',story?.releasedSceneCount,'本集正式确认覆盖的正文场数，不制造独立场 ReviewEvent 或正式镜头分母。'),
   count('registered-episodes','历史／基线库存集',unique(model.episodes),'旧快照对象库存，仅供历史审计，不代表当前候选或正式通过范围。'),
   count('registered-scenes','历史／基线库存场',unique(model.scenes),'旧快照对象库存；不以显示场号映射当前候选。'),
   count('episode-inputs','分集审阅输入事件',operations?.counts?.episodePlanSubmissions,'含历史输入；不是当前已采用集数。'),
  ],
  STORY_SETTINGS:[
   count('entities','主体',unique(graph.entities),'当前发布设定中的永久实体，含地点。'),
   count('locations','地点',Array.isArray(graph.entities)?unique(graph.entities.filter(row=>row.type==='LOCATION')):null,'地点数不代表空间条件完备或坐标已锁定。'),
   count('relations','登记关系',unique(graph.relations),'保留历史标记；关系数不代表素材可下传。'),
  ],
  WORLD_AND_MATERIALS:[
   count('requirements','当前制作需求',queue?.summary?.inventory?.materialRequirements,'仅使用行动投影的去重需求口径。'),
   count('covered','已覆盖需求',queue?.summary?.inventory?.covered,'按当前精确版本和有效门禁计算，不能用文件数量替代。'),
   count('pending-review','待审候选',queue?.summary?.inventory?.pendingReviewCandidates,'候选状态不等于正式放行。'),
  ],
  FULL_PRODUCTION:[
   count('preparation-scenes','准备稿场数',preparation?.content?rows(preparation.content.scenes).length:0,'作者准备稿，不构成正式制作分母。'),
   count('registered-shots','登记镜头（含历史）',unique(model.shots),'库存审计数；正式范围只读取当前阶段投影。'),
  ],
 };
 const modules=WORKSPACE_MODULES.map(module=>{
  const domain=domains.find(domain=>domain.id===module.id);
  return {...module,facts:facts[module.id],status:domain?.status||(module.id==='STORY_SETTINGS'?(model.domainGraphRef?'REGISTERED':'WAITING'):'UNKNOWN'),
   headline:domain?.headline||(module.id==='STORY_SETTINGS'?'主体与空间的查阅、补全在本模块独立进行。':'尚无可判定的当前工作投影。'),
   nextAction:domain?.nextUnlockText||null,work:domain?.counts||null,
   stages:rows(domain?.stages),revisionId:module.id==='STORY_SETTINGS'?model.domainGraphRef?.revisionId||null:module.id==='STORY_CREATION'?story?.revisionId||null:null};
 });
 const actualSnapshot=snapshotId||queue?.snapshotId||metadata?.snapshotId||null;
 const freshness={schemaVersion:'1.0',projectionVersion:'WORKSPACE_PROJECTION_1',
  mode:readOnly?'PUBLISHED_READ_ONLY':metadata?'LIVE_TRANSACTION':'UNVERIFIED',
  snapshotId:actualSnapshot,releaseId:metadata?.releaseId||null,runtimeEpoch:readOnly?null:metadata?.runtimeEpoch||null,
  repositoryRevision:readOnly?null:numeric(metadata?.repositoryRevision),eventSequence:readOnly?null:numeric(metadata?.eventSequence),
  operationRevision:queue?.operationRevision||operations?.operationRevision||null,
  configurationRevisionId:model.systemConfiguration?.reference?.revisionId||null,
  domainRevisionId:model.domainGraphRef?.revisionId||null,preparationRevisionId:preparation?.revisionId||null};
 const audit={schemaVersion:'1.0',authority:readOnly?'已发布只读快照':'实例已发布数据库修订',freshness,
  modules,boundaries:WORKSPACE_BOUNDARIES,
  operationCounts:operations?.counts?Object.entries(operations.counts).filter(([,value])=>numeric(value)!==null).map(([id,value])=>({id,value})):[],
  creatorStages:CREATOR_PRODUCTION_STAGES,
  configuration:{phaseCount:rows(model.systemConfiguration?.config?.workflow?.phases||model.productionPhases).length,gateCount:rows(model.systemConfiguration?.config?.workflow?.gates||model.productionGates).length,
   reference:model.systemConfiguration?.reference||null},
  interfaces:[
   {path:'/api/instance/workflow?workspace=1',purpose:'同一读取事务返回当前工作、模块状态与审计水位。'},
   {path:'/api/instance/configuration',purpose:'当前配置及冻结标准；历史规则不因新默认值而改写。'},
   {path:'/api/instance/domain-workspaces',purpose:'主体与空间的已发布关系、显式保存草稿、预览与确认。'},
   {path:'/api/v8/operations/snapshot',purpose:'正式事件、运行修订和精确对象的有效投影。'},
   {path:'/api/instance/maintenance',purpose:'完整备份、验证、只读导出及隔离恢复的主机任务状态。'},
  ]};
 return {modules,freshness,audit};
}
