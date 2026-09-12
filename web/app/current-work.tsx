"use client";
import { useEffect, useState } from "react";
import { read } from "./client";
import { useSession } from "./session";
import { kindLabels, stateLabels, type Summary } from "./types";
import { workChains, workStateLabels } from "../../server/shared/workflow.mjs";
export function CurrentWork({
  summary,
  onOpen,
  onNavigate,
}: {
  summary: any;
  onOpen: (id: string) => void;
  onNavigate: (m: string, kind?: string) => void;
}) {
  const [chain, setChain] = useSession("current-work-chain", "story"),
    [stages, setStages] = useSession<Record<string, string>>(
      "current-work-stages",
      {},
    ),
    [status, setStatus] = useSession("current-work-status", "NOW"),
    [actor, setActor] = useSession("current-work-actor", "ALL"),
    [items, setItems] = useState<any>(null),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const selected = workChains.find((s: any) => s.id === chain) || workChains[0],
    stage =
      selected.stages.find((s: any) => s.id === stages[chain]) ||
      selected.stages[0],
    counts = summary?.counts || [];
  const count = (kinds: string[], states?: string[]) =>
    counts
      .filter(
        (c: any) =>
          kinds.includes(c.kind) && (!states || states.includes(c.workState)),
      )
      .reduce((n: number, c: any) => n + c.count, 0);
  useEffect(() => {
    let active = true;
    setError("");
    setItems(null);
    if (chain === "exceptions") {
      setItems({ items: [], total: 0 });
      return;
    }
    const q = new URLSearchParams({
      chain,
      workStage: stage.id,
      workState: status,
      actor,
      limit: "50",
      offset: String(offset),
    });
    read("objects?" + q)
      .then((r) => active && setItems(r))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [chain, stage.id, status, offset, actor, attempt, summary]);
  return (
    <section
      className="current-work-center overview"
      data-ready={items ? "overview" : undefined}
      aria-label="流程驱动的当前工作"
    >
      <header className="workspace-introduction">
        <h2>全剧状态与当前工作</h2>
        <p>选择工作链与阶段，查看可推进的对象和下一步。</p>
      </header>
      <nav className="creation-chain" aria-label="三条主体工作链">
        {workChains.map((s: any, i: number) => {
          const kinds = s.stages.flatMap((x: any) => x.kinds);
          return (
            <button
              key={s.id}
              aria-pressed={chain === s.id}
              onClick={() => {
                setChain(s.id);
                setOffset(0);
              }}
            >
              <small>0{i + 1}</small>
              <h3>{s.title}</h3>
              <p>{s.note}</p>
              <div>
                <span>
                  <b>{count(kinds, ["READY", "IN_PROGRESS"])}</b> 项可推进
                </span>
                <span>
                  <b>{count(kinds, ["WAITING", "BLOCKED"])}</b> 项等待或阻断
                </span>
              </div>
            </button>
          );
        })}
      </nav>
      {chain !== "exceptions" && (
        <nav
          className="flow-stage-tabs"
          aria-label={selected.title + "阶段选择"}
        >
          {selected.stages.map((s: any, i: number) => (
            <button
              key={s.id}
              aria-pressed={s.id === stage.id}
              onClick={() => {
                setStages((old) => ({ ...old, [chain]: s.id }));
                setOffset(0);
              }}
            >
              <small>0{i + 1}</small>
              <strong>{s.title}</strong>
              <span>
                {count(s.kinds, ["COMPLETE"])} / {count(s.kinds)} · 已采用 /
                已登记
              </span>
            </button>
          ))}
        </nav>
      )}
      <div className="work-lanes">
        <aside className="stage-inspector">
          <small>所选阶段</small>
          <h2>{chain === "exceptions" ? "异常与交接" : stage.title}</h2>
          <p>{selected.note}</p>
          {chain !== "exceptions" && (
            <>
              <b>{count(stage.kinds, ["READY", "IN_PROGRESS"])} 项可推进</b>
              <p>核对本阶段对象的正文、依据和判断，再回到所属页面处理。</p>
              <button
                className="primary"
                onClick={() =>
                  onNavigate(
                    chain === "materials" && stage.id === "SETTING"
                      ? "settings"
                      : chain,
                    stage.kinds[0],
                  )
                }
              >
                打开本阶段工作区 →
              </button>
              <h3>相关内容与依据</h3>
              {stage.kinds.map((k: string) => (
                <div className="stage-count" key={k}>
                  <span>{kindLabels[k]}</span>
                  <b>
                    {count([k], ["COMPLETE"])} / {count([k])}
                  </b>
                  <small>已采用 / 已登记</small>
                </div>
              ))}
            </>
          )}
          <button
            className="workflow-exception-link"
            aria-pressed={chain === "exceptions"}
            onClick={() =>
              setChain(chain === "exceptions" ? "story" : "exceptions")
            }
          >
            {chain === "exceptions"
              ? "返回故事工作链"
              : `跨对象异常与执行 · ${summary?.operations?.length || 0}`}
          </button>
          <p className="muted">
            未登记的制作范围尚不构成进度分母。对象内的审阅、修改和执行回到所属页面；本页不自动授权或采用。
          </p>
        </aside>
        <section className="work-items">
          <header>
            <div>
              <small>本阶段的对象与行动</small>
              <h2>现在看什么，接下来做什么</h2>
            </div>
            <div className="work-task-filters">
              <label>
                状态
                <select
                  aria-label="工作状态"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setOffset(0);
                  }}
                >
                  {Object.entries({
                    NOW: "现在可推进",
                    ALL: "全部状态",
                    ...workStateLabels,
                  }).map(([v, label]) => (
                    <option key={v} value={v}>
                      {String(label)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                推进主体
                <select
                  aria-label="工作处理方式"
                  value={actor}
                  onChange={(e) => {
                    setActor(e.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="ALL">全部主体</option>
                  <option value="HUMAN">需要人的判断</option>
                  <option value="AI">可请 AI 辅助修改</option>
                  <option value="BOTH">人和 AI 均可修改</option>
                  <option value="AUTOMATION">后台自动执行</option>
                </select>
              </label>
            </div>
          </header>
          {error && (
            <div role="alert">
              <p>当前工作暂不可判断：{error}</p>
              <button onClick={() => setAttempt((n) => n + 1)}>重新读取</button>
            </div>
          )}
          {chain === "exceptions" ? (
            <div className="work-exceptions">
              {summary?.operations?.map((o: any) => (
                <article key={o.id}>
                  <b>{o.kind}</b>
                  <span>{o.status}</span>
                  <p>{o.id}</p>
                  <small>
                    在系统管理中按此操作编号查询；结果未知时先核查原请求。
                  </small>
                </article>
              ))}
              {!summary?.operations?.length && <p>目前没有待核的后台操作。</p>}
            </div>
          ) : !items && !error ? (
            <p role="status">正在读取本阶段工作…</p>
          ) : items?.items.length ? (
            items.items.map((o: any) => (
              <button
                className="work-item"
                key={o.id}
                onClick={() => onOpen(o.id)}
              >
                <div>
                  <small>
                    {kindLabels[o.kind]} · {o.displayId}
                  </small>
                  <b>
                    {o.family ? o.family.title + " · " : ""}
                    {o.title}
                  </b>
                  <p>{o.preview?.description}</p>
                  <small>
                    {o.workState === "WAITING"
                      ? "先核对已改变的精确输入"
                      : o.workState === "BLOCKED"
                        ? "核对禁用、拒绝或未知执行结果"
                        : o.state === "SUBMITTED"
                          ? "阅读上下文并给出判断"
                          : o.state === "ADOPTED"
                            ? "查看已采用内容及版本依据"
                            : "继续编辑，完成后提交审阅"}
                  </small>
                </div>
                <span className="pill">
                  {workStateLabels[
                    o.workState as keyof typeof workStateLabels
                  ] || stateLabels[o.state]}
                </span>
              </button>
            ))
          ) : (
            !error && (
              <p className="empty">
                本阶段当前筛选下没有工作对象。
                {status === "NOW" && (
                  <button onClick={() => setStatus("ALL")}>
                    查看等待与阻断
                  </button>
                )}
              </p>
            )
          )}
          {chain !== "exceptions" && (
            <div className="pager">
              <button
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                上一页
              </button>
              <span>{items?.total || 0} 项登记</span>
              <button
                disabled={items?.nextOffset == null}
                onClick={() => setOffset(items.nextOffset)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

export function GlobalSearch({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(""),
    [result, setResult] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setResult(null);
    setError("");
    if (query.trim().length < 2) return;
    const timer = setTimeout(
      () =>
        read("objects?query=" + encodeURIComponent(query) + "&limit=20")
          .then((r) => active && setResult(r))
          .catch((e) => active && setError(e.message)),
      180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);
  return (
    <div className="global-search">
      <label>
        <span>⌕</span>
        <input
          aria-label="全局搜索"
          placeholder="搜索故事、对白、集场或素材"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
      </label>
      {query.trim().length >= 2 && (
        <div className="search-results" role="region" aria-label="全局搜索结果">
          {error ? (
            <p role="alert">{error}</p>
          ) : !result ? (
            <p role="status">搜索中…</p>
          ) : result.items.length ? (
            result.items.map((o: Summary) => (
              <button
                key={o.id}
                onClick={() => {
                  setQuery("");
                  onOpen(o.id);
                }}
              >
                <small>
                  {kindLabels[o.kind]} · {o.displayId}
                </small>
                <b>{o.title}</b>
                <p>{o.preview?.description}</p>
              </button>
            ))
          ) : (
            <p>没有找到匹配内容。</p>
          )}
          <button onClick={() => setQuery("")}>关闭搜索</button>
        </div>
      )}
    </div>
  );
}
