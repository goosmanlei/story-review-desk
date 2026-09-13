"use client";
import { useEffect, useRef, useState } from "react";
import { useInstanceProfile } from "./instance-context";
import { readWorkspaceJson, workspaceCacheScope } from "./workspace-read-cache";
import { runtimePath } from "./runtime-path";
type Summary = {
  id: string;
  title: string;
  kind: string;
  module?: string;
  state?: string;
  version?: number;
  revisionId?: string;
  draftRevisionId?: string;
  adoptedRevisionId?: string;
  purpose?: string;
  role?: string;
  historical?: boolean;
};
type Context = {
  object: Summary & {
    revision: { id: string; sha256: string; number: number };
    versions: Array<{ id: string; number: number }>;
    media: Array<{
      id: string;
      version_id: string;
      sha256: string;
      availability: string;
      mime_type: string;
      role: string;
    }>;
    reviews: Array<{
      id: string;
      revision_id: string;
      decision: string;
      note: string;
    }>;
    rights?: { fact: string; internalAttestation: boolean } | null;
    invalidations: unknown[];
  };
  inputs: Summary[];
  consumers: Summary[];
  related: Summary[];
  relatedTruncated: boolean;
  basis: Array<{ objectId: string; revisionId: string; sha256: string }>;
};
const states: Record<string, string> = {
  DRAFT: "草稿",
  SUBMITTED: "待审",
  ADOPTED: "采用",
  CHANGES_REQUESTED: "要求修改",
  DISABLED: "禁用",
  ARCHIVED: "历史",
  PRESENT: "已登记可用",
  MISSING: "缺失",
  RETIRED: "退役",
  UNKNOWN: "未知",
  CLEAR: "已明确",
  BLOCKED: "阻断",
};
const domains: Record<string, string> = {
  story: "故事",
  settings: "设定",
  materials: "素材",
  production: "制作",
  collaboration: "协作",
  project: "项目",
};
export default function HandbookInstance({
  kinds,
  onReady,
}: {
  kinds: Record<string, string[]>;
  onReady: () => void;
}) {
  const instance = useInstanceProfile(),
    scope = workspaceCacheScope(instance);
  const [kind, setKind] = useState("SCENE"),
    [query, setQuery] = useState(""),
    [historical, setHistorical] = useState(false),
    [page, setPage] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [catalog, setCatalog] = useState<{
      items: Summary[];
      total: number;
    } | null>(null),
    [counts, setCounts] = useState<Array<{
      module: string;
      count: number;
    }> | null>(null);
  const [selected, setSelected] = useState({ id: "", revision: "" }),
    [context, setContext] = useState<{ value: Context; at: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const [listError, setListError] = useState(""),
    [listPending, setListPending] = useState(true);
  const sequence = useRef(0);
  useEffect(() => {
    const sync = () => {
      const p = new URL(location.href).searchParams;
      setSelected({
        id: p.get("handbookObject") || "",
        revision: p.get("handbookRevision") || "",
      });
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readWorkspaceJson<{
      project: { instanceId: string };
      counts: Array<{ module: string; count: number }>;
    }>(runtimePath("/api/v1/work"), scope, controller.signal)
      .then((r) => {
        if (r.project.instanceId !== instance.instanceId)
          throw Error("实例身份已变化");
        setCounts(r.counts);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setListError(e.message);
      });
    return () => controller.abort();
  }, [scope, refresh, instance.instanceId]);
  useEffect(() => {
    const controller = new AbortController();
    setListError("");
    setListPending(true);
    const p = new URLSearchParams({
      kind,
      query,
      limit: "20",
      offset: String(page * 20),
      historical: String(historical),
    });
    void readWorkspaceJson<{ items: Summary[]; total: number }>(
      runtimePath("/api/v1/objects?" + p),
      scope,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setCatalog(value);
          setListPending(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setListError(e.message);
          setListPending(false);
        }
      });
    return () => controller.abort();
  }, [scope, kind, query, page, historical, refresh]);
  useEffect(() => {
    if (!selected.id) {
      setContext(null);
      return;
    }
    const controller = new AbortController(),
      seq = ++sequence.current;
    setPending(true);
    setError("");
    const p = selected.revision
      ? "?revisionId=" + encodeURIComponent(selected.revision)
      : "";
    void readWorkspaceJson<Context>(
      runtimePath("/api/v1/contexts/" + encodeURIComponent(selected.id) + p),
      scope,
      controller.signal,
    ).then(
      (value) => {
        if (seq === sequence.current) {
          setContext({ value, at: new Date().toISOString() });
          setPending(false);
        }
      },
      (e) => {
        if (!controller.signal.aborted && seq === sequence.current) {
          setError(e.message);
          setPending(false);
        }
      },
    );
    return () => controller.abort();
  }, [scope, selected.id, selected.revision, refresh]);
  function select(id: string, revision = "") {
    const u = new URL(location.href);
    u.searchParams.set("handbookObject", id);
    if (revision) u.searchParams.set("handbookRevision", revision);
    else u.searchParams.delete("handbookRevision");
    u.hash = "";
    history.pushState({}, "", u);
    setSelected({ id, revision });
  }
  const value = context?.value,
    object = value?.object,
    matching =
      object?.id === selected.id &&
      (!selected.revision || object.revision.id === selected.revision);
  const complete = Boolean(catalog && counts && !listPending && (!selected.id || (matching && !pending)));
  const announced = useRef(false), readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  useEffect(() => {
    if (complete && !announced.current) {
      announced.current = true;
      readyCallback.current();
    }
  }, [complete]);
  const links = (rows: Summary[], exact: boolean) =>
    rows.length ? (
      <ul>
        {rows.slice(0, 50).map((row, i) => (
          <li key={row.id + ":" + (row.revisionId || "") + ":" + i}>
            <button
              onClick={() => select(row.id, exact ? row.revisionId || "" : "")}
              title={row.id}
            >
              <strong>{row.title}</strong>
              <small>
                {row.kind} ·{" "}
                {exact ? row.purpose || "精确修订" : row.role || "普通关联"}
                {row.historical ? " · 历史" : ""}
              </small>
              {exact && <code>{row.revisionId}</code>}
            </button>
          </li>
        ))}
        {rows.length > 50 && (
          <li>本视图展示前 50 项；请选择更小的对象范围继续查看。</li>
        )}
      </ul>
    ) : (
      <p className="handbook-muted">此修订未登记这类关系。</p>
    );
  return (
    <section
      className="handbook-instance"
      aria-label="当前项目实例映射"
      data-instance-ready={complete}
    >
      <header>
        <div>
          <span className="handbook-eyebrow">LIVE INSTANCE · 只读</span>
          <h2>{instance.storyTitle}</h2>
          <p>
            六域数量不含历史对象；下方目录可另选历史范围，不推断整剧完成率。
          </p>
        </div>
        <button onClick={() => setRefresh((n) => n + 1)}>刷新实例数据</button>
      </header>
      <div className="handbook-domain-counts">
        {Object.entries(domains).map(([id, label]) => (
          <div key={id}>
            <small>{label}</small>
            <b>
              {counts
                ? counts
                    .filter((c) => c.module === id)
                    .reduce((n, c) => n + c.count, 0)
                : "…"}
            </b>
            <span>{counts ? "个当前对象" : "读取中"}</span>
          </div>
        ))}
      </div>
      <div className="handbook-instance-controls">
        <label>
          对象类型
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(0);
            }}
          >
            {Object.entries(kinds).map(([domain, list]) => (
              <optgroup key={domain} label={domains[domain] || domain}>
                {list.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          搜索对象名称
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="输入名称筛选"
          />
        </label>
        <label className="handbook-check">
          <input
            type="checkbox"
            checked={historical}
            onChange={(e) => {
              setHistorical(e.target.checked);
              setPage(0);
            }}
          />
          包含历史对象
        </label>
      </div>
      {listError && <p role="alert">{listError}</p>}
      {listPending && <p role="status">正在读取对象目录…</p>}
      <div
        className="handbook-object-picker"
        aria-busy={listPending}
        aria-label="选择实例对象"
      >
        {catalog?.items.map((row) => (
          <button
            key={row.id}
            disabled={listPending}
            aria-pressed={selected.id === row.id}
            onClick={() => select(row.id)}
          >
            <span>{row.title}</span>
            <small>
              {states[row.state || ""] || row.state}
              {row.historical ? " · 历史" : ""}
            </small>
          </button>
        ))}
        {catalog && !catalog.items.length && (
          <p>
            此范围尚未登记对象。可以选择其他类型；空白项目不会自动生成示例。
          </p>
        )}
      </div>
      {!!catalog && catalog.total > 20 && (
        <div className="handbook-pagination">
          <button disabled={!page} onClick={() => setPage((n) => n - 1)}>
            上一页
          </button>
          <span>
            第 {page + 1} 页 · 共 {catalog.total} 项
          </span>
          <button
            disabled={(page + 1) * 20 >= catalog.total}
            onClick={() => setPage((n) => n + 1)}
          >
            下一页
          </button>
        </div>
      )}
      {pending && <p role="status">正在读取选中修订的完整关系…</p>}
      {error && <p role="alert">{error}</p>}
      {!selected.id && (
        <p className="handbook-callout">
          选择一个对象，即可把上面的架构概念映射到真实版本和关系。
        </p>
      )}
      {matching && value && object && (
        <div
          aria-busy={pending}
          data-handbook-object={object.id}
          data-handbook-revision={object.revision.id}
        >
          <div className="handbook-selected">
            <div>
              <h3>{object.title}</h3>
              <p>
                当前对象状态：{states[object.state || ""] || object.state} ·{" "}
                {object.kind}
                {object.historical ? " · 历史对象" : ""}
              </p>
              <code>{object.id}</code>
            </div>
            <label>
              查看修订
              <select
                aria-label="实例修订"
                value={object.revision.id}
                onChange={(e) => select(object.id, e.target.value)}
              >
                {!object.versions.some((v) => v.id === object.revision.id) && (
                  <option value={object.revision.id}>当前选定历史修订</option>
                )}
                {object.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    修订 {v.number}
                    {v.id === object.adoptedRevisionId ? " · 采用头" : ""}
                    {v.id === object.draftRevisionId ? " · 草稿头" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="handbook-muted">
            读取于 {new Date(context!.at).toLocaleString()} · 正在查看修订{" "}
            {object.revision.number}。状态属于当前对象；历史修订保留原依据。
          </p>
          <dl className="handbook-heads">
            <div>
              <dt>草稿头</dt>
              <dd>{object.draftRevisionId || "尚无"}</dd>
            </div>
            <div>
              <dt>采用头</dt>
              <dd>{object.adoptedRevisionId || "尚未采用"}</dd>
            </div>
            <div>
              <dt>内容 SHA</dt>
              <dd>{object.revision.sha256}</dd>
            </div>
          </dl>
          <div
            className="handbook-instance-graph"
            aria-label="精确输入到所选修订及直接下游"
          >
            <section>
              <h4>精确输入 →</h4>
              {links(value.inputs, true)}
            </section>
            <section className="handbook-graph-center">
              <small>所选修订</small>
              <strong>{object.title}</strong>
              <code>{object.revision.id}</code>
              <p>点击两侧关系追溯精确修订；下游限其当前草稿或采用头。</p>
            </section>
            <section>
              <h4>→ 当前直接下游</h4>
              {links(value.consumers, true)}
            </section>
          </div>
          {(value.inputs.length >= 200 || value.consumers.length >= 200) && (
            <p>接口关系读取达到上限；此图不代表完整闭包，请按对象继续展开。</p>
          )}
          <details className="handbook-related">
            <summary>
              普通关联 · {value.related.length} 项
              {value.relatedTruncated ? "（有截断）" : ""}
            </summary>
            <p>普通关联不表示精确版本依赖。点击后读取该对象当前内容。</p>
            {links(value.related, false)}
          </details>
          <h3>媒体、权利与判断</h3>
          <p>
            权利事实：{states[object.rights?.fact || "UNKNOWN"]}；内部适用确认：
            {object.rights?.internalAttestation ? "已登记" : "未登记"}
            。本修订存在 {object.invalidations.length} 条失效记录。
          </p>
          {object.media.length ? (
            <table>
              <thead>
                <tr>
                  <th>登记媒体</th>
                  <th>可用状态</th>
                  <th>用途</th>
                </tr>
              </thead>
              <tbody>
                {object.media.map((m, i) => (
                  <tr key={i}>
                    <td>
                      <code>{m.sha256}</code>
                      <small>{m.mime_type}</small>
                    </td>
                    <td>{states[m.availability] || m.availability}</td>
                    <td>{m.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>本修订没有直接绑定媒体。</p>
          )}
          {object.reviews
            .filter((r) => r.revision_id === object.revision.id)
            .map((r) => (
              <blockquote key={r.id}>
                <b>{r.decision}</b>
                <p>{r.note || "此判断未附文字说明。"}</p>
              </blockquote>
            ))}
          {!object.reviews.some(
            (r) => r.revision_id === object.revision.id,
          ) && <p>最近返回的审阅记录中没有针对所选修订的判断。</p>}
          <details>
            <summary>精确读取依据 · {value.basis.length} 份修订</summary>
            <ul>
              {value.basis.map((b) => (
                <li key={b.revisionId}>
                  <code>
                    {b.objectId} · {b.revisionId} · {b.sha256}
                  </code>
                </li>
              ))}
            </ul>
          </details>
          <a
            href={runtimePath(
              "/?view=" +
                ((
                  {
                    production: "pipeline",
                    collaboration: "overview",
                    project: "system",
                  } as Record<string, string>
                )[object.module || ""] ||
                  object.module ||
                  "overview"),
            )}
          >
            前往所属业务入口 →
          </a>
        </div>
      )}
    </section>
  );
}
