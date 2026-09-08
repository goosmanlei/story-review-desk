import {ORCHESTRATION_NAMESPACE} from '../../host/instance-runtime/orchestration-service.mjs';
import {readOrchestrationDashboard} from '../../host/instance-runtime/orchestration-dashboard.mjs';

export function dashboardRecords(metadata = {instanceId:'orchestration-ui', runtimeEpoch:'test-epoch'}) {
  const at = '2026-09-01T01:00:00.000Z';
  const task = (id, status, kind = 'DEVELOP', extra = {}) => ({id, title:`任务 ${id}`, kind, status,
    rootId:id, parentId:null, runtimeEpoch:metadata.runtimeEpoch, createdAt:at, updatedAt:at, dependencies:[],
    progress:'已核对输入，正在验证', inputs:[{ref:'PRIVATE_INPUT_SENTINEL'}], scope:'PRIVATE_SCOPE_SENTINEL',
    execution:{cwd:'/private/WORKTREE_SENTINEL'}, authorization:{token:'CAPABILITY_SENTINEL'}, ...extra});
  const config = {runtimeEpoch:metadata.runtimeEpoch, enabled:true, status:'ACTIVE',
    concurrency:{CREATIVE:3,CREATIVE_QA:0,DEVELOP:3,DEVELOP_QA:2},
    main:{id:'MAIN_SENTINEL',token:'CAPABILITY_SENTINEL'}, scheduler:{threadId:'THREAD_SENTINEL',blocked:null}};
  const tasks = [
    task('working','RUNNING','DEVELOP',{title:'实现协作页面'}),
    task('dependent','WAITING_DEPENDENCIES','CREATIVE',{title:'依赖中的创作',dependencies:['working']}),
    task('qa-parent','QA_PENDING','CREATIVE',{title:'等待独立质检的候选'}),
    task('qa-active','RUNNING','CREATIVE_QA',{title:'正在独立质检',parentId:'qa-parent'}),
    task('rework-parent','REWORK_PENDING','DEVELOP',{qaFailures:1,title:'等待返修的任务'}),
    task('repair','READY','DEVELOP',{parentId:'rework-parent',rootId:'rework-parent',title:'修正页面边界',qaFailures:1}),
    task('blocked','BLOCKED','DEVELOP',{title:'环境工具受阻',progress:'token=CAPABILITY_SENTINEL'}),
    task('unknown','BLOCKED','DEVELOP',{title:'执行待核查'}),
    task('awaiting','AWAITING_DECISION','CREATIVE',{title:'等待加轮',qaFailures:3}),
    task('cancel-pending','CANCEL_REQUESTED','CREATIVE',{title:'取消待核查'}),
    task('finalizing','FINALIZING_RUNNING','DEVELOP_QA',{title:'交付中的任务'}),
    task('delivery-ready','FINALIZING','DEVELOP',{title:'等待交付的任务'}),
    ...Array.from({length:23},(_,i) => task(`completed-${String(i).padStart(2,'0')}`,i===0?'CANCELLED':i===1?'SUPERSEDED':'DONE','DEVELOP_QA',
      {title:i===0?'已取消任务':i===1?'旧返修版本':i===22?'已结束的失败质检':`历史完成 ${i}`,result:{status:i===22?'FAIL':'PASS',summary:'PRIVATE_RESULT_SENTINEL'}})),
  ];
  const runs = [
    {id:'run-work',workerId:'worker-work',taskId:'working',kind:'DEVELOP',phase:'WORK',status:'RUNNING',model:'gpt-test',effort:'high'},
    {id:'run-qa',workerId:'worker-qa',taskId:'qa-active',kind:'CREATIVE_QA',phase:'QA',status:'RUNNING'},
    {id:'run-unknown',workerId:'worker-unknown',taskId:'unknown',kind:'DEVELOP',phase:'WORK',status:'RESULT_UNKNOWN'},
    {id:'run-cancel',workerId:'worker-cancel',taskId:'cancel-pending',kind:'CREATIVE',phase:'WORK',status:'CANCEL_REQUESTED'},
    {id:'run-finalize',workerId:'worker-finalize',taskId:'finalizing',kind:'DEVELOP_QA',phase:'FINALIZE',status:'RUNNING'},
  ].map(run => ({...run,createdAt:at,runtimeEpoch:metadata.runtimeEpoch,tokenHash:'TOKENHASH_SENTINEL',worktree:'/private/RUNPATH_SENTINEL',threadId:'THREAD_SENTINEL',result:{secret:'RESULT_SENTINEL'}}));
  const decisions = [{id:'decision-qa',status:'OPEN',taskId:'awaiting',type:'QA_LIMIT',createdAt:at,summary:'PRIVATE_DECISION_SENTINEL'},
    {id:'decision-closed',status:'RESOLVED',taskId:'working',type:'CONCURRENCY',createdAt:at}];
  const rows = [['config',config],...tasks.map(task => ['tasks/'+task.id,task]),...runs.map(run => ['runs/'+run.id,run]),...decisions.map(decision => ['decisions/'+decision.id,decision])];
  const heartbeat = {schemaVersion:'1.0',instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,status:'RUNNING',updatedAt:at,
    active:runs.filter(run => run.status === 'RUNNING').map(run => ({runId:run.id,taskId:run.taskId,kind:run.kind}))};
  return {metadata,rows,tasks,runs,config,heartbeat,at};
}

export async function dashboardFixture({empty = false, completedPage = 0} = {}) {
  const f = dashboardRecords();
  const entries = empty ? [] : f.rows;
  const tx = {
    getMetadata:async () => f.metadata,
    getAux:async (_,key) => {const row=entries.find(([name]) => name===key);return row ? {bytes:Buffer.from(JSON.stringify(row[1]))} : null;},
    listAux:async (namespace,{prefix}) => {if(namespace!==ORCHESTRATION_NAMESPACE)throw Error('Unexpected namespace');return entries.filter(([key]) => key.startsWith(prefix)).map(([,value]) => ({bytes:Buffer.from(JSON.stringify(value))}));},
  };
  return readOrchestrationDashboard(tx,{heartbeat:empty?null:f.heartbeat,now:Date.parse(f.at),completedPage});
}
