'use client';

import {
  resolveAdoptedVersionId,
  VersionPanel,
  type OperationalStateProjection,
  type ProductionModel,
  type V7AssetFamily,
  type V7AssetVersion,
} from './production-workbench';
import { publicRef, visibleText } from './review-semantics';
import {dailyMaterialVersionRefs,exactMaterialVersion} from './material-daily-versions';

type FamilyProjection = Record<string, unknown> & {
  currentVersionId?: string | null;
  adoptedVersionId?: string | null;
  decisionVersionId?: string | null;
  versionRefs?: string[];
};

function versionOrdinal(id: string) {
  const match = id.match(/@V(\d+)$/i);
  return match ? Number(match[1]) : -1;
}

export function latestMaterialVersion(model: ProductionModel, family: V7AssetFamily | null) {
  if (!family) return null;
  const versions = dailyMaterialVersionRefs(model,family)
    .map((id) => exactMaterialVersion(model,family,id))
    .filter((item): item is V7AssetVersion => Boolean(item));
  return versions.sort((left, right) => (
    versionOrdinal(left.id) - versionOrdinal(right.id)
    || family.versionRefs.indexOf(left.id) - family.versionRefs.indexOf(right.id)
  )).at(-1) || null;
}

export function MaterialVersionHistory({
  model,
  family,
  selectedVersionId,
  stateProjection,
  onSelectVersion,
}: {
  model: ProductionModel;
  family: V7AssetFamily;
  selectedVersionId: string | null;
  stateProjection: OperationalStateProjection | null;
  onSelectVersion: (versionId: string | null) => void;
}) {
  const projectedFamily = (stateProjection?.assetFamiliesById[family.id] || {}) as FamilyProjection;
  const projectedRefs = Array.isArray(projectedFamily.versionRefs)
    ? projectedFamily.versionRefs.map(String)
    : [];
  const versionRefs = [...new Set([...family.versionRefs, ...projectedRefs])];
  const latestVersionId = [...versionRefs].sort((left, right) => (
    versionOrdinal(left) - versionOrdinal(right)
    || versionRefs.indexOf(left) - versionRefs.indexOf(right)
  )).at(-1) || null;
  const adoptedVersionId = resolveAdoptedVersionId(family, stateProjection);
  const latestProjection = latestVersionId ? stateProjection?.assetVersionsById[latestVersionId] : null;
  const latestBase = latestVersionId ? model.assetVersions.find((item) => item.id === latestVersionId) || null : null;
  const textPath = String(latestProjection?.path || latestBase?.path || '');
  const textToken = String(latestProjection?.mediaToken || latestBase?.mediaToken || '');
  const isText = /\.(?:txt|md|srt|vtt)$/i.test(textPath);

  return <section className="material-version-history">
    <section className="material-story-basis">
      <small>VERSION SUMMARY</small>
      <h3>当前素材版本</h3>
      <p><b>最新尝试：</b>{latestVersionId ? publicRef(latestVersionId) : '尚无文件版本'}{latestProjection?.lifecycleState || latestBase?.lifecycleState ? ` · ${visibleText(String(latestProjection?.lifecycleState || latestBase?.lifecycleState))}` : ''}</p>
      <p><b>当前采用：</b>{adoptedVersionId ? publicRef(adoptedVersionId) : '尚未采用任何版本'}{latestVersionId && adoptedVersionId && latestVersionId !== adoptedVersionId ? ' · 与最新尝试不同' : ''}</p>
      <p><b>历史版本：</b>{Math.max(0, versionRefs.length - (latestVersionId ? 1 : 0))} 个；旧版始终保留，不原位覆盖。</p>
      {latestVersionId && selectedVersionId !== latestVersionId && <button onClick={() => onSelectVersion(latestVersionId)}>查看最新尝试 →</button>}
      {adoptedVersionId && selectedVersionId !== adoptedVersionId && <button onClick={() => onSelectVersion(adoptedVersionId)}>查看当前采用 →</button>}
      {isText && textToken && <a href={`/api/v8/media/${encodeURIComponent(textToken)}`} target="_blank" rel="noreferrer">打开最新文本版本 →</a>}
    </section>
    <VersionPanel
      model={model}
      family={family}
      selectedVersionId={selectedVersionId || latestVersionId}
      heading="版本详情与历史"
      onSelectVersion={onSelectVersion}
    />
  </section>;
}
