"use client";
import { useEffect, useState, useMemo } from "react";
import { read } from "./client";
import { RelationshipBoard, type CanvasNode } from "./relationship-board";
import { Content, Rich } from "./content";
import { useSession } from "./session";
import { kindLabels, type Detail } from "./types";
type Open = (id: string, revisionId?: string) => void;
const structureTabs = [
  ["relay", "分集与视角接力"],
  ["causality", "铺垫与揭晓"],
  ["runtime", "分集与逐场时长"],
  ["source", "完整原文处理"],
  ["notes", "创作说明"],
];
export function DomainReading({
  detail,
  onOpen,
}: {
  detail: Detail;
  onOpen: Open;
}) {
  if (detail.kind === "SOURCE")
    return (
      <Content
        detail={{
          ...detail,
          revision: {
            ...detail.revision,
            content: { text: detail.revision.content.text },
          },
        }}
        onOpen={onOpen}
      />
    );
  if (detail.kind === "STORY")
    return <StoryStructure detail={detail} onOpen={onOpen} />;
  if (detail.kind === "EPISODE")
    return <EpisodeDossier detail={detail} onOpen={onOpen} />;
  if (detail.kind === "PREPARATION")
    return <PreparationReading detail={detail} onOpen={onOpen} />;
  if (detail.kind === "REQUIREMENT" || detail.kind === "MATERIAL")
    return <MaterialCard detail={detail} onOpen={onOpen} />;
  return <Content detail={detail} onOpen={onOpen} />;
}
function PreparationReading({
  detail,
  onOpen,
}: {
  detail: Detail;
  onOpen: Open;
}) {
  const tabs = [
    {
      id: "INTENT",
      label: "本场意图",
      keys: [
        "sourceSummary",
        "sceneRole",
        "audienceTakeaway",
        "informationBoundary",
      ],
    },
    {
      id: "BEATS",
      label: "节拍与对白",
      keys: [
        "beats",
        "visualIntent",
        "soundAndDialogueIntent",
        "sourceDialogue",
      ],
    },
    { id: "CUTS", label: "作者镜头准备", keys: ["authoringCuts"] },
    {
      id: "INPUTS",
      label: "实体、状态与输入",
      keys: ["entityStateRequirements", "timeAndSpace", "materialGaps"],
    },
    {
      id: "REVIEW",
      label: "下一步与审阅重点",
      keys: ["nextPreparationAction", "reviewFocus", "handoffReadiness"],
    },
  ];
  const [section, setSection] = useSession(
      "preparation-section:" + detail.id,
      "INTENT",
    ),
    tab = tabs.find((t) => t.id === section) || tabs[0],
    content = Object.fromEntries(
      Object.entries(detail.revision.content).filter(([key]) =>
        tab.keys.includes(key),
      ),
    );
  return (
    <section className="preparation-reading">
      <h3>本场制作准备稿</h3>
      <nav className="reading-tabs" aria-label="本场准备内容">
        {tabs.map((t) => (
          <button
            key={t.id}
            aria-pressed={section === t.id}
            onClick={() => setSection(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <Content
        detail={{
          ...detail,
          revision: { ...detail.revision, content },
          links: [],
          dependencies: [],
          media: [],
        }}
        onOpen={onOpen}
      />
      {!Object.keys(content).length && (
        <p className="empty">此修订尚未登记这部分准备内容。</p>
      )}
    </section>
  );
}
function EpisodeDossier({ detail, onOpen }: { detail: Detail; onOpen: Open }) {
  const [view, setView] = useSession("dossier-tab:" + detail.id, "purpose");
  const c = detail.revision.content,
    d = c.reviewDossier;
  const sections = [
    ["purpose", "任务与回报"],
    ["information", "信息与因果"],
    ["characters", "人物与喜剧"],
    ["scenes", "场次职责"],
    ["all", "完整卷宗"],
  ];
  const values =
    view === "purpose"
      ? {
          openingHook: c.openingHook,
          coreAdvance: c.coreAdvance,
          endingCliffhanger: c.endingCliffhanger,
          reviewDossier: { purpose: d?.purpose, payoff: d?.payoff },
        }
      : view === "information"
        ? {
            reviewDossier: Object.fromEntries(
              Object.entries(d || {}).filter(([k]) =>
                /information|causal|withheld|boundary/i.test(k),
              ),
            ),
          }
        : view === "characters"
          ? {
              reviewDossier: Object.fromEntries(
                Object.entries(d || {}).filter(([k]) =>
                  /character|comedy|knowledge/i.test(k),
                ),
              ),
            }
          : view === "scenes"
            ? {
                reviewDossier: {
                  sceneFlow: d?.sceneFlow,
                  progressionSlices: d?.progressionSlices,
                },
              }
            : c;
  return (
    <section className="episode-reading">
      <div className="reading-tabs">
        {sections.map(([id, label]) => (
          <button
            key={id}
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <Content
        detail={{
          ...detail,
          revision: { ...detail.revision, content: values },
          links: [],
          dependencies: [],
        }}
        onOpen={onOpen}
      />
      <h3>本集场次</h3>
      <div className="scene-flow">
        {detail.links
          .filter((l) => l.kind === "SCENE")
          .map((s, i) => (
            <button key={s.id} onClick={() => onOpen(s.id)}>
              <small>{String(i + 1).padStart(2, "0")}</small>
              <b>{s.title}</b>
              <p>
                {
                  d?.sceneFlow?.find((f: any) => f.sceneId === s.id)?.function
                    ?.text
                }
              </p>
            </button>
          ))}
      </div>
    </section>
  );
}
function StoryStructure({ detail, onOpen }: { detail: Detail; onOpen: Open }) {
  const [tab, setTab] = useSession("structure-tab:" + detail.id, "relay"),
    [offset, setOffset] = useSession("source-index-offset:" + detail.id, 0);
  const c = detail.revision.content;
  const links = (ids: string[]) =>
    ids?.map((id) => (
      <button key={id} onClick={() => onOpen(id)}>
        {id}
      </button>
    ));
  return (
    <section className="structure-reading">
      <div className="reading-tabs">
        {structureTabs.map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "relay" && (
        <>
          <h3>分集结构</h3>
          <div className="episode-grid">
            {detail.links
              .filter((l) => l.kind === "EPISODE")
              .map((e, i) => (
                <button key={e.id} onClick={() => onOpen(e.id)}>
                  <small>第 {i + 1} 集</small>
                  <b>{e.title}</b>
                  <span>打开分集卷宗 →</span>
                </button>
              ))}
          </div>
          <h3>叙事段落与视角接力</h3>
          {c.sequences?.map((s: any) => (
            <details key={s.id}>
              <summary>{s.title}</summary>
              <Rich value={s} />
              <div className="context-links">{links(s.sceneIds)}</div>
            </details>
          ))}
        </>
      )}
      {tab === "causality" && (
        <div className="causal-chains">
          {c.causalChains?.map((s: any) => (
            <article key={s.id}>
              <h3>{s.title}</h3>
              <Rich
                value={{
                  mustPreserve: s.mustPreserve,
                  description: s.description,
                }}
              />
              <div>
                <h4>铺垫</h4>
                {links(s.setupSceneIds)}
                <h4>揭晓与回收</h4>
                {links(s.payoffSceneIds)}
              </div>
            </article>
          ))}
        </div>
      )}
      {tab === "runtime" && (
        <>
          <Rich value={{ runtimeMethod: c.runtimeMethod }} />
          <RuntimeTable onOpen={onOpen} />
          {c.legacySceneEstimates && (
            <details>
              <summary>历史稿估时依据（保留原场次）</summary>
              <Rich value={c.legacySceneEstimates} />
            </details>
          )}
        </>
      )}
      {tab === "source" && (
        <>
          <p>按原始叙述顺序核对处理方式、保留理由及对应场次。</p>
          {c.sourceNarrationIndex?.slice(offset, offset + 30).map((s: any) => (
            <article className="source-index-row" key={s.id}>
              <small>
                {s.id} · {s.treatment}
              </small>
              <h3>{s.summary}</h3>
              <p>{s.reason}</p>
              <div className="context-links">{links(s.sceneIds)}</div>
            </article>
          ))}
          <div className="pager">
            <button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 30))}
            >
              上一页
            </button>
            <span>
              {offset + 1}–
              {Math.min(offset + 30, c.sourceNarrationIndex?.length || 0)} /{" "}
              {c.sourceNarrationIndex?.length || 0}
            </span>
            <button
              disabled={offset + 30 >= (c.sourceNarrationIndex?.length || 0)}
              onClick={() => setOffset(offset + 30)}
            >
              下一页
            </button>
          </div>
        </>
      )}
      {tab === "notes" && (
        <Rich
          value={{
            changeSummary: c.changeSummary,
            runtimeMethod: c.runtimeMethod,
          }}
        />
      )}
    </section>
  );
}
function RuntimeTable({ onOpen }: { onOpen: Open }) {
  const [data, setData] = useState<any>(null),
    [owner, setOwner] = useSession("runtime-table-episode", ""),
    [episodes, setEpisodes] = useState<any[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    read("objects?kind=EPISODE&limit=200")
      .then((r) => setEpisodes(r.items))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let active = true;
    setData(null);
    read(
      "objects?kind=SCENE&limit=200" +
        (owner ? "&owner=" + encodeURIComponent(owner) : ""),
    )
      .then((r) => active && setData(r))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [owner]);
  return (
    <>
      <select
        aria-label="估时分集"
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
      >
        <option value="">全部分集</option>
        {episodes.map((e) => (
          <option key={e.id} value={e.id}>
            {e.displayId} · {e.title}
          </option>
        ))}
      </select>
      {error && <p role="alert">{error}</p>}
      <table className="runtime-table">
        <thead>
          <tr>
            <th>场次</th>
            <th>叙事任务</th>
            <th>基准时长</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((s: any) => (
            <tr key={s.id}>
              <td>
                <button onClick={() => onOpen(s.id)}>
                  {s.displayId} · {s.title}
                </button>
              </td>
              <td>{s.preview?.description}</td>
              <td>
                {s.preview?.seconds == null
                  ? "未估时"
                  : s.preview.seconds + " 秒"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.nextOffset !== null && data?.nextOffset !== undefined && (
        <p>当前显示前 200 场，请按分集筛选。</p>
      )}
    </>
  );
}
function MaterialCard({ detail, onOpen }: { detail: Detail; onOpen: Open }) {
  const c = detail.revision.content;
  return (
    <section className="material-information-card">
      <div className="material-card-heading">
        <span>
          {c.businessCategoryPrimaryName || c.category || c.kind || "素材"}
        </span>
        <span>{c.businessCategorySecondaryName || ""}</span>
      </div>
      <section>
        <h3>为什么需要</h3>
        <Rich
          value={
            c.storyBasis || { reason: c.reason, description: c.description }
          }
        />
        {!c.storyBasis && !c.reason && !c.description && (
          <p className="muted">此条尚未记录需求理由，可从关联素材需求核对。</p>
        )}
      </section>
      <section>
        <h3>用途与使用位置</h3>
        <Rich
          value={{
            purposeNote: c.purposeNote,
            scope: c.scope,
            domainContext: c.domainContext,
          }}
        />
        <div className="context-links">
          {detail.links
            .filter((l) =>
              ["ENTITY", "SCENE", "EPISODE", "REQUIREMENT"].includes(l.kind),
            )
            .map((l) => (
              <button key={l.id} onClick={() => onOpen(l.id)}>
                <small>{kindLabels[l.kind]}</small>
                {l.title}
              </button>
            ))}
        </div>
      </section>
      <details>
        <summary>全部生产资料与登记信息</summary>
        <Content detail={detail} onOpen={onOpen} />
      </details>
    </section>
  );
}

export function RelationshipCanvas({
  onOpen,
  owner = "",
}: {
  onOpen: Open;
  owner?: string;
}) {
  const [result, setResult] = useState<any>(null),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    read(
      "relationships?offset=" +
        offset +
        (owner ? "&owner=" + encodeURIComponent(owner) : ""),
    )
      .then((r) => active && setResult(r))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [owner, offset]);
  const rows = result?.items || [];
  const nodes = useMemo(
    () =>
      Array.from(
        new Map<string, CanvasNode>(
          rows.flatMap(
            (r: any) =>
              [
                [
                  r.fromId,
                  {
                    id: r.fromId,
                    label: r.fromTitle,
                    group: "关联主体",
                    icon: "object",
                  },
                ],
                [
                  r.toId,
                  {
                    id: r.toId,
                    label: r.toTitle,
                    group: "关联主体",
                    icon: "object",
                  },
                ],
              ] as Array<[string, CanvasNode]>,
          ),
        ).values(),
      ),
    [result],
  );
  const edges = useMemo(
    () =>
      rows.map((r: any) => ({
        id: r.id,
        from: r.fromId,
        to: r.toId,
        label: r.content.label || r.title,
        directed: true,
        uncertain: r.content.status !== "CONFIRMED",
      })),
    [result],
  );
  return (
    <section className="relation-workspace">
      {error && <p role="alert">{error}</p>}
      <RelationshipBoard
        nodes={nodes}
        edges={edges}
        selectedId={selected}
        onSelect={setSelected}
        onSelectEdge={onOpen}
        onOpenNode={onOpen}
        label="实体关系全景"
        viewportKey={"settings-relations:" + owner + ":" + offset}
        height={480}
      />
      <div className="pager">
        <button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          上一页关系
        </button>
        <button
          disabled={result?.nextOffset == null}
          onClick={() => setOffset(result.nextOffset)}
        >
          下一页关系
        </button>
        {selected && (
          <button onClick={() => onOpen(selected)}>打开选中主体</button>
        )}
      </div>
    </section>
  );
}
