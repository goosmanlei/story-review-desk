'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useRuntimeMode } from '../runtime-mode';
import './trial.css';
import {AssetReview,loadTrialSnapshot,loadTrialScopes,type TrialScopeIndex} from '../trial-asset-review';

type Criterion = { id: string; label: string; description: string };
type TrialAsset = {
  id: string; mediaId: string; versionId: string; sha256: string;
  mediaKind: 'IMAGE' | 'AUDIO' | 'VIDEO'; mediaUrl: string; version: number;
  lifecycle: string; title?: string; label?: string; recipeId?: string; metadata: Record<string, unknown>;
  prompt: string | { main?: string; negative?: string; full?: string; model?: string; parameters?: Record<string, unknown>; inputs?: unknown[] };
  qa: Record<string, unknown>; reviewCriteria: Criterion[]; reviewHeadId?: string;
  qualityBlocked?: boolean;
  qualityBlockReason?: string; nonWaivableBlocked?: boolean;
  reviewLock?: { locked: boolean; reason: string };
  qaObservations?: Array<{ observations: { summary?: string; technicalStatus?: string; auditoryStatus?: string; findings?: Array<string | { observation?: string }> }; sourceSHA: string }>;
  latestReview?: { payload: { decision: string; comment?: string; criteria?: Array<{ id: string; result: string; comment?: string }> } };
};
type TrialSnapshot = {
  mode: 'LOCAL_TRIAL'; mutationEtag: string;
  scope: { id: string; title: string; projectTitle: string; countsTowardFormalProject: false };
  checkpoint: Record<string, unknown>;
  recipes: Array<{ id: string; subjectId: string; label: string; model: string; outputPath?: string; fullPrompt?: string; blockedBy?: string[] }>;
  story?: {
    episodes: Array<{ episodeUid: string; displayLabel: string; title: string; goal: string; audienceKnowsAtEnd: string; endingHook: string; sourceSceneId: string }>;
    sourceScenes: Array<{ sceneId: string; exactSourceText: string }>;
    shotProposals: Array<{ id: string; episodeUid: string; displayLabel: string; title: string; visualIntent: string; continuityIntent: string; audienceGain: string; proposedDurationSeconds: number }>;
    dialogue: Array<{ id: string; speaker: string; text: string; shotProposalId: string }>;
  };
  assets: TrialAsset[];
  budgets: Record<string, unknown> | Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
};
const labels: Record<string, string> = {
  REVIEW_PENDING: '待你审阅', RELEASED: '已通过并放行', REVISION_REQUIRED: '需要修改', DO_NOT_USE: '禁止使用',
};
const stages = [
  ['镜头方案与预演', '镜头设计与输入锁定', '粗分镜与对白并行', 'Animatic锁时'],
  ['镜头成品', '正式首尾帧', '镜头视频', '单镜锁定'],
  ['场景成片', '场剪辑与画面锁定', '场声音与混音字幕', '场级QA'],
  ['分集成片', '分集组装', '分集审阅', '分集技术QC'],
  ['全剧交付', '跨集连续性', '权利敏感技术终检', '交付归档'],
];


