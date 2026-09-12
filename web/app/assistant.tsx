"use client";
import { useEffect, useState } from "react";
import { read, post, commands } from "./client";
import { useSession } from "./session";
import { Content } from "./content";
import type { Detail } from "./types";
export function Assistant({
  detail,
  onApplied,
  onOpen,
  onClose,
}: {
  detail: Detail;
  onApplied: () => void;
  onOpen: (id: string, revisionId?: string) => void;
  onClose?: () => void;
}) {
  const [prompt, setPrompt] = useSession(
      "assistant-prompt:" + detail.id,
      detail.kind === "COMMENT"
        ? "请结合评论的原始上下文，把这条意见优化为清楚、具体、可核对的修改建议。保留原观点，不替我作正式判断。"
        : "",
    ),
    [operation, setOperation] = useSession<any>(
      "assistant-job:" + detail.id,
      null,
    ),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState<any>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (
      !operation?.operationId ||
      !["QUEUED", "RUNNING", "SUCCEEDED"].includes(operation.status)
    )
      return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value: any = await read("operations/" + operation.operationId, {
          refresh: true,
        });
        if (!active) return;
        setOperation(value);
        if (value.status === "SUCCEEDED") {
          const suggestion = await read(
            "suggestions/" + operation.operationId,
            {
              refresh: true,
            },
          );
          if (active) setPreview(suggestion);
          return;
        }
        if (["QUEUED", "RUNNING"].includes(value.status))
          timer = setTimeout(poll, 750);
      } catch (e) {
        if (active) setError(e);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [operation?.operationId, operation?.status]);
  async function ask() {
    setBusy(true);
    setError(null);
    setPreview(null);
    const operationId = crypto.randomUUID();
    setOperation({ operationId, status: "RESULT_UNKNOWN" });
    try {
      setOperation(
        await post("jobs", {
          operationId,
          kind: "AI_SUGGEST",
          objectId: detail.id,
          expectedVersion: detail.version,
          revisionId: detail.revision.id,
          prompt,
        }),
      );
    } catch (e: any) {
      if (e.responseStatus && e.responseStatus < 500)
        setOperation({
          operationId,
          status: "FAILED",
          error: { message: e.message },
        });
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await commands([
        {
          type: "suggestion.apply",
          id: detail.id,
          expectedVersion: detail.version,
          suggestionId: operation.operationId,
        },
      ]);
      setPreview(null);
      setOperation(null);
      onApplied();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="assistant-panel" aria-label="AI 助手">
      <header>
        <div>
          <small>AI 助手 · 当前修订 {detail.revision.number}</small>
          <h3>
            {detail.kind === "COMMENT" ? "优化这条评论" : "结合当前版本讨论"}
          </h3>
        </div>
        {onClose && (
          <button aria-label="收起 AI 助手" onClick={onClose}>
            ×
          </button>
        )}
      </header>
      <p className="assistant-context-title">{detail.title}</p>
      {detail.kind === "COMMENT" && (
        <blockquote>
          {detail.revision.content.anchor?.quote && (
            <p>{detail.revision.content.anchor.quote}</p>
          )}
          <p>{detail.revision.content.text}</p>
        </blockquote>
      )}
      <p>先预览建议，应用时保存为草稿。未应用正文保留 10 分钟。</p>
      <textarea
        aria-label="给助手的问题"
        value={prompt}
        rows={4}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <button
        disabled={
          busy ||
          !prompt.trim() ||
          ["QUEUED", "RUNNING", "RESULT_UNKNOWN"].includes(operation?.status)
        }
        onClick={ask}
      >
        请求建议
      </button>
      {error && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
      {operation && (
        <p role="status">
          {{
            QUEUED: "正在排队",
            RUNNING: "正在生成建议",
            SUCCEEDED: "建议已就绪",
            FAILED: "执行失败",
            CANCELLED: "已取消",
            RESULT_UNKNOWN: "结果未知，请先核查原请求",
          }[operation.status as string] || operation.status}
          <small>
            {operation.operationId}
            {operation.providerRequestId && " · " + operation.providerRequestId}
          </small>
        </p>
      )}
      {operation?.error && <p>{operation.error.message}</p>}
      {operation?.status === "RESULT_UNKNOWN" && (
        <button
          onClick={() =>
            void read("operations/" + operation.operationId, { refresh: true })
              .then(setOperation)
              .catch(setError)
          }
        >
          核查原操作结果
        </button>
      )}
      {operation?.status === "QUEUED" && (
        <button
          onClick={() =>
            void post("operations/" + operation.operationId + "/cancel", {
              operationId: crypto.randomUUID(),
            })
              .then(() =>
                read("operations/" + operation.operationId, { refresh: true }),
              )
              .then(setOperation)
              .catch(setError)
          }
        >
          取消这次请求
        </button>
      )}
      {preview && (
        <section>
          <h4>建议预览</h4>
          <p>{preview.content.summary}</p>
          <Content
            detail={{
              ...detail,
              revision: {
                ...detail.revision,
                content: {
                  ...detail.revision.content,
                  ...preview.content.patch,
                },
              },
              media: [],
              links: [],
              dependencies: [],
            }}
            onOpen={onOpen}
          />
          {detail.kind !== "SOURCE" && (
            <button
              className="primary"
              disabled={
                busy ||
                preview.revisionId !== detail.revision.id ||
                !!preview.appliedRevisionId
              }
              onClick={apply}
            >
              将此建议应用为草稿
            </button>
          )}
        </section>
      )}
    </aside>
  );
}
