"use client";
import { useEffect, useRef, useState } from "react";
import { read, commands, cache, invalidateReads, uploadMedia } from "./client";
import { Assistant } from "./assistant";
import { Content } from "./content";
import {
  WorkspaceTabs,
  FacetFilters,
  EpisodeNavigator,
  CatalogItem,
  type View,
} from "./workspace-navigation";
import { DomainReading, RelationshipCanvas } from "./domain-reading";
import { ReviewContext, Comments } from "./review-context";
import { CurrentWork, GlobalSearch } from "./current-work";
import { configureLayoutStorage } from "./layout-storage";
import { StorySpaceSettings } from "./spatial-baseline";
import { ConfigurationWorkspace } from "./configuration-workspace";
import { SourceText } from "./source-text";
import { RuntimeOperations } from "./runtime-operations";
import { MaintenancePanel } from "./maintenance-panel";
import { ProductionPanel, RightsPanel } from "./production-panel";
import { ConfigEditor } from "./config-editor";
import { Editor } from "./editor";
import { useSession, readingPositions, rememberPosition } from "./session";
import { LinkPicker } from "./link-picker";
import {
  stateLabels,
  kindLabels,
  type Detail,
  type Summary,
  type Draft,
} from "./types";

const workspaces = [
  {
    id: "overview",
    label: "当前工作",
    mark: "当前",
    note: "全剧状态与当下可开展工作",
  },
  {
    id: "story",
    label: "故事创作",
    mark: "故事",
    note: "来源资料、故事结构与叙事拆解",
  },
  {
    id: "settings",
    label: "故事设定",
    mark: "设定",
    note: "主体分类、空间设定与实体关系",
  },
  {
    id: "materials",
    label: "素材管理",
    mark: "素材",
    note: "实体素材目录、集场筛选与素材信息卡",
  },
  {
    id: "production",
    label: "全剧制作",
    mark: "制作",
    note: "镜头制作、场景剪辑与分集成片",
  },
  {
    id: "project",
    label: "系统管理",
    mark: "管理",
    note: "使用与初始化、系统配置、数据与运行",
  },
];
const tabs: Record<string, string[]> = {
  story: ["SOURCE", "STORY", "EPISODE", "SCENE"],
  settings: ["ENTITY", "RELATION", "SPACE", "STATE", "REPRESENTATION"],
  materials: [
    "MATERIAL",
    "REQUIREMENT",
    "ASSET",
    "PROMPT",
    "CALL",
    "EXPECTED_OUTPUT",
  ],
  production: [
    "PREPARATION",
    "COVERAGE",
    "SHOT_DESIGN",
    "SHOT",
    "INPUT_LOCK",
    "ASSEMBLY",
    "DELIVERABLE",
  ],
  project: ["GUIDANCE", "NOTE", "COMMENT"],
};
const fresh = (module: string): View => ({
  kind: tabs[module]?.[0] || "",
  id: "",
  query: "",
  offset: 0,
  owner: "",
  historical: false,
  ...(module === "materials" ? { lane: "BASE" } : {}),
});
const blankContent = (kind: string) =>
  kind === "SCENE"
    ? { text: "" }
    : kind === "COMMENT" || kind === "GUIDANCE" || kind === "PROMPT"
      ? { text: "" }
      : { description: "" };
function OperationError({ error }: { error: any }) {
  return error ? (
    <div className="error" role="alert">
      {error.message || String(error)}
      {error.operationId && <small>操作编号：{error.operationId}</small>}
    </div>
  ) : null;
}

