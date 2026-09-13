"use client";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useInstanceProfile } from "./instance-context";
import { readWorkspaceJson, workspaceCacheScope } from "./workspace-read-cache";
import { runtimePath } from "./runtime-path";
import HandbookInstance from "./handbook-instance";
import "./architecture-handbook.css";
type Heading = { id: string; title: string; level: number };
type Chapter = {
  id: string;
  title: string;
  summary: string;
  part: string;
  toc: Heading[];
  contentSha256: string;
  reviewedAt: string;
  text: string;
};
type Catalog = {
  title: string;
  softwareCommit: string;
  contentSha256: string;
  chapters: Chapter[];
  kinds: Record<string, string[]>;
  diagrams: Array<{ id: string; title: string; description: string }>;
};
type Document = Chapter & {
  html: string;
  markdown: string;
  softwareCommit: string;
  bookSha256: string;
  references: Array<{ path: string; sha256: string }>;
};
type Reading = {
  chapter?: string;
  query?: string;
  positions?: Record<string, number>;
  scales?: Record<string, number>;
};
function stored(key: string): Reading {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
}
export default function ArchitectureHandbook() {
  const instance = useInstanceProfile(),
    scope = workspaceCacheScope(instance),
    storageKey = instance.instanceId + ":architecture-handbook:v1";
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [chapter, setChapter] = useState(""),
    [query, setQuery] = useState(""),
    [doc, setDoc] = useState<Document | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const reading = useRef<Reading>({}),
    content = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    instanceReady = useRef(false),
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    pendingHash = useRef("");
  const [figure, setFigure] = useState<{
      id: string;
      title: string;
      description: string;
    } | null>(null),
    [scale, setScale] = useState(1);
  const write = () => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(reading.current));
    } catch {}
  };
  useEffect(() => {
    reading.current = stored(storageKey);
    setQuery(reading.current.query || "");
    const sync = () => {
      const url = new URL(location.href);
      pendingHash.current = url.hash;
      setChapter(
        url.searchParams.get("chapter") ||
          reading.current.chapter ||
          "overview",
      );
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(reading.current));
      } catch {}
    };
  }, [storageKey]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void readWorkspaceJson<Catalog>(
      runtimePath("/api/v1/documentation/catalog"),
      scope,
      controller.signal,
    ).then(setCatalog, (e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [scope, reload]);
  useEffect(() => {
    if (!catalog || !chapter) return;
    if (!catalog.chapters.some((c) => c.id === chapter)) {
      setError("这个章节不存在，请从目录选择。");
      return;
    }
    const controller = new AbortController();
    setError("");
    void readWorkspaceJson<Document>(
      runtimePath("/api/v1/documentation/chapters/" + chapter),
      scope + ":" + catalog.contentSha256,
      controller.signal,
    ).then(
      (value) => {
        if (
          value.bookSha256 !== catalog.contentSha256 ||
          value.softwareCommit !== catalog.softwareCommit
        ) {
          setError("手册版本已更新，请重新读取目录。");
          return;
        }
        setDoc(value);
      },
      (e) => {
        if (!controller.signal.aborted) setError(e.message);
      },
    );
    return () => controller.abort();
  }, [scope, chapter, catalog, reload]);
  const restore = () => {
    const node = content.current;
    if (!node) return;
    const hash = pendingHash.current;
    pendingHash.current = "";
    if (hash) {
      let id;
      try {
        id = decodeURIComponent(hash.slice(1));
      } catch {
        return;
      }
      const target = node.querySelector('[id="' + CSS.escape(id) + '"]');
      if (target) {
        node.scrollTop +=
          target.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          16;
        return;
      }
    }
    node.scrollTop = reading.current.positions?.[chapter] || 0;
  };
  useLayoutEffect(() => {
    if (doc?.id !== chapter) return;
    if (chapter === "instance") {
      instanceReady.current = false;
      return;
    }
    restore();
  }, [doc, chapter]);
  function savePosition() {
    if (doc?.id !== chapter || !content.current || (chapter === "instance" && !instanceReady.current)) return;
    reading.current.positions = {
      ...reading.current.positions,
      [chapter]: content.current.scrollTop,
    };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(write, 200);
  }
  function navigate(id: string, hash = "") {
    savePosition();
    reading.current.chapter = id;
    write();
    const url = new URL(location.href);
    url.searchParams.set("view", "system");
    url.searchParams.set("systemTab", "architecture");
    url.searchParams.set("chapter", id);
    url.hash = hash;
    history.pushState({}, "", url);
    pendingHash.current = hash;
    setChapter(id);
    if (id === chapter) restore();
  }
  function articleClick(event: MouseEvent) {
    const element = event.target as Element;
    const image = element.closest<HTMLImageElement>("img[data-diagram]");
    if (image) {
      const item = catalog?.diagrams.find(
        (d) => d.id === image.dataset.diagram,
      );
      if (item) {
        setFigure(item);
        setScale(reading.current.scales?.[item.id] || 1);
        dialog.current?.showModal();
      }
      return;
    }
    const anchor = element.closest<HTMLAnchorElement>("a[href]");
    if (
      !anchor ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.button !== 0
    )
      return;
    const u = new URL(anchor.href);
    if (
      u.origin === location.origin &&
      u.searchParams.get("systemTab") === "architecture" &&
      u.searchParams.get("chapter")
    ) {
      event.preventDefault();
      navigate(u.searchParams.get("chapter")!, u.hash);
    }
  }
  const matches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return !q
      ? []
      : (catalog?.chapters || [])
          .filter((c) =>
            (c.title + " " + c.text).toLocaleLowerCase().includes(q),
          )
          .map((c) => {
            const index = c.text.toLocaleLowerCase().indexOf(q);
            return {
              ...c,
              snippet: c.text.slice(
                Math.max(0, index - 35),
                Math.max(0, index - 35) + 130,
              ),
            };
          });
  }, [query, catalog]);
  const active = catalog?.chapters.find((c) => c.id === chapter),
    index = catalog?.chapters.findIndex((c) => c.id === chapter) ?? -1,
    ready = doc?.id === chapter;
  return (
    <section className="architecture-handbook" aria-label="系统架构手册">
      <header className="handbook-cover">
        <div>
          <span className="handbook-eyebrow">
            STORY REVIEW DESK / FIELD GUIDE
          </span>
          <h2>理解系统，走进创作</h2>
          <p>
            从业务全景到一次精确的判断。通用主册由核心维护，实例册读取当前故事。
          </p>
        </div>
        <span className="handbook-edition">
          只读继承
          <code title={catalog?.softwareCommit}>
            {catalog?.softwareCommit.slice(0, 8) || "读取版本…"}
          </code>
        </span>
      </header>
      <div className="handbook-layout">
        <aside className="handbook-directory">
          <label className="handbook-search">
            搜索整本手册
            <input
              type="search"
              value={query}
              placeholder="例如：采用头、部署、media"
              onChange={(e) => {
                setQuery(e.target.value);
                reading.current.query = e.target.value;
                write();
              }}
            />
          </label>
          {query.trim() ? (
            <div className="handbook-search-results" aria-label="手册搜索结果">
              <small>{matches.length} 个章节匹配</small>
              {matches.map((c) => (
                <button key={c.id} onClick={() => navigate(c.id)}>
                  <b>{c.title}</b>
                  <span>{c.snippet}</span>
                </button>
              ))}
              {!matches.length && (
                <p>没有匹配的章节。可以使用业务词或字段名搜索。</p>
              )}
              <button
                onClick={() => {
                  setQuery("");
                  reading.current.query = "";
                  write();
                }}
              >
                返回完整目录
              </button>
            </div>
          ) : (
            <nav aria-label="系统架构章节">
              {catalog?.chapters.map((c, i) => (
                <button
                  key={c.id}
                  aria-current={chapter === c.id ? "page" : undefined}
                  onClick={() => navigate(c.id)}
                >
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <b>{c.title}</b>
                  <small>{c.part}</small>
                </button>
              ))}
            </nav>
          )}
        </aside>
        <div className="handbook-reading-column">
          <div className="handbook-reading-toolbar">
            <span>{active?.part || "通用主册"}</span>
            <details>
              <summary>本章目录</summary>
              <nav>
                {(ready ? doc.toc : active?.toc)?.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => navigate(chapter, "#" + h.id)}
                  >
                    {h.title}
                  </button>
                ))}
              </nav>
            </details>
            <button onClick={() => setReload((n) => n + 1)}>重新读取</button>
          </div>
          {error && (
            <p role="alert" className="handbook-error">
              {error}
            </p>
          )}
          <div
            className="handbook-content"
            ref={content}
            onScroll={savePosition}
            tabIndex={0}
            aria-label="手册正文"
            data-handbook-chapter={ready ? chapter : ""}
          >
            {!ready ? (
              <div className="handbook-loading" role="status">
                正在读取这一章…
              </div>
            ) : (
              <>
                <article
                  className="handbook-prose"
                  onKeyDown={(event) => {
                    if (
                      (event.key === "Enter" || event.key === " ") &&
                      (event.target as Element).matches("img[data-diagram]")
                    ) {
                      event.preventDefault();
                      (event.target as HTMLElement).click();
                    }
                  }}
                  onClick={articleClick}
                  dangerouslySetInnerHTML={{ __html: doc.html }}
                />
                {chapter === "instance" && (
                <HandbookInstance kinds={catalog!.kinds} onReady={() => { instanceReady.current = true; restore(); }} />
                )}
                <footer className="handbook-chapter-footer">
                  <p>
                    最近核验：{doc.reviewedAt} · 随软件{" "}
                    {doc.softwareCommit.slice(0, 8)} 发布
                  </p>
                  <details>
                    <summary>实现依据与源文件</summary>
                    <p>
                      以下链接绑定发布提交。来源摘要用于发现实现变化，不能替代语义核对。
                    </p>
                    <ul>
                      {doc.references.map((r) => (
                        <li key={r.path}>
                          <a
                            href={
                              "https://github.com/goosmanlei/story-review-desk/blob/" +
                              doc.softwareCommit +
                              "/" +
                              r.path
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            {r.path}
                          </a>
                          <code>{r.sha256}</code>
                        </li>
                      ))}
                    </ul>
                    <a
                      href={
                        "https://github.com/goosmanlei/story-review-desk/blob/" +
                        doc.softwareCommit +
                        "/docs/handbook/chapters/" +
                        doc.id +
                        ".md"
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      阅读 Markdown 源文稿 →
                    </a>
                  </details>
                  <div className="handbook-pagination">
                    <button
                      disabled={index <= 0}
                      onClick={() => navigate(catalog!.chapters[index - 1].id)}
                    >
                      ← 上一章
                    </button>
                    <span>
                      {index + 1} / {catalog?.chapters.length}
                    </span>
                    <button
                      disabled={
                        index < 0 ||
                        index === (catalog?.chapters.length || 0) - 1
                      }
                      onClick={() => navigate(catalog!.chapters[index + 1].id)}
                    >
                      下一章 →
                    </button>
                  </div>
                </footer>
              </>
            )}
          </div>
        </div>
      </div>
      <dialog
        ref={dialog}
        className="handbook-diagram-dialog"
        onClose={() => setFigure(null)}
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current.close();
        }}
      >
        <header>
          <h3>{figure?.title}</h3>
          <label>
            缩放
            <input
              aria-label="图表缩放"
              type="range"
              min="0.6"
              max="2.5"
              step="0.1"
              value={scale}
              onChange={(e) => {
                const next = Number(e.target.value);
                setScale(next);
                if (figure) {
                  reading.current.scales = {
                    ...reading.current.scales,
                    [figure.id]: next,
                  };
                  write();
                }
              }}
            />
          </label>
          <button onClick={() => dialog.current?.close()} aria-label="关闭图表">
            关闭 ×
          </button>
        </header>
        <div className="handbook-diagram-viewport">
          {figure && (
            <img
              src={runtimePath("/api/v1/documentation/assets/" + figure.id)}
              alt={figure.description}
              style={{ width: scale * 100 + "%", maxWidth: "none" }}
            />
          )}
        </div>
        <p>{figure?.description}</p>
      </dialog>
    </section>
  );
}
