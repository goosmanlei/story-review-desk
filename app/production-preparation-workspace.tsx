'use client';
import {useEffect,useState,useRef} from 'react';
import {managementMutation,readManagementResponse} from './system-management-client';
import {useManagementDraftGuard} from './management-draft-guard';
import {useRuntimeMode} from './runtime-mode';
import {visibleText} from './review-semantics';
import './entity-workspace.css';
import './workflow-production.css';
import './preparation-workspace.css';
import {CREATOR_PRODUCTION_STAGES,creatorProductionStageForGate,creatorProductionStageDefinition,creatorProductionGateDefinition,resolveCreatorProductionStage,type CreatorProductionStageId} from './creator-production-workflow';
type Scene={sceneId:string;displayId:string;episodeUid:string;sceneContentHash:string;sourceSummary?:Record<string,unknown>;preparation:Record<string,unknown>;navigationOnly?:boolean};
type State={releaseId:string;revisionId:string|null;content:{basis:Record<string,unknown>;scenes:Scene[];episodes?:Array<{episodeUid:string;displayId:string;title:string;sceneIds:string[]}>}|null;candidate:{revisionId:string;contentHash:string;episodes:Array<{episodeUid:string;displayId:string;title:string;sceneIds:string[]}>;scenes:Array<{id:string;displayId:string;title:string}>}|null;comments:Array<{sceneId:string;text:string;revisionId:string;preparationRevisionId:string}>;stale:boolean;readOnly?:boolean};
const editableKeys=new Set(['sceneRole','audienceTakeaway','informationBoundary','beats','visualIntent','soundAndDialogueIntent','entityStateRequirements','timeAndSpace','materialGaps','nextPreparationAction','reviewFocus']);
const immutableKeys=new Set(['sourceDialogue','generationAuthorized','formalShotIds','formalReviewCreated','adoptionCreated','formalAdoptionPerformed','adoptedAssetBindings','mediaObserved','canonicalEntityId','stateId','bindingStatus','locationBinding','stateBinding','zoneBinding','cameraBinding','freezeBinding']);
function containsImmutable(value:unknown):boolean{return Array.isArray(value)?value.some(containsImmutable):Boolean(value&&typeof value==='object'&&Object.entries(value).some(([key,item])=>immutableKeys.has(key)||containsImmutable(item)));}
const labels:Record<string,string>={sceneRole:'本场作用',candidatePurpose:'候选本场任务',informationBoundary:'信息与视点边界',viewpoint:'观察视点',retainUntilLater:'暂不揭晓',order:'顺序',soundAndDialogueIntent:'声音与对白意图',sourceDialogue:'本场对白依据',scriptBlockId:'正文块',speaker:'说话人',performanceNote:'表演提示',entityStateRequirements:'实体状态与素材需要',description:'具体要求',canonicalEntityId:'实体绑定',bindingStatus:'绑定情况',stateId:'状态绑定',timeAndSpace:'时间与空间',transition:'场间转换',locationBinding:'地点绑定',stateBinding:'状态绑定',zoneBinding:'区域绑定',cameraBinding:'机位绑定',freezeBinding:'冻结点绑定',beats:'叙事与动作节拍',visualIntent:'画面意图',actionIntent:'动作意图',soundIntent:'声音意图',dialogueContext:'对白与表演',entityStateNeeds:'实体、状态与空间条件',materialGaps:'素材缺项',nextPreparationAction:'下一步准备',reviewFocus:'审阅重点',narrativeBeat:'叙事节拍',audienceTakeaway:'观众所得',purpose:'本场作用',audienceKnown:'观众已知',audienceWithheld:'暂不揭晓',slugline:'场景',storyTime:'故事时间',title:'场名',text:'内容',entityName:'主体',state:'状态',reason:'依据',name:'名称',requirement:'要求',note:'说明',material:'素材',type:'类型'};
function PreparationValue({value}:{value:unknown}){if(value==null)return <span>待核</span>;if(typeof value==='string'||typeof value==='number')return <p>{({UNKNOWN:'待核',UNBOUND_PROPOSAL:'尚未绑定的准备提案',A:'改编与制作提案',AUTHORING_DRAFT:'准备草稿'} as Record<string,string>)[String(value)]||visibleText(String(value))}</p>;if(Array.isArray(value))return <ol>{value.map((v,i)=><li key={i}><PreparationValue value={v}/></li>)}</ol>;if(typeof value==='object')return <dl>{Object.entries(value).filter(([k])=>!['meaning','mediaObserved','adoptedAssetBindings'].includes(k)).map(([k,v])=><div key={k}><dt>{labels[k]||k}</dt><dd><PreparationValue value={v}/></dd></div>)}</dl>;return null;}
function PreparationEditor({value,onChange}:{value:Record<string,unknown>;onChange:(value:Record<string,unknown>)=>void}){
 function field(v:unknown,change:(value:unknown)=>void,label:string):React.ReactNode {
  if(Array.isArray(v)){const locked=containsImmutable(v);return <fieldset><legend>{label}</legend>{v.map((item,i)=><div key={i}>{field(item,next=>change(v.map((old,j)=>j===i?next:old)),label+' '+(i+1))}{!locked&&<button type="button" onClick={()=>change(v.filter((_,j)=>j!==i))}>移除此项</button>}</div>)}{locked?<small>本组含冻结绑定事实；此处可修改要求描述，新增或移除绑定须回到实体与素材定义。</small>:<button type="button" onClick={()=>change([...v,typeof v[0]==='object'?Object.fromEntries(Object.keys(v[0]||{}).map(k=>[k,''])):''])}>增加一项</button>}</fieldset>;}
  if(v&&typeof v==='object')return <fieldset><legend>{label}</legend>{Object.entries(v).map(([k,item])=><div key={k}>{immutableKeys.has(k)?<section aria-label={(labels[k]||k)+'（冻结事实）'}><strong>{labels[k]||k} · 只读</strong>{typeof item==='boolean'?<p>{item?'已记录':'未发生'}</p>:<PreparationValue value={item}/>}</section>:field(item,next=>change({...v,[k]:next}),labels[k]||k)}</div>)}</fieldset>;
  return <label>{label}<textarea value={v==null?'':String(v)} onChange={e=>change(e.target.value)}/></label>;
 }
 return <div className="preparation-editor">{Object.entries(value).filter(([k])=>editableKeys.has(k)).map(([k,v])=><div key={k}>{field(v,next=>onChange({...value,[k]:next}),labels[k]||k)}</div>)}</div>;
}


