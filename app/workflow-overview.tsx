'use client';
import {useEffect,useState} from 'react';
import type {CanvasNode,CanvasEdge} from './relationship-canvas';
import {readManagementResponse} from './system-management-client';
import type {ActionItem,QueuePayload,WorkspaceDomainSummary,WorkspaceStageSummary} from './action-queue-contract';
import './workflow-production.css';
import {creatorProductionStageForGate} from './creator-production-workflow';
import type {WorkspaceAudit,WorkspaceFreshness,WorkspaceModule} from './workspace-audit-contract';

export type WorkflowProjection={audit?:WorkspaceAudit;freshness?:WorkspaceFreshness;modules?:WorkspaceModule[];nodes:Array<CanvasNode&{href:string}>;edges:CanvasEdge[];preparationWork?:{title:string;sceneCount:number;href:string;status:string;capabilities:string[];reason:string;boundary:string}|null};
export type WorkflowStage=WorkspaceStageSummary&{href:string;detail:string;items:ActionItem[];preparation?:WorkflowProjection['preparationWork']};
export const workflowEvents=['review:operations-updated','review:configuration-updated','review:relations-updated','review:sources-updated','review:materials-updated','review:preparation-updated','focus'];

export function useWorkflowProjection(){
 const [snapshot,setSnapshot]=useState<{queue:QueuePayload;workflow:WorkflowProjection;readAt:string}|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();let sequence=0;
  const refresh=()=>{const request=++sequence;void fetch('/api/instance/workflow?workspace=1',{signal:controller.signal,cache:'no-store'}).then(readManagementResponse<{queue:QueuePayload;workflow:WorkflowProjection}>).then(({queue,workflow})=>{if(!queue||!workflow||queue.snapshotId!==workflow.freshness?.snapshotId||queue.operationRevision!==workflow.freshness?.operationRevision)throw Error('工作投影依据不一致，请重新读取');if(!controller.signal.aborted&&request===sequence){setSnapshot({queue,workflow,readAt:new Date().toISOString()});setError('');}}).catch(reason=>{if(!controller.signal.aborted&&request===sequence){setSnapshot(null);setError(reason instanceof Error?reason.message:'工作流程读取失败');}});};
  const visibleRefresh=()=>{if(document.visibilityState==='visible')refresh();};
  refresh();workflowEvents.forEach(event=>window.addEventListener(event,refresh));document.addEventListener('visibilitychange',visibleRefresh);
  const timer=window.setInterval(visibleRefresh,20000);
  return()=>{controller.abort();window.clearInterval(timer);workflowEvents.forEach(event=>window.removeEventListener(event,refresh));document.removeEventListener('visibilitychange',visibleRefresh);};
 },[attempt]);
 return {snapshot,error,refresh:()=>setAttempt(n=>n+1)};
}

export function workflowItemStage(item:ActionItem):string|null{
 // Only an exact gate determines creator stage; canonical phases remain audit identities.
 if(item.ownerModule==='FULL_PRODUCTION')return creatorProductionStageForGate(item.productionGateId);
 if(item.ownerModule==='STORY_CREATION')return ({EPISODE_PLANNING:'EPISODE_PLAN',STORY_CONFIRMATION:'STORY_CONFIRMATION',SCENE_COVERAGE:'SCENE_COVERAGE'} as Record<string,string>)[item.workstream]||null;
 // Action type is not a material lifecycle. Unbound actions stay explicitly at chain level.
 return item.materialCreatorStage||null;
}
export function buildWorkflowStages(domain:WorkspaceDomainSummary,workflow:WorkflowProjection,items:ActionItem[]):WorkflowStage[]{
 return domain.stages.map(stage=>{
  const node=workflow.nodes.find(n=>n.id===stage.id);
  const storyHref=stage.id==='EPISODE_PLAN'?'?view=story&storyMode=logic':stage.id==='STORY_CONFIRMATION'?'?view=story&storyMode=logic':stage.id==='SCENE_COVERAGE'?'?view=story&storyMode=audit':null;
  const materialHref = domain.id === 'WORLD_AND_MATERIALS' ? '?view=materials&materialMode=classification&materialCreatorStage='+encodeURIComponent(stage.id) : null;
  return {...stage,href:node?.href||storyHref||materialHref||domain.navigationIntent.href,detail:node?.detail||domain.nextUnlockText,items:items.filter(item=>item.ownerModule===domain.id&&workflowItemStage(item)===stage.id),preparation:domain.id==='FULL_PRODUCTION'&&stage.id==='SHOT_PRODUCTION'?workflow.preparationWork:null};
 });
}
export function workflowCount(stage:WorkspaceStageSummary){return stage.denominatorState==='KNOWN'&&stage.denominator!=null?`${stage.count??'未知'} / ${stage.denominator}`:stage.count==null?'正式范围未锁定':`${stage.count} · 正式分母未锁定`;}
function ConnectedWorkflowOverview(){const {snapshot,error}=useWorkflowProjection();const [selected,setSelected]=useState('');const domain=snapshot?.queue.workspaceSummary?.domains[0];if(!snapshot||!domain)return <p role={error?'alert':'status'}>{error||'正在读取工作流程…'}</p>;return <WorkflowOverview stages={buildWorkflowStages(domain,snapshot.workflow,snapshot.queue.workUnits||snapshot.queue.items)} selectedId={selected||domain.stages[0]?.id||''} onSelect={setSelected} label={domain.label}/>;}
export function WorkflowOverview(props:{stages?:WorkflowStage[];selectedId?:string;onSelect?:(id:string)=>void;label?:string}={}){
 if(!props.stages||!props.onSelect||!props.label)return <ConnectedWorkflowOverview/>;
 const {stages,selectedId,onSelect,label}=props;
 return <nav className="flow-stage-tabs" aria-label={label+'阶段选择'}>{stages.map((stage,index)=><button type="button" key={stage.id} aria-pressed={stage.id===selectedId} onClick={()=>onSelect(stage.id)}><small>{String(index+1).padStart(2,'0')}</small><span>{stage.label}</span><em>{workflowCount(stage)}</em></button>)}</nav>;
}