export default function Desk() {
  const [workspace, setWorkspace] = useState("overview"),
    [views, setViews] = useState<Record<string, View>>({}),
    [title, setTitle] = useState("故事审阅台"),
    [ready, setReady] = useState(false),
    [summary, setSummary] = useState<any>(null),
    [error, setError] = useState<any>(null),
    [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [systemTab, setSystemTab] = useSession("system-tab", "start");
  const viewsRef = useRef<Record<string, View>>({});
  const navigationSequence = useRef(0);
  const [returnTo, setReturnTo] = useState<{
    workspace: string;
    view: View;
    systemTab: string;
  } | null>(null);
  function rememberViews(next: Record<string, View>) {
    viewsRef.current = next;
    setViews(next);
    try {
      sessionStorage.setItem("review-workspace-views", JSON.stringify(next));
    } catch {}
  }
  function locate(w: string, v: View, push = false) {
    const u = new URL(location.href);
    u.search = "";
    if (w !== "overview") u.searchParams.set("view", w);
    for (const [key, value] of Object.entries(v))
      if (value !== undefined && value !== "" && value !== false && value !== 0)
        u.searchParams.set(key, String(value));
    if (push) history.pushState({}, "", u);
    else history.replaceState({}, "", u);
  }
  useEffect(() => {
    try {
      rememberViews(
        JSON.parse(sessionStorage.getItem("review-workspace-views") || "{}"),
      );
    } catch {}
    const url = new URL(location.href);
    const view = url.searchParams.get("view");
    if (view && workspaces.some((x) => x.id === view)) setWorkspace(view);
    try {
      const saved = JSON.parse(
        sessionStorage.getItem("review-unsaved") || "{}",
      );
      setDrafts(saved);
    } catch {}
    read("work")
      .then((value) => {
        setTitle(value.project?.title || "故事审阅台");
        configureLayoutStorage(value.project.instanceId);
        setSummary(value);
        setReady(true);
      })
      .catch(setError);
    const back = () => {
      const u = new URL(location.href),
        requested = u.searchParams.get("view") || "overview";
      const w = workspaces.some((x) => x.id === requested)
        ? requested
        : "overview";
      navigationSequence.current++;
      setWorkspace(w);
      const next: View = { ...fresh(w) };
      for (const key of [
        "kind",
        "id",
        "query",
        "owner",
        "revisionId",
        "category",
        "mediaType",
        "entity",
        "lane",
        "phase",
        "gate",
      ])
        if (u.searchParams.has(key))
          (next as any)[key] = u.searchParams.get(key) || "";
      next.offset = Math.max(0, Number(u.searchParams.get("offset") || 0)) || 0;
      next.historical = u.searchParams.get("historical") === "true";
      rememberViews({ ...viewsRef.current, [w]: next });
    };
    back();
    const changed = () =>
      void read("work", { refresh: true })
        .then((value) => {
          setTitle(value.project.title);
          setSummary(value);
        })
        .catch(setError);
    window.addEventListener("review:changed", changed);
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("popstate", back);
      window.removeEventListener("review:changed", changed);
    };
  }, []);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (Object.keys(drafts).length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [drafts]);
  function updateDraft(id: string, draft: Draft | null) {
    setDrafts((old) => {
      const next = { ...old };
      if (draft) next[id] = draft;
      else delete next[id];
      try {
        sessionStorage.setItem("review-unsaved", JSON.stringify(next));
      } catch {
        setError(Error("浏览器草稿存储已满；当前草稿仍保留在页面，请先保存。"));
      }
      return next;
    });
  }
  function navigate(w: string, kind?: string) {
    navigationSequence.current++;
    if (kind)
      rememberViews({ ...viewsRef.current, [w]: { ...fresh(w), kind } });
    setWorkspace(w);
    locate(w, viewsRef.current[w] || fresh(w), true);
  }
  function updateView(value: Partial<View>) {
    navigationSequence.current++;
    const before = viewsRef.current[workspace] || fresh(workspace);
    const next = { ...before, ...value };
    if (
      value.id !== undefined &&
      value.id !== before.id &&
      value.revisionId === undefined
    )
      next.revisionId = undefined;
    rememberViews({ ...viewsRef.current, [workspace]: next });
    locate(workspace, next);
  }
  async function open(id: string, revisionId?: string) {
    const seq = ++navigationSequence.current;
    try {
      const object: Detail = await read("objects/" + encodeURIComponent(id));
      if (seq !== navigationSequence.current) return;
      setReturnTo({
        workspace,
        view: viewsRef.current[workspace] || fresh(workspace),
        systemTab,
      });
      const module =
        object.module === "collaboration" ? "project" : object.module;
      rememberViews({
        ...viewsRef.current,
        [module]: {
          ...(viewsRef.current[module] || fresh(module)),
          kind: object.kind,
          id,
          offset: 0,
          historical: object.historical,
          revisionId,
          owner: "",
          query: "",
          category: "",
          mediaType: "",
          lane: "",
          gate: "",
        },
      });
      setWorkspace(module);
      if (module === "project") setSystemTab("records");
      const u = new URL(location.href);
      u.search = new URLSearchParams({
        view: module,
        kind: object.kind,
        id,
        ...(revisionId ? { revisionId } : {}),
      }).toString();
      history.pushState({}, "", u);
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="desk">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <span>阅</span>
          <div>
            <b>{title}</b>
            <small>LOCAL PRODUCTION DESK</small>
          </div>
        </a>
        <nav className="workspace-nav" aria-label="工作区">
          {workspaces.map((w) => (
            <button
              key={w.id}
              aria-current={workspace === w.id ? "page" : undefined}
              onClick={() => navigate(w.id)}
            >
              <span>{w.mark}</span>
              <div>
                <strong>{w.label}</strong>
                <small>{w.note}</small>
              </div>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="online-dot" /> 单故事工作空间
          {Object.keys(drafts).length > 0 && (
            <button onClick={() => void open(Object.keys(drafts)[0])}>
              {Object.keys(drafts).length} 份未保存内容
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        <header className="page-heading">
          <div>
            <p>{title} · 创作工作空间</p>
            <h1>{workspaces.find((w) => w.id === workspace)?.label}</h1>
          </div>
          <GlobalSearch onOpen={open} />
        </header>
        {returnTo && (
          <div className="source-return">
            <button
              onClick={() => {
                navigationSequence.current++;
                rememberViews({
                  ...viewsRef.current,
                  [returnTo.workspace]: returnTo.view,
                });
                setWorkspace(returnTo.workspace);
                setSystemTab(returnTo.systemTab);
                locate(returnTo.workspace, returnTo.view, true);
                setReturnTo(null);
              }}
            >
              ← 返回{workspaces.find((w) => w.id === returnTo.workspace)?.label}
            </button>
            <span>恢复来源处的筛选与阅读位置</span>
          </div>
        )}
        <OperationError error={error} />
        {!ready && !error ? (
          <div className="loading" role="status">
            正在读取项目…
          </div>
        ) : workspace === "overview" ? (
          <CurrentWork summary={summary} onOpen={open} onNavigate={navigate} />
        ) : (
          <>
            {workspace === "project" && (
              <div className="tabs">
                {[
                  ["start", "使用与初始化"],
                  ["config", "系统配置"],
                  ["records", "项目指引与候选"],
                  ["runtime", "数据与运行"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    aria-pressed={systemTab === id}
                    onClick={() => setSystemTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {workspace === "project" && systemTab !== "records" ? (
              <SystemPanel
                tab={systemTab}
                onNavigate={(m) => navigate(m, "SOURCE")}
                onConfigure={() => setSystemTab("config")}
              />
            ) : (
              <Workbench
                module={workspace}
                value={views[workspace] || fresh(workspace)}
                onChange={updateView}
                onOpen={open}
                drafts={drafts}
                onDraft={updateDraft}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
function Workbench({
  module,
  value,
  onChange,
  onOpen,
  drafts,
  onDraft,
}: {
  module: string;
  value: View;
  onChange: (value: Partial<View>) => void;
  onOpen: (id: string, revisionId?: string) => void;
  drafts: Record<string, Draft>;
  onDraft: (id: string, draft: Draft | null) => void;
}) {
  const [loadedCatalog, setCatalog] = useState<{
      key: string;
      items: Summary[];
      total: number;
      nextOffset: number | null;
    } | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [context, setContext] = useState<any>(null),
    [error, setError] = useState<any>(null),
    [attempt, setAttempt] = useState(0),
    [creating, setCreating] = useState<{ module: string; kind: string } | null>(
      null,
    ),
    [newTitle, setNewTitle] = useState(""),
    [newSourceText, setNewSourceText] = useState(""),
    [sourceRole, setSourceRole] = useState("PRIMARY"),
    [busy, setBusy] = useState(false),
    [newLinks, setNewLinks] = useState<any[]>([]),
    [file, setFile] = useState<File | null>(null),
    [episodes, setEpisodes] = useState<Summary[]>([]);
  const listRef = useRef<HTMLDivElement>(null),
    detailRef = useRef<HTMLDivElement>(null);
  const catalogKey = new URLSearchParams({
    kind: value.kind,
    query: value.query,
    offset: String(value.offset),
    limit: "50",
    historical: String(value.historical),
    ...(value.owner ? { owner: value.owner } : {}),
    ...Object.fromEntries(
      ["category", "mediaType", "entity", "lane", "gate"]
        .filter((k) => !!(value as any)[k])
        .map((k) => [k, (value as any)[k]]),
    ),
  }).toString();
  // Effects from a render that changed the query still see its previous state.
  // Only the catalog for this exact query may choose or display an object.
  const catalog = loadedCatalog?.key === catalogKey ? loadedCatalog : null;
  useEffect(() => {
    let active = true;
    const position = readingPositions.get("catalog:" + catalogKey) || 0;
    setCatalog((old) => (old?.key === catalogKey ? old : null));
    setError(null);
    read("objects?" + catalogKey)
      .then((rows) => {
        if (active) {
          setCatalog({ ...rows, key: catalogKey });
          requestAnimationFrame(() => {
            if (listRef.current) listRef.current.scrollTop = position;
          });
        }
      })
      .catch((e) => active && setError(e));
    return () => {
      active = false;
    };
  }, [catalogKey, attempt]);
  useEffect(() => {
    if (!catalog) return;
    if (!value.id && catalog.items[0]) onChange({ id: catalog.items[0].id });
  }, [catalog, value.id]);
  useEffect(() => {
    let active = true;
    const id = value.id;
    const position = readingPositions.get("detail:" + id) || 0;
    setDetail((old) => (old?.id === id ? old : null));
    if (id)
      read<any>("contexts/" + encodeURIComponent(id))
        .then((d) => {
          if (active) {
            setDetail(d.object);
            setContext(d);
            requestAnimationFrame(() => {
              if (detailRef.current) detailRef.current.scrollTop = position;
            });
          }
        })
        .catch((e) => active && setError(e));
    return () => {
      active = false;
    };
  }, [value.id, attempt]);
  useEffect(() => {
    if (
      [
        "EPISODE",
        "SCENE",
        "MATERIAL",
        "ASSET",
        "REQUIREMENT",
        "PREPARATION",
        "COVERAGE",
        "SHOT_DESIGN",
        "SHOT",
        "INPUT_LOCK",
      ].includes(value.kind)
    )
      read("objects?kind=EPISODE&limit=200")
        .then((r) => setEpisodes(r.items))
        .catch(() => {});
  }, [value.kind]);
  useEffect(() => {
    if (
      module === "story" &&
      value.kind === "SCENE" &&
      !value.owner &&
      context?.objectId === value.id
    ) {
      const episode = context.primary.find((p: Detail) => p.kind === "EPISODE");
      if (episode) onChange({ owner: episode.id, offset: 0 });
    }
  }, [context?.objectId, value.owner, value.kind, module]);
  const refresh = () => {
    invalidateReads();
    setAttempt((x) => x + 1);
  };
  async function create() {
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      const media =
        ["ASSET", "SOURCE"].includes(value.kind) && file
          ? [await uploadMedia(file)]
          : [];
      if (value.kind === "ASSET" && !media.length)
        throw Error("请先选择此素材版本的实际文件");
      if (value.kind === "SOURCE" && !file && !newSourceText.trim())
        throw Error("请填写来源正文或选择原始文件");
      await commands([
        {
          type: "save",
          id,
          kind: value.kind,
          title: newTitle,
          content: {
            ...blankContent(value.kind),
            ...(value.kind === "SOURCE"
              ? {
                  text: newSourceText,
                  sourceRole,
                  authority: sourceRole === "PRIMARY" ? "F" : "A",
                  observation: file ? "ORIGINAL_UNOBSERVED" : "TEXT_REGISTERED",
                }
              : {}),
            ...(file ? { mediaType: file.type.split("/")[0] } : {}),
          },
          expectedVersion: 0,
          links: newLinks,
          media,
        },
      ]);
      setNewLinks([]);
      setFile(null);
      setCreating(null);
      setNewTitle("");
      setNewSourceText("");
      onChange({ id, offset: 0, query: "" });
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="workbench"
      data-ready={catalog ? "workspace" : undefined}
      data-module={module}
      data-kind={value.kind}
      data-catalog-key={catalog?.key}
    >
      <WorkspaceTabs module={module} value={value} onChange={onChange} />
      <div className="workspace-toolbar">
        {["settings", "materials"].includes(module) && (
          <FacetFilters value={value} onChange={onChange} />
        )}
        <label className="search">
          <span>⌕</span>
          <input
            aria-label="搜索对象"
            placeholder="搜索当前目录"
            value={value.query}
            onChange={(e) =>
              onChange({ query: e.target.value, offset: 0, id: "" })
            }
          />
        </label>
        {episodes.length > 0 &&
          [
            "EPISODE",
            "SCENE",
            "MATERIAL",
            "ASSET",
            "REQUIREMENT",
            "PREPARATION",
            "COVERAGE",
            "SHOT_DESIGN",
            "SHOT",
            "INPUT_LOCK",
          ].includes(value.kind) && (
            <select
              aria-label="分集筛选"
              value={value.owner}
              onChange={(e) =>
                onChange({ owner: e.target.value, id: "", offset: 0 })
              }
            >
              <option value="">全部分集</option>
              {episodes.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.displayId} · {e.title}
                </option>
              ))}
            </select>
          )}
        <label className="check">
          <input
            type="checkbox"
            checked={value.historical}
            onChange={(e) =>
              onChange({ historical: e.target.checked, offset: 0, id: "" })
            }
          />
          包含历史依据
        </label>
        {value.kind !== "COMMENT" && (
          <button
            onClick={() => {
              setNewLinks([]);
              setFile(null);
              setCreating({ module, kind: value.kind });
            }}
          >
            ＋ 新建{kindLabels[value.kind]}
          </button>
        )}
        {value.kind === "COMMENT" && (
          <span className="muted">在所属正文中圈选或添加评论</span>
        )}
      </div>
      <OperationError error={error} />
      {error && <button onClick={refresh}>重新读取</button>}
      {creating?.module === module && creating.kind === value.kind && (
        <div className="new-form">
          <label>
            {value.kind === "SOURCE"
              ? "登记来源资料"
              : "新建" + kindLabels[value.kind]}
            <input
              aria-label="新对象标题"
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </label>
          {["ASSET", "RELATION"].includes(value.kind) && (
            <>
              <p>
                {newLinks.map((l) => (
                  <span key={l.id}>
                    {l.title}{" "}
                    <button
                      onClick={() =>
                        setNewLinks(newLinks.filter((x) => x.id !== l.id))
                      }
                    >
                      移除
                    </button>
                  </span>
                ))}
              </p>
              <LinkPicker
                kind={value.kind === "ASSET" ? "MATERIAL" : "ENTITY"}
                label={
                  value.kind === "ASSET"
                    ? "选择所属素材族"
                    : "选择关系端点（两个主体）"
                }
                onChoose={(item) => {
                  if (!newLinks.some((l) => l.id === item.id))
                    setNewLinks(
                      value.kind === "ASSET"
                        ? [{ ...item, role: "FAMILY" }]
                        : [...newLinks.slice(-1), { ...item, role: "ENTITY" }],
                    );
                }}
              />
            </>
          )}
          {value.kind === "SOURCE" && (
            <>
              <label>
                资料角色
                <select
                  value={sourceRole}
                  onChange={(e) => setSourceRole(e.target.value)}
                >
                  <option value="PRIMARY">原始依据</option>
                  <option value="DERIVED">派生整理</option>
                  <option value="AUXILIARY">辅助资料</option>
                </select>
              </label>
              <label>
                来源正文
                <textarea
                  aria-label="来源正文"
                  rows={5}
                  value={newSourceText}
                  onChange={(e) => setNewSourceText(e.target.value)}
                />
              </label>
              <p>
                原始文件与可读取文字分别登记。上传不表示已实际观察或已采用故事。
              </p>
            </>
          )}
          {["ASSET", "SOURCE"].includes(value.kind) && (
            <label>
              实际媒体文件
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
          )}
          <button disabled={busy || !newTitle.trim()} onClick={create}>
            创建草稿
          </button>
          <button onClick={() => setCreating(null)}>取消</button>
        </div>
      )}
      <div
        className={"workspace-columns module-" + module + " kind-" + value.kind}
      >
        <div
          className="catalog"
          ref={listRef}
          onScroll={(e) => {
            if (catalog)
              rememberPosition(
                "catalog:" + catalogKey,
                e.currentTarget.scrollTop,
              );
          }}
        >
          <div className="catalog-heading">
            <span>{kindLabels[value.kind]}</span>
            <small>{catalog?.total ?? "…"} 个</small>
          </div>
          {module === "story" &&
          ["EPISODE", "SCENE"].includes(value.kind) &&
          !value.query &&
          !value.historical ? (
            <EpisodeNavigator
              episodes={episodes}
              value={value}
              onChange={onChange}
            />
          ) : !catalog ? (
            <p className="loading" role="status">
              读取目录…
            </p>
          ) : catalog.items.length ? (
            <div className="catalog-items">
              {catalog.items.map((o) => (
                <CatalogItem
                  key={o.id}
                  object={o}
                  selected={value.id === o.id}
                  unsaved={!!drafts[o.id]}
                  onChoose={() => onChange({ id: o.id })}
                />
              ))}
            </div>
          ) : (
            <p className="empty">此目录还没有内容。</p>
          )}
          <div className="pager">
            <button
              disabled={!value.offset}
              onClick={() =>
                onChange({ offset: Math.max(0, value.offset - 50) })
              }
            >
              上一页
            </button>
            <button
              disabled={!catalog?.nextOffset}
              onClick={() => onChange({ offset: catalog!.nextOffset! })}
            >
              下一页
            </button>
          </div>
        </div>
        <div
          className="detail-scroll"
          ref={detailRef}
          onScroll={(e) => {
            if (catalog && detail?.id === value.id)
              rememberPosition("detail:" + value.id, e.currentTarget.scrollTop);
          }}
        >
          {catalog &&
          detail &&
          detail.id === value.id &&
          detail.kind === value.kind ? (
            <ObjectPanel
              key={detail.id}
              detail={detail}
              context={context}
              onContextRefresh={() =>
                void read("contexts/" + encodeURIComponent(detail.id), {
                  refresh: true,
                })
                  .then((c) =>
                    setContext((old: any) =>
                      old?.objectId === c.objectId ? c : old,
                    ),
                  )
                  .catch(setError)
              }
              requestedRevision={value.revisionId}
              draft={drafts[detail.id]}
              onDraft={(d) => onDraft(detail.id, d)}
              onRefresh={refresh}
              onOpen={onOpen}
            />
          ) : (
            <div className="empty">
              {value.id
                ? "正在读取此版本…"
                : "从左侧选择一个对象，或创建新草稿。"}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
function ObjectPanel({
  requestedRevision,
  detail,
  context,
  onContextRefresh,
  draft,
  onDraft,
  onRefresh,
  onOpen,
}: {
  detail: Detail;
  context: any;
  onContextRefresh: () => void;
  requestedRevision?: string;
  draft?: Draft;
  onDraft: (d: Draft | null) => void;
  onRefresh: () => void;
  onOpen: (id: string, revisionId?: string) => void;
}) {
  const [editing, setEditing] = useState(Boolean(draft)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<any>(null),
    [message, setMessage] = useState(""),
    [revision, setRevision] = useState(requestedRevision || ""),
    [historic, setHistoric] = useState<Detail | null>(null),
    [historicContext, setHistoricContext] = useState<any>(null),
    [anchor, setAnchor] = useSession<any>(
      "comment-anchor:" + detail.revision.id,
      null,
    ),
    [assistant, setAssistant] = useState(false),
    [source, setSource] = useState<any>(null);
  const [sourceOffset, setSourceOffset] = useSession(
    "source-offset:" + (historic || detail).revision.id,
    0,
  );
  const revisionSequence = useRef(0);
  useEffect(() => {
    setRevision(requestedRevision || "");
    setHistoric(null);
    setSource(null);
    if (requestedRevision && requestedRevision !== detail.revision.id)
      void chooseRevision(requestedRevision);
  }, [detail.revision.id, requestedRevision]);
  const shown = historic || detail;
  const shownContext = historic ? historicContext : context;
  useEffect(() => {
    let active = true;
    if (shown.kind === "SOURCE" && shown.revision.content.originalRevisionId)
      read(
        "source/" +
          encodeURIComponent(shown.revision.id) +
          "?offset=" +
          sourceOffset,
      )
        .then(
          (s) => active && setSource({ ...s, revisionId: shown.revision.id }),
        )
        .catch((e) => active && setError(e));
    return () => {
      active = false;
    };
  }, [shown.revision.id, sourceOffset]);
  const currentDraft = draft || {
    title: detail.title,
    content: detail.revision.content,
    basedOnVersion: detail.version,
  };
  async function perform(command: any) {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const receipt = await commands([command]);
      const saved = await read<Detail>(
        "objects/" + encodeURIComponent(detail.id),
        { refresh: true },
      );
      if (saved.version !== receipt.results[0].version)
        throw Error("保存后对象再次改变；请读取最新版本，原操作回执已保留");
      setMessage("已保存并核对回读");
      onDraft(null);
      setEditing(false);
      onRefresh();
      return receipt;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function chooseRevision(id: string) {
    const sequence = ++revisionSequence.current;
    setRevision(id === detail.revision.id ? "" : id);
    setSource(null);
    if (id === detail.revision.id) {
      setHistoric(null);
      return;
    }
    try {
      const selected = await read(
        "contexts/" +
          encodeURIComponent(detail.id) +
          "?revisionId=" +
          encodeURIComponent(id),
      );
      if (sequence !== revisionSequence.current) return;
      setHistoric(selected.object);
      setHistoricContext(selected);
    } catch (e) {
      setError(e);
    }
  }
  function loadSource(offset = 0) {
    setSourceOffset(offset);
  }

  if (
    revision &&
    revision !== detail.revision.id &&
    historic?.revision.id !== revision
  )
    return <p role="status">正在读取所选修订…</p>;
  return (
    <article
      className="object-panel"
      data-ready={
        shown.kind === "SOURCE" &&
        shown.revision.content.originalRevisionId &&
        (!source ||
          source.revisionId !== shown.revision.id ||
          source.offset !== sourceOffset)
          ? undefined
          : "detail"
      }
      data-object-id={shown.id}
      data-object-kind={shown.kind}
      data-object-version={shown.version}
      onMouseUp={() => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0),
          element =
            range.startContainer.nodeType === 1
              ? (range.startContainer as Element)
              : range.startContainer.parentElement,
          end =
            range.endContainer.nodeType === 1
              ? (range.endContainer as Element)
              : range.endContainer.parentElement;
        const body = element?.closest("[data-content-object]");
        if (
          body?.getAttribute("data-content-object") !== shown.id ||
          body.getAttribute("data-content-revision") !== shown.revision.id
        )
          return;
        const block = element?.closest("[data-block-id]"),
          field = element?.closest("[data-content-path]"),
          quote = selection.toString();
        if (
          block &&
          block.contains(end) &&
          (
            shown.revision.content.blocks || shown.revision.content.scriptBlocks
          )?.some(
            (b: any) =>
              b.id === block.getAttribute("data-block-id") &&
              b.text.includes(quote),
          )
        )
          setAnchor({ blockId: block.getAttribute("data-block-id"), quote });
        else if (field && field.contains(end)) {
          try {
            const path = JSON.parse(
              field.getAttribute("data-content-path") || "[]",
            );
            const text = path.reduce(
              (v: any, k: string) =>
                v && Object.hasOwn(v, k) ? v[k] : undefined,
              shown.revision.content,
            );
            if (typeof text === "string" && text.includes(quote))
              setAnchor({ path, quote });
          } catch {}
        }
      }}
    >
      <header className="object-heading">
        <div>
          <p>
            {kindLabels[shown.kind]}{" "}
            {shown.displayId && " / " + shown.displayId}
          </p>
          <h2>{shown.title}</h2>
        </div>
        <span className={"pill state-" + shown.state}>
          {stateLabels[shown.state]}
        </span>
      </header>
      <div className="object-actions">
        <select
          aria-label="查看版本"
          value={revision || detail.revision.id}
          onChange={(e) => void chooseRevision(e.target.value)}
        >
          {!detail.versions.some((v) => v.id === revision) && historic && (
            <option value={revision}>修订 {historic.revision.number}</option>
          )}
          {detail.versions.map((v) => (
            <option value={v.id} key={v.id}>
              修订 {v.number}
              {v.id === detail.adoptedRevisionId ? " · 已采用" : ""}
              {v.id === detail.draftRevisionId ? " · 当前稿" : ""}
            </option>
          ))}
        </select>
        {!historic && !["ASSET", "SOURCE"].includes(detail.kind) && (
          <button onClick={() => setEditing(!editing)} disabled={busy}>
            {editing ? "返回阅读" : "编辑内容"}
          </button>
        )}
        <button
          onClick={() => setAssistant(!assistant)}
          aria-pressed={assistant}
        >
          AI 辅助
        </button>
        {draft && <span className="unsaved">有未保存修改</span>}
      </div>
      <OperationError error={error} />
      {error && (
        <button onClick={onRefresh}>读取最新版本（保留未保存修改）</button>
      )}
      {draft && draft.basedOnVersion !== detail.version && (
        <p className="notice">
          你的修改基于版本 {draft.basedOnVersion}；当前版本已变为{" "}
          {detail.version}。本地修改仍保留，请先核对最新内容再整理修改。
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      {shown.invalidations.length > 0 && (
        <p className="notice">
          本版本引用的依据已改变。请核对受影响内容后保存新修订。
        </p>
      )}
      {editing && !historic ? (
        <>
          <Editor detail={detail} draft={currentDraft} onChange={onDraft} />
          <div className="save-bar">
            <button
              className="primary"
              disabled={busy || !draft}
              onClick={() =>
                perform({
                  type: "save",
                  id: detail.id,
                  expectedVersion: currentDraft.basedOnVersion,
                  title: currentDraft.title,
                  content: currentDraft.content,
                  ...(currentDraft.links ? { links: currentDraft.links } : {}),
                  ...(currentDraft.dependencies
                    ? { dependencies: currentDraft.dependencies }
                    : {}),
                })
              }
            >
              保存草稿
            </button>
            <button
              disabled={busy}
              onClick={() => {
                onDraft(null);
                setEditing(false);
              }}
            >
              放弃本次修改
            </button>
          </div>
        </>
      ) : (
        <>
          <ReviewContext
            detail={shown}
            context={shownContext}
            onOpen={onOpen}
          />
          {shown.kind === "RELATION" && <RelationshipCanvas onOpen={onOpen} />}
          {shown.kind === "SPACE" && <StorySpaceSettings />}
          <DomainReading detail={shown} onOpen={onOpen} />
          {shown.kind === "SOURCE" &&
            shown.revision.content.originalRevisionId && (
              <section className="source-reader">
                <button onClick={() => void loadSource()}>
                  读取原始资料正文
                </button>
                {source &&
                source.revisionId === shown.revision.id &&
                source.offset === sourceOffset ? (
                  <>
                    <SourceText text={source.text} />
                    <div className="pager">
                      <button
                        disabled={!source.offset}
                        onClick={() =>
                          void loadSource(Math.max(0, source.offset - 16000))
                        }
                      >
                        上一段
                      </button>
                      <span>
                        {source.offset + 1}–{source.offset + source.text.length}{" "}
                        / {source.total}
                      </span>
                      <button
                        disabled={source.nextOffset === null}
                        onClick={() => void loadSource(source.nextOffset)}
                      >
                        下一段
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="source-loading" role="status">
                    正在读取此修订的来源正文…
                  </p>
                )}
              </section>
            )}
        </>
      )}
      {!historic && !editing && (
        <>
          <div className="submit-bar">
            {["DRAFT", "CHANGES_REQUESTED"].includes(detail.state) && (
              <button
                className="primary"
                disabled={busy || Boolean(draft)}
                onClick={() =>
                  perform({
                    type: "submit",
                    id: detail.id,
                    expectedVersion: detail.version,
                    revisionId: detail.revision.id,
                  })
                }
              >
                提交审阅
              </button>
            )}
            <span>
              {detail.adoptedRevisionId &&
              detail.adoptedRevisionId !== detail.revision.id
                ? "已采用版本继续保留，当前稿尚未采用。"
                : detail.state === "ADOPTED"
                  ? "此修订已采用。"
                  : "保存和提交均不会自动采用。"}
            </span>
          </div>
          {detail.kind === "ASSET" && (
            <RightsPanel detail={detail} onSave={perform} busy={busy} />
          )}
          {detail.kind === "INPUT_LOCK" && (
            <ProductionPanel detail={detail} onOpen={onOpen} />
          )}
          <ReviewPanel
            detail={detail}
            busy={busy}
            onReview={(command) => perform(command)}
          />
        </>
      )}
      {!historic &&
        !editing &&
        !["COMMENT", "GUIDANCE", "SOURCE"].includes(detail.kind) && (
          <Comments
            detail={shown}
            context={shownContext}
            anchor={anchor}
            onClearAnchor={() => setAnchor(null)}
            onOpen={onOpen}
            onChanged={onContextRefresh}
          />
        )}
      {assistant && (
        <Assistant
          detail={detail}
          onApplied={onRefresh}
          onOpen={onOpen}
          onClose={() => setAssistant(false)}
        />
      )}
      {shown.reviews.length > 0 && (
        <details className="review-history">
          <summary>已有判断 · {shown.reviews.length}</summary>
          {shown.reviews.map((r) => (
            <section key={r.id}>
              <b>
                {{
                  ADOPT: "采用",
                  REQUEST_CHANGES: "要求修改",
                  DISABLE: "禁止使用",
                }[r.decision] || r.decision}
              </b>
              <p>{r.note}</p>
              {r.findings?.map((f: any, i: number) => (
                <p key={i}>
                  {f.verdict} · {f.note}
                </p>
              ))}
              <small>
                {r.author} ·{" "}
                {new Date(r.created_at).toLocaleDateString("zh-CN")}
              </small>
            </section>
          ))}
        </details>
      )}
    </article>
  );
}
function ReviewPanel({
  detail,
  busy,
  onReview,
}: {
  detail: Detail;
  busy: boolean;
  onReview: (command: any) => void;
}) {
  const [decision, setDecision] = useSession(
      "decision:" + detail.revision.id,
      "",
    ),
    [note, setNote] = useSession("judgment-note:" + detail.revision.id, ""),
    [findings, setFindings] = useSession<
      Record<string, { verdict: string; note: string }>
    >("findings:" + detail.revision.id, {}),
    [attestation, setAttestation] = useSession(
      "attestation:" + detail.revision.id,
      false,
    );
  const criteria =
    detail.revision.content.reviewSpec?.criteria ||
    detail.revision.content.configurationBinding?.reviewSpec?.criteria ||
    [];
  if (!["SUBMITTED", "ADOPTED"].includes(detail.state)) return null;
  return (
    <section className="review-panel">
      <h3>审阅当前修订</h3>
      <p>判断与采用在一次提交中完成，保留所审版本和依据。</p>
      {criteria.map((c: any) => (
        <fieldset key={c.id}>
          <legend>{c.label || c.id}</legend>
          <p>{c.question}</p>
          <div className="choices">
            {[
              ["PASS", "通过"],
              ["FAIL", "需修改"],
              ...(c.allowNA ? [["NA", "不适用"]] : []),
            ].map(([v, label]) => (
              <button
                key={v}
                aria-pressed={findings[c.id]?.verdict === v}
                onClick={() =>
                  setFindings((old) => ({
                    ...old,
                    [c.id]: {
                      verdict: old[c.id]?.verdict === v ? "" : v,
                      note: old[c.id]?.note || "",
                    },
                  }))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <input
            aria-label={(c.label || c.id) + "说明"}
            placeholder="判断依据或修改建议"
            value={findings[c.id]?.note || ""}
            onChange={(e) =>
              setFindings((old) => ({
                ...old,
                [c.id]: {
                  verdict: old[c.id]?.verdict || "",
                  note: e.target.value,
                },
              }))
            }
          />
        </fieldset>
      ))}
      <div className="choices decision">
        {(detail.state === "ADOPTED"
          ? [["DISABLE", "禁止使用"]]
          : [
              ["ADOPT", "采用此修订"],
              ["REQUEST_CHANGES", "要求修改"],
              ["DISABLE", "禁止使用"],
            ]
        ).map(([v, label]) => (
          <button
            key={v}
            aria-pressed={decision === v}
            onClick={() => setDecision(decision === v ? "" : v)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        aria-label="审阅说明"
        placeholder="记录判断依据与必要修改"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {detail.kind === "ASSET" && (
        <label className="check">
          <input
            type="checkbox"
            checked={attestation}
            onChange={(e) => setAttestation(e.target.checked)}
          />
          确认本版本可用于项目内部制作（保留原始权利事实）
        </label>
      )}
      <button
        className="primary"
        disabled={busy || !decision}
        onClick={() =>
          onReview({
            type: "review",
            id: detail.id,
            expectedVersion: detail.version,
            revisionId: detail.revision.id,
            decision,
            explicit: true,
            note,
            findings: Object.entries(findings).map(([criterionId, f]) => ({
              criterionId,
              ...f,
            })),
            internalAttestation: attestation,
          })
        }
      >
        提交判断
      </button>
    </section>
  );
}
function SystemPanel({
  tab,
  onNavigate,
  onConfigure,
}: {
  tab: string;
  onNavigate: (m: string) => void;
  onConfigure: () => void;
}) {
  const [configuration, setConfiguration] = useState<any>(null),
    [health, setHealth] = useState<any>(null),
    [error, setError] = useState<any>(null),
    [title, setTitle] = useState(""),
    [configDraft, setConfigDraft] = useSession<any>("configuration-drafts", {}),
    [configBusy, setConfigBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    read("configurations")
      .then((v) => {
        setConfiguration(v);
        setTitle(
          v.items.find((x: any) => x.scope === "project")?.content.title || "",
        );
      })
      .catch(setError);
    read("health", { refresh: true }).then(setHealth).catch(setError);
  }, []);
  async function save(scope: string) {
    if (configBusy) return;
    setConfigBusy(true);
    setError(null);
    try {
      const c = configuration.items.find((x: any) => x.scope === scope),
        draft = configDraft[scope];
      if (!draft) return;
      await commands([
        {
          type: "configuration.save",
          scope,
          expectedVersion: draft.basedOnVersion,
          content: draft.content,
        },
      ]);
      setConfiguration(await read("configurations", { refresh: true }));
      setConfigDraft((old: any) => {
        const next = { ...old };
        delete next[scope];
        return next;
      });
      setMessage("配置已保存并回读");
    } catch (e) {
      setError(e);
    } finally {
      setConfigBusy(false);
    }
  }
  return (
    <section
      className="system-panel"
      data-ready={configuration ? "workspace" : undefined}
    >
      <OperationError error={error} />
      {message && <p role="status">{message}</p>}
      {tab === "start" ? (
        <div className="management-start">
          <section>
            <span className="eyebrow">开始使用</span>
            <h2>一个故事，一个独立的创作工作空间</h2>
            <p>
              导入来源资料，组织故事与集场，再逐步完成设定、素材准备和全剧制作。人、项目
              Codex 与网页助手共用同一份业务状态。
            </p>
            <div className="management-readiness">
              <div>
                <small>实例规则</small>
                <b>{configuration?.items?.length ? "已登记" : "待配置"}</b>
              </div>
              <div>
                <small>业务存储</small>
                <b>{health ? "PostgreSQL" : "读取中"}</b>
              </div>
              <div>
                <small>后台工作器</small>
                <b>{health?.worker ? "已连接" : "未连接"}</b>
              </div>
            </div>
            <button className="primary" onClick={onConfigure}>
              核对系统配置与审阅标准 →
            </button>
            <button onClick={() => onNavigate("story")}>
              打开故事来源资料
            </button>
          </section>
          <section>
            <h2>人与 AI 如何协作</h2>
            <p>
              在正文中圈选、评论，并请助手优化意见。助手建议先预览，再应用为草稿；提交审阅和确认采用各有明确动作。
            </p>
            <p>
              项目目录中的 Codex 通过 review
              命令读取、修改与查询结果。系统能力不足时先升级软件，不直接修改业务数据库。
            </p>
          </section>
          <details>
            <summary>为下一部故事建立独立项目</summary>
            <pre>
              node review-software/tools/project.mjs create /新项目目录 --source
              /核心仓库目录 --title 故事名
            </pre>
          </details>
        </div>
      ) : tab === "config" ? (
        <>
          <ConfigurationWorkspace
            busy={configBusy}
            configuration={configuration}
            drafts={configDraft}
            onChange={(scope, content, version) =>
              setConfigDraft((old: any) => ({
                ...old,
                [scope]: {
                  content,
                  basedOnVersion: old[scope]?.basedOnVersion ?? version,
                },
              }))
            }
            onSave={(scope) => void save(scope)}
          />
        </>
      ) : (
        <>
          <h2>这个故事的数据与运行</h2>
          <dl>
            <dt>软件版本</dt>
            <dd className="mono">{health?.softwareCommit || "读取中"}</dd>
            <dt>数据库版本</dt>
            <dd>{health?.schemaVersion || "读取中"}</dd>
            <dt>后台工作器</dt>
            <dd>
              {health?.worker
                ? new Date(health.worker.updatedAt).toLocaleString()
                : "尚未连接"}
            </dd>
          </dl>
          <a className="button" href="/api/v1/export">
            导出业务数据
          </a>
          <p>
            完整项目包还包含登记媒体。使用项目命令可导出、核验和导入到独立空白审阅台。
          </p>
          <pre>npm run review -- export --output 项目包目录</pre>
          <details>
            <summary>独立恢复与实例核验</summary>
            <p>
              先核验项目包，再导入独立空白项目。恢复不覆盖当前实例，普通项目包不包含凭据和执行资格。
            </p>
            <pre>
              {"npm run review -- verify --file 项目包目录\n" +
                "npm run review -- import --file 项目包目录"}
            </pre>
          </details>
          <button
            onClick={() =>
              void read("health", { refresh: true })
                .then(setHealth)
                .catch(setError)
            }
          >
            刷新运行状态
          </button>
          <RuntimeOperations />
          <MaintenancePanel />
        </>
      )}
    </section>
  );
}