function slug(value:string){return value.toLowerCase().replaceAll('_','-');}
function preparationSelectionUrl(episodeUid:string,sceneId:string,stageId?:string,gate?:{id:string;phaseId:string}){
 const url=new URL(window.location.href);
 for(const [key,value] of [['preparationEpisode',episodeUid],['preparationScene',sceneId]]){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key);}
 if(stageId)url.searchParams.set('creatorStage',slug(stageId));
 if(gate){url.searchParams.set('productionPhase',slug(gate.phaseId));url.searchParams.set('productionGate',slug(gate.id));}
 if(stageId==='EPISODE_EDIT'){url.searchParams.delete('scene');url.searchParams.delete('preparationScene');}
 return url;
}
export type PreparationStageContext={creatorStageId:CreatorProductionStageId;navigationScopeType:'SCENE'|'EPISODE'|'PROJECT';scopeType:'SHOT'|'SCENE'|'EPISODE'|'PROJECT';sceneId?:string;episodeUid:string;phaseId:string;gateId:string};
type PreparationWorkflow={phases:Array<{id:string;label:string;order?:number;entryGateId?:string}>;gates:Array<{id:string;phaseId:string;label:string;purpose?:string;scopeType?:string;exitCriteria?:unknown[]}>};
type Props={workflow?:PreparationWorkflow;initialPhaseId?:string|null;initialGateId?:string|null;initialCreatorStageId?:string|null;renderStage?:(context:PreparationStageContext)=>React.ReactNode;onStageChange?:(phaseId:string,gateId:string,creatorStageId?:CreatorProductionStageId,context?:PreparationStageContext)=>void};
export function ProductionPreparationWorkspace({workflow,initialPhaseId,initialGateId,initialCreatorStageId,renderStage,onStageChange}:Props={}){
 const {hostedReadOnly}=useRuntimeMode();
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[selected,setSelected]=useState(''),[selectedEpisode,setSelectedEpisode]=useState(''),[stageSelection,setStageSelection]=useState(''),[gateSelection,setGateSelection]=useState(''),[comment,setComment]=useState(''),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false),[draft,setDraft]=useState<Record<string,unknown>>({}),[section,setSection]=useState('INTENT');
 const [remoteWorkflow,setRemoteWorkflow]=useState<PreparationWorkflow|null>(null),[configurationError,setConfigurationError]=useState('');
 const dirty=useRef(false),latestState=useRef<State|null>(null),locationSelection=useRef({href:'',episodeUid:'',sceneId:'',stageId:'',gateId:''});
 useEffect(()=>{if(workflow)return;const c=new AbortController();void fetch('/api/instance/workflow',{cache:'no-store',signal:c.signal}).then(readManagementResponse<{definition?:PreparationWorkflow}>).then(value=>{if(c.signal.aborted)return;if(!value.definition||value.definition.phases.length!==5||value.definition.gates.length!==15)throw Error('共享制作检查配置尚未完整');setRemoteWorkflow(value.definition);setConfigurationError('');}).catch(e=>{if(!c.signal.aborted){setRemoteWorkflow(null);setConfigurationError(e.message||'共享流程配置读取失败');}});return()=>c.abort();},[workflow,attempt]);
 useEffect(()=>{dirty.current=Boolean(comment.trim()||editing);},[comment,editing]);
 useEffect(()=>{latestState.current=state;},[state]);
 useManagementDraftGuard(Boolean(comment.trim()||editing),'制作准备稿与意见');
 useEffect(()=>{const c=new AbortController();void fetch('/api/instance/production-preparation',{cache:'no-store',signal:c.signal}).then(readManagementResponse<State>).then(v=>{if(c.signal.aborted)return;const old=latestState.current;if(dirty.current&&old&&(old.revisionId!==v.revisionId||old.releaseId!==v.releaseId||v.stale)){setError('背景资料已变化。当前编辑及原版本基线已保留；保存时重新核对，不覆盖新修订。');return;}latestState.current=v;setState(v);setError('');}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[attempt]);
 useEffect(()=>{const events=['review:operations-updated','review:sources-updated','review:relations-updated','review:configuration-updated','focus'];const f=()=>setAttempt(a=>a+1),visible=()=>{if(document.visibilityState==='visible')f();};events.forEach(e=>window.addEventListener(e,f));document.addEventListener('visibilitychange',visible);const timer=window.setInterval(visible,20000);return()=>{events.forEach(e=>window.removeEventListener(e,f));document.removeEventListener('visibilitychange',visible);window.clearInterval(timer);};},[]);
 useEffect(()=>{
  const restore=(event?:PopStateEvent)=>{
   const params=new URLSearchParams(window.location.search);if(event&&params.get('view')!=='pipeline')return;
   const next={href:window.location.href,episodeUid:params.get('preparationEpisode')||'',sceneId:params.get('preparationScene')||'',stageId:params.get('creatorStage')||'',gateId:params.get('productionGate')||''},previous=locationSelection.current;
   if(event&&next.episodeUid===previous.episodeUid&&next.sceneId===previous.sceneId&&next.stageId===previous.stageId&&next.gateId===previous.gateId)return;
   if(event&&dirty.current&&!window.confirm('放弃本页未保存的编辑与意见并切换？')){event.stopImmediatePropagation();window.history.pushState({...window.history.state},'',previous.href);return;}
   dirty.current=false;setComment('');setEditing(false);locationSelection.current=next;setSelected(next.sceneId);setSelectedEpisode(next.episodeUid);setStageSelection(next.stageId);setGateSelection(next.gateId);
  };
  restore();window.addEventListener('popstate',restore,true);return()=>window.removeEventListener('popstate',restore,true);
 },[]);
 const definition=workflow||remoteWorkflow;
 const requestedStage=stageSelection||initialCreatorStageId||'',resolvedStage=resolveCreatorProductionStage(requestedStage);
 const configuredGates=definition?.gates||[],requestedGate=gateSelection||initialGateId||resolvedStage?.defaultGateId||'';
 const exactGate=configuredGates.find(g=>g.id===requestedGate||slug(g.id)===requestedGate);
 const phaseEntry=configuredGates.find(g=>g.phaseId===initialPhaseId);
 const stage=CREATOR_PRODUCTION_STAGES.find(s=>s.id===resolvedStage?.stageId)||(!requestedStage?creatorProductionStageDefinition(creatorProductionStageForGate(exactGate?.id||phaseEntry?.id||'')||''):null)||CREATOR_PRODUCTION_STAGES[0];
 const stageGates=stage.gateIds.flatMap(id=>configuredGates.filter(g=>g.id===id));
 const gate=exactGate||stageGates.find(g=>g.id===stage.defaultGateId);
 const gateDefinition=creatorProductionGateDefinition(gate?.id||'');
 const configuredScopeMismatch=Boolean(gate&&gateDefinition&&(gate.phaseId!==gateDefinition.phaseId||gate.scopeType&&gate.scopeType!==gateDefinition.scopeType));
 const stageError=requestedStage&&!resolvedStage?'链接指定的制作阶段无法定位，未切换到其他阶段。':requestedGate&&!exactGate?'链接指定的制作检查无法定位，未打开其他检查。':exactGate&&!stage.gateIds.includes(exactGate.id)?'制作阶段与检查不匹配，未改绑到其他对象。':configuredScopeMismatch?'检查配置的阶段或作用域与正式契约不匹配，未打开其他对象。':'';
 const episodeMode=stage.id==='EPISODE_EDIT',shotProductionMode=stage.id==='SHOT_PRODUCTION',breakdownMode=shotProductionMode&&gate?.id==='SHOT_PLAN_INPUT_LOCK';
 const episodes=state?.candidate?.episodes||state?.content?.episodes||[];
 // Formal episode navigation is independent of an absent/stale preparation draft.
 // A navigation-only row has no preparation hash or editable body to rebind.
 const scenes:Scene[]=state?.candidate?episodes.flatMap(ep=>ep.sceneIds.map(id=>state.content?.scenes.find(s=>s.sceneId===id&&s.episodeUid===ep.episodeUid)||{sceneId:id,displayId:state.candidate?.scenes.find(s=>s.id===id)?.displayId||id,episodeUid:ep.episodeUid,sceneContentHash:'',sourceSummary:{title:state.candidate?.scenes.find(s=>s.id===id)?.title||''},preparation:{},navigationOnly:true})):state?.content?.scenes||[];
 const selectedRecord=episodeMode?undefined:scenes.find(s=>s.sceneId===selected),requestedEpisode=episodes.find(e=>e.episodeUid===selectedEpisode);
 const episode=selectedEpisode?requestedEpisode:selectedRecord?episodes.find(e=>e.episodeUid===selectedRecord.episodeUid):selected&&!episodeMode?undefined:episodes[0];
 const missingEpisode=Boolean(selectedEpisode&&!requestedEpisode),missingScene=Boolean(!episodeMode&&selected&&!selectedRecord),mismatchedScene=Boolean(selectedRecord&&(!episode||selectedRecord.episodeUid!==episode.episodeUid||!episode.sceneIds.includes(selectedRecord.sceneId)));
 const selectionError=state&&(missingEpisode?'此链接的永久集身份不在当前准备稿中。没有转到首集或其他同名集，请从集场目录选择。':missingScene?'此链接的永久场身份不在当前准备稿中。没有转到其他同名场，请从集场目录选择。':mismatchedScene?'此链接的永久集与场身份不匹配。没有自动换集或换场；请重新选择正确的集场。':'');
 const episodeScenes=scenes.filter(s=>episode&&s.episodeUid===episode.episodeUid&&episode.sceneIds.includes(s.sceneId));
 const scene=episodeMode||selectionError?undefined:selected?selectedRecord:episodeScenes[0],source=state?.stale?undefined:state?.candidate?.scenes.find(s=>s.id===scene?.sceneId);
 const canonicalScopeType=gateDefinition?.scopeType||null;
 const navigationScopeType=canonicalScopeType==='PROJECT'?'PROJECT':episodeMode?'EPISODE':'SCENE';
 const tabs=[{id:'INTENT',label:'本场意图',keys:['sceneRole','audienceTakeaway','informationBoundary']},{id:'BEATS',label:'节拍与对白',keys:['beats','visualIntent','soundAndDialogueIntent','sourceDialogue']},{id:'INPUTS',label:'实体、状态与输入',keys:['entityStateRequirements','timeAndSpace','materialGaps']},{id:'REVIEW',label:'下一步与审阅重点',keys:['nextPreparationAction','reviewFocus']}];
 const currentTab=tabs.find(t=>t.id===section)||tabs[0];
 // The episode workspace must not carry a hidden scene, including on reload.
 useEffect(()=>{if(!episodeMode)return;const url=new URL(window.location.href);if(url.searchParams.has('scene')||url.searchParams.has('preparationScene')){url.searchParams.delete('scene');url.searchParams.delete('preparationScene');window.history.replaceState(window.history.state,'',url);locationSelection.current={...locationSelection.current,href:url.href,sceneId:''};}},[episodeMode]);
 function leaveDraft(){if((comment.trim()||editing)&&!confirm('放弃本页未保存的编辑与意见并切换？'))return false;dirty.current=false;setComment('');setEditing(false);return true;}
 function rememberLocation(episodeUid:string,sceneId:string){const params=new URLSearchParams(window.location.search);locationSelection.current={href:window.location.href,episodeUid,sceneId,stageId:params.get('creatorStage')||'',gateId:params.get('productionGate')||''};}
 function chooseContext(episodeUid:string,sceneId:string){if(!leaveDraft())return;const url=preparationSelectionUrl(episodeUid,episodeMode?'':sceneId,stage.id);if(url.href!==window.location.href)window.history.pushState({...window.history.state},'',url);rememberLocation(episodeUid,episodeMode?'':sceneId);setSelectedEpisode(episodeUid);setSelected(episodeMode?'':sceneId);}
 function chooseScene(id:string){const next=episodeScenes.find(s=>s.sceneId===id);if(next)chooseContext(next.episodeUid,next.sceneId);}
 function chooseEpisode(uid:string){const nextEpisode=episodes.find(e=>e.episodeUid===uid);if(!nextEpisode)return;const next=episodeMode?undefined:scenes.find(s=>s.episodeUid===uid&&nextEpisode.sceneIds.includes(s.sceneId));chooseContext(uid,next?.sceneId||'');}
 function chooseCheck(stageId:CreatorProductionStageId,gateId:string){
  if(selectionError||!leaveDraft())return;const nextStage=CREATOR_PRODUCTION_STAGES.find(s=>s.id===stageId),nextGate=configuredGates.find(g=>g.id===gateId);
  if(!nextStage||!nextGate||!nextStage.gateIds.includes(nextGate.id))return;
  const nextScene=nextStage.scope==='SCENE'?(scene||episodeScenes[0]):undefined;
  const nextCanonical=creatorProductionGateDefinition(nextGate.id)?.scopeType||null;
  const context=nextCanonical&&episode?{creatorStageId:nextStage.id,navigationScopeType:nextCanonical==='PROJECT'?'PROJECT' as const:nextStage.scope,scopeType:nextCanonical,episodeUid:episode.episodeUid,...(nextStage.scope==='SCENE'&&nextScene?{sceneId:nextScene.sceneId}:{}),phaseId:nextGate.phaseId,gateId:nextGate.id}:undefined;
  setStageSelection(nextStage.id);setGateSelection(nextGate.id);setSelected(nextScene?.sceneId||'');
  if(onStageChange)onStageChange(nextGate.phaseId,nextGate.id,nextStage.id,context);
  else{const url=preparationSelectionUrl(episode?.episodeUid||'',nextScene?.sceneId||'',nextStage.id,nextGate);if(url.href!==window.location.href)window.history.pushState({...window.history.state},'',url);}
  rememberLocation(episode?.episodeUid||'',nextScene?.sceneId||'');
 }
 async function submit(action:'comment'|'save'){if(!state||!scene||!breakdownMode||stageError||state.stale||hostedReadOnly||state.readOnly||selectionError)return;setBusy(true);try{const content=action==='save'?{...state.content,scenes:state.content!.scenes.map(s=>s.sceneId===scene.sceneId?{...s,preparation:draft}:s)}:undefined;await managementMutation('/api/instance/production-preparation',{action,expectedReleaseId:state.releaseId,expectedRevisionId:state.revisionId,...(action==='comment'?{sceneId:scene.sceneId,text:comment}:{content})});setComment('');setEditing(false);setAttempt(v=>v+1);}catch(e){setError(e instanceof Error?e.message:'保存未完成');}finally{setBusy(false);}}
 const editable=Boolean(scene)&&!scene?.navigationOnly&&breakdownMode&&!selectionError&&!stageError&&!hostedReadOnly&&!state?.readOnly&&!state?.stale;
 const stageContext:PreparationStageContext|undefined=!selectionError&&!stageError&&gate&&canonicalScopeType&&episode&&(episodeMode||scene)?{creatorStageId:stage.id,navigationScopeType,scopeType:canonicalScopeType,episodeUid:episode.episodeUid,...(!episodeMode&&scene?{sceneId:scene.sceneId}:{}),phaseId:gate.phaseId,gateId:gate.id}:undefined;
 const exportChecks=stageGates.filter(g=>stage.exportGateIds.includes(g.id)),regularChecks=stageGates.filter(g=>!stage.exportGateIds.includes(g.id));
 const checkButtons=(checks:typeof stageGates)=><div className="preparation-check-list">{checks.map(g=><button type="button" key={g.id} data-production-check={g.id} disabled={Boolean(selectionError)} aria-pressed={g.id===gate?.id} onClick={()=>chooseCheck(stage.id,g.id)}><strong>{g.label}</strong>{g.purpose&&<span>{g.purpose}</span>}</button>)}</div>;
 return <section className="production-preparation production-flow-workspace creator-production-workspace" aria-label="场景上下文的全剧制作">
  <nav className="creator-production-stages" aria-label="全剧制作模块">{CREATOR_PRODUCTION_STAGES.map((s,i)=><button type="button" key={s.id} data-creator-stage={s.id} disabled={Boolean(selectionError)} aria-pressed={s.id===stage.id} onClick={()=>chooseCheck(s.id,s.defaultGateId)}><small>{String(i+1).padStart(2,'0')}</small><strong>{s.label}</strong></button>)}</nav>
  {shotProductionMode&&<nav className="shot-production-step-navigation" aria-label="镜头制作六步骤">{checkButtons(regularChecks)}</nav>}
  <nav className="preparation-episode-chips" aria-label="制作上下文分集">{episodes.map(ep=><button type="button" key={ep.episodeUid} data-preparation-episode={ep.episodeUid} aria-pressed={ep.episodeUid===episode?.episodeUid} onClick={()=>chooseEpisode(ep.episodeUid)}><b>{ep.displayId}</b><span>{ep.title}</span></button>)}{state&&!episodes.length&&<p>尚未建立候选分集。正式制作范围仍待确定。</p>}</nav>
  {error&&<p className="workflow-warning" role="alert">{error}<button type="button" onClick={()=>setAttempt(v=>v+1)}>重新读取</button></p>}
  {configurationError&&<p className="workflow-warning" role="alert">{configurationError}。没有使用另一套检查模板。</p>}
  {(selectionError||stageError)&&<p className="workflow-warning" role="alert">{selectionError||stageError}</p>}
  {state?.stale&&<p className="workflow-warning" role="alert">候选或正文依据已变化。保留原稿供对照，不能自动换绑、编辑或转交。</p>}
  {!state&&!error&&<p role="status">正在读取制作准备与集场上下文…</p>}
  <div className={'preparation-stage-layout'+(episodeMode?' is-episode':'')}>
   {!episodeMode&&<aside className="preparation-scene-directory"><nav aria-label="制作上下文场次">{episodeScenes.map(s=><button type="button" key={s.sceneId} data-preparation-scene={s.sceneId} aria-current={scene?.sceneId===s.sceneId?'location':undefined} onClick={()=>chooseScene(s.sceneId)}><b>{s.displayId}</b><span>{(!state?.stale?state?.candidate?.scenes.find(c=>c.id===s.sceneId)?.title:undefined)||String(s.sourceSummary?.title||'场准备')}</span></button>)}</nav>{state&&!episodeScenes.length&&<p>此集尚无可定位的场准备。</p>}</aside>}
   <main className="preparation-stage-workspace" data-creator-scope={navigationScopeType}>
    <header className="preparation-stage-heading"><div><small>{navigationScopeType==='PROJECT'?'全剧导出检查':episodeMode?episode?.displayId:[episode?.displayId,scene?.displayId].filter(Boolean).join(' / ')}</small><h2>{selectionError?'制作上下文需核对':episodeMode?(episode?.title||'选择分集'):source?.title||String(scene?.sourceSummary?.title||'选择本场')}</h2><p>{stage.purpose}</p></div>{scene&&typeof state?.content?.basis.candidateRevisionId==='string'&&<a href={'?view=story&storyMode=logic&narrativeLevel=scene&episodePlanRevision='+encodeURIComponent(state.content.basis.candidateRevisionId)+'&episode='+encodeURIComponent(scene.episodeUid)+'&scene='+encodeURIComponent(scene.sceneId)}>阅读对应正文 →</a>}</header>
    {!shotProductionMode&&!!regularChecks.length&&<details className="preparation-stage-checks"><summary>阶段检查{gate&&canonicalScopeType!=='PROJECT'?' · '+gate.label:''}</summary>{checkButtons(regularChecks)}</details>}
    {!!exportChecks.length&&<details className="preparation-stage-checks preparation-export-checks" open={navigationScopeType==='PROJECT'}><summary>全剧导出检查 · 独立全剧范围</summary><p>当前分集仅用于阅读导航。这些检查覆盖全剧，不作为所选分集的通过或采用。</p>{checkButtons(exportChecks)}</details>}
    {!selectionError&&!stageError&&(stageContext&&renderStage?renderStage(stageContext):<section className="workflow-empty"><h3>本上下文尚未建立正式制作对象</h3><p>{!gate||!canonicalScopeType?'检查配置或精确作用域尚未可读，不能从阶段名称推断正式范围。':'准备稿不解锁制作。需由已采用正文和精确输入建立对应正式对象后，才能判断缺项及推进动作。'}</p><small>正式范围与进度：待确定（UNKNOWN）</small></section>)}
    {breakdownMode&&scene&&!scene.navigationOnly&&!stageError&&<section className="preparation-authoring-basis" aria-label="本场镜头设计准备依据">
     <header><h3>本场制作准备稿</h3><p>{state?.stale?'依据待重核，只读保留原稿。':'围绕镜头表达整理本场意图与素材要求；未创建正式镜头或生成授权。'}</p></header>
     <nav className="preparation-section-tabs" aria-label="本场准备内容">{tabs.map(t=><button type="button" key={t.id} aria-pressed={section===t.id} onClick={()=>setSection(t.id)}>{t.label}</button>)}</nav>
     {editing?<><PreparationEditor value={draft} onChange={setDraft}/><div className="preparation-editor-actions"><button type="button" disabled={busy||state?.stale} onClick={()=>void submit('save')}>保存本场准备稿</button><button type="button" onClick={()=>setEditing(false)}>取消编辑</button></div></>:<div className="preparation-reading-surface">{section==='INTENT'&&<details className="preparation-source"><summary>本场正文摘要依据</summary><PreparationValue value={scene.sourceSummary}/></details>}{currentTab.keys.map(key=>Object.hasOwn(scene.preparation,key)&&<section className="preparation-field" key={key}><h4>{labels[key]||key}</h4><PreparationValue value={scene.preparation[key]}/></section>)}{editable&&<button type="button" className="preparation-edit-button" onClick={()=>{setDraft(structuredClone(scene.preparation));setEditing(true);}}>编辑本场准备内容</button>}</div>}
     <section className="preparation-comments"><header><h4>本场准备意见</h4><span>意见不是正式 Review 裁决</span></header>{state?.comments.filter(c=>c.sceneId===scene.sceneId).map(c=><blockquote key={c.revisionId}>{c.text}{c.preparationRevisionId!==state.revisionId&&<small>记录于原准备稿修订 · 保留历史依据</small>}</blockquote>)}{!hostedReadOnly&&!state?.readOnly&&<><textarea aria-label="本场准备意见" value={comment} onChange={e=>setComment(e.target.value)} placeholder="记录制作意图、状态、空间或素材要求中的具体问题"/><button type="button" disabled={busy||state?.stale||!comment.trim()} onClick={()=>void submit('comment')}>保存准备意见</button></>}</section>
     <details className="preparation-exact-basis"><summary>精确依据与转交边界</summary><dl><div><dt>永久场身份</dt><dd>{scene.sceneId}</dd></div><div><dt>正文哈希</dt><dd>{scene.sceneContentHash}</dd></div><div><dt>准备稿修订</dt><dd>{state?.revisionId}</dd></div></dl><p>准备参考不是被采用的素材输入。正式转交仍须完成分集方案、场正文和场级镜头意图的审阅及受控同步，再建立正式镜头计划；不从旧场号映射或补造镜头。</p></details>
    </section>}
    {state&&!state.content&&breakdownMode&&<section className="workflow-empty"><h3>尚未登记制作准备稿</h3><p>先基于完整候选整理各场作用、画面动作、实体状态和素材缺项。准备稿不会创建正式镜头身份。</p></section>}
   </main>
  </div>
 </section>;
}
