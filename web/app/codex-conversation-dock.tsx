'use client';

import {createPortal} from 'react-dom';
import {useReviewOverlayHost} from './review-overlay-host';
import { instanceLocalStorage, instanceSessionStorage } from './client-storage';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useInstanceProfile } from './instance-context';
import { useRuntimeMode } from './runtime-mode';
import { useAssistant } from './assistant/context-provider';
import { canonicalJson, textHash, type AssistantContextRef, type ClientDraft, type WorkContextResult, type WorkFocus } from './assistant/types';
import styles from './codex-conversation-dock.module.css';
import { StoryCommentEntry } from './story-comments';
import {runtimePath} from './runtime-path';
import {managementMutation} from './system-management-client';

function OriginalContextImage({ url, title }: { url: string; title: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- Display the exact registered original without a derivative service.
  return <img className={styles.contextImage} src={runtimePath(url)} alt={`${title}，本轮所选原图`} />;
}

type Resource = { id: string; title: string; kind: string; href: string; versionId?: string; role: string; excerpt: string; media?: { kind: string; previewUrl?: string } };
type ContextView = AssistantContextRef & { focus: WorkFocus; focusKey: string; dependencyHash: string; resources: Resource[]; missing: string[]; draftTargets: ClientDraft[] };
type ExecutionReceipt={operationId:string;action:string;status:string;mutated:boolean;resultRevisionId?:string};
type ChangePreview={suggestionId:string;objectId:string;title:string;expectedVersion:number;revisionId:string;appliedRevisionId?:string|null;fields:{label:string;before:string;after:string}[]};
type Message = { changePreview?:ChangePreview;mode?:'DISCUSS'|'EXECUTE';executionReceipts?:ExecutionReceipt[];id: string; role: string; text: string; status: string; context?: ContextView; contextUnavailable?: boolean; workContext?: WorkContextResult; unknowns?: string[]; evidence?: { path: string; note: string }[] };
type Conversation = { id: string; assistantProtocol?: string; headHash: string; state: string; canSend: boolean; archived: boolean; activeTurnId: string | null; activeTurnStatus: string | null; queuePosition: number | null; blockedReason: string | null; messages: Message[]; progress?: { message: string; partialText?: string } | null };
type Summary = { id: string; assistantProtocol?: string; preview: string; state: string; messageCount: number; archived: boolean; activeTurnStatus?: string };
type Bridge = { executionProtocol?:string|null;online: boolean; status: string; model?: string; schedulerProtocol?: string; workContextProtocol?: string; workContextPreflightVerified?: boolean };
type Envelope = { conversation?: Conversation; conversations?: Summary[]; bridge?: Bridge; pagination?: { nextCursor: string | null }; error?: string | { message?: string }; message?: string; context?: ContextView };
type Composer = { text: string; focus: WorkFocus | null; draft: Omit<ClientDraft, 'baseHash'> | null; references: string[]; includeDraft: boolean };
const API = '/api/v1/assistant';
const EMPTY: Composer = { text: '', focus: null, draft: null, references: [], includeDraft: true };

async function jsonRequest(url: string, body?: unknown, key?: string, signal?: AbortSignal): Promise<Envelope> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json() as Envelope;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message || `请求未完成（${response.status}）`);
  return payload;
}
async function streamConversation(url:string,signal:AbortSignal,onValue:(value:Envelope)=>void){
  const response=await fetch(url,{signal,headers:{Accept:'text/event-stream'}});
  if(!response.ok||!response.body)throw new Error('助手连接暂不可用，请稍后重试。');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try{for(;;){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});if(buffer.length>2*1024**2)throw new Error('助手流超出大小限制');
    let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');if(data){const value=JSON.parse(data) as Envelope;if(frame.startsWith('event: error'))throw new Error(typeof value.error==='string'?value.error:'助手连接已结束');onValue(value);}}
  }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function sameSubject(a: WorkFocus | null, b: WorkFocus | null) {
  return Boolean(a && b && a.projectId === b.projectId && a.subjectType === b.subjectType && a.subjectId === b.subjectId && a.versionId === b.versionId);
}
function navigate(href: string) {
  if (!href.startsWith('/') || href.startsWith('//')) return;
  window.history.pushState({}, '', runtimePath(href));
  window.dispatchEvent(new PopStateEvent('popstate'));
}
function validUnicode(value: string) {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function readableStatus(value: string) {
  return ({ READY: '可继续', QUEUED: '排队中', RUNNING: '运行中', BLOCKED: '已结束', SUCCEEDED: '已完成', CANCELLED: '已停止', RESULT_UNKNOWN: '结果待核查', FAILED: '未完成', STALE_CONTEXT: '依据已更新' } as Record<string, string>)[value] || '待处理';
}
function suggestionQuestions(focus: WorkFocus | null) {
  if (focus?.subjectType === 'EPISODE') return ['这一项有什么问题？', '核对前后集衔接', '帮我完善这条意见'];
  if (focus?.subjectType === 'SCENE') return ['这段人物行动合理吗？', '对照原文检查这一场', '帮我完善这条意见'];
  if (focus?.subjectType === 'MATERIAL') return ['按标准检查这个版本', '对照上游素材检查连续性', '解释当前制作资料的缺项'];
  if (focus?.subjectType === 'WORK_ITEM') return ['这项工作为什么还不能推进？', '核对输入和验收标准', '梳理修改影响'];
  return ['我现在可以推进哪些工作？', '解释当前内容的依据', '有哪些需要优先核对的问题？'];
}

export function CodexConversationDock() {
  const overlayHost=useReviewOverlayHost();
  const instance = useInstanceProfile();
  const { hostedReadOnly: remoteReadOnly } = useRuntimeMode();
  const disabled = instance.capabilities.assistantEnabled === false;
  const hostedReadOnly = remoteReadOnly || disabled;
  const assistant = useAssistant();
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastOpenRequest = useRef(0);
  const epoch = useRef(0);
  const previewEpoch = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [restoredKey, setRestoredKey] = useState('');
  const sending = useRef(false);
  const pendingRequests = useRef(new Map<string, string>());
  const [width, setWidth] = useState(420);
  const [composer, setComposer] = useState<Composer>(EMPTY);
  const [mode,setMode]=useState<'DISCUSS'|'EXECUTE'>('DISCUSS');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversationId, storeConversationId] = useState('');
  const setConversationId = useCallback((value:string) => {storeConversationId(value);setMode('DISCUSS');},[]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [archived, setArchived] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [previewState, setPreview] = useState<ContextView | null>(null);
  const [previewSignature, setPreviewSignature] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [contextRefresh,setContextRefresh]=useState(0);
  const seenActions=useRef(new Set<string>());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [adopted, setAdopted] = useState<Record<string, { targetId: string; before: string; after: string }>>({});
  const [adopting, setAdopting] = useState('');
  const projectId = assistant.focus?.projectId || 'unbound';
  const storageKey = `creative-assistant:local:${projectId}`;
  const focus = composer.focus || assistant.focus;
  const differentPage = Boolean(composer.focus && !sameSubject(composer.focus, assistant.focus));
  const effectiveDraft = composer.focus ? composer.draft : assistant.activeDraft;
  const focusSignature = canonicalJson(focus);
  const draftSignature = canonicalJson(composer.includeDraft && effectiveDraft ? { id: effectiveDraft.id, label: effectiveDraft.label, fieldId: effectiveDraft.fieldId, subjectId: effectiveDraft.subjectId, versionId: effectiveDraft.versionId, value: effectiveDraft.value } : null);
  const refSignature = canonicalJson(composer.references);
  const contextSignature = `${focusSignature}:${draftSignature}:${refSignature}`;
  const preview = previewSignature === contextSignature ? previewState : null;

  useEffect(() => {
    if (projectId === 'unbound' || hostedReadOnly) return;
    const timer = setTimeout(() => {
      epoch.current += 1; setConversation(null); setPreview(null); setError('');
      try {
        const saved = JSON.parse(instanceLocalStorage.getItem(storageKey) || '{}');
        setConversationId(typeof saved.conversationId === 'string' ? saved.conversationId : '');
        setComposer(saved.composer?.focus?.projectId === projectId ? saved.composer : EMPTY);
      } catch { setComposer(EMPTY); setConversationId(''); }
      setRestoredKey(storageKey);
    }, 0);
    return () => clearTimeout(timer);
  }, [storageKey, projectId, hostedReadOnly]);

  useEffect(() => {
    if (projectId === 'unbound' || hostedReadOnly) return;
    if (restoredKey !== storageKey) return;
    try { instanceLocalStorage.setItem(storageKey, JSON.stringify({ conversationId, composer })); }
    catch {
      const timer = setTimeout(() => setNotice('本机暂不能保存对话输入，离开前请复制未发送内容。'), 0);
      return () => clearTimeout(timer);
    }
  }, [storageKey, restoredKey, projectId, conversationId, composer, hostedReadOnly]);

  useEffect(() => {
    document.documentElement.dataset.assistantOpen = open ? 'true' : 'false';
    if(open)window.dispatchEvent(new CustomEvent('review-open-panel',{detail:'codex'}));
    document.documentElement.style.setProperty('--assistant-width', `${width}px`);
    return () => { delete document.documentElement.dataset.assistantOpen; document.documentElement.style.removeProperty('--assistant-width'); };
  }, [open, width]);
  useEffect(()=>{
    const switchPanel=(event:Event)=>{if((event as CustomEvent).detail==='comments')setOpen(false);};
    window.addEventListener('review-open-panel',switchPanel);
    return()=>window.removeEventListener('review-open-panel',switchPanel);
  },[]);

  const freeze = useCallback((text: string) => {
    setComposer((previous) => {
      if (previous.focus) return { ...previous, text };
      const target = assistant.activeDraft;
      return { ...previous, text, focus: assistant.focus ? structuredClone(assistant.focus) : null,
        draft: target ? { id: target.id, label: target.label, fieldId: target.fieldId, subjectId: target.subjectId, versionId: target.versionId, value: target.value } : null };
    });
  }, [assistant.activeDraft, assistant.focus]);

  useEffect(() => {
    if (!assistant.openRequest || assistant.openRequest === lastOpenRequest.current) return;
    lastOpenRequest.current = assistant.openRequest;
    setOpen(true);
    const target = assistant.activeDraft;
    setComposer((previous) => previous.text.trim() && previous.focus ? previous : ({ ...previous, focus: assistant.focus ? structuredClone(assistant.focus) : null,
      draft: target ? { id: target.id, label: target.label, fieldId: target.fieldId, subjectId: target.subjectId, versionId: target.versionId, value: target.value } : null,
      includeDraft: true }));
    setNotice('已打开助手。若还有未发送的问题，将保留其原讨论对象；可点击改用当前页面。');
    input.current?.focus();
  }, [assistant.openRequest, assistant.activeDraft, assistant.focus]);

  useEffect(() => {
    if (!open || hostedReadOnly || focusSignature === 'null') return;
    const controller = new AbortController();
    const current = ++previewEpoch.current;
    const timer = setTimeout(() => { void (async () => {
      setPreviewError('');
      const draft = JSON.parse(draftSignature) as Omit<ClientDraft, 'baseHash'> | null;
      const targets = draft ? [{ ...draft, baseHash: await textHash(draft.value) }] : [];
      const selected = JSON.parse(focusSignature) as WorkFocus;
      const references = [...new Set([...(selected.references || []), ...JSON.parse(refSignature) as string[]])];
      const response = await jsonRequest(`${API}/context`, { focus: { ...selected, references }, draftTargets: targets }, undefined, controller.signal);
      if (current === previewEpoch.current) { setPreview(response.context || null); setPreviewSignature(contextSignature); }
    })().catch((reason) => { if (!controller.signal.aborted && current === previewEpoch.current) setPreviewError(reason.message); }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, hostedReadOnly, focusSignature, draftSignature, refSignature, contextSignature,contextRefresh]);

  const loadList = useCallback(async (cursor?: string) => {
    if (hostedReadOnly) return;
    const payload = await jsonRequest(`${API}/conversations?archived=${archived ? 'only' : 'exclude'}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    setBridge(payload.bridge || null); setNextCursor(payload.pagination?.nextCursor || null);
    setSummaries((old) => cursor ? [...old, ...(payload.conversations || []).filter((item) => !old.some((previous) => previous.id === item.id))] : payload.conversations || []);
  }, [archived, hostedReadOnly]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void loadList().catch((reason) => setError(reason.message)), 0);
    return () => clearTimeout(timer);
  }, [open, loadList]);
  useEffect(() => {
    if (!open || hostedReadOnly || !conversationId) return;
    const current = ++epoch.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await streamConversation(`${API}/events?conversationId=${encodeURIComponent(conversationId)}`,controller.signal,payload=>{
          if (current !== epoch.current) return;
          setConversation(payload.conversation || null); setBridge(payload.bridge || null); setLoading(false);
        });
      } catch (reason) { if (current === epoch.current && !controller.signal.aborted) { setError((reason as Error).message); setLoading(false); } }
      if (!controller.signal.aborted && current === epoch.current) timer = setTimeout(poll, 1200);
    };
    timer = setTimeout(() => { setLoading(true); void poll(); }, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, hostedReadOnly, conversationId]);

  useEffect(()=>{
    const receipts=conversation?.messages.flatMap(message=>message.executionReceipts||[])||[];
    const unseen=receipts.filter(receipt=>!seenActions.current.has(receipt.operationId));
    if(!unseen.length)return;
    unseen.forEach(receipt=>seenActions.current.add(receipt.operationId));
    setContextRefresh(value=>value+1);
    for(const event of ['review:operations-updated','review:relations-updated','review:preparation-updated'])window.dispatchEvent(new Event(event));
  },[conversation?.messages]);

  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'nearest' }); }, [conversation?.messages.length, conversation?.progress?.partialText, open]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  async function send() {
    if (!preview || !composer.text.trim() || !validUnicode(composer.text) || sending.current || busy || hostedReadOnly || conversation?.activeTurnId || (conversation && !conversation.assistantProtocol)) return;
    sending.current = true;
    const operationEpoch = epoch.current;
    setBusy(true); setError(''); setNotice('');
    const sentComposerSignature = canonicalJson(composer);
    const clearSentComposer = () => {setComposer((current) => canonicalJson(current) === sentComposerSignature ? EMPTY : current);setMode('DISCUSS');};
    const frozen = { ...composer, focus: preview.focus };
    const body = { mode,action: conversation ? 'SEND' : 'START', ...(conversation ? { conversationId: conversation.id, expectedTurnHeadHash: conversation.headHash } : {}), userMessage: frozen.text.trim(), focus: preview.focus, draftTargets: preview.draftTargets, expectedDependencyHash: preview.dependencyHash };
    let key = '', requestSignature = '';
    const persistRequests = () => {
      try { instanceSessionStorage.setItem(`${storageKey}:requests`, JSON.stringify([...pendingRequests.current])); }
      catch { setNotice('请求标识暂只保存在本页。若结果不明，请先核查对话记录再刷新。'); }
    };
    try {
      requestSignature = `${projectId}:${await textHash(canonicalJson(body))}`;
      try {
        const stored = JSON.parse(instanceSessionStorage.getItem(`${storageKey}:requests`) || '[]');
        if (Array.isArray(stored)) for (const entry of stored) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].startsWith('assistant-')) pendingRequests.current.set(entry[0], entry[1]);
        }
      } catch { /* Retain the in-memory ledger when session storage is unavailable. */ }
      key = pendingRequests.current.get(requestSignature) || '';
      if (!key && pendingRequests.current.size >= 64) throw new Error('有较多请求结果尚未核实，请先查看对话记录');
      if (!key) key = `assistant-${crypto.randomUUID()}`;
      pendingRequests.current.set(requestSignature, key); persistRequests();
      const payload = await jsonRequest(`${API}/conversations`, body, key);
      pendingRequests.current.delete(requestSignature); persistRequests();
      if (operationEpoch !== epoch.current) { void loadList(); return; }
      if (payload.conversation) { setConversation(payload.conversation); setConversationId(payload.conversation.id); }
      clearSentComposer(); setPreview(null); void loadList();
    } catch (reason) {
      if (operationEpoch !== epoch.current) { void loadList(); return; }
      setError(`${(reason as Error).message}。不会自动重发本轮。`);
      // START identity is deterministic, allowing a lost response to be checked without another model request.
      if (!key) return;
      const expectedId = conversation?.id || `codx_${(await textHash(`conversation\0${key}`)).slice(0, 32)}`;
      const expectedTurn = `turn_${(await textHash(`turn\0${key}`)).slice(0, 32)}`;
      try {
        const recovered = await jsonRequest(`${API}/conversations?conversationId=${expectedId}`);
        if (recovered.conversation?.messages.some((message) => message.id === expectedTurn && message.role === 'user') && operationEpoch === epoch.current) {
          pendingRequests.current.delete(requestSignature); persistRequests();
          setConversationId(expectedId); setConversation(recovered.conversation); clearSentComposer(); setNotice('已找回本轮记录，正在读取原请求状态。'); setError('');
        }
      } catch { /* Keep the exact composer and request key for explicit retry. */ }
    } finally { sending.current = false; setBusy(false); }
  }

  async function conversationAction(action: string, target = conversation) {
    if (!target) return;
    const operationEpoch = epoch.current;
    setError('');
    try {
      await jsonRequest(`${API}/conversations`, { action, conversationId: target.id, expectedTurnHeadHash:target.headHash, ...(action === 'CANCEL' ? { turnId: target.activeTurnId } : {}) }, `assistant-${crypto.randomUUID()}`);
      if (operationEpoch !== epoch.current) { await loadList(); return; }
      setNotice(action === 'CANCEL' ? '已请求停止，等待工作器确认。' : action === 'ARCHIVE' ? '对话已归档，记录仍保留。' : '对话已恢复。');
      if (action === 'ARCHIVE') { setConversationId(''); setConversation(null); }
      await loadList();
    } catch (reason) { setError((reason as Error).message); }
  }

  async function adopt(message: Message, targetId: string, text: string) {
    if (!message.context || !message.workContext || message.workContext.stale) return;
    const original = message.context.draftTargets.find((item) => item.id === targetId);
    const current = assistant.findDraft(targetId);
    if (!original || !current || !sameSubject(message.context.focus, assistant.focus)) { setNotice('请先回到这条建议对应的对象与版本，再采用草稿。'); return; }
    setAdopting(`${message.id}:${targetId}`); setError('');
    try {
      await jsonRequest(`${API}/suggestions/check`, { conversationId: conversation?.id, messageId: message.id, assistantContext: { packetId: message.context.packetId, packetHash: message.context.packetHash }, targetId, expectedDraftHash: original.baseHash });
      if (!assistant.findDraft(targetId)?.apply(text, original.value)) throw new Error('草稿已被编辑或当前不可采用，已保留建议供比较和复制');
      setAdopted((old) => ({ ...old, [`${message.id}:${targetId}`]: { targetId, before: original.value, after: text } }));
      setNotice('已填入页面草稿，尚未正式提交。');
    } catch (reason) { setError((reason as Error).message); }
    finally { setAdopting(''); }
  }
  async function applyChange(message:Message){
    const change=message.changePreview;
    if(!change||message.workContext?.stale||change.appliedRevisionId)return;
    setAdopting(message.id+':change');setError('');
    try{
      await managementMutation('/api/v1/suggestions/'+encodeURIComponent(change.suggestionId)+'/apply',{objectId:change.objectId,expectedVersion:change.expectedVersion});
      setNotice('已保存为草稿，正式采用仍需在原页面确认。');
      if(conversationId){const value=await jsonRequest(API+'/conversations?conversationId='+encodeURIComponent(conversationId));if(value.conversation)setConversation(value.conversation);}
    }catch(reason){setError((reason as Error).message);}finally{setAdopting('');}
  }
  function undo(key: string) {
    const record = adopted[key];
    if (!record || !assistant.findDraft(record.targetId)?.apply(record.before, record.after)) { setNotice('草稿已有后续修改，未覆盖你的内容。'); return; }
    setAdopted((old) => { const next = { ...old }; delete next[key]; return next; }); setNotice('已撤销本次采用。');
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault();event.stopPropagation(); setOpen(false); }
    if (event.key === 'Tab' && window.innerWidth < 1280) {
      const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]');
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  const bridgeReady = Boolean(bridge?.online && bridge.workContextProtocol === 'REVIEW_WORK_CONTEXT_V1' && bridge.workContextPreflightVerified);
  const canSend = Boolean((mode==='DISCUSS'||bridge?.executionProtocol==='REVIEW_DRAFT_PREVIEW_V1')&&preview && composer.text.trim() && validUnicode(composer.text) && !busy && !loading && restoredKey === storageKey && bridgeReady && (!conversationId || conversation) && (!conversation || (conversation.assistantProtocol && conversation.canSend)));

  if(!overlayHost)return null;
  return createPortal(<>
    <div className="review-floating-tools"><StoryCommentEntry/>{!disabled&&!open&&<button className={styles.floatingButton} aria-label="项目 Codex" onClick={() => setOpen(true)}><span>✦</span> 项目 Codex</button>}</div>
    {!disabled&&open && <>
      <button className={styles.backdrop} aria-label="关闭项目 Codex" onClick={() => setOpen(false)} />
      <aside ref={panel} className={styles.drawer} aria-label="项目 Codex 工作助手" onKeyDown={keyboard} style={{ width: `min(${width}px, 100vw)` }}>
        <header className={styles.header}><div><small>创作助手 · Codex</small><h2>一起看当前工作</h2></div><button className={styles.commentSwitch} onClick={()=>{const entry=document.querySelector<HTMLButtonElement>('#story-comment-entry button, .story-comment-entry-fallback');entry?.click();}}>查看评论</button><button aria-label="收起项目 Codex" onClick={() => setOpen(false)}>×</button></header>
        {hostedReadOnly ? <div className={styles.hostedNotice}><p>远端镜像只读。请在本地审阅台使用工作助手。</p><a href={runtimePath("http://localhost:3000")}>打开本地审阅台</a></div> : <>
          <nav className={styles.toolbar}><button onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>对话记录</button><button onClick={() => { epoch.current += 1; setConversationId(''); setConversation(null); setComposer(EMPTY); setError(''); }}>新建对话</button><span className={bridgeReady ? styles.online : styles.offline}>{bridgeReady ? '已连接' : bridge?.online ? '需要更新连接' : '未连接'}</span></nav>
          {historyOpen && <section className={styles.history} aria-label="Codex会话列表"><div className={styles.toolbar}><button aria-pressed={!archived} onClick={() => setArchived(false)}>当前对话</button><button aria-pressed={archived} onClick={() => setArchived(true)}>已归档</button></div>{summaries.map((item) => <button key={item.id} aria-pressed={conversationId === item.id} onClick={() => { epoch.current += 1; setConversation(null); setConversationId(item.id); setHistoryOpen(false); setError(''); }}><b>{item.preview || '未命名对话'}</b><small>{item.assistantProtocol ? readableStatus(item.state) : '旧版只读记录'} · {item.messageCount}条消息</small></button>)}{!summaries.length && <p>暂无对话。</p>}{nextCursor && <button onClick={() => void loadList(nextCursor).catch((reason) => setError(reason.message))}>加载更多</button>}</section>}
          <section className={styles.focusCard} aria-label="本轮工作上下文"><div><small>{composer.focus ? '本轮已固定' : '跟随当前页面'}</small><b>{preview?.focus.title || focus?.title || '请先打开一个工作对象'}</b>{focus?.versionId && <small>版本：{focus.versionId}</small>}</div>{composer.focus && <button onClick={() => setComposer((old) => ({ ...EMPTY, text: old.text }))}>改用当前页面</button>}</section>
          {differentPage && <p className={styles.notice}>页面已切换，本轮仍讨论上方对象。</p>}
          <details className={styles.contextDetails}><summary>本轮依据{preview ? ` · ${preview.resources.length}项` : previewError ? '暂不可用' : '正在读取'}</summary>{preview?.resources.map((resource) => <div key={resource.id}><button onClick={() => navigate(resource.href)}>{resource.title}</button>{resource.media?.previewUrl && <a href={runtimePath(resource.media.previewUrl)} target="_blank" rel="noreferrer"><OriginalContextImage url={resource.media.previewUrl} title={resource.title} /></a>}<small>{resource.role === 'HISTORICAL' ? '历史版本' : '本轮资料'}{resource.media ? resource.media.kind === 'image' ? ' · 原图将在发送时校验' : ' · 仅文字和技术资料' : ''}</small></div>)}{effectiveDraft && <label><input type="checkbox" checked={composer.includeDraft} onChange={(event) => setComposer((old) => ({ ...old, includeDraft: event.target.checked }))} />带入未提交意见：{effectiveDraft.label}</label>}{focus?.selection && <button onClick={() => { const next = { ...focus }; delete next.selection; setComposer((old) => ({ ...old, focus: next })); }}>移除圈选范围</button>}{preview?.missing.map((item) => <p key={item}>缺项：{item}</p>)}{composer.references.map((ref) => <button key={ref} onClick={() => setComposer((old) => ({ ...old, references: old.references.filter((item) => item !== ref) }))}>移除比较资料：{ref}</button>)}</details>
          {previewError && <p className={styles.error} role="alert">{previewError}</p>}
          <section className={styles.conversation} aria-label="Codex 对话记录" aria-busy={loading}>
            {!conversation?.messages.length && <div className={styles.empty}><b>从正在看的内容开始</b><p>直接提问，或圈选正文、聚焦一条意见后再讨论。</p>{suggestionQuestions(focus).map((question) => <button key={question} onClick={() => { freeze(question); input.current?.focus(); }}>{question}</button>)}</div>}
            {conversation?.messages.map((message) => <article className={`${styles.message} ${message.role === 'user' ? styles.userMessage : ''}`} key={message.id} data-message-status={message.status}><header><b>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Codex' : '系统'}</b><small>{message.mode==='EXECUTE'?'执行 · ':message.mode==='DISCUSS'?'讨论 · ':''}{readableStatus(message.status)}</small></header>{message.context && <div className={styles.messageScope}><span>{message.context.focus.title}</span><button onClick={() => navigate(message.context!.resources[0]?.href || '')}>回到对象</button></div>}<div className={styles.answer}>{message.text}</div>{message.executionReceipts?.length?<details className={styles.executionReceipts}><summary>已核验主机操作 · {message.executionReceipts.length} 项</summary>{message.executionReceipts.map(receipt=><div key={receipt.operationId}><b>{({save_settings_draft:'保存设定草稿',publish_settings:'确认设定发布',save_preparation_scene:'保存本场准备稿',apply_preparation_revalidation:'重核准备稿与用途关联'} as Record<string,string>)[receipt.action]||receipt.action}</b><code>{receipt.operationId}</code>{receipt.resultRevisionId&&<small>结果修订：{receipt.resultRevisionId}</small>}</div>)}</details>:null}{message.changePreview&&<details className={styles.suggestion}><summary>修改预览 · {message.changePreview.title}</summary>{message.changePreview.fields.map((field,i)=><div key={i}><b>{field.label}</b><label>当前内容<pre>{field.before}</pre></label><label>建议内容<pre>{field.after}</pre></label></div>)}<button disabled={Boolean(adopting)||Boolean(message.workContext?.stale)||Boolean(message.changePreview.appliedRevisionId)} onClick={()=>void applyChange(message)}>{message.changePreview.appliedRevisionId?'已保存草稿':adopting===message.id+':change'?'正在核对…':'确认保存为草稿'}</button></details>}{message.contextUnavailable && <p className={styles.error}>这轮证据暂不可读取，建议不能采用。</p>}{message.workContext?.stale && <p className={styles.notice}>依据已更新；这条回答仅针对当时版本。</p>}{message.workContext?.observedImageIds.length ? <small className={styles.observed}>已提供原图：{message.workContext.observedImageIds.map((ref) => message.context?.resources.find((resource) => resource.id === ref)?.title || '所选版本').join('、')}</small> : null}{message.evidence?.length ? <details><summary>查看依据</summary>{message.evidence.map((evidence, index) => { const resource = message.context?.resources.find((item) => `resource:${item.id}` === evidence.path); return <div key={index}>{resource ? <button onClick={() => navigate(resource.href)}>{resource.title}</button> : <span>{evidence.path}</span>}<p>{evidence.note}</p>{resource && <button onClick={() => setComposer((old) => ({ ...old, references: [...new Set([...old.references, resource.id])] }))}>加入下一轮比较</button>}</div>; })}</details> : null}{message.unknowns?.length ? <details><summary>尚未确定</summary><ul>{message.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}{message.workContext?.suggestions.map((suggestion, index) => { const target = message.context?.draftTargets.find((item) => item.id === suggestion.targetId); const key = `${message.id}:${suggestion.targetId}`; return <details className={styles.suggestion} key={`${key}:${index}`}><summary>建议草稿 · {target?.label || '目标不可用'}</summary><label>原意见<pre>{target?.value || '（空）'}</pre></label><label>建议意见<pre>{suggestion.text}</pre></label><div className={styles.toolbar}><button disabled={!target || Boolean(message.workContext?.stale) || Boolean(adopting)} onClick={() => void adopt(message, suggestion.targetId, suggestion.text)}>{adopting === key ? '正在核对…' : '采用到草稿'}</button><button onClick={() => void navigator.clipboard.writeText(suggestion.text).then(() => setNotice('已复制建议。')).catch(() => setNotice('复制失败，请手动选择建议文字。'))}>复制建议</button>{adopted[key] && <button onClick={() => undo(key)}>撤销采用</button>}</div></details>; })}</article>)}
            {conversation?.activeTurnId && <div className={styles.progress} role="status"><b>{conversation.progress?.message || (conversation.activeTurnStatus === 'QUEUED' ? `等待处理${conversation.queuePosition ? ` · 第${conversation.queuePosition}位` : ''}` : '正在分析当前工作')}</b>{conversation.progress?.partialText && <p>{conversation.progress.partialText}</p>}<button onClick={() => void conversationAction('CANCEL')}>停止本轮</button></div>}
            {conversation && !conversation.assistantProtocol && <div className={styles.notice}>这是旧版只读记录。<button onClick={() => { setConversation(null); setConversationId(''); setComposer(EMPTY); setNotice('已开启新版对话；旧记录完整保留。'); }}>继续讨论当前工作</button></div>}
            {conversation?.blockedReason && conversation.assistantProtocol && <p className={styles.notice}>{conversation.blockedReason === 'ARCHIVED' ? '对话已归档。' : '本轮已结束，不会自动重试；可新建对话继续。'}</p>}
            <div ref={end} />
          </section>
          {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
          <section className={styles.composer}><div className={styles.modeSelector} role="group" aria-label="本轮 Codex 模式"><button type="button" aria-pressed={mode==='DISCUSS'} disabled={busy||Boolean(conversation?.activeTurnId)} onClick={()=>{setMode('DISCUSS');}}>讨论</button><button type="button" aria-pressed={mode==='EXECUTE'} disabled={busy||Boolean(conversation?.activeTurnId)||bridge?.executionProtocol!=='REVIEW_DRAFT_PREVIEW_V1'} onClick={()=>setMode('EXECUTE')}>执行</button></div>{mode==='EXECUTE'?<div className={styles.executionScope}><small>先预览当前对象的修改，确认后保存为草稿；正式采用仍在原页面提交。</small></div>:<small>只讨论和提供建议，不更改项目数据。</small>}<label htmlFor={`${id}-input`}>{mode==='EXECUTE'?'本轮需要完成哪些受控修改？':'想结合当前工作讨论什么？'}</label><textarea id={`${id}-input`} ref={input} value={composer.text} maxLength={12000} rows={3} placeholder="例如：这处因果是否成立？请结合前后场给出建议。" onChange={(event) => { if (!event.target.value) setComposer((old) => ({ ...old, text: '', focus: null, draft: null })); else freeze(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) void send(); } }} /><div className={styles.toolbar}><small>Enter发送 · Shift+Enter换行</small><button disabled={!canSend} onClick={() => void send()}>{busy ? '发送中…' : '发送'}</button></div><small>{mode==='EXECUTE'?'修改前会核对对象与来源版本；建议保留 10 分钟。':'建议采用后仍需在原页面提交。'}</small></section>
          <footer className={styles.footer}><details><summary>连接与显示</summary><p>{bridge?.online ? `本机Codex已连接${bridge.model ? ` · ${bridge.model}` : ''}` : '请在“系统管理 → 数据与运行”核对后台工作器与本机助手配置。'}</p><label>助手宽度<input type="range" min="360" max="620" step="20" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label></details>{conversation && <button disabled={Boolean(conversation.activeTurnId)} onClick={() => void conversationAction(conversation.archived ? 'RESTORE' : 'ARCHIVE')}>{conversation.archived ? '恢复对话' : '归档对话'}</button>}</footer>
        </>}
      </aside>
    </>}
  </>,overlayHost);
}
