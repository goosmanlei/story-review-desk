"use client";
import { useEffect, useState } from "react";
import { read } from "./client";
import { kindLabels, stateLabels, type Summary } from "./types";
import { LinkPicker } from "./link-picker";

export type View = {
  kind: string;
  id: string;
  query: string;
  offset: number;
  owner: string;
  historical: boolean;
  revisionId?: string;
  category?: string;
  mediaType?: string;
  entity?: string;
  lane?: string;
  phase?: string;
  gate?: string;
};
type Change = (v: Partial<View>) => void;
export const phases = [
  {
    id: "PREVIS",
    label: "动态预演",
    note: "先确认如何讲清这场戏",
    gates: [
      ["SHOT_PLAN_INPUT_LOCK", "镜头方案与输入", "SHOT_DESIGN"],
      ["STORYBOARD_DIALOGUE", "分镜与对白", "SHOT"],
      ["ANIMATIC_LOCK", "动态预演锁定", "INPUT_LOCK"],
    ],
  },
  {
    id: "SHOT_FINISH",
    label: "镜头制作",
    note: "关键帧、视频与镜头审阅",
    gates: [
      ["KEYFRAMES", "关键帧", "ASSET"],
      ["SHOT_VIDEO", "镜头视频", "ASSET"],
      ["SHOT_LOCK", "镜头锁定", "INPUT_LOCK"],
    ],
  },
  {
    id: "SCENE_FINISH",
    label: "场景成片",
    note: "画面、声音与场景质检",
    gates: [
      ["PICTURE_LOCK", "画面锁定", "ASSEMBLY"],
      ["SOUND_MIX_SUBTITLES", "声音、混音与字幕", "ASSEMBLY"],
      ["SCENE_QA", "场景质检", "DELIVERABLE"],
    ],
  },
  {
    id: "EPISODE_FINISH",
    label: "分集成片",
    note: "整集装配与综合审阅",
    gates: [
      ["EPISODE_ASSEMBLY", "分集装配", "ASSEMBLY"],
      ["EPISODE_REVIEW", "分集审阅", "DELIVERABLE"],
      ["EPISODE_TECH_QC", "技术质检", "DELIVERABLE"],
    ],
  },
  {
    id: "SERIES_DELIVERY",
    label: "全剧交付",
    note: "连续性、权利与交付检查",
    gates: [
      ["SERIES_CONTINUITY", "全剧连续性", "DELIVERABLE"],
      ["RIGHTS_SAFETY_TECH", "权利、安全与技术", "DELIVERABLE"],
      ["DELIVERY_ARCHIVE", "交付归档", "DELIVERABLE"],
    ],
  },
];
export function WorkspaceTabs({
  module,
  value,
  onChange,
}: {
  module: string;
  value: View;
  onChange: Change;
}) {
  const select = (kind: string, extra: Partial<View> = {}) =>
    onChange({
      kind,
      id: "",
      offset: 0,
      owner: "",
      category: "",
      mediaType: "",
      lane: "",
      gate: "",
      ...extra,
    });
  let groups: string[][] = [];
  let selected = value.kind;
  if (module === "story") {
    groups = [
      ["SOURCE", "来源资料"],
      ["STORY", "故事结构"],
      ["narrative", "叙事拆解"],
    ];
    selected = ["EPISODE", "SCENE"].includes(value.kind)
      ? "narrative"
      : value.kind;
  }
  if (module === "settings") {
    groups = [
      ["ENTITY", "主体分类"],
      ["SPACE", "空间设定"],
      ["RELATION", "实体关系"],
    ];
    selected = ["STATE", "REPRESENTATION"].includes(value.kind)
      ? "ENTITY"
      : value.kind;
  }
  if (module === "materials") {
    groups = [
      ["base", "基础素材"],
      ["process", "制作过程素材"],
    ];
    selected = value.lane === "PROCESS" ? "process" : "base";
  }
  if (module === "project")
    groups = [
      ["GUIDANCE", "项目指引"],
      ["NOTE", "候选记录"],
      ["COMMENT", "评论记录"],
    ];
  const sub =
    module === "story" && selected === "narrative"
      ? ["EPISODE", "SCENE"]
      : module === "settings" && selected === "ENTITY"
        ? ["ENTITY", "STATE", "REPRESENTATION"]
        : module === "materials"
          ? [
              "MATERIAL",
              "REQUIREMENT",
              "ASSET",
              "PROMPT",
              "CALL",
              "EXPECTED_OUTPUT",
            ]
          : module === "production"
            ? [
                "PREPARATION",
                "COVERAGE",
                "SHOT_DESIGN",
                "SHOT",
                "INPUT_LOCK",
                "ASSEMBLY",
                "DELIVERABLE",
              ]
            : [];
  return (
    <>
      {groups.length > 0 && (
        <div
          className="tabs domain-tabs"
          role="tablist"
          aria-label="工作区内容"
        >
          {groups.map(([id, label]) => (
            <button
              role="tab"
              aria-selected={selected === id}
              key={id}
              onClick={() =>
                select(
                  id === "narrative"
                    ? "EPISODE"
                    : id === "base" || id === "process"
                      ? "MATERIAL"
                      : id,
                  { lane: id === "process" ? "PROCESS" : "BASE" },
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {module === "production" && (
        <>
          <div className="phase-strip" aria-label="制作阶段">
            {phases.map((p, i) => (
              <button
                key={p.id}
                aria-pressed={(value.phase || "PREVIS") === p.id}
                onClick={() =>
                  select(p.gates[0][2], { phase: p.id, gate: p.gates[0][0] })
                }
              >
                <small>0{i + 1}</small>
                <b>{p.label}</b>
                <span>{p.note}</span>
              </button>
            ))}
          </div>
          <div className="gate-strip" aria-label="阶段关口">
            {(
              phases.find((p) => p.id === (value.phase || "PREVIS")) ||
              phases[0]
            ).gates.map(([id, label, kind]) => (
              <button
                key={id}
                aria-pressed={value.gate === id}
                onClick={() =>
                  select(kind, { phase: value.phase || "PREVIS", gate: id })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {sub.length > 0 && (
        <div className="tabs sub-tabs" role="tablist" aria-label="内容分类">
          {sub.map((kind) => (
            <button
              role="tab"
              aria-selected={value.kind === kind}
              key={kind}
              onClick={() =>
                select(kind, {
                  owner: value.owner,
                  lane: value.lane,
                  phase: value.phase,
                })
              }
            >
              {kindLabels[kind]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
const labels: Record<string, string> = {
  VISUAL: "图像",
  HISTORICAL_MEDIA_EVIDENCE: "历史媒体依据",
  DERIVED_CROP: "派生裁切",
  MATERIAL_REQUIREMENT_CHARACTER_INFO_CARD: "人物信息卡",
  PROP_STATE: "道具状态",
  STORYBOARD: "分镜图",
  KEYFRAME: "关键帧",
  CHARACTER_REFERENCE: "人物参考",
  CHARACTER: "人物",
  LOCATION: "地点",
  PROP: "道具",
  GROUP: "群体",
  ORGANIZATION: "组织",
  CONCEPT: "概念",
  EVENT: "事件",
  SPACE: "空间",
  IMAGE: "图像",
  AUDIO: "音频",
  VIDEO: "视频",
  MATERIAL_PREPARATION: "基础素材",
  PRODUCTION: "制作过程",
};
export const categoryLabel = (key: string) => labels[key] || key;
export function FacetFilters({
  value,
  onChange,
}: {
  value: View;
  onChange: Change;
}) {
  const [facets, setFacets] = useState<{ kind: string; items: any[] } | null>(
      null,
    ),
    [entityLabel, setEntityLabel] = useState("");
  useEffect(() => {
    let active = true;
    if (value.entity)
      read("objects/" + encodeURIComponent(value.entity))
        .then((o) => active && setEntityLabel(o.title))
        .catch(() => active && setEntityLabel(value.entity || ""));
    else setEntityLabel("");
    return () => {
      active = false;
    };
  }, [value.entity]);
  useEffect(() => {
    let active = true;
    read("facets?kind=" + value.kind)
      .then((r) => active && setFacets({ kind: value.kind, items: r.items }))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [value.kind]);
  const rows = facets?.kind === value.kind ? facets.items : [];
  const categories = Array.from(
    new Map(
      rows.filter((x) => x.category).map((x) => [x.category, x.label]),
    ).entries(),
  );
  const media = Array.from(
    new Set(rows.map((x) => x.mediaType).filter(Boolean)),
  );
  return (
    <>
      {["MATERIAL", "REQUIREMENT", "ASSET"].includes(value.kind) && (
        <div className="entity-filter">
          <LinkPicker
            kind="ENTITY"
            label={entityLabel ? "主体 · " + entityLabel : "按主体查看素材"}
            onChoose={(item) =>
              onChange({ entity: item.id, id: "", offset: 0 })
            }
          />
          {value.entity && (
            <button
              aria-label="清除主体筛选"
              onClick={() => onChange({ entity: "", id: "", offset: 0 })}
            >
              ×
            </button>
          )}
        </div>
      )}
      {categories.length > 1 && (
        <select
          aria-label="业务分类"
          value={value.category || ""}
          onChange={(e) =>
            onChange({ category: e.target.value, id: "", offset: 0 })
          }
        >
          <option value="">全部分类</option>
          {categories.map(([id, label]) => (
            <option key={id} value={id}>
              {categoryLabel(label)}
            </option>
          ))}
        </select>
      )}
      {media.length > 1 && (
        <select
          aria-label="媒体类型"
          value={value.mediaType || ""}
          onChange={(e) =>
            onChange({ mediaType: e.target.value, id: "", offset: 0 })
          }
        >
          <option value="">全部媒体</option>
          {media.map((id) => (
            <option key={id} value={id}>
              {categoryLabel(id)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
export function EpisodeNavigator({
  episodes,
  value,
  onChange,
}: {
  episodes: Summary[];
  value: View;
  onChange: Change;
}) {
  const [scenes, setScenes] = useState<{
    owner: string;
    items: Summary[];
  } | null>(null);
  const owner = value.owner || (value.kind === "EPISODE" ? value.id : "");
  useEffect(() => {
    let active = true;
    if (owner)
      read(
        "objects?kind=SCENE&owner=" + encodeURIComponent(owner) + "&limit=200",
      )
        .then((r) => active && setScenes({ owner, items: r.items }))
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [owner]);
  return (
    <nav className="episode-tree" aria-label="集场目录">
      {episodes.map((e) => (
        <div key={e.id}>
          <button
            className="episode-node"
            data-catalog-id={e.id}
            aria-expanded={e.id === owner}
            aria-current={value.id === e.id ? "location" : undefined}
            onClick={() =>
              onChange({
                kind: "EPISODE",
                id: e.id,
                owner: "",
                offset: 0,
                query: "",
              })
            }
          >
            <small>{e.displayId}</small>
            <b>{e.title}</b>
            <span>{e.id === owner ? "−" : "＋"}</span>
          </button>
          {e.id === owner &&
            scenes?.owner === owner &&
            scenes.items.map((s) => (
              <button
                className="scene-node"
                key={s.id}
                data-catalog-id={s.id}
                aria-current={value.id === s.id ? "location" : undefined}
                onClick={() =>
                  onChange({
                    kind: "SCENE",
                    id: s.id,
                    owner,
                    offset: 0,
                    query: "",
                  })
                }
              >
                <small>{s.displayId}</small>
                <span>{s.title}</span>
                <i className={"state-dot state-" + s.state} />
              </button>
            ))}
        </div>
      ))}
    </nav>
  );
}
export function CatalogItem({
  object: o,
  selected,
  unsaved,
  onChoose,
}: {
  object: Summary;
  selected: boolean;
  unsaved: boolean;
  onChoose: () => void;
}) {
  const media = o.thumbnail;
  return (
    <button
      className={
        "catalog-row " +
        (["ENTITY", "MATERIAL", "ASSET"].includes(o.kind) ? "catalog-card" : "")
      }
      data-catalog-id={o.id}
      aria-current={selected ? "location" : undefined}
      onClick={onChoose}
    >
      {["MATERIAL", "ASSET"].includes(o.kind) && (
        <div className="catalog-media">
          {media?.availability === "PRESENT" &&
          media.mimeType.startsWith("image/") ? (
            <img
              loading="lazy"
              src={"/api/v1/media/" + media.sha256}
              alt={o.family?.title || o.title}
            />
          ) : (
            <span>
              {media?.availability === "RETIRED"
                ? "媒体已退役"
                : media?.availability === "MISSING"
                  ? "媒体缺失"
                  : categoryLabel(o.preview?.mediaType || "") || "待备素材"}
            </span>
          )}
        </div>
      )}
      <small>
        {o.displayId || kindLabels[o.kind]}
        {unsaved ? " · 未保存" : ""}
      </small>
      <b>
        {o.family ? o.family.title + " · " : ""}
        {o.title}
      </b>
      {o.preview?.category && <em>{categoryLabel(o.preview.category)}</em>}
      {o.preview?.description && <p>{o.preview.description}</p>}
      <span>
        {o.kind === "MATERIAL" && media && !media.adopted ? "候选预览 · " : ""}
        <i className={"state-dot state-" + o.state} />
        {stateLabels[o.state]}
        {o.stale ? " · 依据待核" : ""}
        {o.historical ? " · 历史依据" : ""}
      </span>
    </button>
  );
}
