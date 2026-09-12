'use client';

import {runtimePath} from './runtime-path';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useInstanceProfile } from './instance-context';
import { useAssistantFocus } from './assistant/context-provider';
import { StoryWorkspaceHeading } from './story-workspace-heading';
import { SystemManagement } from './system-management';
import { StorySettingsWorkspace } from './story-settings-workspace';
import {StandaloneCurrentWorkCenter} from './current-work-center';
import {ProductionPreparationWorkspace} from './production-preparation-workspace';
import {GenericSourceReader,type GenericSourceFocus} from './generic-source-reader';
import {EntityMaterialCatalog} from './entity-material-catalog';
import {saveMaterialBrowseLocation,restoreMaterialBrowseLocation} from './material-browse-state';
import {projectMaterialCreatorStage} from './material-taxonomy';
import { GenericAuthoringWorkspace } from './generic-authoring-workspace';
import type {SourceSummary} from '../presentation/domain-sources.mjs';

const views=[
  ['overview','当前工作','当前','全剧状态与当下可开展工作'],
  ['story','故事创作','故事','来源资料、故事结构与叙事拆解'],
  ['settings','故事设定','设定','主体分类、空间设定与实体关系'],
  ['materials','素材管理','素材','实体素材目录、集场筛选与统一素材信息卡'],
  ['pipeline','全剧制作','制作','镜头制作、场景剪辑与分集成片'],
  ['system','系统管理','管理','使用与初始化、系统配置、数据与运行'],
];
const storyModes=[['source','来源资料'],['story-structure','故事结构'],['logic','叙事拆解']];
const phases=[
  ['PREVIS','镜头方案与预演',['镜头设计与输入锁定','粗分镜与对白并行','Animatic锁时']],
  ['SHOT_FINISH','镜头成品',['正式首尾帧','镜头视频','单镜锁定']],
  ['SCENE_FINISH','场景成片',['场剪辑与画面锁定','场声音与混音字幕','场级QA']],
  ['EPISODE_FINISH','分集成片',['分集组装','分集审阅','分集技术QC']],
  ['SERIES_DELIVERY','全剧交付',['跨集连续性','权利敏感技术终检','交付归档']],
] as const;
const workflows=[
  ['故事 → 剧本','STORY → SCREENPLAY','准备来源资料','从来源资料开始，整理故事结构、分集剧情与逐场正文。','story','当前场次'],
  ['剧本 → 素材','SCREENPLAY → MATERIALS','等待当前剧本','根据剧本登记人物、地点、道具与声音需求，再制作和审阅素材。','materials','当前素材需求'],
  ['剧本 + 素材 → 全剧制作','SCREENPLAY + MATERIALS → PRODUCTION','等待场景与输入确认','场正文与镜头意图确认后建立正式镜头计划，按镜头制作六步骤和后续场景、分集剪辑推进。','pipeline','当前正式镜头'],
];
function tabs(items:string[][],selected:string,select:(id:string)=>void,label:string,className:string,prefix:string) {
  return <nav className={className} role="tablist" aria-label={label}>{items.map(([id,title],index)=><button key={id} id={`${prefix}-${id}`} role="tab" aria-controls={`${prefix}-panel`} aria-selected={selected===id} tabIndex={selected===id?0:-1} className={selected===id?'active':''} onClick={()=>select(id)} onKeyDown={event=>{
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowRight'?(index+1)%items.length:event.key==='ArrowLeft'?(index-1+items.length)%items.length:-1;
    if(next<0)return;event.preventDefault();select(items[next][0]);window.requestAnimationFrame(()=>window.document.getElementById(`${prefix}-${items[next][0]}`)?.focus());
  }}>{title}</button>)}</nav>;
}
const validView = (value: unknown): value is string => typeof value === 'string' && views.some(([id]) => id === value);

