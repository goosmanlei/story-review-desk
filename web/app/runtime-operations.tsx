"use client";
import { useState } from "react";
import { read } from "./client";
import { useSession } from "./session";
const states: Record<string, string> = {
  QUEUED: "排队中",
  RUNNING: "执行中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  RESULT_UNKNOWN: "结果待核查",
};
export function RuntimeOperations() {
  const [id, setId] = useSession("runtime-operation-query", ""),
    [value, setValue] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function query() {
    setBusy(true);
    setError("");
    try {
      setValue(
        await read("operations/" + encodeURIComponent(id.trim()), {
          refresh: true,
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="runtime-operation-query">
      <h3>操作记录与结果查询</h3>
      <p>
        使用网页、项目命令或后台任务给出的操作编号核查结果。结果未知时先查询原操作。
      </p>
      <label>
        操作编号
        <input
          aria-label="查询操作编号"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <button disabled={busy || !id.trim()} onClick={() => void query()}>
        查询原操作
      </button>
      {error && <p role="alert">{error}</p>}
      {value && (
        <article>
          <b>{states[value.status] || value.status}</b>
          <p>{value.error?.message}</p>
          <details>
            <summary>运行回执与核验依据</summary>
            <pre>{JSON.stringify(value, null, 2)}</pre>
          </details>
        </article>
      )}
    </section>
  );
}
