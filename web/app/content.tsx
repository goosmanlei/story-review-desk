"use client";
import { useState, useEffect, useRef } from "react";
import { captureSelection, restoreSelection } from "./session";
import {
  productionFieldLabels,
  productionValueLabels,
} from "./production-labels";
import type { Detail } from "./types";
export const fieldLabels: Record<string, string> = {
  episodeTask: "本集任务",
  characterAction: "人物行动",
  expressionFocus: "表达重点",
  deliveredResult: "交付给观众的结果",
  changedState: "状态变化",
  unresolvedQuestions: "留下的问题",
  information: "信息与因果",
  characterKnowledge: "人物知情边界",
  comedyBeats: "喜剧节拍",
  role: "承担作用",
  inheritedInformation: "承接信息",
  newInformation: "新增信息",
  withheldInformation: "暂不揭晓",
  causalLinks: "因果关系",
  whyNeeded: "为什么需要",
  onScreenRequirement: "画面内需求",
  authorityClass: "依据属性",
  businessCategoryPrimaryName: "素材分类",
  businessCategorySecondaryName: "用途分类",
  requirements: "需求",
  quote: "原文引用",
  locator: "来源位置",
  treatment: "原文处理",
  summary: "摘要",
  mustPreserve: "必须保留",
  setupSceneIds: "铺垫场次",
  payoffSceneIds: "揭晓场次",
  runtimeMethod: "时长口径",
  changeSummary: "创作说明",
  sourceNarrationIndex: "原文处理索引",
  flowBlockReasons: "下传受阻原因",
  rightsStatus: "权利状态",
  qaStatus: "质检结论",
  canFlowDownstream: "可供下游使用",
  rightsFacts: "权利事实",
  materialRequirementRefs: "素材需求引用",
  audienceGain: "观众所得",
  audiencePosition: "观众的位置",
  authoringUnknowns: "创作待核项",
  coverageRole: "覆盖职责",
  displayName: "人物",
  hiddenTruth: "隐藏真相",
  informationLayers: "信息层次",
  knowledge: "人物知情",
  outputState: "结束状态",
  progressionSlices: "推进段落",
  sequenceTitle: "段落",
  structuralRole: "结构职责",
  turningPoint: "转折",
  visibleAction: "可见行动",
  description: "说明",
  text: "正文",
  purpose: "场景任务",
  audienceKnown: "观众已知",
  audienceWithheld: "保留信息",
  viewpoint: "视点",
  transition: "场间承接",
  storyTime: "故事时间",
  slugline: "场景",
  openingHook: "开场与承接",
  coreAdvance: "推进与转折",
  endingCliffhanger: "结尾与承接",
  reviewQuestion: "审阅问题",
  reviewDossier: "审阅依据",
  acceptanceCriteria: "验收要点",
  reason: "需求理由",
  visualIntent: "画面意图",
  actionIntent: "动作与表演",
  soundIntent: "声音设计",
  dialogueContext: "对白",
  audienceTakeaway: "观众所得",
  narrativeBeat: "叙事节拍",
  design: "镜头设计",
  shotSize: "景别",
  cameraAngle: "机位角度",
  cameraMovement: "机位运动",
  estimatedDurationSeconds: "估计时长（秒）",
  keyframeStrategy: "关键帧策略",
  composition: "构图",
  performance: "表演",
  lighting: "光线",
  continuity: "连续性",
  startState: "起始状态",
  endState: "结束状态",
  transitionIn: "切入",
  transitionOut: "切出",
  technical: "制作规格",
  prompt: "提示词",
  main: "主提示词",
  negative: "负向提示词",
  sourceSummary: "场景依据",
  sourceEvidence: "来源证据",
  content: "候选内容",
  beats: "节拍安排",
  sequences: "叙事段落",
  causalChains: "因果链",
  runtime: "时长估计",
  baseSec: "基准秒数",
  compactSec: "紧凑秒数",
  spaciousSec: "舒展秒数",
  rationale: "估时依据",
  title: "标题",
  name: "名称",
  label: "名称",
  note: "说明",
  function: "叙事功能",
  class: "依据属性",
  evidenceRefs: "精确依据",
  sceneFlow: "场次推进",
  boundaryEvidence: "边界依据",
  opening: "开场",
  ending: "结尾",
  setup: "铺垫",
  payoff: "回收",
  purposeAndPayoff: "任务与回报",
  informationCausality: "信息与因果",
  sourceRole: "来源角色",
  authority: "依据属性",
  model: "模型",
  parametersRaw: "调用参数",
  sourceRef: "原始依据",
  actualPrompt: "实际提示词",
  actualParameters: "实际参数",
  rightsWarning: "权利提示",
  status: "状态",
  stage: "阶段",
  originalKind: "原候选类型",
  aliases: "别名",
  evidence: "依据",
  type: "类型",
  dimensions: "状态条件",
  scope: "适用范围",
  include: "包含条件",
  exclude: "排除条件",
  inherit: "继承条件",
  timeAndSpace: "时间与空间",
  sceneRole: "场景作用",
  informationBoundary: "信息边界",
  soundAndDialogueIntent: "声音与对白",
  sourceDialogue: "来源对白",
  entityStateRequirements: "主体状态需求",
  materialGaps: "素材缺口",
  reviewFocus: "审阅重点",
  handoffReadiness: "制作准备情况",
  classification: "分类",
  informationCardProposal: "信息卡",
  identityChangeReason: "镜头变更依据",
  camera: "机位设计",
  base: "基础空间",
  dressing: "场景陈设",
  appearance: "外观",
  anchor: "定位依据",
  orientation: "朝向",
  relation: "相对关系",
  height: "高度",
  looks: "观察方向",
  origin: "起点位置",
  preserveBaseGeometry: "保持基础几何",
  segments: "制作段落",
  action: "动作",
  negativePrompt: "负向提示词",
  decision: "既有判断",
  criterionFindings: "逐项判断",
  verdict: "结论",
  observation: "原观察记录",
  purposeNote: "用途说明",
  cameras: "机位",
  characters: "出场人物",
  locs: "场景空间",
  zones: "空间区域",
  dialogue: "对白",
  durationSeconds: "设计时长",
  technicalSpec: "技术规格",
  parameters: "调用参数",
  output: "产物定义",
  source: "来源",
  realizes: "实现需求",
  inputBindings: "实际输入依据",
  materialRequirementBindings: "素材需求依据",
  frozenBasis: "历史冻结依据",
  requirement: "需求定义",
  bindings: "关联依据",
  conditions: "生效条件",
  from: "起点",
  to: "终点",
  domainContext: "主体归属",
  storyBasis: "故事依据",
  coverageReasons: "覆盖理由",
  cardSpec: "设计说明",
  mediaKind: "媒体类型",
  businessCategoryPrimary: "业务分类",
  businessCategorySecondary: "子分类",
  reviewDecision: "原判断",
  trialDecision: "原试制判断",
  trialStatus: "原试制状态",
  imageTechnicalFacts: "图像技术事实",
};
Object.assign(fieldLabels, productionFieldLabels);
export function Rich({
  value,
  depth = 0,
  path = [],
}: {
  value: any;
  depth?: number;
  path?: string[];
}) {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return (
      <p className="rich-text" data-content-path={JSON.stringify(path)}>
        {typeof value === "boolean"
          ? value
            ? "是"
            : "否"
          : typeof value === "string"
            ? productionValueLabels[value] || value
            : String(value)}
      </p>
    );
  if (Array.isArray(value))
    return (
      <div className="rich-list">
        {value.map((item, i) => (
          <div className="rich-item" key={item?.id || i}>
            <Rich value={item} depth={depth + 1} path={[...path, String(i)]} />
          </div>
        ))}
      </div>
    );
  if (
    value.text &&
    Object.keys(value).every((k) =>
      ["text", "class", "authority", "evidenceRefs"].includes(k),
    )
  )
    return (
      <p
        className="rich-text"
        data-content-path={JSON.stringify([...path, "text"])}
      >
        {value.class && <span className="pill">{value.class}</span>}{" "}
        {value.text}
      </p>
    );
  return (
    <div>
      {Object.entries(value)
        .filter(
          ([k, v]) =>
            fieldLabels[k] &&
            v !== null &&
            v !== "" &&
            !["id", "contentHash"].includes(k),
        )
        .map(([key, item]) => (
          <div className="rich-field" key={key}>
            {depth < 3 && <h4>{fieldLabels[key]}</h4>}
            <Rich value={item} depth={depth + 1} path={[...path, key]} />
          </div>
        ))}
    </div>
  );
}
export function Content({
  detail,
  onOpen,
}: {
  detail: Detail;
  onOpen: (id: string, revisionId?: string) => void;
}) {
  const c = detail.revision.content,
    [zoom, setZoom] = useState<string | null>(null),
    [scale, setScale] = useState(100);
  const bodyRef = useRef<HTMLDivElement>(null),
    selectionKey = detail.id + ":" + detail.revision.id;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (bodyRef.current) restoreSelection(selectionKey, bodyRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [selectionKey]);
  const blocks = c.blocks || c.scriptBlocks;
  return (
    <div
      ref={bodyRef}
      className="content-body"
      data-content-object={detail.id}
      data-content-revision={detail.revision.id}
      onMouseUp={() => {
        if (bodyRef.current) captureSelection(selectionKey, bodyRef.current);
      }}
    >
      {detail.kind === "ASSET" && !detail.media.length && (
        <p className="notice">
          此版本没有登记可读取的实际媒体，原版本依据仍保留。
        </p>
      )}
      {detail.media.length > 0 && (
        <div className="media-list">
          {detail.media.map((m) => (
            <figure key={m.id + m.version_id + m.role}>
              {m.availability !== "PRESENT" ? (
                <div className="empty">
                  {m.availability === "RETIRED" ? "此媒体已退役" : "此媒体缺失"}
                  ，原登记仍保留
                </div>
              ) : m.mime_type.startsWith("image/") ? (
                <button
                  className="image-open"
                  onClick={() => setZoom(m.sha256)}
                >
                  <img
                    src={"/api/v1/media/" + m.sha256}
                    alt={detail.title}
                    loading="lazy"
                  />
                </button>
              ) : m.mime_type.startsWith("audio/") ? (
                <audio
                  controls
                  preload="none"
                  src={"/api/v1/media/" + m.sha256}
                />
              ) : m.mime_type.startsWith("video/") ? (
                <video
                  controls
                  preload="metadata"
                  src={"/api/v1/media/" + m.sha256}
                />
              ) : (
                <a href={"/api/v1/media/" + m.sha256}>读取已登记文件</a>
              )}
              <figcaption>
                {m.role === "OUTPUT" ? "实际产物" : "依据附件"} · {m.version_id}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {c.slugline && <p className="slugline">{c.slugline}</p>}
      {blocks ? (
        <div className="script-body">
          {blocks.map((block: any, i: number) => (
            <p
              key={block.id || i}
              data-block-id={block.id}
              className={block.type === "dialogue" ? "dialogue" : "action"}
            >
              {block.speaker && <b>{block.speaker}　</b>}
              {block.performanceNote && <em>（{block.performanceNote}）</em>}
              {block.text}
            </p>
          ))}
        </div>
      ) : (
        c.text && (
          <p
            className="rich-text main-text"
            data-content-path={JSON.stringify(["text"])}
          >
            {c.text}
          </p>
        )
      )}
      <Rich
        value={Object.fromEntries(
          Object.entries(c).filter(
            ([k]) =>
              ![
                "text",
                "blocks",
                "scriptBlocks",
                "slugline",
                "reviewSpec",
                "configurationBinding",
              ].includes(k),
          ),
        )}
      />
      {detail.links.length > 0 && (
        <section className="related">
          <h3>关联对象</h3>
          {detail.links.map((link) => (
            <button key={link.id + link.role} onClick={() => onOpen(link.id)}>
              {link.title}
            </button>
          ))}
        </section>
      )}
      {detail.dependencies.length > 0 && (
        <details className="source-details">
          <summary>本版本依据 · {detail.dependencies.length}</summary>
          {detail.dependencies.map((d) => (
            <button
              key={d.revisionId + d.purpose}
              onClick={() => onOpen(d.objectId, d.revisionId)}
            >
              {d.title}
              <small>
                {d.purpose === "ACTUAL_INPUT"
                  ? "实际输入"
                  : d.purpose === "DEFINITION"
                    ? "需求定义"
                    : "内容依据"}
              </small>
            </button>
          ))}
        </details>
      )}
      {zoom && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="原图查看"
          onClick={() => setZoom(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setZoom(null);
          }}
          tabIndex={-1}
        >
          <button autoFocus onClick={() => setZoom(null)}>
            关闭
          </button>
          <div
            className="image-zoom-controls"
            onClick={(e) => e.stopPropagation()}
          >
            <label>
              缩放
              <input
                aria-label="原图缩放"
                type="range"
                min="40"
                max="300"
                step="10"
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
              />
            </label>
            <span>{scale}%</span>
            <button onClick={() => setScale(100)}>适合窗口</button>
            <a href={"/api/v1/media/" + zoom} target="_blank" rel="noreferrer">
              打开原图
            </a>
          </div>
          <div
            className="image-zoom-scroll"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              style={{
                width: scale + "%",
                maxWidth: "none",
                maxHeight: "none",
                objectFit: "contain",
              }}
              src={"/api/v1/media/" + zoom}
              alt={detail.title}
            />
          </div>
        </div>
      )}
    </div>
  );
}
