'use client';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { EpisodePlanContext } from './episode-plan-context';
import { annotatedText } from './document-blocks';
import { commentTargetBinding, commentTargetKey, type StoryCommentTarget, type StoryCommentThread } from './story-comment-model';
import { sceneCommentAnchorSegments, type SceneCommentAnchor } from './scene-script-comments';
import { useRuntimeMode } from './runtime-mode';
import { useInstanceProfile } from './instance-context';
import { sceneRequirements } from './scene-narrative-context';
import { requirementCommentField } from './story-comment-model';
import { PaginatedClosedCommentHistory } from './closed-comment-history';

type Draft = { targetKey: string; anchor: SceneCommentAnchor; text: string; commentId?: string; commentRevisionId?: string; latestEventId?: string };
type SelectionPosition = { left: number; top: number };
type Context = {
  targets: StoryCommentTarget[]; threads: StoryCommentThread[]; draft: Draft|null; activeId: string|null;
  capture: () => void; locate: (thread: StoryCommentThread) => void; activate: (thread:StoryCommentThread)=>void;
};
const Comments = createContext<Context|null>(null);
const readStored = (key: string) => { try { return JSON.parse(localStorage.getItem(key)||'null'); } catch { return null; } };
const storeDraft = (key: string, value: unknown) => { try { if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,JSON.stringify(value)); } catch { /* in-memory editor remains usable */ } };
function selectionPosition(range: Range): SelectionPosition|null {
  const rects=Array.from(range.getClientRects()).filter(r=>r.width&&r.height&&r.bottom>60&&r.top<innerHeight-8&&r.right>0&&r.left<innerWidth);
  const rect=rects.at(-1);if(!rect)return null;
  return {left:Math.max(8,Math.min(innerWidth-120,rect.right-112)),top:rect.top>=108?rect.top-46:Math.min(innerHeight-48,rect.bottom+8)};
}

/** The slot keeps the current view's comments beside the project assistant. */
export function StoryCommentEntry() {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- The launcher also runs outside the manually routed story page.
  return <><span id="story-comment-entry"/><button type="button" className="story-comment-entry-fallback story-comment-trigger" onClick={()=>window.location.assign('/?view=story&storyMode=logic&comments=open')}>查看评论</button></>;
}

