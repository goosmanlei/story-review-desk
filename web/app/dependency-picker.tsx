"use client";
import { useState } from "react";
import { read } from "./client";
import { LinkPicker } from "./link-picker";
import { type Detail, type Draft, kindLabels } from "./types";
export function DependencyPicker({
  detail,
  draft,
  onChange,
}: {
  detail: Detail;
  draft: Draft;
  onChange: (value: Draft) => void;
}) {
  const actual = detail.kind === "INPUT_LOCK",
    kinds = actual
      ? ["ASSET", "CALL", "PROMPT"]
      : [
          "SCENE",
          "REQUIREMENT",
          "STATE",
          "REPRESENTATION",
          "PREPARATION",
          "SHOT_DESIGN",
          "SHOT",
          "ASSET",
          "CALL",
          "PROMPT",
        ];
  const [kind, setKind] = useState(kinds[0]),
    [selected, setSelected] = useState<Detail | null>(null),
    [revision, setRevision] = useState(""),
    [error, setError] = useState("");
  const dependencies = draft.dependencies || detail.dependencies;
  return (
    <fieldset>
      <legend>{actual ? "实际输入的精确版本" : "此修订使用的依据版本"}</legend>
      {dependencies.map((d) => (
        <div className="reorder" key={d.revisionId}>
          <span>
            {d.title || d.objectId || d.revisionId} ·{" "}
            {d.purpose === "ACTUAL_INPUT" ? "实际输入" : "设计依据"}
          </span>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...draft,
                dependencies: dependencies.filter(
                  (x) => x.revisionId !== d.revisionId,
                ),
              })
            }
          >
            移除依据
          </button>
        </div>
      ))}
      <select
        aria-label="依据类型"
        value={kind}
        onChange={(e) => {
          setKind(e.target.value);
          setSelected(null);
        }}
      >
        {kinds.map((k) => (
          <option key={k} value={k}>
            {kindLabels[k]}
          </option>
        ))}
      </select>
      <LinkPicker
        kind={kind}
        label="选择依据及版本"
        onChoose={async (item) => {
          try {
            const value = await read<Detail>(
              "objects/" + encodeURIComponent(item.id),
              { refresh: true },
            );
            setSelected(value);
            setRevision(
              (actual ? value.adoptedRevisionId : value.draftRevisionId) || "",
            );
            setError("");
          } catch (e) {
            setError(String(e));
          }
        }}
      />
      {selected && (
        <div>
          <p>{selected.title}</p>
          <select
            aria-label="依据修订"
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
          >
            <option value="">选择修订</option>
            {selected.versions
              .filter((v) => !actual || v.id === selected.adoptedRevisionId)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  修订 {v.number}
                  {v.id === selected.adoptedRevisionId ? " · 已采用" : ""}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={!revision}
            onClick={() => {
              onChange({
                ...draft,
                dependencies: [
                  ...dependencies.filter((d) => d.objectId !== selected.id),
                  {
                    objectId: selected.id,
                    title: selected.title,
                    revisionId: revision,
                    purpose: actual ? "ACTUAL_INPUT" : "DESIGN",
                  },
                ],
              });
              setSelected(null);
            }}
          >
            添加此版本
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
