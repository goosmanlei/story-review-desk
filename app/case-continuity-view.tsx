'use client';

import type { AdaptationAudit } from './adaptation-audit';
import { visibleText } from './review-semantics';

type Check = { check_id?: string; name?: string; status?: string; result?: unknown; note?: string };

const requiredChecks = new Set([
  'CHECK-PEOPLE',
  'CHECK-DEATH-ORDER',
  'CHECK-NINE-HEADS',
  'CHECK-HEAD-BODY-LOCATIONS',
  'CHECK-EVIDENCE',
  'CHECK-ADJUDICATION',
]);

function ResultView({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ol>{value.map((item, index) => <li key={index}>{visibleText(String(item))}</li>)}</ol>;
  if (value && typeof value === 'object') return <dl>{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key}><dt>{visibleText(key)}</dt><dd>{Array.isArray(item) ? item.map(String).join(' → ') : visibleText(String(item))}</dd></div>)}</dl>;
  return <p>{visibleText(String(value ?? 'UNKNOWN'))}</p>;
}

export function CaseContinuityView({ audit }: { audit: AdaptationAudit }) {
  const checks = (Array.isArray(audit.selfChecks) ? audit.selfChecks : []) as Check[];
  const visibleChecks = checks.filter((check) => requiredChecks.has(check.check_id || ''));
  return <section className="case-continuity-view" aria-labelledby="case-continuity-title">
    <header><div><small>CASE CONTINUITY GUARD</small><h2 id="case-continuity-title">案件连续性核对表</h2><p>这些是剧本修改后的强制回看项，直接投影原文改编审计，不由页面重新推理。任何一项变化，都要回查受影响场、空间状态与下游资产。</p></div><span>{visibleChecks.length}项当前核对</span></header>
    <div className="case-continuity-grid">{visibleChecks.map((check, index) => <article key={check.check_id || index}>
      <header><span>{String(index + 1).padStart(2, '0')}</span><div><small>{check.check_id || 'UNKNOWN'}</small><h3>{visibleText(check.name || '未命名核对')}</h3></div><i data-status={check.status}>{visibleText(check.status || 'UNKNOWN')}</i></header>
      <ResultView value={check.result} />
      {check.note && <footer><b>边界说明</b><p>{visibleText(check.note)}</p></footer>}
    </article>)}</div>
    {!visibleChecks.length && <p className="v6-empty-note">当前审计快照没有投影案件核对表；保持UNKNOWN，不自动补写。</p>}
  </section>;
}