export function StoryCommentsProvider({plan,episodeUid,sceneId,onReveal,children}: {
  plan: EpisodePlanContext; episodeUid?: string; sceneId?: string;
  onReveal?: (target: StoryCommentTarget,blockId:string)=>void; children: ReactNode;
}) {
  const {hostedReadOnly}=useRuntimeMode(), instance=useInstanceProfile();
  const [targets,setTargets]=useState<StoryCommentTarget[]>([]), [openThreads,setThreads]=useState<StoryCommentThread[]>([]);
  const [closedCount,setClosedCount]=useState(0),[closedThreads,setClosedThreads]=useState<StoryCommentThread[]>([]);
  const threads=[...openThreads,...closedThreads];
  const rememberClosed=useCallback((thread:StoryCommentThread)=>setClosedThreads(current=>[...current.filter(item=>item.commentId!==thread.commentId),thread].slice(-20)),[]);
  const [error,setError]=useState(''),[loaded,setLoaded]=useState(false),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
  const [draft,setDraft]=useState<Draft|null>(null),[activeId,setActiveId]=useState<string|null>(null);
  const [pending,setPending]=useState<Draft|null>(null),[notice,setNotice]=useState(''),[suggestion,setSuggestion]=useState('');
  const [selectionSpot,setSelectionSpot]=useState<SelectionPosition|null>(null),[entrySlot,setEntrySlot]=useState<HTMLElement|null>(null);
  const [refresh,setRefresh]=useState(0);
  const root=useRef<HTMLDivElement>(null), editor=useRef<HTMLTextAreaElement>(null), trigger=useRef<HTMLButtonElement>(null);
  const drawer=useRef<HTMLElement>(null), selectionRange=useRef<Range|null>(null), revealTimer=useRef<number|undefined>(undefined), activationTimer=useRef<number|undefined>(undefined);
  const scope=`${instance.instanceId}:${plan.revisionId}:${sceneId||episodeUid}`;
  const prefix=`story-comments:${instance.instanceId}:${plan.revisionId}:`;
  const draftKey=(d:Draft)=>`${prefix}${d.targetKey}:${d.commentId||`new:${d.anchor.blockId}:${d.anchor.startOffset}:${d.anchor.endBlockId||d.anchor.blockId}:${d.anchor.endBlockOffset??d.anchor.endOffset}`}`;
  const scopeKey=`story-comments-editor:${scope}`;
  const currentIdentity=useRef(scope);
  const draftIdentity=useRef('');
  const readGeneration=useRef(0);
  const invalidateReads=useCallback(()=>{readGeneration.current++;},[]);
  useLayoutEffect(()=>{currentIdentity.current=scope;draftIdentity.current=draft?JSON.stringify(draft):'';return()=>{currentIdentity.current='';draftIdentity.current='';};},[scope,draft]);
  const url=`/api/v8/script-comments?revisionId=${encodeURIComponent(plan.revisionId)}&${sceneId?'sceneId='+encodeURIComponent(sceneId):'episodeUid='+encodeURIComponent(episodeUid||'')}`;

  const readComments=useCallback(async(signal?:AbortSignal)=>{
    if(signal?.aborted)return;
    const generation=++readGeneration.current;
    try{
      const response=await fetch(url,{cache:'no-store',signal}); const value=await response.json() as {error?:string;snapshotId:string;revisionId:string;planContentHash:string;targets:StoryCommentTarget[];threads:StoryCommentThread[];closedCount?:number};
      if(!response.ok)throw new Error(value.error||'读取评论失败');
      if(value.snapshotId!==plan.snapshotId||value.revisionId!==plan.revisionId||value.planContentHash!==plan.contentHash)throw new Error('评论与当前故事版本不一致');
      if(!signal?.aborted&&generation===readGeneration.current){setTargets(value.targets);setThreads(value.threads);setClosedCount(value.closedCount||0);setClosedThreads([]);setError('');setLoaded(true);}
    }catch(e){if(!signal?.aborted&&generation===readGeneration.current){setError(e instanceof Error?e.message:'读取失败');setLoaded(false);}}
  },[url,plan.snapshotId,plan.revisionId,plan.contentHash]);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.resolve().then(()=>readComments(controller.signal));
    return()=>{controller.abort();invalidateReads();};
  },[readComments,refresh,invalidateReads]);
  useEffect(()=>{
    const update=()=>setRefresh(n=>n+1);
    window.addEventListener('focus',update);window.addEventListener('story-comments-changed',update);
    const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel(`story-comments:${instance.instanceId}`):null;
    if(channel)channel.onmessage=update;
    return()=>{window.removeEventListener('focus',update);window.removeEventListener('story-comments-changed',update);channel?.close();};
  },[instance.instanceId]);
  useEffect(()=>{
    const key=readStored(scopeKey); const saved=typeof key==='string'&&key.startsWith(prefix)?readStored(key):null;
    const timer=window.setTimeout(()=>{if(saved?.anchor&&typeof saved.text==='string'&&typeof saved.targetKey==='string')setDraft(saved);},0);
    return()=>window.clearTimeout(timer);
    // Restore only a draft explicitly used in this view/scope, never a neighbouring scene.
  },[scopeKey,prefix]);
  useEffect(()=>{
    const timer=window.setTimeout(()=>{
      setEntrySlot(document.getElementById('story-comment-entry'));
      const url=new URL(location.href);
      if(url.searchParams.get('comments')==='open'){setOpen(true);url.searchParams.delete('comments');history.replaceState(history.state,'',url);}
    },0);
    return()=>{window.clearTimeout(timer);window.clearTimeout(revealTimer.current);window.clearTimeout(activationTimer.current);};
  },[]);
  useEffect(()=>{
    document.documentElement.dataset.storyCommentsOpen=String(open);
    if(open)window.dispatchEvent(new CustomEvent('review-open-panel',{detail:'comments'}));
    const switchPanel=(event:Event)=>{if((event as CustomEvent).detail==='codex')setOpen(false);};
    window.addEventListener('review-open-panel',switchPanel);
    return()=>{delete document.documentElement.dataset.storyCommentsOpen;window.removeEventListener('review-open-panel',switchPanel);};
  },[open]);
  useEffect(()=>{
    if(!pending)return;
    const reposition=()=>setSelectionSpot(selectionRange.current?selectionPosition(selectionRange.current):null);
    const clear=()=>{if(window.getSelection()?.isCollapsed){setPending(null);selectionRange.current=null;}};
    window.addEventListener('scroll',reposition,true);window.addEventListener('resize',reposition);document.addEventListener('selectionchange',clear);
    return()=>{window.removeEventListener('scroll',reposition,true);window.removeEventListener('resize',reposition);document.removeEventListener('selectionchange',clear);};
  },[pending]);
  useEffect(()=>{
    if(!open)return;
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}};
    window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
  },[open]);

  function changeDraft(value: Draft|null) {
    setSuggestion('');setDraft(value);
    if(value){storeDraft(draftKey(value),value);storeDraft(scopeKey,draftKey(value));}
    else storeDraft(scopeKey,null);
  }
  function startDraft(value:Draft) {
    const saved=readStored(draftKey(value));
    // Different selections retain separate drafts and always open the chosen passage.
    const next=saved?.anchor&&JSON.stringify(saved.anchor)===JSON.stringify(value.anchor)?saved:value;
    setNotice('');
    changeDraft(next);setPending(null);selectionRange.current=null;window.getSelection()?.removeAllRanges();
    setActiveId(next.commentId||'DRAFT');setOpen(true);
    revealAnchor(next.targetKey,next.anchor,next.commentId||'DRAFT',true);
  }
  function cancelDraft() {
    if(!draft||busy)return;
    storeDraft(draftKey(draft),null);changeDraft(null);setActiveId(null);setNotice('');
    trigger.current?.focus({preventScroll:true});
  }
  const capture=useCallback(()=>{
    setPending(null);
    const selection=window.getSelection();
    if(!selection||selection.isCollapsed||selection.rangeCount!==1||!loaded||hostedReadOnly){setPending(null);return;}
    const range=selection.getRangeAt(0);
    window.clearTimeout(activationTimer.current);
    // Native paragraph selection often ends at the next element's offset zero.
    // Intersect the range with actual comment text, excluding labels and boundary-only nodes.
    const selected=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-comment-text]')||[]).flatMap(node=>{
      if(!node.getClientRects().length||!range.intersectsNode(node))return [];
      const clipped=document.createRange();clipped.selectNodeContents(node);
      if(range.compareBoundaryPoints(Range.START_TO_START,clipped)>0)clipped.setStart(range.startContainer,range.startOffset);
      if(range.compareBoundaryPoints(Range.END_TO_END,clipped)<0)clipped.setEnd(range.endContainer,range.endOffset);
      if(clipped.collapsed||!node.contains(clipped.startContainer)||!node.contains(clipped.endContainer))return [];
      return [{node,range:clipped}];
    });
    if(!selected.length)return;
    const key=selected[0].node.dataset.commentTarget;
    if(selected.some(s=>s.node.dataset.commentTarget!==key)){setNotice('请在同一场正文或同一集的设计说明内圈选。');return;}
    const target=targets.find(t=>commentTargetKey(t)===key);if(!target)return;
    const first=target.blocks.findIndex(b=>b.id===selected[0].node.dataset.commentBlock),last=target.blocks.findIndex(b=>b.id===selected.at(-1)!.node.dataset.commentBlock);
    const blocks=selected.map(s=>target.blocks.find(b=>b.id===s.node.dataset.commentBlock));
    if(blocks.some(b=>!b)||new Set(blocks.map(b=>b!.id)).size!==blocks.length)return;
    if(target.kind==='SCENE_SCRIPT'&&(first<0||last<first||last-first+1!==selected.length||selected.some((s,i)=>s.node.dataset.commentBlock!==target.blocks[first+i].id)))return;
    const offset=(container:HTMLElement,node:Node,pos:number)=>{const r=document.createRange();r.selectNodeContents(container);r.setEnd(node,pos);return r.toString().length;};
    const segments=selected.map(({node,range:part},i)=>{
      const b=blocks[i]!,a=offset(node,part.startContainer,part.startOffset),z=offset(node,part.endContainer,part.endOffset);
      return {blockId:b.id,startOffset:a,endOffset:z,quote:b.text.slice(a,z)};
    });
    if(segments.some(s=>s.endOffset<=s.startOffset))return;
    const firstSegment=segments[0],lastSegment=segments.at(-1)!;
    const visualRange=selected[0].range.cloneRange(),end=selected.at(-1)!.range;visualRange.setEnd(end.endContainer,end.endOffset);
    selectionRange.current=visualRange;setSelectionSpot(selectionPosition(visualRange));
    setPending({targetKey:key!,text:'',anchor:{...firstSegment,segments,quote:segments.map(s=>s.quote).join('\n\n'),endBlockId:lastSegment.blockId,endBlockOffset:lastSegment.endOffset}});
    setNotice('');
  },[targets,loaded,hostedReadOnly]);
  useEffect(()=>{
    // Touch selection handles and keyboard extensions also update the nearby action.
    let timer:number;
    const update=()=>{window.clearTimeout(timer);timer=window.setTimeout(capture,80);};
    document.addEventListener('selectionchange',update);
    return()=>{window.clearTimeout(timer);document.removeEventListener('selectionchange',update);};
  },[capture]);
  const revealAnchor=useCallback((targetKey:string,anchor:SceneCommentAnchor,annotationId:string,editing=false)=>{
    window.clearTimeout(revealTimer.current);
    const target=targets.find(t=>commentTargetKey(t)===targetKey);if(!target)return;
    const blockId=anchor.blockId;
    onReveal?.(target,blockId);
    let attempts=0;
    const find=()=>{
      // React may commit the new editor after an existing anchor is already visible.
      if(editing&&editor.current?.dataset.commentEditor!==`${targetKey}:${annotationId}:${JSON.stringify(anchor)}`){
        if(++attempts<12)revealTimer.current=window.setTimeout(find,50);return;
      }
      const nodes=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-comment-text]')||[]);
      const availableBlock=nodes.some(n=>n.dataset.commentTarget===targetKey&&n.dataset.commentBlock===blockId)?blockId:sceneCommentAnchorSegments(anchor).find(s=>nodes.some(n=>n.dataset.commentTarget===targetKey&&n.dataset.commentBlock===s.blockId))?.blockId;
      const matches=nodes.filter(n=>n.dataset.commentTarget===commentTargetKey(target)&&n.dataset.commentBlock===availableBlock);
      const node=matches.find(n=>n.getClientRects().length>0)||matches[0];
      if(!node){if(++attempts<12)revealTimer.current=window.setTimeout(find,50);else setNotice('原圈选暂未显示，请重新打开对应文字。');return;}
      let parent:HTMLElement|null=node.parentElement;while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}
      const mark=node.querySelector<HTMLElement>(`[data-script-comment-ids~="${CSS.escape(annotationId)}"]`),source=mark||node;
      source.scrollIntoView({block:'center',behavior:'auto'});
      // Keep the original passage visible above the compact mobile drawer.
      const sourceRect=source.getBoundingClientRect(),panelRect=drawer.current?.getBoundingClientRect();
      const top=90,bottom=innerWidth<=700&&panelRect?panelRect.top-16:innerHeight-90;
      window.scrollBy({top:sourceRect.top-(top+Math.max(0,(bottom-top-sourceRect.height)/2)),behavior:'instant'});
      if(editing){drawer.current?.scrollTo({top:0,behavior:'instant'});editor.current?.focus({preventScroll:true});}
      else source.focus({preventScroll:true});
    };revealTimer.current=window.setTimeout(find,0);
  },[targets,onReveal]);
  const locate=useCallback((thread:StoryCommentThread)=>{
    setOpen(true);setActiveId(thread.commentId);
    if(!thread.anchorMatchesCurrentText){setNotice('原圈选无法在当前文字中精确定位。');return;}
    revealAnchor(commentTargetKey(thread.target),thread.anchor,thread.commentId);
  },[revealAnchor]);
  function activate(thread:StoryCommentThread) {
    window.clearTimeout(activationTimer.current);
    // Wait for a multi-click text selection before opening an existing annotation.
    activationTimer.current=window.setTimeout(()=>{if(window.getSelection()?.isCollapsed)locate(thread);},300);
  }

  async function mutate(action:string,thread?:StoryCommentThread) {
    const currentDraft=draft, identity=scope;
    const target=targets.find(t=>commentTargetKey(t)===(thread?commentTargetKey(thread.target):currentDraft?.targetKey));
    if(!target||busy||hostedReadOnly||!loaded)return;
    const existing=thread||(currentDraft?.commentId?threads.find(t=>t.commentId===currentDraft.commentId):undefined);
    // A response started before this write must not restore the old comment head.
    invalidateReads();
    setBusy(true);setLoaded(false);setNotice('');
    try {
      const op=await fetch('/api/v8/operations/snapshot?summary=1',{cache:'no-store'});if(!op.ok)throw new Error('无法读取当前保存状态');const state=await op.json() as {mutationEtag:string;etag:string};
      const response=await fetch('/api/v8/script-comments',{method:'POST',headers:{'Content-Type':'application/json','If-Match':state.mutationEtag||state.etag,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({schemaVersion:'1.2',snapshotId:plan.snapshotId,revisionId:plan.revisionId,target:commentTargetBinding(target),commentId:existing?.commentId||crypto.randomUUID(),commentAction:action,
        ...(existing?{commentRevisionId:currentDraft?.commentId===existing.commentId?currentDraft.commentRevisionId:existing.commentRevisionId,latestEventId:currentDraft?.commentId===existing.commentId?currentDraft.latestEventId:existing.latestEventId}:{}),
        ...(['CREATE','EDIT'].includes(action)?{anchor:currentDraft?.anchor,commentText:currentDraft?.text}:{})})});
      const value=await response.json() as {error?:string};if(!response.ok)throw new Error(value.error||'评论未保存');
      if(currentIdentity.current!==identity)return;
      if(['CREATE','EDIT'].includes(action)&&currentDraft){storeDraft(draftKey(currentDraft),null);changeDraft(null);}
      setNotice(action==='RESOLVE_USER'?'评论已关闭。':action==='REOPEN'?'评论已重新打开。':'评论已保存。');
      // Keep actions disabled until their next binding is read from the server.
      setLoaded(false);await readComments();
      const channel=new BroadcastChannel(`story-comments:${instance.instanceId}`);channel.postMessage('changed');channel.close();
    }catch(e){if(currentIdentity.current===identity){setNotice(e instanceof Error?e.message:'保存失败');setRefresh(n=>n+1);}}finally{if(currentIdentity.current===identity)setBusy(false);}
  }
  async function polish() {
    if(!draft?.text.trim()||busy||hostedReadOnly)return;
    const target=targets.find(t=>commentTargetKey(t)===draft.targetKey);if(!target)return;
    const identity=draftIdentity.current;setBusy(true);setSuggestion('');
    try {
      const response=await fetch('/api/v8/operations/snapshot?summary=1',{cache:'no-store'});if(!response.ok)throw new Error('无法读取保存状态');const op=await response.json() as {mutationEtag:string;etag:string};
      const result=await fetch('/api/v8/script-comments/polish',{method:'POST',headers:{'Content-Type':'application/json','If-Match':op.mutationEtag||op.etag,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({schemaVersion:'1.2',snapshotId:plan.snapshotId,revisionId:plan.revisionId,target:commentTargetBinding(target),anchor:draft.anchor,commentDraft:draft.text})});
      const value=await result.json() as {error?:string;polishedComment:string};if(!result.ok)throw new Error(value.error||'润色未完成');
      if(identity===draftIdentity.current)setSuggestion(value.polishedComment);
    }catch(e){if(identity===draftIdentity.current)setNotice(e instanceof Error?e.message:'润色未完成');}finally{setBusy(false);}
  }
  const designFields=sceneId?new Set([...sceneRequirements(plan,sceneId).requirements.map(r=>requirementCommentField(r.id,sceneId)),...(plan.content.narrativeRevision?.causalChains.filter(c=>c.setupSceneIds.includes(sceneId)||c.payoffSceneIds.includes(sceneId)).map(c=>`chain:${c.id}`)||[])]):null;
  const episodeIndex=plan.content.episodes.findIndex(ep=>ep.episodeUid===episodeUid);
  const previousUid=plan.content.episodes[episodeIndex-1]?.episodeUid,nextUid=plan.content.episodes[episodeIndex+1]?.episodeUid;
  const boundaryComment=(t:StoryCommentThread)=>{
    const previous=t.target.episodeUid===previousUid,next=t.target.episodeUid===nextUid;
    if(!previous&&!next)return false;
    if(t.target.kind==='EPISODE_DESIGN')return t.anchor.blockId===(previous?'endingCliffhanger':'openingHook');
    const excerpt=plan.presentation[t.target.episodeUid]?.[previous?'ending':'opening'];
    return excerpt?.sceneId===t.target.subjectId&&sceneCommentAnchorSegments(t.anchor).every(s=>excerpt.blocks.some(b=>b.id===s.blockId));
  };
  const visibleThreads=threads.filter(t=>sceneId?t.target.subjectId===sceneId||t.target.kind==='EPISODE_DESIGN'&&sceneCommentAnchorSegments(t.anchor).some(s=>designFields?.has(s.blockId)):t.target.episodeUid===episodeUid||boundaryComment(t));
  const commentCount=visibleThreads.filter(t=>t.status!=='RESOLVED').length;
  const editingThread=draft?.commentId?threads.find(t=>t.commentId===draft.commentId):null;
  const editable=loaded&&!!draft&&(!draft.commentId||editingThread?.status!=='RESOLVED'&&editingThread?.anchorMatchesCurrentText);
  const value={targets,threads,draft,activeId,capture,locate,activate};
  return <Comments.Provider value={value}><div className="story-comment-surface" ref={root}>{children}</div>
    {entrySlot&&createPortal(<button type="button" className="story-comment-trigger" ref={trigger} aria-expanded={open} onClick={()=>{
      setOpen(!open);
      if(!open&&draft){setActiveId(draft.commentId||'DRAFT');revealAnchor(draft.targetKey,draft.anchor,draft.commentId||'DRAFT',true);}
    }}>查看评论 · {commentCount} 待处理{closedCount?` · ${closedCount} 已关闭`:''}{draft?' · 草稿':''}</button>,entrySlot)}
    {typeof document!=='undefined'&&createPortal(<>
      {pending&&selectionSpot&&<button type="button" className="story-comment-selection" style={selectionSpot} onMouseDown={event=>event.preventDefault()} onClick={()=>startDraft(pending)}>添加评论</button>}
      {open&&<aside ref={drawer} className="story-comment-drawer" aria-label="文字评论"><header><div><small>正文与分集设计</small><h3>文字评论 <span>{commentCount} 未关闭</span></h3></div><button type="button" aria-label="收起文字评论" onClick={()=>{setOpen(false);trigger.current?.focus();}}>×</button></header>
        {draft&&<section className="story-comment-editor"><header><b>{draft.commentId?'编辑评论':'添加新评论'}</b><button type="button" aria-label={draft.commentId?'取消编辑评论':'取消新评论'} disabled={busy} onClick={cancelDraft}>×</button></header><small>{targets.find(t=>commentTargetKey(t)===draft.targetKey)?.label}</small><q>{draft.anchor.quote}</q><label>修改意见<textarea ref={editor} data-comment-editor={`${draft.targetKey}:${draft.commentId||'DRAFT'}:${JSON.stringify(draft.anchor)}`} value={draft.text} disabled={busy||hostedReadOnly} onChange={e=>changeDraft({...draft,text:e.target.value})}/></label>
          <div><button type="button" disabled={busy||hostedReadOnly||!editable||!draft.text.trim()} onClick={()=>void mutate(draft.commentId?'EDIT':'CREATE')}>{busy?'处理中…':draft.commentId?'保存修改':'提交评论'}</button><button type="button" disabled={busy||hostedReadOnly||!editable||!draft.text.trim()} onClick={()=>void polish()}>AI 润色修改意见</button><button type="button" disabled={busy} onClick={cancelDraft}>取消</button></div>
          {suggestion&&<section className="story-comment-suggestion"><b>AI 建议 · 尚未保存</b><p>{suggestion}</p><button type="button" onClick={()=>changeDraft({...draft,text:suggestion})}>采用到草稿</button></section>}
        </section>}
        {notice&&<p role="status">{notice}</p>}
        <p className="story-comment-help">圈选文字附近可添加评论；正文评论在叙事拆解的集、场视角中共享，正式判断另行提交。</p>
        {hostedReadOnly&&<p>只读镜像，请在本地审阅台添加、编辑或关闭评论。</p>}
        {error&&<p role="alert">{error}<button type="button" onClick={()=>setRefresh(n=>n+1)}>重新读取</button></p>}
        {!loaded&&!error&&<p role="status">正在读取评论…</p>}
        <div className="story-comment-list"><section aria-label="未关闭评论">{visibleThreads.filter(t=>t.status!=='RESOLVED').map(t=>{
          const label=targets.find(x=>commentTargetKey(x)===commentTargetKey(t.target))?.label||t.target.subjectId;
          return <article key={t.commentId} data-comment-id={t.commentId} data-comment-status={t.status} className={activeId===t.commentId?'is-selected':''}>
            <button type="button" className="story-comment-location" onClick={()=>locate(t)}><small>{label} · 待处理</small><q>{t.anchor.quote}</q><p>{t.commentText}</p></button>
            {t.applicabilityState==='STALE'&&<small>{t.anchorMatchesCurrentText?'文字仍可定位，创作上下文需要核对。':'原圈选已无法定位。'}</small>}
            <footer><button type="button" disabled={busy||!loaded||hostedReadOnly||!t.anchorMatchesCurrentText} onClick={()=>startDraft({targetKey:commentTargetKey(t.target),anchor:t.anchor,text:t.commentText,commentId:t.commentId,commentRevisionId:t.commentRevisionId,latestEventId:t.latestEventId})}>编辑</button><button type="button" disabled={busy||!loaded||hostedReadOnly||!!draft?.commentId} onClick={()=>void mutate('RESOLVE_USER',t)}>关闭评论</button></footer>
          </article>;
        })}</section></div>
        {loaded&&!commentCount&&<p>当前文字没有待处理评论。圈选正文或设计说明即可添加；已关闭记录在下方保留。</p>}
        {loaded&&<PaginatedClosedCommentHistory<StoryCommentThread> key={scope} endpoint={url} refreshKey={refresh+':'+closedCount} onThreadRead={rememberClosed} renderActions={t=><footer><button type="button" className="story-comment-location" disabled={!t.anchorMatchesCurrentText} onClick={()=>locate(t)}>定位原圈选</button><button type="button" disabled={busy||!loaded||hostedReadOnly||!t.anchorMatchesCurrentText||!!draft?.commentId} onClick={()=>void mutate('REOPEN',t)}>重新打开</button></footer>}/>}

      </aside>}
      {notice&&!open&&<p className="story-comment-toast" role="status">{notice}</p>}
    </>,document.body)}
  </Comments.Provider>;
}

export function CommentText({kind,subjectId,blockId,text}: {kind:StoryCommentTarget['kind'];subjectId:string;blockId:string;text:string}) {
  const context=useContext(Comments);
  const key=commentTargetKey({kind,subjectId});
  const target=context?.targets.find(t=>commentTargetKey(t)===key);
  const block=target?.blocks.find(b=>b.id===blockId);
  if(!context||!block||block.text!==text)return <>{text}</>;
  const threads=context.threads.filter(t=>commentTargetKey(t.target)===key&&t.anchorMatchesCurrentText);
  const annotations=threads.flatMap(t=>sceneCommentAnchorSegments(t.anchor).map(s=>({...s,id:t.commentId,state:t.status})));
  if(context.draft?.targetKey===key)annotations.push(...sceneCommentAnchorSegments(context.draft.anchor).map(s=>({...s,id:context.draft!.commentId||'DRAFT',state:'OPEN' as const})));
  return <span data-comment-text data-comment-target={key} data-comment-block={blockId} tabIndex={-1} onMouseUp={context.capture} onKeyUp={context.capture}>{annotatedText(text,blockId,annotations,context.activeId,id=>{if(!window.getSelection()?.isCollapsed)return;const thread=threads.find(t=>t.commentId===id);if(thread)context.activate(thread);})}</span>;
}
export function DesignText({episodeUid,fieldId,text}: {episodeUid:string;fieldId:string;text:string}) {
  return <CommentText kind="EPISODE_DESIGN" subjectId={episodeUid} blockId={fieldId} text={text}/>;
}
export function CommentScriptBlocks({sceneId,blocks,highlighted=[],anchorPrefix}: {sceneId:string;anchorPrefix?:string;blocks:Array<{id:string;text:string;type:string;speaker?:string;performanceNote?:string|null}>;highlighted?:string[]}) {
  const uniquePrefix=useId();
  return <>{blocks.map(b=><p key={b.id} id={`${anchorPrefix??uniquePrefix}${b.id}`} data-block-id={b.id} tabIndex={-1} className={`${b.type} ${highlighted.includes(b.id)?'is-evidence-highlight':''}`}>{b.speaker&&<b>【{b.speaker}】</b>}{b.performanceNote&&`（${b.performanceNote}）`}<CommentText kind="SCENE_SCRIPT" subjectId={sceneId} blockId={b.id} text={b.text}/></p>)}</>;
}
