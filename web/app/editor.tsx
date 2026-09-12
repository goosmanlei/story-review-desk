"use client";
import type { Detail, Draft } from "./types";
import { DependencyPicker } from "./dependency-picker";
import { ConfigEditor } from "./config-editor";
import { LinkPicker } from "./link-picker";
const fields: Record<string, Array<[string, string]>> = {
  SOURCE: [
    ["description", "资料说明"],
    ["text", "来源正文"],
  ],
  STORY: [["description", "故事结构与创作说明"]],
  EPISODE: [
    ["openingHook", "开场与承接"],
    ["coreAdvance", "推进与转折"],
    ["endingCliffhanger", "结尾与承接"],
    ["reviewQuestion", "审阅问题"],
  ],
  SCENE: [
    ["purpose", "本场任务"],
    ["audienceKnown", "观众已知"],
    ["audienceWithheld", "保留信息"],
    ["transition", "场间承接"],
  ],
  ENTITY: [["description", "主体档案"]],
  STATE: [["description", "状态依据"]],
  REPRESENTATION: [["description", "表现定义"]],
  RELATION: [
    ["description", "关系说明"],
    ["type", "关系类型"],
  ],
  SPACE: [["description", "空间设定"]],
  REQUIREMENT: [["description", "素材需求"]],
  MATERIAL: [["description", "素材说明"]],
  PROMPT: [
    ["text", "提示词正文"],
    ["prompt", "提示词"],
  ],
  CALL: [
    ["description", "调用说明"],
    ["model", "模型"],
    ["prompt", "提示词"],
  ],
  EXPECTED_OUTPUT: [["description", "预期产物"]],
  PREPARATION: [
    ["sourceSummary", "场景依据"],
    ["audienceTakeaway", "观众所得"],
  ],
  COVERAGE: [["description", "节拍覆盖"]],
  SHOT_DESIGN: [["description", "镜头设计说明"]],
  SHOT: [
    ["visualIntent", "画面意图"],
    ["actionIntent", "动作与表演"],
    ["soundIntent", "声音设计"],
    ["dialogueContext", "对白"],
    ["audienceTakeaway", "观众所得"],
  ],
  INPUT_LOCK: [["description", "实际输入说明"]],
  ASSEMBLY: [["description", "场景剪辑说明"]],
  DELIVERABLE: [["description", "成片说明"]],
  COMMENT: [["text", "评论正文"]],
  GUIDANCE: [["text", "项目指引"]],
  NOTE: [["description", "候选说明"]],
};
export function Editor({
  detail,
  draft,
  onChange,
}: {
  detail: Detail;
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const linkOptions: Record<string, Array<[string, string]>> = {
    EPISODE: [["SCENE", "SCENE"]],
    STATE: [["ENTITY", "ENTITY"]],
    REPRESENTATION: [
      ["ENTITY", "ENTITY"],
      ["STATE", "STATE"],
    ],
    RELATION: [["ENTITY", "ENTITY"]],
    REQUIREMENT: [
      ["ENTITY", "ENTITY"],
      ["STATE", "STATE"],
      ["REPRESENTATION", "REPRESENTATION"],
    ],
    MATERIAL: [["REQUIREMENT", "REQUIREMENT"]],
    INPUT_LOCK: [["MATERIAL", "FAMILY"]],
    PREPARATION: [["SCENE", "SCENE"]],
    SHOT_DESIGN: [
      ["SCENE", "SCENE"],
      ["REQUIREMENT", "REQUIREMENT"],
    ],
    ASSEMBLY: [["SCENE", "SCENE"]],
    SHOT: [
      ["SCENE", "SCENE"],
      ["REQUIREMENT", "REQUIREMENT"],
    ],
  };
  const set = (key: string, value: any) =>
      onChange({ ...draft, content: { ...draft.content, [key]: value } }),
    blocks = draft.content.blocks || draft.content.scriptBlocks;
  return (
    <form className="edit-form" onSubmit={(e) => e.preventDefault()}>
      <label>
        标题
        <input
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </label>
      {(fields[detail.kind] || [["description", "说明"]]).map(
        ([key, label]) => draft.content[key] && typeof draft.content[key] === "object" ? (
          <fieldset key={key}><legend>{label}</legend><ConfigEditor value={draft.content[key]} onChange={(v) => set(key, v)} /></fieldset>
        ) : (
          <label key={key}>
            {label}
            <textarea
              value={
                typeof draft.content[key] === "string" ? draft.content[key] : ""
              }
              rows={key === "text" ? 16 : 4}
              onChange={(e) => set(key, e.target.value)}
            />
          </label>
        ),
      )}
      {detail.kind === "SCENE" && (
        <fieldset>
          <legend>场正文</legend>
          {blocks ? (
            blocks.map((block: any, index: number) => (
              <div className="block-editor" key={block.id}>
                <div>
                  <span>{index + 1}</span>
                  <button
                    type="button"
                    disabled={!index}
                    onClick={() => {
                      const next = [...blocks];
                      [next[index - 1], next[index]] = [
                        next[index],
                        next[index - 1],
                      ];
                      set("blocks", next);
                    }}
                  >
                    上移段落
                  </button>
                  <button
                    type="button"
                    disabled={index === blocks.length - 1}
                    onClick={() => {
                      const next = [...blocks];
                      [next[index + 1], next[index]] = [
                        next[index],
                        next[index + 1],
                      ];
                      set("blocks", next);
                    }}
                  >
                    下移段落
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      set(
                        "blocks",
                        blocks.filter((_: any, i: number) => i !== index),
                      )
                    }
                  >
                    删除段落
                  </button>
                  <select
                    aria-label={"第 " + (index + 1) + " 段类型"}
                    value={block.type || "action"}
                    onChange={(e) =>
                      set(
                        "blocks",
                        blocks.map((b: any, i: number) =>
                          i === index ? { ...b, type: e.target.value } : b,
                        ),
                      )
                    }
                  >
                    <option value="action">动作</option>
                    <option value="dialogue">对白</option>
                    <option value="heading">标题</option>
                  </select>
                  <input
                    aria-label={"第 " + (index + 1) + " 段说话人"}
                    placeholder="说话人"
                    value={block.speaker || ""}
                    onChange={(e) =>
                      set(
                        "blocks",
                        blocks.map((b: any, i: number) =>
                          i === index ? { ...b, speaker: e.target.value } : b,
                        ),
                      )
                    }
                  />
                </div>
                <textarea
                  aria-label={"第 " + (index + 1) + " 段正文"}
                  value={block.text || ""}
                  rows={3}
                  onChange={(e) =>
                    set(
                      "blocks",
                      blocks.map((b: any, i: number) =>
                        i === index ? { ...b, text: e.target.value } : b,
                      ),
                    )
                  }
                />
              </div>
            ))
          ) : (
            <textarea
              aria-label="场正文"
              value={draft.content.text || ""}
              rows={18}
              onChange={(e) => set("text", e.target.value)}
            />
          )}
          <button
            type="button"
            onClick={() =>
              set("blocks", [
                ...(blocks ||
                  (draft.content.text
                    ? [
                        {
                          id: crypto.randomUUID(),
                          type: "action",
                          text: draft.content.text,
                        },
                      ]
                    : [])),
                {
                  id: crypto.randomUUID(),
                  type: "action",
                  speaker: "",
                  text: "",
                },
              ])
            }
          >
            增加段落
          </button>
        </fieldset>
      )}
      {detail.kind === "REQUIREMENT" && (
        <label>
          验收要点（每行一项）
          <textarea
            rows={8}
            value={(draft.content.acceptanceCriteria || []).join("\n")}
            onChange={(e) =>
              set("acceptanceCriteria", e.target.value.split("\n"))
            }
          />
        </label>
      )}
      {detail.kind === "EPISODE" && (
        <fieldset>
          <legend>本集场次顺序</legend>
          {(draft.links || detail.links)
            .filter((l) => l.role === "SCENE")
            .map((l, index, all) => (
              <div className="reorder" key={l.id}>
                <span>
                  {detail.links.find((x) => x.id === l.id)?.title || l.id}
                </span>
                <button
                  type="button"
                  disabled={!index}
                  onClick={() => {
                    const order = [...all];
                    [order[index - 1], order[index]] = [
                      order[index],
                      order[index - 1],
                    ];
                    onChange({
                      ...draft,
                      links: [
                        ...(draft.links || detail.links).filter(
                          (x) => x.role !== "SCENE",
                        ),
                        ...order,
                      ],
                    });
                  }}
                >
                  上移
                </button>
                <button
                  type="button"
                  disabled={index === all.length - 1}
                  onClick={() => {
                    const order = [...all];
                    [order[index], order[index + 1]] = [
                      order[index + 1],
                      order[index],
                    ];
                    onChange({
                      ...draft,
                      links: [
                        ...(draft.links || detail.links).filter(
                          (x) => x.role !== "SCENE",
                        ),
                        ...order,
                      ],
                    });
                  }}
                >
                  下移
                </button>
              </div>
            ))}
        </fieldset>
      )}
      {[
        "SPACE",
        "INPUT_LOCK",
        "SHOT_DESIGN",
        "SHOT",
        "PREPARATION",
        "ASSEMBLY",
        "DELIVERABLE",
        "CALL",
        "PROMPT",
      ].includes(detail.kind) && (
        <DependencyPicker detail={detail} draft={draft} onChange={onChange} />
      )}
      {[
        "design",
        "camera",
        "dressing",
        "segments",
        "composition",
        "motion",
        "lighting",
        "timing",
        "durationSeconds",
        "beats",
        "shots",
        "constraints",
        "visual",
        "sound",
        "performance",
        "continuity",
        "outputSpec",
      ]
        .filter((key) => draft.content[key] !== undefined)
        .map((key) => (
          <details key={key}>
            <summary>详细内容</summary>
            <ConfigEditor
              value={{ [key]: draft.content[key] }}
              onChange={(value) => set(key, value[key])}
            />
          </details>
        ))}
      <fieldset>
        <legend>关联对象</legend>
        {(draft.links || detail.links).map((l) => (
          <div className="reorder" key={l.id + l.role}>
            <span>
              {(l as any).title ||
                detail.links.find((x) => x.id === l.id)?.title ||
                l.id}
            </span>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...draft,
                  links: (draft.links || detail.links).filter(
                    (x) => x.id !== l.id || x.role !== l.role,
                  ),
                })
              }
            >
              移除关联
            </button>
          </div>
        ))}
        {(linkOptions[detail.kind] || []).map(([kind, role]) => (
          <LinkPicker
            kind={kind}
            key={role}
            label="添加关联"
            onChoose={(item) => {
              const links = draft.links || detail.links;
              if (!links.some((l) => l.id === item.id && l.role === role))
                onChange({ ...draft, links: [...links, { ...item, role }] });
            }}
          />
        ))}
      </fieldset>
    </form>
  );
}
