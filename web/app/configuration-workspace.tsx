"use client";
import { ConfigEditor } from "./config-editor";
import { useSession } from "./session";
const topics = [
  ["reviewStandards", "审阅标准"],
  ["entityTypes", "主体类型"],
  ["materialTypes", "素材分类"],
  ["productionStages", "制作流程"],
  ["technicalStandards", "技术规格"],
  ["sourceRules", "来源规则"],
  ["assistant", "AI 助手"],
  ["limits", "资源边界"],
  ["project", "故事与项目规则"],
];
export function ConfigurationWorkspace({
  configuration,
  drafts,
  onChange,
  onSave,
  busy = false,
}: {
  configuration: any;
  drafts: any;
  onChange: (scope: string, content: any, version: number) => void;
  onSave: (scope: string) => void;
  busy?: boolean;
}) {
  const [topic, setTopic] = useSession(
    "configuration-topic",
    "reviewStandards",
  );
  const scope = topic === "project" ? "project" : "system",
    row = configuration?.items.find((r: any) => r.scope === scope),
    value = drafts[scope]?.content || row?.content;
  if (!row) return <p role="status">正在读取配置…</p>;
  return (
    <div className="configuration-workspace">
      <nav aria-label="配置目录">
        {topics.map(([id, label]) => (
          <button
            key={id}
            aria-current={topic === id ? "location" : undefined}
            onClick={() => setTopic(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <section>
        <header>
          <small>
            {scope === "system" ? "通用系统规则" : "当前故事规则"} · 版本{" "}
            {row.version}
          </small>
          <h2>{topics.find((t) => t[0] === topic)?.[1]}</h2>
        </header>
        <ConfigEditor
          name={topic === "project" ? "" : topic}
          value={topic === "project" ? value : (value[topic] ?? null)}
          onChange={(v) =>
            onChange(
              scope,
              topic === "project" ? v : { ...value, [topic]: v },
              drafts[scope]?.basedOnVersion ?? row.version,
            )
          }
        />
        <div className="save-bar">
          <button
            className="primary"
            disabled={busy || !drafts[scope]}
            onClick={() => onSave(scope)}
          >
            保存{scope === "system" ? "系统" : "项目"}配置
          </button>
          {drafts[scope] && <span className="unsaved">有未保存修改</span>}
        </div>
        <details>
          <summary>配置导入与导出</summary>
          <p>
            系统规则与项目规则分别交换；导入内容先进入表单草稿，核对后保存。
          </p>
          <button
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify({ scope, content: value }, null, 2)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = scope + "-configuration.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
          >
            导出{scope === "system" ? "系统" : "项目"}配置
          </button>
          <ConfigImport
            scope={scope}
            onRead={(content) => onChange(scope, content, row.version)}
          />
        </details>
      </section>
    </div>
  );
}
import { useState } from "react";
function ConfigImport({
  scope,
  onRead,
}: {
  scope: string;
  onRead: (content: any) => void;
}) {
  const [error, setError] = useState("");
  return (
    <label>
      导入到配置草稿
      <input
        aria-label="导入配置文件"
        type="file"
        accept="application/json,.json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            if (file.size > 1024 * 1024) throw Error("配置文件超过 1 MiB");
            const parsed = JSON.parse(await file.text());
            if (
              parsed.scope !== scope ||
              !parsed.content ||
              typeof parsed.content !== "object" ||
              Array.isArray(parsed.content)
            )
              throw Error("配置归属不一致或格式无效");
            onRead(parsed.content);
            setError("");
          } catch (e: any) {
            setError(e.message);
          }
        }}
      />
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
