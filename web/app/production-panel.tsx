"use client";
import { useEffect, useState } from "react";
import { post, read } from "./client";
import { useSession } from "./session";
import type { Detail } from "./types";
export function RightsPanel({
  detail,
  busy,
  onSave,
}: {
  detail: Detail;
  busy: boolean;
  onSave: (command: any) => void;
}) {
  const [fact, setFact] = useState(detail.rights?.fact || "UNKNOWN"),
    [internal, setInternal] = useState(
      detail.rights?.internalAttestation || false,
    ),
    [note, setNote] = useSession("rights-note:" + detail.revision.id, "");
  return (
    <details className="review-panel">
      <summary>记录此版本的权利事实</summary>
      <p>项目内部适用确认仅用于本项目下传；保留事实依据及所指版本。</p>
      <label>
        权利事实
        <select
          value={fact}
          onChange={(e) => {
            setFact(e.target.value);
            if (e.target.value === "BLOCKED") setInternal(false);
          }}
        >
          <option value="UNKNOWN">未知</option>
          <option value="CLEAR">已有明确权利依据</option>
          <option value="BLOCKED">禁止下传</option>
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          disabled={fact === "BLOCKED"}
          checked={internal}
          onChange={(e) => setInternal(e.target.checked)}
        />
        确认符合项目内部适用条件
      </label>
      <label>
        事实来源与适用范围
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button
        disabled={busy || !note.trim()}
        onClick={() =>
          onSave({
            type: "rights.record",
            id: detail.id,
            expectedVersion: detail.version,
            revisionId: detail.revision.id,
            fact,
            internalAttestation: internal,
            evidence: { note },
          })
        }
      >
        保存权利事实
      </button>
    </details>
  );
}
export function ProductionPanel({
  detail,
  onOpen,
}: {
  detail: Detail;
  onOpen: (id: string, revisionId?: string) => void;
}) {
  const [operation, setOperation] = useSession<any>(
      "production-operation:" + detail.id,
      null,
    ),
    [confirmed, setConfirmed] = useState(false),
    [kind, setKind] = useState("GENERATE"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [capabilities, setCapabilities] = useState<string[]>([]);
  useEffect(() => {
    read("health", { refresh: true })
      .then((r) => setCapabilities(r.worker?.value?.capabilities || []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (
      !operation?.operationId ||
      !["QUEUED", "RUNNING"].includes(operation.status)
    )
      return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await read("operations/" + operation.operationId, {
          refresh: true,
        });
        if (active) {
          setOperation(value);
          if (["QUEUED", "RUNNING"].includes(value.status))
            timer = setTimeout(poll, 750);
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [operation?.operationId, operation?.status]);
  async function generate() {
    const operationId = crypto.randomUUID();
    setBusy(true);
    setError("");
    setOperation({ operationId, status: "RESULT_UNKNOWN" });
    try {
      setOperation(
        await post("jobs", {
          operationId,
          kind,
          objectId: detail.id,
          expectedVersion: detail.version,
          revisionId: detail.revision.id,
          authorized: true,
          authorization: {
            objectId: detail.id,
            revisionId: detail.revision.id,
          },
        }),
      );
      setConfirmed(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="review-panel">
      <h3>执行已锁定的实际输入</h3>
      <p>产物保存为候选版本。执行授权仅适用于当前输入修订。</p>
      <select
        aria-label="制作任务类型"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      >
        <option value="GENERATE">生成素材</option>
        <option value="MEDIA_PROCESS">媒体处理</option>
      </select>
      {!capabilities.includes(kind) && <p>本机尚未配置此制作工作器。</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核对当前输入、产出素材族，并授权本次执行
      </label>
      <button
        disabled={
          busy ||
          !confirmed ||
          !capabilities.includes(kind) ||
          detail.state !== "ADOPTED" ||
          detail.invalidations.length > 0 ||
          Boolean(
            operation &&
              ["QUEUED", "RUNNING", "RESULT_UNKNOWN"].includes(
                operation.status,
              ),
          )
        }
        onClick={generate}
      >
        授权并执行一次
      </button>
      {operation && (
        <div>
          <p>操作编号：{operation.operationId}</p>
          <p>
            {
              (
                {
                  QUEUED: "排队中",
                  RUNNING: "执行中",
                  SUCCEEDED: "执行成功",
                  FAILED: "执行失败",
                  CANCELLED: "已取消",
                  RESULT_UNKNOWN: "结果待核查",
                } as Record<string, string>
              )[operation.status]
            }
          </p>
          <button
            onClick={() =>
              read("operations/" + operation.operationId, { refresh: true })
                .then(setOperation)
                .catch((e) => setError(String(e)))
            }
          >
            查询原操作
          </button>
          {operation.status === "QUEUED" && (
            <button
              onClick={() =>
                post("operations/" + operation.operationId + "/cancel", {
                  operationId: crypto.randomUUID(),
                })
                  .then(() =>
                    read("operations/" + operation.operationId, {
                      refresh: true,
                    }),
                  )
                  .then(setOperation)
                  .catch((e) => setError(String(e)))
              }
            >
              取消排队
            </button>
          )}
          {operation.result?.assets?.map((a: any) => (
            <button key={a.id} onClick={() => onOpen(a.id, a.revisionId)}>
              查看产物
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