export default function TrialPage() {
  const { hostedReadOnly } = useRuntimeMode();
  const [snapshot, setSnapshot] = useState<TrialSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestController = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState('');
  const [scopeIndex, setScopeIndex] = useState<TrialScopeIndex | null>(null);
  const params = useSearchParams();
  const requestedScopeId = params.get('scopeId') || '';
  const requestedView = params.get('view') || 'materials';
  const view = ['story', 'materials', 'pipeline'].includes(requestedView) ? requestedView : 'materials';
  const readSnapshot = useCallback(async (controller: AbortController) => {
    try {
      const index = await loadTrialScopes(controller.signal);
      const scopeId = requestedScopeId || index.defaultScopeId || undefined;
      const next = scopeId ? await loadTrialSnapshot(controller.signal, scopeId) : null;
      if (!controller.signal.aborted) setScopeIndex(index);
      if (!controller.signal.aborted) setSnapshot(next);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setSnapshot(null);
        setError(reason instanceof Error ? reason.message : '试制资料读取失败');
        throw reason;
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [requestedScopeId]);
  async function refresh() {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true); setError('');
    await readSnapshot(controller);
  }
  useEffect(() => {
    if (hostedReadOnly) return;
    const controller = new AbortController();
    requestController.current = controller;
    void Promise.resolve().then(() => readSnapshot(controller)).catch(() => {});
    return () => requestController.current?.abort();
  }, [hostedReadOnly, readSnapshot]);
  const scopeQuery = snapshot ? `&scopeId=${encodeURIComponent(snapshot.scope.id)}` : '';
  const recipeId = (snapshot?.recipes.some(item => item.id === selected) ? selected : '') || snapshot?.recipes[0]?.id || '';
  const recipe = snapshot?.recipes.find((item) => item.id === recipeId);
  const versions = snapshot?.assets.filter((item) => item.mediaId === recipe?.subjectId) || [];
  const [versionId, setVersionId] = useState('');
  const asset = versions.find((item) => item.versionId === versionId) || versions.at(-1);
  return <main className="review-shell trial-shell">
    <aside className="workspace-sidebar" aria-label="审阅台主导航"><Link className="sidebar-brand" href="/"><span className="brand-mark">阅</span><span><b>{snapshot?.scope.projectTitle || '制作审阅台'}</b><small>本剧试制范围</small></span></Link><nav className="workspace-nav">{[['overview', '当前工作'], ['story', '故事创作'], ['materials', '素材管理'], ['pipeline', '全剧制作'], ['system', '系统管理']].map(([id, label], index) => <a key={id} className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} href={['overview', 'system'].includes(id) ? `/?view=${id}` : `/trial?view=${id}${scopeQuery}`}><span>0{index + 1}</span><b>{label}</b></a>)}</nav><Link className="trial-return" href="/">← 返回全剧当前工作</Link></aside>
    <div className="workspace-main"><header className="workspace-topbar"><div><small>独立试制范围</small><h1>{snapshot?.scope.title || '试制审阅'}</h1></div><button onClick={() => void refresh().catch(() => {})} disabled={hostedReadOnly || loading}>刷新状态</button></header><div className="workspace-content">
      {hostedReadOnly ? <section className="trial-empty"><h2>试制素材保存在本机</h2><p>请在本地审阅图片、试听声音并保存正式判断。</p><a href="http://localhost:3000/trial?view=materials">打开本地试制</a></section> : <>
        {error && <div className="trial-feedback"><p role="alert">{error}</p><button onClick={() => void refresh().catch(() => {})} disabled={loading}>重新读取试制资料</button></div>}
        {loading && <p role="status">正在读取试制内容…</p>}
        {!snapshot && !loading && !error && <section className="trial-empty"><h2>尚未设置试制范围</h2><p>这个实例还没有试制内容、素材或审阅记录。</p><Link href="/">返回审阅台</Link></section>}
        {snapshot && <>
          {scopeIndex && scopeIndex.scopes.length > 1 && <label>试制范围 <select aria-label="试制范围" value={snapshot.scope.id} onChange={event => { const url = new URL(location.href); url.searchParams.set('scopeId', event.target.value); location.assign(url.href); }}>{scopeIndex.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.title}</option>)}</select></label>}
          <p className="trial-scope-note">已登记 {snapshot.story?.episodes?.length ?? 0} 个分集选段 · {snapshot.story?.shotProposals?.length ?? 0} 项镜头提案 · {snapshot.recipes.length} 项素材配方 · 本试制进度单独统计</p>
          {view === 'materials' && <div className="trial-material-workspace"><nav className="trial-catalog" aria-label="试制素材目录">{snapshot.recipes.map((item) => {
            const produced = snapshot.assets.filter((candidate) => candidate.mediaId === item.subjectId);
            return <button key={item.id} aria-pressed={recipeId === item.id} onClick={() => { setSelected(item.id); setVersionId(''); }}><b>{item.label}</b><span>{produced.length ? labels[produced.at(-1)!.lifecycle] || '已有候选' : '尚未产出'}</span></button>;
          })}</nav><article className="trial-material-detail">
            {versions.length > 1 && <label className="trial-version-select">查看版本 <select value={asset?.versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.map((item) => <option key={item.versionId} value={item.versionId}>{item.version} · {labels[item.lifecycle] || item.lifecycle}</option>)}</select></label>}
            {asset ? <AssetReview key={asset.versionId} asset={asset} etag={snapshot.mutationEtag} refresh={refresh} currentVersion={asset === versions.at(-1)} /> : <section className="trial-empty"><h2>{recipe?.label || '选择一项素材'}</h2><div className="trial-placeholder">产物展示区 · 尚未生成</div><p>生成完成并登记文件后，可在这里查看和审阅。</p>{recipe?.outputPath && <p className="trial-output"><b>固定输出</b><code>{recipe.outputPath}</code><button onClick={() => void navigator.clipboard.writeText(recipe.outputPath!)}>复制</button></p>}</section>}
            <section className="trial-usage"><h2>为什么需要这项素材</h2><p>缺项：当前试制资料没有登记这项素材的用途与使用依据。</p><p>通过一项素材只采用所审版本；后续工作仍需核对各自的输入、产物和审阅记录。</p></section>
          </article></div>}
          {view === 'story' && <section className="trial-story"><h2>本次试制的故事与镜头提案</h2><p>以下显示当前试制绑定的内容；提案数量不代表已确认方案或正式制作分母。</p>{!snapshot.story?.episodes?.length && <p>尚未登记分集选段。</p>}{snapshot.story?.episodes?.map((episode) => <article key={episode.episodeUid} className="trial-empty"><h2>{episode.displayLabel} · {episode.title}</h2><p><b>本集要表达</b>：{episode.goal}</p><p><b>看完知道什么</b>：{episode.audienceKnowsAtEnd}</p><p><b>结尾悬念</b>：{episode.endingHook}</p>{snapshot.story?.shotProposals?.filter((shot) => shot.episodeUid === episode.episodeUid).map((shot) => <section className="trial-shot" key={shot.id}><h3>{shot.displayLabel} · {shot.title} <small>{typeof shot.proposedDurationSeconds === 'number' ? `拟 ${shot.proposedDurationSeconds} 秒` : '拟定时长未登记'}</small></h3><p>{shot.visualIntent}</p>{snapshot.story?.dialogue?.filter((line) => line.shotProposalId === shot.id).map((line) => <blockquote key={line.id}><b>{line.speaker}</b>：{line.text}</blockquote>)}<p><b>连续性</b>：{shot.continuityIntent}</p></section>)}<details className="trial-details"><summary>来源场正文 · {episode.sourceSceneId}</summary><pre>{snapshot.story?.sourceScenes?.find((scene) => scene.sceneId === episode.sourceSceneId)?.exactSourceText || '缺项：来源正文未登记'}</pre></details></article>)}</section>}
          {view === 'pipeline' && <section className="trial-production"><h2>从素材进入试制成片</h2><p>下列门禁需核对独立的实际产物和审阅记录。当前试制快照未登记逐门禁进度。</p>{stages.map(([title, ...gates], index) => <section key={title}><h3>0{index + 1} · {title}</h3>{gates.map((gate) => <p key={gate}><b>{gate}</b><span>进度未登记</span></p>)}</section>)}</section>}
          <details className="trial-details"><summary>本轮预算与执行记录</summary><pre>{JSON.stringify({ budgets: snapshot.budgets, executions: snapshot.executions }, null, 2)}</pre></details>
        </>}
      </>}
    </div></div>
  </main>;
}