export function EmptyInstanceDesk({ snapshotId }: { snapshotId: string }) {
  const instance = useInstanceProfile();
  const defaultView = validView(instance.capabilities.landingView) ? instance.capabilities.landingView : 'system';
  const [view, setView] = useState(defaultView);
  const [routeReady,setRouteReady]=useState(false);
  const viewRef=useRef(defaultView);
  const [storyMode,setStoryMode]=useState('source');
  const [phaseId,setPhaseId]=useState('PREVIS');
  const [documents, setDocuments] = useState<SourceSummary[]>([]);
  const [listState, setListState] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [listAttempt, setListAttempt] = useState(0);
  const [genericSourceFocus,setGenericSourceFocus] = useState<GenericSourceFocus|null>(null);
  // The source focus is valid only while its successfully loaded body is visible.
  const sourceFocus = view === 'story' && storyMode === 'source' ? genericSourceFocus : null;
  useAssistantFocus({ projectId: instance.projectId, snapshotId, subjectType: sourceFocus ? 'SOURCE' : 'PROJECT', subjectId: sourceFocus?.id || instance.projectId, title: sourceFocus?.title || instance.storyTitle, view });

  const closeDocument = useCallback(() => {
    setGenericSourceFocus(null);
  }, []);
  const selectView = useCallback((next: string) => {
    viewRef.current=next;
    setView(next);
    if (next !== 'story') closeDocument();
  }, [closeDocument]);
  useEffect(() => {
    const refresh = (event?:PopStateEvent) => {
      const incoming=new URL(location.href);
      if(restoreMaterialBrowseLocation(incoming))history.replaceState(history.state,'',incoming);
      const requested = new URL(location.href).searchParams.get('view');
      if(event&&(validView(requested)?requested:defaultView)!==viewRef.current&&!window.dispatchEvent(new Event('review:configuration-before-leave',{cancelable:true}))){const url=new URL(location.href);url.searchParams.set('view',viewRef.current);history.pushState({},'',url);return;}
      selectView(validView(requested) ? requested : defaultView);
      const params=new URL(location.href).searchParams;
      const mode=params.get('storyMode')==='audit'?'logic':storyModes.find(([id])=>id===params.get('storyMode'))?.[0]||'source';
      if(params.get('storyMode')==='audit'){const url=new URL(location.href);url.searchParams.set('storyMode','logic');history.replaceState(history.state,'',url);}
      setStoryMode(mode);if(mode!=='source')closeDocument();
      if(requested==='materials'&&params.get('materialMode')!=='classification'){const url=new URL(location.href);url.searchParams.set('materialMode','classification');history.replaceState(history.state,'',url);}
      setPhaseId(phases.find(([id])=>id===params.get('productionPhase')||id.toLowerCase().replaceAll('_','-')===params.get('productionPhase'))?.[0]||'PREVIS');
    };
    let active=true;
    queueMicrotask(()=>{if(active){refresh();setRouteReady(true);}});
    addEventListener('popstate', refresh);
    return () => {active=false;removeEventListener('popstate', refresh);};
  }, [defaultView, selectView, closeDocument]);

  useEffect(() => {
    if(view!=='overview')return;
    const controller = new AbortController();
    let active = true;
    void fetch('/api/v1/workspaces/sources', { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('来源目录暂时无法读取');
        const body = await response.json() as { sources?: SourceSummary[] };
        if (!Array.isArray(body.sources)) throw new Error('来源目录格式不匹配');
        if (active) { setDocuments(body.sources); setListState('READY'); }
      })
      .catch(() => { if (active) setListState('ERROR'); });
    return () => { active = false; controller.abort(); };
  }, [instance.instanceId, snapshotId, listAttempt,view]);

  useEffect(() => {
    const refresh=()=>{setListState('LOADING');setListAttempt(value=>value+1);};
    window.addEventListener('review:sources-updated',refresh);
    return()=>window.removeEventListener('review:sources-updated',refresh);
  }, []);

  function goHome() {
    if(!window.dispatchEvent(new Event('review:configuration-before-leave',{cancelable:true})))return;
    saveMaterialBrowseLocation(new URL(location.href));
    history.pushState({},'', '/');
    selectView(defaultView);setStoryMode('source');setPhaseId('PREVIS');
    window.dispatchEvent(new Event('review:root-location'));
    document.querySelector('.workspace-main')?.scrollTo({top:0});window.scrollTo({top:0});
  }
  function navigate(next: string) {
    if (next === view) return;
    if (!window.dispatchEvent(new Event("review:configuration-before-leave", {cancelable:true}))) return;
    selectView(next);
    const url = new URL(location.href);
    if(view==='materials')saveMaterialBrowseLocation(url);
    url.searchParams.set('view', next);
    if(next==='materials')restoreMaterialBrowseLocation(url,true);
    if (url.href !== location.href) history.pushState({}, '', url);
    window.document.querySelector('.workspace-main')?.scrollTo({top:0});window.scrollTo({top:0});
  }
  const title = views.find(([id]) => id === view)?.[1] || '当前工作';
  const sources = documents;
  const sourcesLoaded=listState==='READY';
  const sourcesError=listState==='ERROR';
  function route(key:string,next:string){const url=new URL(location.href);url.searchParams.set(key,next);if(url.href!==location.href)history.pushState({},'',url);}
  function selectStory(next:string){if(next===storyMode)return;if(!window.dispatchEvent(new Event('review:configuration-before-leave',{cancelable:true})))return;setStoryMode(next);if(next!=='source')closeDocument();route('storyMode',next);}
  function selectPhase(next:string){setPhaseId(next);route('productionPhase',next.toLowerCase().replaceAll('_','-'));}
  const currentView=views.find(([id])=>id===view)||views[0];
  const phase=phases.find(([id])=>id===phaseId)||phases[0];
  const startStory=<button className="empty-desk-action" onClick={()=>{setView('system');const url=new URL(location.href);url.searchParams.set('view','system');url.searchParams.set('systemTab','start');if(url.href!==location.href)history.pushState({},'',url);window.document.querySelector('.workspace-main')?.scrollTo({top:0});window.scrollTo({top:0});}}>确认系统规则 →</button>;
  return <main className="review-shell empty-desk">
    <aside className="workspace-sidebar" aria-label="审阅台主导航">
      <button className="sidebar-brand" onClick={goHome} aria-label="返回审阅台首页"><span className="brand-mark">{instance.branding.mark}</span><span><b>{instance.branding.title}</b><small>LOCAL PRODUCTION DESK</small></span></button>
      <nav className="workspace-nav" aria-label="主导航">{views.map(([id,label,index,desc])=><button key={id} aria-label={label} className={view===id?'active':''} aria-current={view===id?'page':undefined} onClick={()=>navigate(id)}><span>{index}</span><div><b>{label}</b><small>{desc}</small></div></button>)}</nav>
      <div className="sidebar-snapshot"><i/><div><b>{instance.storyTitle}</b><span>故事、素材与审阅记录独立保存</span></div></div>
    </aside>
    <div className="workspace-main"><header className="workspace-topbar"><div className="view-context"><span>{currentView[2]}</span><div><small>当前视图</small><b>{title}</b></div></div><span className="empty-desk-context">{instance.storyTitle}</span></header><div className="workspace-content"><section className="workspace-view">
      {view==='system'||view==='settings'||view==='overview'?null:view==='story'?<StoryWorkspaceHeading>{tabs(storyModes,storyMode,selectStory,'故事创作方式','segmented story-mode-tabs','empty-story')}</StoryWorkspaceHeading>:<header className="workspace-heading"><div><p>{({materials:'SCREENPLAY → MATERIALS',pipeline:'FULL PRODUCTION'} as Record<string,string>)[view]}</p><h1>{view==='pipeline'?'从拆镜表达，到整集成片':title}</h1></div><p>{currentView[3]}</p></header>}
    {view==='overview'&&<StandaloneCurrentWorkCenter/>}
    {view==='story'&&<>
      <div id="empty-story-panel" role="tabpanel" aria-labelledby={`empty-story-${storyMode}`}>
      {storyMode!=='source'&&<GenericAuthoringWorkspace kind={storyMode==='story-structure'?'STORY_OUTLINE':storyMode==='logic'?'EPISODE_PLAN':'SCENE_SCRIPT'}/>}
      {storyMode==='story-structure'&&<GenericAuthoringWorkspace kind="SCREENPLAY"/>}
      {storyMode==='logic'&&<GenericAuthoringWorkspace kind="SCENE_SCRIPT"/>}
      {storyMode==='source'?<GenericSourceReader onDocumentChange={setGenericSourceFocus}/>:<section className="empty-desk-panel"><header><small>下一步</small><h2>{storyMode==='story-structure'?'从作者草稿继续推进':storyMode==='logic'?'完整分集候选进入审阅':'场正文逐场进入审阅'}</h2></header><p>{storyMode==='story-structure'?'来源资料整理后，在这里查看故事骨架、人物关系、案件因果与观众线索。':storyMode==='logic'?'形成完整分集候选后，在这里判断各集剧情设计。集数和时长仍未锁定。':'形成当前场正文后，在这里对照来源、填写意见并逐场审阅。当前场次分母未锁定。'}</p><footer>{startStory}</footer></section>}
      </div>
    </>}
    {view==='materials'&&<div className="material-center"><h2>素材分类管理</h2><EntityMaterialCatalog requirements={[]} selectedRequirement={null} mode="classification" onSelect={()=>{}} stageFor={()=>projectMaterialCreatorStage({lifecycleState:'WAITING_UPSTREAM'})} inspector={<p>先选择实体，登记状态与素材需求；存在定义不代表已有产物。<a href={runtimePath("?view=settings")}>登记主体与空间 →</a></p>} episodeScope="全部" sceneScope="全部" mediaFilter="全部" stageFilter="全部" search=""/></div>}
    {view==='pipeline'&&<ProductionPreparationWorkspace initialPhaseId={phaseId}/>}
    {view==='settings'&&<StorySettingsWorkspace />}
    {routeReady&&view==='system'&&<SystemManagement />}
    </section></div></div>
    <nav className="mobile-nav is-six-entries" aria-label="移动端导航">{views.map(([id,label,short])=><button key={id} aria-label={label} className={view===id?'active':''} aria-current={view===id?'page':undefined} onClick={()=>navigate(id)}>{short}</button>)}</nav>
  </main>;
}
