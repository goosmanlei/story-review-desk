'use client';
import {useCallback,useEffect,useMemo,useState} from 'react';
import {productionMaterialKinds,productionMaterialLocation,type ProductionMaterialFilters,type ProductionMaterialRow} from '../host/instance-runtime/production-materials.mjs';
import type {ProductionMaterialPage} from '../host/instance-runtime/production-material-query.mjs';
import {mergePagedProductionModel} from './paged-production-data';
import {ProductionWorkItemInformationCard,type ProductionModel,type ProductionNavigationIntent} from './production-workbench';
import {MaterialReviewDrawer} from './material-review-drawer';
import {visibleText} from './review-semantics';
import './production-material-catalog.css';

type Page=ProductionMaterialPage&{snapshotId:string;operationRevision:number|string};
type Location={familyId:string|null;versionId:string|null;filters:ProductionMaterialFilters};
const queryFields={search:'processQ',kind:'processKind',mediaType:'processMedia',lifecycleState:'processState',gateId:'processGate',episodeUid:'processEpisode',sceneId:'processScene',shotId:'processShot'} as const;
const emptyLocation:Location={familyId:null,versionId:null,filters:{}};
const lifecycleLabels:Record<string,string>={WAITING_UPSTREAM:'等待上游',READY_TO_START:'待制作',IN_PROGRESS:'制作中',REVIEW_PENDING:'待审阅',RELEASED:'已通过',REVISION_REQUIRED:'需返修',DO_NOT_USE:'禁止使用',UNKNOWN:'待核验',NOT_PRODUCED:'未产出'};
const mediaLabels:Record<string,string>={IMAGE:'图像',AUDIO:'声音',VIDEO:'视频',TEXT:'文本',UNKNOWN:'媒介待核'};
const gateLabels:Record<string,string>={SHOT_PLAN_INPUT_LOCK:'镜头设计与输入锁定',STORYBOARD_DIALOGUE:'粗分镜／对白并行',ANIMATIC_LOCK:'Animatic锁时',KEYFRAMES:'正式关键帧',SHOT_VIDEO:'镜头视频',SHOT_LOCK:'单镜锁定'};

function readLocation():Location {
  const params=new URL(window.location.href).searchParams;
  return{familyId:params.get('productionMaterial'),versionId:params.get('productionMaterialVersion'),filters:Object.fromEntries(Object.entries(queryFields).flatMap(([key,param])=>params.get(param)?[[key,params.get(param)]]:[]))};
}
function writeLocation(value:Location,push=false){
  const url=new URL(window.location.href);url.searchParams.set('view','materials');url.searchParams.set('materialCatalog','production');
  for(const [key,param]of Object.entries(queryFields)){const valueForKey=value.filters[key as keyof ProductionMaterialFilters];if(valueForKey)url.searchParams.set(param,valueForKey);else url.searchParams.delete(param);}
  for(const [key,valueForKey]of [['productionMaterial',value.familyId],['productionMaterialVersion',value.versionId]]){if(valueForKey)url.searchParams.set(key!,valueForKey);else url.searchParams.delete(key!);}
  if(push)window.history.pushState(window.history.state,'',url);else window.history.replaceState(window.history.state,'',url);
  window.dispatchEvent(new Event('review:material-catalog-location'));
}

