import {CREATOR_PRODUCTION_STAGES} from './creator-production-workflow.mjs';

// One ownership catalogue for work status, help and assistant metadata. It never
// changes frozen canonical gate identities, review decisions or input bindings.
export const WORKSPACE_MODULES = Object.freeze([
 {id:'STORY_CREATION',label:'故事创作',href:'?view=story&storyMode=source',responsibility:'来源资料、故事结构、分集候选与正文评论；审阅输入、正式裁决和受控源同步分别留痕。'},
 {id:'STORY_SETTINGS',label:'故事设定',href:'?view=settings',responsibility:'主体档案、空间与关系共用永久身份。Codex按明确选择的当前资料抽取建议，经保存、预览和确认维护设定。'},
 {id:'WORLD_AND_MATERIALS',label:'素材管理',href:'?view=materials&materialMode=classification',responsibility:'按实体、集和场组织素材需求、生产资料、实际版本与正式审阅；关联不代表放行。'},
 {id:'FULL_PRODUCTION',label:'全剧制作',href:'?view=pipeline',responsibility:'镜头拆解、镜头生成、场景剪辑、分集成片；设计采用、精确输入锁定和实际生成分别判断。'},
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
export function projectWorkspaceModules({model={},queue=null,operations=null,metadata=null,readOnly=false,preparation=null,snapshotId=null}={}){
 const domains=rows(queue?.workspaceSummary?.domains),graph=model.domainGraph||{};
 const facts={
  STORY_CREATION:[
   count('registered-episodes','已登记集',unique(model.episodes),'登记对象数，不等于正式通过集数。'),
   count('registered-scenes','已登记场',unique(model.scenes),'登记对象数，不以旧场号重映射当前候选。'),
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
   stages:rows(domain?.stages),revisionId:module.id==='STORY_SETTINGS'?model.domainGraphRef?.revisionId||null:null};
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
