"use client";
import { useEffect, useRef, useState } from "react";
import { post, read, runtimeHeaders, invalidateReads } from "./client";
import { useSession } from "./session";
const labels: Record<string, string> = {
  MAINTENANCE_VERIFY: "实例核验",
  MAINTENANCE_BACKUP: "完整备份",
  MAINTENANCE_RESTORE: "独立恢复",
  QUEUED: "等待执行",
  RUNNING: "正在执行",
  SUCCEEDED: "已完成",
  FAILED: "未完成",
  CANCELLED: "已取消",
  RESULT_UNKNOWN: "结果待核",
};
export function MaintenancePanel() {
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [operation, setOperation] = useSession<any>("maintenance-operation", null),
    [backup, setBackup] = useSession("restore-backup", ""),
    [target, setTarget] = useSession("restore-target", ""),
    [busy, setBusy] = useState(false),
    [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = async (id = operation?.id) => {
    try {
      const v = await read("maintenance", { refresh: true });
      setState(v);
      if (id) {
        const o = await read("operations/" + encodeURIComponent(id), {
          refresh: true,
        });
        setOperation({ id: o.operationId, status: o.status });
      }
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    void refresh();
    fileInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  useEffect(() => {
    if (
      !state?.operations?.some((o: any) =>
        ["QUEUED", "RUNNING"].includes(o.status),
      )
    )
      return;
    const t = setTimeout(() => void refresh(), 1500);
    return () => clearTimeout(t);
  }, [state, operation]);
  const locked =
    busy || ["QUEUED", "RUNNING", "RESULT_UNKNOWN"].includes(operation?.status);
  async function run(kind: string) {
    if (locked) return;
    setBusy(true);
    setError("");
    setMessage("");
    const id = crypto.randomUUID();
    setOperation({ id, status: "RESULT_UNKNOWN" });
    try {
      const r = await post("jobs", {
        operationId: id,
        kind,
        ...(kind === "MAINTENANCE_RESTORE"
          ? { backupId: backup, targetName: target, explicit: true }
          : {}),
      });
      setOperation({ id, status: r.status });
      setMessage("任务已登记，完成后在下方查看核验结果。");
      await refresh(id);
    } catch (e: any) {
      setError(e.message);
      if (e.responseStatus && e.responseStatus < 500)
        setOperation({ id, status: "FAILED" });
    } finally {
      setBusy(false);
    }
  }
  async function importPackage() {
    if (locked) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const objects = await read("objects?limit=1&historical=true", {
        refresh: true,
      });
      if (objects.total)
        throw Error(
          "项目包只导入独立空白审阅台。当前故事已有内容，请先建立空白项目，或从已登记备份恢复到新目录。",
        );
      const manifestFile = files.find((f) => f.name === "manifest.json");
      if (!manifestFile || manifestFile.size > 8 * 1024 * 1024)
        throw Error("请选择包含 manifest.json 的完整项目包目录。");
      const manifest = JSON.parse(await manifestFile.text());
      if (
        manifest.format !== "review-project-package" ||
        manifest.version !== 2 ||
        !Array.isArray(manifest.chunks) ||
        !Array.isArray(manifest.media)
      )
        throw Error("项目包格式或版本无效");
      const prefix = manifestFile.webkitRelativePath.slice(
          0,
          -"manifest.json".length,
        ),
        map = new Map(
          files.map((f) => [f.webkitRelativePath.slice(prefix.length), f]),
        );
      const getFile = (relative: string) => {
        if (
          typeof relative !== "string" ||
          relative.split("/").some((s) => !s || s === ".." || s === ".")
        )
          throw Error("项目包路径无效");
        const f = map.get(relative);
        if (!f) throw Error("项目包缺少 " + relative);
        return f;
      };
      const chunks = manifest.chunks.map((c: any) => getFile(c.path)),
        transfer = new Blob([
          JSON.stringify(manifest.project) + "\n",
          ...chunks,
        ]);
      if (transfer.size !== manifest.transfer?.bytes)
        throw Error("项目数据大小与清单不符");
      const upload = async (
        route: string,
        body: Blob,
        query: Record<string, string>,
      ) => {
        const id = crypto.randomUUID();
        setOperation({ id, status: "RESULT_UNKNOWN" });
        const response = await fetch(
          "/api/v1/" +
            route +
            "?" +
            new URLSearchParams({ ...query, operationId: id }),
          {
            method: "POST",
            headers: {
              ...(await runtimeHeaders()),
              "Content-Type": "application/octet-stream",
            },
            body,
          },
        );
        const receipt = await response.json();
        if (!response.ok) {
          setOperation({ id, status: "FAILED" });
          throw Error(receipt.error?.message || "上传失败");
        }
        setOperation({ id, status: receipt.status });
        for (;;) {
          const o = await read("operations/" + id, { refresh: true });
          setOperation({ id, status: o.status });
          if (o.status === "SUCCEEDED") return;
          if (["FAILED", "CANCELLED", "RESULT_UNKNOWN"].includes(o.status))
            throw Error(o.error?.message || o.status);
          await new Promise((r) => setTimeout(r, 500));
        }
      };
      for (const [i, m] of manifest.media.entries()) {
        setMessage(`正在导入登记媒体 ${i + 1} / ${manifest.media.length}`);
        await upload("upload", getFile("media/" + m.sha256), {
          sha256: m.sha256,
          forImport: "true",
        });
      }
      setMessage("正在验证并导入业务数据…");
      await upload("import", transfer, { sha256: manifest.transfer.sha256 });
      invalidateReads();
      setMessage("导入已完成。重新打开审阅台以进入新的运行期。");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="maintenance-workspace">
      <p>备份包含业务版本、原始资料与登记媒体；恢复建立独立副本。</p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="management-actions">
        <button
          disabled={locked}
          onClick={() => void run("MAINTENANCE_VERIFY")}
        >
          核验当前实例
        </button>
        <button
          disabled={locked}
          onClick={() => void run("MAINTENANCE_BACKUP")}
        >
          创建完整备份
        </button>
        <button onClick={() => void refresh()}>刷新状态</button>
      </div>
      {operation?.status === "RESULT_UNKNOWN" && (
        <p role="alert">操作结果待核，先刷新原编号的状态：{operation.id}</p>
      )}
      <details className="package-import">
        <summary>导入完整项目包</summary>
        <p>
          在独立空白审阅台中，选择解压后的项目包目录。原件按登记 SHA
          核验；不导入凭据或执行资格。
        </p>
        <input
          ref={fileInput}
          type="file"
          multiple
          aria-label="完整项目包目录"
          disabled={locked}
          onChange={(e) => setFiles(Array.from(e.target.files || []))}
        />
        <button
          disabled={locked || !files.length}
          onClick={() => void importPackage()}
        >
          核验并导入到当前空白实例
        </button>
      </details>
      {!!state?.backups?.length && (
        <section className="management-restore">
          <h3>下载或恢复已核验备份</h3>
          <label>
            已有备份
            <select
              aria-label="已有备份"
              value={backup}
              onChange={(e) => setBackup(e.target.value)}
            >
              <option value="">选择一份完整备份</option>
              {state.backups.map((b: any) => (
                <option value={b.id} key={b.id}>
                  {new Date(b.createdAt).toLocaleString()} · {b.mediaFiles}{" "}
                  份媒体
                </option>
              ))}
            </select>
          </label>
          <label>
            新实例目录名
            <input
              value={target}
              aria-label="新实例目录名"
              onChange={(e) => setTarget(e.target.value)}
              placeholder="例如 my-story-copy"
            />
          </label>
          <button
            disabled={locked || !backup || !target.trim()}
            onClick={() => void run("MAINTENANCE_RESTORE")}
          >
            恢复到新目录
          </button>
          {state.backups
            .filter((b: any) => b.id === backup)
            .map((b: any) => (
              <a className="button" key={b.id} href={b.downloadUrl} download>
                下载完整备份
              </a>
            ))}
          <p>
            恢复副本位于本项目受管恢复目录，使用独立数据库，完成后显示精确目录；上线由该副本自己的部署入口完成。
          </p>
        </section>
      )}
      <div className="maintenance-operations" aria-label="维护任务记录">
        {state?.operations?.map((o: any) => (
          <article key={o.id}>
            <header>
              <b>{labels[o.kind] || o.kind}</b>
              <span className="pill">{labels[o.status] || o.status}</span>
            </header>
            {o.error && <p>{o.error.message}</p>}
            {o.result && (
              <p>
                {o.result.status === "RESTORED_VERIFIED"
                  ? "独立副本已恢复并核验，当前实例未切换。"
                  : o.result.passed
                    ? "业务数据、来源和登记媒体完整性核验通过。"
                    : ""}
              </p>
            )}
            <details>
              <summary>核验依据</summary>
              <dl>
                <dt>操作编号</dt>
                <dd>{o.id}</dd>
                {o.result?.sha256 && (
                  <>
                    <dt>业务包 SHA</dt>
                    <dd className="mono">{o.result.sha256}</dd>
                  </>
                )}
                {o.result?.mediaFiles !== undefined && (
                  <>
                    <dt>登记媒体</dt>
                    <dd>{o.result.mediaFiles} 份</dd>
                  </>
                )}
                {o.result?.target && (
                  <>
                    <dt>独立项目目录</dt>
                    <dd>{o.result.target}</dd>
                  </>
                )}
              </dl>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