export function ProductionMaterialCatalog({model:baseModel,snapshotId}:{model:ProductionModel;snapshotId?:string}){
  const [location,setLocation]=useState<Location>(emptyLocation),[loaded,setLoaded]=useState(false),[page,setPage]=useState<Page|null>(null),[detail,setDetail]=useState<Page|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[detailError,setDetailError]=useState(''),[revision,setRevision]=useState(0),[requestMore,setRequestMore]=useState<string|null>(null);
  useEffect(()=>{const read=()=>{setLocation(readLocation());setLoaded(true);};read();window.addEventListener('popstate',read);window.addEventListener('review:material-catalog-location',read);return()=>{window.removeEventListener('popstate',read);window.removeEventListener('review:material-catalog-location',read);};},[]);
  useEffect(()=>{const refresh=()=>{setRequestMore(null);setRevision(value=>value+1);};window.addEventListener('review:operations-updated',refresh);return()=>window.removeEventListener('review:operations-updated',refresh);},[]);
  const filterKey=JSON.stringify(location.filters);
  useEffect(()=>{
    if(!loaded)return;
    const controller=new AbortController(),query=new URLSearchParams({limit:'50',detail:'summary'});
    for(const [key,value]of Object.entries(JSON.parse(filterKey)))if(value)query.set(key,String(value));
    if(requestMore)query.set('cursor',requestMore);
    setLoading(true);setError('');
    void fetch('/api/v8/ui/production-materials?'+query,{cache:'no-store',signal:controller.signal}).then(async response=>{
      const body=await response.json() as Page&{error?:string};if(!response.ok)throw new Error(body.error||'制作素材目录读取失败');
      if(snapshotId&&body.snapshotId!==snapshotId)throw new Error('制作素材发布已更新，请刷新页面');
      if(!controller.signal.aborted)setPage(previous=>requestMore&&previous&&previous.snapshotId===body.snapshotId&&previous.operationRevision===body.operationRevision?{...body,entries:[...previous.entries,...body.entries.filter(row=>!previous.entries.some(old=>old.id===row.id))]}:body);
    }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'制作素材目录读取失败');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[loaded,filterKey,snapshotId,revision,requestMore]);
  useEffect(()=>{
    if(!loaded||!location.familyId){setDetail(null);setDetailError('');return;}
    const controller=new AbortController(),query=new URLSearchParams({familyId:location.familyId});
    if(location.versionId)query.set('versionId',location.versionId);
    setDetail(null);setDetailError('');
    void fetch('/api/v8/ui/production-materials?'+query,{cache:'no-store',signal:controller.signal}).then(async response=>{
      const body=await response.json() as Page&{error?:string};if(!response.ok)throw new Error(body.error||'制作素材详情读取失败');
      if(snapshotId&&body.snapshotId!==snapshotId)throw new Error('制作素材详情与当前发布不一致');
      if(body.entries.length!==1||body.entries[0].familyId!==location.familyId)throw new Error('返回详情未精确绑定指定素材');
      if(!controller.signal.aborted)setDetail(body);
    }).catch(reason=>{if(!controller.signal.aborted)setDetailError(reason instanceof Error?reason.message:'制作素材详情读取失败');});
    return()=>controller.abort();
  },[loaded,location.familyId,location.versionId,snapshotId,revision]);
  const model=useMemo(()=>detail?mergePagedProductionModel(baseModel,detail.page):baseModel,[baseModel,detail]);
  const selected=detail?.entries[0]||null;
  const patchFilter=(patch:Partial<ProductionMaterialFilters>)=>{setRequestMore(null);setPage(null);writeLocation({...location,filters:{...location.filters,...patch}});};
  const select=(row:ProductionMaterialRow,versionId:string|null=null)=>writeLocation({...location,familyId:row.familyId,versionId},true);
  const close=()=>{writeLocation({...location,familyId:null,versionId:null});return true;};
  const openBasic=useCallback((requirementId:string)=>{const query=new URLSearchParams({view:'materials',materialCatalog:'basic',material:requirementId});window.location.assign('/?'+query);},[]);
  const navigate=(intent:ProductionNavigationIntent)=>{
    const item=model.workItems.find(row=>row.id===intent.workItemId),family=model.assetFamilies.find(row=>row.id===(intent.familyId||item?.outputAssetRef));
    if(!item||!family){setDetailError('所选工作项或素材族不存在，已停止默认回退');return;}
    if(family.id!==item.outputAssetRef&&!(item.additionalOutputAssetRefs||[]).includes(family.id)){
      const requirements=(model.materialRequirements||[]).filter(row=>row.requirementClass==='REQUIRED'&&row.assetFamilyRefs.includes(family.id));
      if(requirements.length===1){openBasic(requirements[0].id);return;}
      const producer=model.workItems.find(row=>row.outputAssetRef===family.id);
      if(!producer){setDetailError('该输入尚无可唯一定位的素材信息卡，保留当前对象');return;}
    }
    writeLocation({...location,familyId:family.id,versionId:intent.versionId||null},true);
  };
  const productionLink=selected?'/?'+new URLSearchParams({view:'pipeline',item:selected.workItemId,work:selected.workPackageId,...(selected.scopeOwner.type==='SHOT'?{shot:selected.scopeOwner.id}:{}),...(selected.gateId?{productionGate:selected.gateId}:{}),...(selected.phaseId?{productionPhase:selected.phaseId}:{})}):'';
  const scopeLabel=(row:ProductionMaterialRow)=>{
    if(row.scopeOwner.type==='SHOT'){const shot=baseModel.shots.find(item=>item.id===row.scopeOwner.id);return shot?.title||row.scopeOwner.id;}
    if(row.scopeOwner.type==='SCENE'){const scene=baseModel.scenes.find(item=>item.id===row.scopeOwner.id);return scene?.title||row.scopeOwner.id;}
    return row.scopeOwner.id;
  };
  return <section className="production-material-catalog" aria-label="制作过程素材">
    <header className="production-material-heading"><div><h2>制作过程素材</h2><p>按步骤查找分镜、对白、预演和关键帧，打开同一素材版本及制作信息卡。</p></div><span>{page?`${page.total} 项制作产物`:'正在读取目录'}</span></header>
    <div className="production-material-filters">
      <label>制作步骤<select value={location.filters.gateId||''} onChange={event=>patchFilter({gateId:event.target.value})}><option value="">全部步骤</option>{Object.entries(gateLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>素材种类<select value={location.filters.kind||''} onChange={event=>patchFilter({kind:event.target.value})}><option value="">全部种类</option>{productionMaterialKinds.map(kind=><option key={kind.id} value={kind.id}>{kind.label}</option>)}</select></label>
      <label>媒介<select value={location.filters.mediaType||''} onChange={event=>patchFilter({mediaType:event.target.value})}><option value="">全部媒介</option>{Object.entries(mediaLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>状态<select value={location.filters.lifecycleState||''} onChange={event=>patchFilter({lifecycleState:event.target.value})}><option value="">全部状态</option>{(page?.facets.lifecycleStates||[]).map(value=><option key={value} value={value}>{lifecycleLabels[value]||visibleText(value)}</option>)}</select></label>
      <label>分集<select value={location.filters.episodeUid||''} onChange={event=>patchFilter({episodeUid:event.target.value,sceneId:'',shotId:''})}><option value="">全部分集</option>{(page?.facets.episodeUids||[]).map(id=><option key={id} value={id}>{baseModel.episodes.find(row=>row.episodeUid===id)?.displayId||id}</option>)}</select></label>
      <label>场景<select value={location.filters.sceneId||''} onChange={event=>patchFilter({sceneId:event.target.value,shotId:''})}><option value="">全部场景</option>{(page?.facets.sceneIds||[]).map(id=><option key={id} value={id}>{baseModel.scenes.find(row=>row.id===id)?.title||id}</option>)}</select></label>
      <label className="production-material-search">搜索<input type="search" value={location.filters.search||''} placeholder="素材、镜头、场景或永久身份" onChange={event=>patchFilter({search:event.target.value})}/></label>
    </div>
    {error&&<p role="alert">{error} <button type="button" onClick={()=>{setRequestMore(null);setRevision(value=>value+1);}}>重新读取</button></p>}
    {!!page?.issues.length&&<p role="status">{page.issues.length} 项产物归属或版本绑定待核验，暂未计入当前目录。</p>}
    {!loading&&page?.entries.length===0&&<p className="production-material-empty">当前范围尚无制作过程素材。正式镜头设计与输入锁定完成后，粗分镜、对白和后续关键帧会按步骤出现在这里。</p>}
    <div className="production-material-list" aria-busy={loading}>{(page?.entries||[]).map(row=><button type="button" key={row.id} className="production-material-row" data-production-material-id={row.familyId} onClick={()=>select(row)}>
      <span className="production-material-kind">{row.kindLabel}<small>{mediaLabels[row.mediaType]||row.mediaType}</small></span><span className="production-material-title"><b>{visibleText(row.title)}</b><small>{scopeLabel(row)} · {gateLabels[row.gateId||'']||'已登记制作步骤'}</small></span>
      <span>{lifecycleLabels[row.lifecycleState]||visibleText(row.lifecycleState)}<small>{row.presentVersionIds.length?`${row.presentVersionIds.length} 个文件版本`:'尚未产出文件'}</small></span><span aria-hidden="true">→</span>
    </button>)}</div>
    {loading&&<p role="status">正在读取制作素材…</p>}{page?.hasMore&&!loading&&<button type="button" className="production-material-more" onClick={()=>setRequestMore(page.nextCursor)}>继续读取</button>}
    <MaterialReviewDrawer open={Boolean(location.familyId)} title={selected?.title||'制作素材详情'} kind="material" onClose={close}>
      {detailError?<section role="alert"><p>{detailError}</p><code>{location.familyId}{location.versionId?' / '+location.versionId:''}</code><button type="button" onClick={()=>setRevision(value=>value+1)}>重新读取详情</button></section>:!selected?<p role="status">正在核对精确制作素材与版本…</p>:<>
        <div className="production-material-detail-links"><a href={productionLink}>返回镜头制作的对应步骤 →</a><a href={productionMaterialLocation(selected,location.versionId)}>此版本的素材深链</a></div>
        <dl className="production-material-owner"><div><dt>所属{({SHOT:'镜头',SCENE:'场景',EPISODE:'分集',PROJECT:'全剧'})[selected.scopeOwner.type]}</dt><dd>{scopeLabel(selected)}</dd></div><div><dt>素材种类</dt><dd>{selected.kindLabel}</dd></div><div><dt>范围修订</dt><dd>{selected.scopeOwner.revisionId||'尚未登记'}</dd></div></dl>
        <ProductionWorkItemInformationCard model={model} workItemId={selected.workItemId} familyId={selected.familyId} versionId={location.versionId} onNavigate={navigate} onOpenMaterial={openBasic}/>
        <section className="production-material-usage"><h3>引用与使用</h3><p>已声明 {selected.declaredConsumerWorkItemIds.length} 个后续工作项，实际版本输入 {selected.actualConsumers.length} 项。</p>{selected.actualConsumers.map((consumer,index)=><p key={consumer.versionId+':'+index}><a href={productionMaterialLocation({familyId:consumer.familyId},consumer.versionId)}>{consumer.versionId}</a> 使用 {consumer.inputVersionId} · <code>{consumer.sha256}</code></p>)}{selected.materialRequirementIds.map(id=><button type="button" key={id} onClick={()=>openBasic(id)}>查看关联基础素材 →</button>)}</section>
      </>}
    </MaterialReviewDrawer>
  </section>;
}
