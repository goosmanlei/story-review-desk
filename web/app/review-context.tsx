"use client";
import { useState } from "react";
import { read, commands } from "./client";
import { Assistant } from "./assistant";
import { Rich, Content } from "./content";
import { useSession } from "./session";
import { type Detail, kindLabels, stateLabels } from "./types";

type Open = (id: string, revisionId?: string) => void;
export function ReviewContext({
  detail,
  context,
  onOpen,
}: {
  detail: Detail;
  context: any;
  onOpen: Open;
}) {
  if (!context || context.revisionId !== detail.revision.id) return null;
  const episode = context.primary.find((p: Detail) => p.kind === "EPISODE");
  const scene = context.primary.find((p: Detail) => p.kind === "SCENE");
  return (
    <section className="context-panel" aria-label="审阅上下文">
      {detail.historical && (
        <p className="notice">
          历史依据 · 保留原场次和版本，不对应当前稿的同号场次。
        </p>
      )}
      {episode && (
        <details className="episode-dossier" open={detail.kind === "SCENE"}>
          <summary>
            本集任务与回报 · {episode.displayId} {episode.title}
          </summary>
          <Rich
            value={
              episode.revision.content.reviewDossier?.purpose || {
                coreAdvance: episode.revision.content.coreAdvance,
              }
            }
          />
          <Rich value={episode.revision.content.reviewDossier?.payoff} />
          <button onClick={() => onOpen(episode.id, episode.revision.id)}>
            打开本集卷宗
          </button>
          <small>
            {episode.contextBinding === "EXACT_INPUT"
              ? "本对象引用的精确输入"
              : "当前关联卷宗"}{" "}
            · 修订 {episode.revision.number}
          </small>
        </details>
      )}
      {scene && detail.module === "production" && (
        <details className="scene-context" open>
          <summary>本场正文与制作依据 · {scene.title}</summary>
          <p>{scene.revision.content.purpose}</p>
          <div className="script-excerpt">
            {(scene.revision.content.blocks || []).map((b: any) => (
              <p key={b.id}>
                {b.speaker && <b>{b.speaker}　</b>}
                {b.text}
              </p>
            ))}
          </div>
          <button onClick={() => onOpen(scene.id, scene.revision.id)}>
            打开完整场正文
          </button>
          <small>
            {scene.contextBinding === "EXACT_INPUT"
              ? "已引用的场正文修订"
              : "当前关联场正文，尚不证明已锁定"}{" "}
            · {scene.revision.number}
          </small>
        </details>
      )}
      {context.sourceSegments.length > 0 && (
        <details>
          <summary>
            来源原文的处理依据 · {context.sourceSegments.length}
          </summary>
          {context.sourceSegments.map((s: any) => (
            <article key={s.item.id}>
              <b>{s.item.id}</b>
              <p>{s.item.summary}</p>
              <p>{s.item.reason}</p>
              <button onClick={() => onOpen(s.structureId, s.revisionId)}>
                核对原文处理与来源版本
              </button>
            </article>
          ))}
        </details>
      )}
      {context.assets.length > 0 && (
        <section className="family-versions">
          <h3>产物与版本</h3>
          {context.previewAsset && (
            <>
              <Content
                detail={{
                  ...context.previewAsset,
                  revision: { ...context.previewAsset.revision, content: {} },
                  links: [],
                  dependencies: [],
                }}
                onOpen={onOpen}
              />
              <button onClick={() => onOpen(context.previewAsset.id)}>
                审阅此素材版本 →
              </button>
            </>
          )}
          {context.assets.map((a: any) => (
            <button key={a.id} onClick={() => onOpen(a.id)}>
              <b>{a.displayId || a.title}</b>
              <span>
                {a.adoptedAsset ? "采用版本" : stateLabels[a.state]}
                {a.historical ? " · 历史候选" : ""}
              </span>
            </button>
          ))}
        </section>
      )}
      {context.related.length > 0 && (
        <details className="related-context">
          <summary>
            {detail.module === "materials"
              ? "用途与使用位置"
              : detail.module === "settings"
                ? "关联设定与素材需求"
                : "关联内容"}{" "}
            · {context.related.length}
            {context.relatedTruncated ? "＋" : ""}
          </summary>
          <div className="context-links">
            {context.related.map((r: any) => (
              <button key={r.id + r.role} onClick={() => onOpen(r.id)}>
                <small>
                  {kindLabels[r.kind]}
                  {r.historical ? " · 历史依据" : ""}
                </small>
                <span>{r.title}</span>
              </button>
            ))}
          </div>
        </details>
      )}
      {context.consumers.length > 0 && (
        <details>
          <summary>实际引用本修订的下游 · {context.consumers.length}</summary>
          <div className="context-links">
            {context.consumers.map((r: any) => (
              <button
                key={r.id + r.purpose}
                onClick={() => onOpen(r.id, r.revisionId)}
              >
                {kindLabels[r.kind]} · {r.title}
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

export function Comments({
  detail,
  context,
  anchor,
  onClearAnchor,
  onOpen,
  onChanged,
}: {
  detail: Detail;
  context: any;
  anchor: any;
  onClearAnchor: () => void;
  onOpen: Open;
  onChanged: () => void;
}) {
  const [text, setText] = useSession("comment-draft:" + detail.revision.id, ""),
    [filter, setFilter] = useSession("comments-filter:" + detail.id, "OPEN"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [assistant, setAssistant] = useState<Detail | null>(null),
    [message, setMessage] = useState("");
  async function add(withAssistant = false) {
    setBusy(true);
    setError("");
    try {
      const id = "comment_" + crypto.randomUUID();
      await commands([
        {
          type: "save",
          id,
          kind: "COMMENT",
          expectedVersion: 0,
          title: "关于 " + detail.title,
          content: {
            text,
            status: "OPEN",
            target: {
              objectId: detail.id,
              revisionId: detail.revision.id,
              expectedVersion: detail.version,
              sha256: detail.revision.sha256,
              label: detail.title,
            },
            ...(anchor ? { anchor } : {}),
          },
          links: [
            { id: detail.id, role: "SOURCE", expectedVersion: detail.version },
          ],
          dependencies: [
            { revisionId: detail.revision.id, purpose: "CONTENT" },
          ],
        },
      ]);
      setText("");
      setMessage("评论已保存，判断与采用仍由你确认。");
      if (withAssistant)
        setAssistant(
          await read("objects/" + encodeURIComponent(id), { refresh: true }),
        );
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(c: any) {
    setBusy(true);
    setError("");
    try {
      await commands([
        {
          type: "save",
          id: c.id,
          expectedVersion: c.version,
          content: {
            ...c.content,
            status: c.content.status === "OPEN" ? "RESOLVED" : "OPEN",
          },
        },
      ]);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const comments = (context?.comments || []).filter(
    (c: any) => filter === "ALL" || c.content.status === filter,
  );
  return (
    <section className="comments-panel" aria-label="正文评论">
      <header>
        <div>
          <h3>评论与协作</h3>
          <p>结合正文、依据和已有判断，留下具体意见。</p>
        </div>
        <select
          aria-label="评论筛选"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="OPEN">未解决</option>
          <option value="RESOLVED">已解决</option>
          <option value="ALL">全部评论</option>
        </select>
      </header>
      {anchor?.quote && (
        <blockquote className="selection-quote">
          <small>当前圈选</small>
          <p>{anchor.quote}</p>
          <button onClick={onClearAnchor}>取消圈选引用</button>
        </blockquote>
      )}
      <label>
        我的意见
        <textarea
          aria-label="我的评论"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="可先圈选一段正文，再说明希望优化的地方。"
        />
      </label>
      <div className="comment-actions">
        <button
          className="primary"
          disabled={busy || !text.trim()}
          onClick={() => void add()}
        >
          保存评论
        </button>
        <button disabled={busy || !text.trim()} onClick={() => void add(true)}>
          保存意见并请助手优化
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {comments.map((c: any) => {
        const target = c.content.target;
        const exact = target?.revisionId === detail.revision.id;
        return (
          <article key={c.id} className="comment-card">
            <small>
              {exact ? "当前正文修订" : "原评论依据 · 与当前修订不同"} ·{" "}
              {c.content.status === "OPEN" ? "未解决" : "已解决"}
            </small>
            {c.content.anchor?.quote && (
              <blockquote>{c.content.anchor.quote}</blockquote>
            )}
            <p>{c.content.text}</p>
            {!exact && (
              <details>
                <summary>查看评论原始上下文</summary>
                <p>{target?.label}</p>
                <small>{target?.revisionId || "未登记精确修订"}</small>
                <Rich value={target?.blocks} />
              </details>
            )}
            <div>
              <button disabled={busy} onClick={() => void resolve(c)}>
                {c.content.status === "OPEN" ? "标记已解决" : "重新打开"}
              </button>
              <button
                onClick={() =>
                  void read<Detail>("objects/" + encodeURIComponent(c.id))
                    .then(setAssistant)
                    .catch((e) => setError(e.message))
                }
              >
                结合这条意见问助手
              </button>
              <button onClick={() => onOpen(c.id)}>评论版本记录</button>
            </div>
          </article>
        );
      })}
      {!comments.length && <p className="empty">此筛选下暂无评论。</p>}
      {context?.commentsTruncated && (
        <p>先显示最近 100 条；全部评论可在系统管理的评论记录中查找。</p>
      )}
      {assistant && (
        <div className="comment-assistant">
          <button onClick={() => setAssistant(null)}>收起助手</button>
          <Assistant
            key={assistant.revision.id}
            detail={assistant}
            onClose={() => setAssistant(null)}
            onOpen={onOpen}
            onApplied={() => {
              void read<Detail>("objects/" + encodeURIComponent(assistant.id), {
                refresh: true,
              }).then((next) =>
                setAssistant((current) =>
                  current?.id === next.id ? next : current,
                ),
              );
              onChanged();
            }}
          />
        </div>
      )}
    </section>
  );
}
