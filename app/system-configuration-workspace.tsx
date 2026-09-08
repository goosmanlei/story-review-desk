"use client";
import { useEffect, useState } from "react";
import { CONFIGURATION_SECTIONS, type ConfigurationGroup } from "../host/instance-runtime/configuration-sections.mjs";
import type {
  Configuration,
} from "../host/instance-runtime/configuration-model.mjs";
import type { ConfigurationState } from "../host/instance-runtime/configuration-service.mjs";
import { useRuntimeMode } from "./runtime-mode";
import "./system-configuration.css";
import { ReviewStandardsEditor } from "./review-standards-editor";
import { DomainConfigurationEditor } from "./domain-configuration-editor";
import { CREATOR_PRODUCTION_STAGES, creatorProductionStageForGate, creatorProductionStageDefinition, creatorProductionGateDefinition } from "./creator-production-workflow";
const groups = CONFIGURATION_SECTIONS.flatMap(section => section.groups);
type Group = ConfigurationGroup;
type State = ConfigurationState & {
  readOnly?: boolean;
  historical?: boolean;
  draft?: {
    revisionId: string;
    published?: boolean;
    configuration: Configuration;
    expectedReleaseId: string;
    upgradeKeys: string[];
  } | null;
};
type Preview = {
  previewHash: string;
  semanticChange: boolean;
  changedGroups: string[];
  affectedObjects: string[];
  retainedObjectCount: number;
  checks: string[];
};
async function read<T>(response: Response): Promise<T> {
  const value = (await response.json()) as { error?: unknown };
  if (!response.ok)
    throw new Error(
      typeof value.error === "string" ? value.error : "配置操作未完成",
    );
  return value as T;
}
const freshId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export function SystemConfigurationWorkspace() {
  const { hostedReadOnly } = useRuntimeMode();
  const [state, setState] = useState<State | null>(null);
  const [config, setConfig] = useState<Configuration | null>(null);
  const [group, setGroup] = useState<Group>("technical");
  const [profileId, setProfileId] = useState("episode-plan");
  const [gateId, setGateId] = useState("SHOT_PLAN_INPUT_LOCK");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [upgradeKeys, setUpgradeKeys] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedDraftVisible, setSavedDraftVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const readonly = hostedReadOnly || state?.readOnly;
  async function load() {
    if (!mayReplace()) return;
    const s = await read<State>(
      await fetch("/api/instance/configuration", { cache: "no-store" }),
    );
    setState(s);
    setConfig(s.configuration);
    setDraftId(s.draft?.revisionId || null);
    setPreview(null);
    setDirty(false);
    setSavedDraftVisible(false);
    setUpgradeKeys([]);
  }
  useEffect(() => {
    let active = true;
    void fetch("/api/instance/configuration", { cache: "no-store" })
      .then(read<State>)
      .then((s) => {
        if (active) {
          setState(s);
          setConfig(s.configuration);
          setDraftId(s.draft?.revisionId || null);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const leave = (event: Event) => {if(!window.confirm("有未保存的配置修改，离开后将丢失。仍要离开吗？"))event.preventDefault();};
    const locationBefore = window.location.href;
    const back = (event: PopStateEvent) => {if(new URL(window.location.href).searchParams.get("view") !== "system" && !window.confirm("有未保存的配置修改，离开后将丢失。仍要离开吗？")){window.history.pushState({}, "", locationBefore);event.stopImmediatePropagation();}};
    const link = (event: MouseEvent) => { const anchor=(event.target as Element)?.closest?.("a[href]"); if(anchor && !window.confirm("有未保存的配置修改，离开后将丢失。仍要离开吗？")) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", link, true);
    window.addEventListener("review:configuration-before-leave",leave);
    window.addEventListener("popstate",back,true);
    return () => {window.removeEventListener("beforeunload",warn);document.removeEventListener("click",link,true);window.removeEventListener("review:configuration-before-leave",leave);window.removeEventListener("popstate",back,true);};
  }, [dirty]);
  const mayReplace = () => !dirty || window.confirm("有未保存的配置修改，载入其他版本会丢弃这些修改。仍要载入吗？");
  function edit(fn: (c: Configuration) => void) {
    if (!config || readonly || busy) return;
    const next = structuredClone(config);
    fn(next);
    setConfig(next);
    setDirty(true);
    setPreview(null);
    setMessage("");
  }
  async function request(path: string, method: string, body: unknown) {
    const op = await read<{ mutationEtag: string }>(
      await fetch("/api/v8/operations/snapshot?summary=1", { cache: "no-store" }),
    );
    return await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "If-Match": op.mutationEtag,
        "Idempotency-Key": `configuration:${crypto.randomUUID()}`,
      },
      body: JSON.stringify(body),
    });
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  if (!state || !config)
    return (
      <section className="configuration-page" aria-label="系统配置编辑器">

        <h2>系统配置</h2>
        <p role={error ? "alert" : "status"}>
          {error || "正在读取当前有效配置…"}
        </p>
        {error && <button onClick={() => void action(load)}>重新读取</button>}
      </section>
    );
  const gate =
    config.workflow.gates.find((g) => g.id === gateId) ||
    config.workflow.gates[0];
  const creatorStage = creatorProductionStageDefinition(creatorProductionStageForGate(gate.id));
  const creatorStageGates = config.workflow.gates.filter(g => creatorProductionStageForGate(g.id) === creatorStage?.id);
  const gateScopeLabel = ({ SHOT: "单个镜头", SCENE: "当前场景", EPISODE: "当前分集", PROJECT: "全剧范围" } as Record<string, string>)[gate.scopeType] || "范围待核对";
  const text = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    multiline = false,
    help = "",
  ) => (
    <label key={label} className="configuration-field">
      {label}
      {multiline ? (
        <textarea
          aria-label={label}
          aria-describedby={help ? `configuration-${group}-${label}-help` : undefined}
          disabled={readonly}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          aria-label={label}
          aria-describedby={help ? `configuration-${group}-${label}-help` : undefined}
          disabled={readonly}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help && <small id={`configuration-${group}-${label}-help`} className="configuration-field-help">{help}</small>}
    </label>
  );
  const section = CONFIGURATION_SECTIONS.find(section => section.groups.some(([id]) => id === group))!;
  return (
    <section className="configuration-page" aria-label="系统配置编辑器">
      <header className="configuration-heading">
        <span className="configuration-badge">
          {readonly
              ? "只读镜像"
              : dirty
                ? "未保存草稿"
                : savedDraftVisible
                  ? "已保存草稿 · 未发布"
                  : state.initialized
                  ? "已发布配置"
                  : "当前规则 · 待固化"}
        </span>
      </header>
      <nav className="configuration-tabs" aria-label="系统配置分组">
        {CONFIGURATION_SECTIONS.map(({id, label, groups: children}) => (
          <button
            key={id}
            aria-pressed={section.id === id}
            onClick={() => setGroup(children[0][0])}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="configuration-layout">
        <section className="configuration-editor">
          {section.groups.length > 1 && <nav className="configuration-subtabs" aria-label={section.label}>{section.groups.map(([id,label]) => <button key={id} aria-pressed={group===id} onClick={()=>setGroup(id)}>{label}</button>)}</nav>}
          <header>
            <h2>{groups.find(([id]) => id === group)![1]}</h2>
            <p>
              本故事的覆盖只影响当前实例。已有审阅对象继续使用其绑定的规则。
            </p>
          </header>
          {group === "review" && <ReviewStandardsEditor config={config} state={state} profileId={profileId} onSelect={setProfileId} onEdit={edit} readonly={Boolean(readonly)} upgradeKeys={upgradeKeys} onUpgrade={keys=>{setUpgradeKeys(keys);setDirty(true);setPreview(null);}} />}
          {group === "entities" && <DomainConfigurationEditor value={config.domain} mode="structure" readonly={Boolean(readonly)} onChange={domain=>edit(c=>{c.schemaVersion="2.0";c.domain=domain;})} />}
          {group === "taxonomy" && (
            <>
              <h3>素材目录分类</h3>
              {config.taxonomy.categories.map((cat, ci) => (
                <article className="configuration-card" key={cat.id}>
                  <div className="configuration-card-heading">
                    <b>
                      {cat.icon} {cat.label}
                    </b>
                    <span>{cat.id}</span>
                  </div>
                  <div className="configuration-form-grid">
                    {text("一级分类", cat.label, (v) =>
                      edit((c) => {
                        const target = c.taxonomy.categories[ci];
                        if (!target.aliases.includes(target.label))
                          target.aliases.push(target.label);
                        target.label = v;
                      }),
                    )}
                    {text("图标", cat.icon, (v) =>
                      edit((c) => {
                        c.taxonomy.categories[ci].icon = v;
                      }),
                    )}
                    <label className="configuration-field">
                      色调
                      <select
                        disabled={readonly}
                        value={cat.tone}
                        onChange={(e) =>
                          edit((c) => {
                            c.taxonomy.categories[ci].tone = e.target.value;
                          })
                        }
                      >
                        {[
                          "people",
                          "scene",
                          "prop",
                          "dialogue",
                          "voice",
                          "foley",
                          "ambience",
                          "music",
                          "style",
                          "neutral",
                        ].map((tone, i) => (
                          <option key={tone} value={tone}>
                            {
                              [
                                "人物紫",
                                "场景绿",
                                "道具棕",
                                "台词蓝",
                                "配音红",
                                "拟音橙",
                                "环境青",
                                "配乐紫",
                                "参考灰",
                                "中性",
                              ][i]
                            }
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {cat.types.map((type, ti) => (
                    <div className="configuration-type" key={type.id}>
                      <div className="configuration-form-grid">
                        {text("二级类型", type.label, (v) =>
                          edit((c) => {
                            const t = c.taxonomy.categories[ci].types[ti];
                            if (!t.aliases.includes(t.label))
                              t.aliases.push(t.label);
                            t.label = v;
                          }),
                        )}
                        <label className="configuration-field">
                          媒介
                          <select
                            disabled={readonly}
                            value={type.mediaType}
                            onChange={(e) =>
                              edit((c) => {
                                c.taxonomy.categories[ci].types[ti].mediaType =
                                  e.target.value as typeof type.mediaType;
                              })
                            }
                          >
                            {[
                              ["IMAGE", "图像"],
                              ["AUDIO", "音频"],
                              ["VIDEO", "视频"],
                              ["TEXT", "文本"],
                            ].map(([id, label]) => (
                              <option key={id} value={id}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="configuration-field">
                          审阅标准
                          <select
                            disabled={readonly}
                            value={type.reviewProfileId}
                            onChange={(e) =>
                              edit((c) => {
                                c.taxonomy.categories[ci].types[
                                  ti
                                ].reviewProfileId = e.target.value;
                              })
                            }
                          >
                            {config.reviewProfiles
                              .filter((p) => p.subjectKind === "ASSET")
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.label}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="configuration-field">
                          生产方式
                          <select
                            disabled={readonly}
                            value={type.productionLane}
                            onChange={(e) =>
                              edit((c) => {
                                c.taxonomy.categories[ci].types[
                                  ti
                                ].productionLane = e.target.value;
                              })
                            }
                          >
                            {[
                              ["MANUAL_OR_ASSISTED", "人工与辅助制作"],
                              ["CODEX", "Codex执行"],
                              ["USER_EXTERNAL", "用户外部执行"],
                            ].map(([id, label]) => (
                              <option key={id} value={id}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {!readonly && (
                        <button
                          onClick={() =>
                            edit((c) =>
                              c.taxonomy.categories[ci].types.splice(ti, 1),
                            )
                          }
                        >
                          移除此类型
                        </button>
                      )}
                    </div>
                  ))}
                  {!readonly && (
                    <div className="configuration-row-actions">
                      <button
                        onClick={() =>
                          edit((c) =>
                            c.taxonomy.categories[ci].types.push({
                              id: freshId("type"),
                              label: "新类型",
                              aliases: [],
                              mediaType: "IMAGE",
                              reviewProfileId: "material-image",
                              productionLane: "MANUAL_OR_ASSISTED",
                            }),
                          )
                        }
                      >
                        ＋ 添加类型
                      </button>
                      <button
                        disabled={ci === 0}
                        onClick={() =>
                          edit((c) => {
                            const a = c.taxonomy.categories;
                            [a[ci - 1], a[ci]] = [a[ci], a[ci - 1]];
                          })
                        }
                      >
                        分类上移
                      </button>
                    </div>
                  )}
                </article>
              ))}
              {!readonly && (
                <button
                  onClick={() =>
                    edit((c) =>
                      c.taxonomy.categories.push({
                        id: freshId("category"),
                        label: "新分类",
                        aliases: [],
                        icon: "◇",
                        tone: "neutral",
                        types: [],
                      }),
                    )
                  }
                >
                  ＋ 添加分类
                </button>
              )}
            </>
          )}
          {group === "workflow" && (
            <>
              <p>按制作对象设置检查要求。输入锁定、独立审阅与权利限制持续有效；分组不改变已冻结对象的标准。</p>
              <nav className="configuration-tabs" aria-label="流程配置制作模块">
                {CREATOR_PRODUCTION_STAGES.map(stage => (
                  <button type="button" key={stage.id}
                    aria-pressed={creatorStage?.id === stage.id}
                    disabled={!config.workflow.gates.some(g => g.id === stage.defaultGateId)}
                    onClick={() => setGateId(stage.defaultGateId)}
                  >{String(stage.order).padStart(2, "0")} {stage.label}</button>
                ))}
              </nav>
              {creatorStage ? <p>{creatorStage.purpose}</p> : <p role="alert">当前检查尚未归入业务阶段，请核对配置身份；不会按名称猜测归属。</p>}
              <label className="configuration-field">
                本阶段检查项
                <select value={gate.id} onChange={e => setGateId(e.target.value)}>
                  {!creatorStage && <option value={gate.id}>{gate.label}</option>}
                  <optgroup label="制作工作区">
                    {creatorStageGates.filter(g => creatorProductionGateDefinition(g.id)?.subarea === "WORKSPACE").map(g => (
                      <option value={g.id} key={g.id}>{g.label}</option>
                    ))}
                  </optgroup>
                  {!!creatorStage?.exportGateIds.length && <optgroup label="导出时核对">
                    {creatorStageGates.filter(g => creatorProductionGateDefinition(g.id)?.subarea === "EXPORT_CHECKS").map(g => (
                      <option value={g.id} key={g.id}>{g.label}</option>
                    ))}
                  </optgroup>}
                </select>
              </label>
              <p>检查对象：{gateScopeLabel}。{gate.scopeType === "PROJECT" ? "导出检查覆盖全剧，不因选择某集而缩小范围；只在相关导出流程核对，不自动判定通过。" : "仅对适用对象核对；尚未明确的条件仍需补充依据。"}</p>
              {text("检查项名称", gate.label, (v) =>
                edit((c) => {
                  c.workflow.gates.find((g) => g.id === gate.id)!.label = v;
                }),
              )}
              {text(
                "检查目的",
                gate.purpose,
                (v) =>
                  edit((c) => {
                    c.workflow.gates.find((g) => g.id === gate.id)!.purpose = v;
                  }),
                true,
              )}
              <fieldset disabled={readonly}>
                <legend>额外前置检查（同类对象）</legend>
                {config.workflow.gates
                  .filter(
                    (g, i) =>
                      i <
                        config.workflow.gates.findIndex(
                          (x) => x.id === gate.id,
                        ) && g.scopeType === gate.scopeType,
                  )
                  .map((g) => (
                    <label key={g.id}>
                      <input
                        type="checkbox"
                        checked={gate.extraPrerequisites.includes(g.id)}
                        onChange={(e) =>
                          edit((c) => {
                            const target = c.workflow.gates.find(
                              (x) => x.id === gate.id,
                            )!;
                            target.extraPrerequisites = e.target.checked
                              ? [...target.extraPrerequisites, g.id]
                              : target.extraPrerequisites.filter(
                                  (id) => id !== g.id,
                                );
                          })
                        }
                      />
                      {g.label}
                    </label>
                  ))}
              </fieldset>
              <fieldset disabled={readonly}>
                <legend>额外交付要求</legend>
                {[
                  ["TECHNICAL_REPORT", "技术报告"],
                  ["CONTINUITY_REPORT", "连续性报告"],
                  ["SUBTITLE_FILE", "字幕文件"],
                  ["AUDIO_STEMS", "声音分轨"],
                ].map(([id, label]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={gate.additionalOutputTypes.includes(id)}
                      onChange={(e) =>
                        edit((c) => {
                          const target = c.workflow.gates.find(
                            (x) => x.id === gate.id,
                          )!;
                          target.additionalOutputTypes = e.target.checked
                            ? [...target.additionalOutputTypes, id]
                            : target.additionalOutputTypes.filter(
                                (x) => x !== id,
                              );
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <label>
                <input
                  disabled={readonly}
                  type="checkbox"
                  checked={config.workflow.earlyAmbience}
                  onChange={(e) =>
                    edit((c) => {
                      c.workflow.earlyAmbience = e.target.checked;
                    })
                  }
                />
                允许已锁定地点设定的无同步环境底声提前准备
              </label>
            </>
          )}
          {group === "workflow" && (
            <section className="configuration-card">
              <h3>素材制作前置条件</h3>
              <p>
                按永久需求与场次标识绑定；所选场正文通过后才可推进这些素材。
              </p>
              {(config.workflow.materialPrerequisites || []).map((rule, i) => (
                <div key={rule.id}>
                  {text("规则名称", rule.label, (v) =>
                    edit((c) => {
                      c.workflow.materialPrerequisites![i].label = v;
                    }),
                  )}
                  {text(
                    "需求标识（逗号分隔）",
                    rule.requirementIds.join(","),
                    (v) =>
                      edit((c) => {
                        c.workflow.materialPrerequisites![i].requirementIds = v
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                      }),
                  )}
                  {text(
                    "需确认的场次（逗号分隔）",
                    rule.requiredSceneIds.join(","),
                    (v) =>
                      edit((c) => {
                        c.workflow.materialPrerequisites![i].requiredSceneIds =
                          v
                            .split(/[,，]/)
                            .map((s) => s.trim())
                            .filter(Boolean);
                      }),
                  )}
                  {!readonly && (
                    <button
                      onClick={() =>
                        edit((c) => {
                          c.workflow.materialPrerequisites!.splice(i, 1);
                        })
                      }
                    >
                      移除此规则
                    </button>
                  )}
                </div>
              ))}
              {!readonly && (
                <button
                  onClick={() =>
                    edit((c) => {
                      (c.workflow.materialPrerequisites ||= []).push({
                        id: freshId("prerequisite"),
                        label: "素材制作前置条件",
                        requirementIds: [],
                        requiredSceneIds: [],
                      });
                    })
                  }
                >
                  ＋ 添加素材前置条件
                </button>
              )}
            </section>
          )}
          {group === "technical" && (
            <>
              <div className="configuration-form-grid">
                {text("故事名称",config.presentation.storyTitle,v=>edit(c=>{c.presentation.storyTitle=v;}),false,"显示在故事上下文与相关页面中，用来识别当前故事；不会改变已有内容或永久身份。")}
                {text("审阅台名称",config.presentation.title,v=>edit(c=>{c.presentation.title=v;}),false,"显示在侧栏、页脚等审阅台品牌位置；不会改变项目或实例身份。")}
              </div>
              <h3>内部画面基线</h3>
              <div className="configuration-form-grid configuration-picture-grid">
                {text("画幅", config.technical.picture.aspectRatio, (v) =>
                  edit((c) => {
                    c.technical.picture.aspectRatio = v;
                  }),
                  false,
                  "规定后续画面构图的宽高比例，并与下方像素尺寸相互校验。",
                )}
                {(["width", "height", "fps"] as const).map((k, i) =>
                  text(
                    ["宽度（像素）", "高度（像素）", "帧率"][i],
                    String(config.technical.picture[k]),
                    (v) =>
                      edit((c) => {
                        c.technical.picture[k] =
                          v === "" || v === "UNKNOWN" ? "UNKNOWN" : Number(v);
                      }),
                    false,
                    [
                      "与高度共同组成后续制作和技术审阅采用的目标分辨率。",
                      "与宽度共同组成后续制作和技术审阅采用的目标分辨率。",
                      "作为后续画面制作与技术审阅采用的目标时间基准。",
                    ][i],
                  ),
                )}
                <label className="configuration-field">
                  确认状态
                  <select
                    aria-label="内部画面基线确认状态"
                    aria-describedby="configuration-technical-picture-confirmation-help"
                    disabled={readonly}
                    value={config.technical.picture.confirmation}
                    onChange={(e) =>
                      edit((c) => {
                        c.technical.picture.confirmation = e.target.value;
                      })
                    }
                  >
                    {[
                      ["UNKNOWN", "未确认"],
                      ["SUGGESTED", "建议值"],
                      ["CONFIRMED", "已确认"],
                    ].map(([id, label]) => (
                      <option value={id} key={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small id="configuration-technical-picture-confirmation-help" className="configuration-field-help">表示整组画面参数的可信度；选择“已确认”前，画幅、宽度、高度和帧率必须完整。</small>
                </label>
              </div>
              <p>画面基线发布不会改写已生成文件的实际参数。</p>
            </>
          )}
          {group === "sources" && (
            <>
              <h3>来源核对顺序</h3>
              {config.sources.order.map((source, index) => (
                <article className="configuration-card" key={source.id}>
                  {text(`${index + 1}. 来源名称`, source.label, (v) =>
                    edit((c) => {
                      c.sources.order[index].label = v;
                    }),
                  )}
                  <label className="configuration-field">
                    资料角色
                    <select
                      disabled={readonly}
                      value={source.role}
                      onChange={(e) =>
                        edit((c) => {
                          c.sources.order[index].role = e.target.value;
                        })
                      }
                    >
                      {[
                        ["PRIMARY", "原始依据"],
                        ["DERIVED", "派生整理"],
                        ["AUXILIARY", "辅助资料"],
                      ].map(([id, label]) => (
                        <option value={id} key={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!readonly && (
                    <button
                      disabled={index === 0}
                      onClick={() =>
                        edit((c) => {
                          const a = c.sources.order;
                          [a[index - 1], a[index]] = [a[index], a[index - 1]];
                        })
                      }
                    >
                      上移
                    </button>
                  )}
                </article>
              ))}
            </>
          )}
          {group === "references" && (
            <>
              <DomainConfigurationEditor value={config.domain} mode="references" readonly={Boolean(readonly)} onChange={domain=>edit(c=>{c.schemaVersion="2.0";c.domain=domain;})} />
              <h3>连续性检查</h3>
              {text(
                "当前规范的实例文档别名",
                config.sources.continuity.specAlias,
                (v) =>
                  edit((c) => {
                    c.sources.continuity.specAlias = v;
                  }),
              )}
              <p>必需空间绑定：地点、状态、区域、机位、冻结点。</p>
              {config.sources.continuity.themes.map((theme, index) => (
                <div className="configuration-type" key={theme.id}>
                  {text("检查主题", theme.label, (v) =>
                    edit((c) => {
                      c.sources.continuity.themes[index].label = v;
                    }),
                  )}
                  {!readonly && (
                    <button
                      onClick={() =>
                        edit((c) =>
                          c.sources.continuity.themes.splice(index, 1),
                        )
                      }
                    >
                      移除此主题
                    </button>
                  )}
                </div>
              ))}
              {!readonly && (
                <button
                  onClick={() =>
                    edit((c) =>
                      c.sources.continuity.themes.push({
                        id: freshId("theme"),
                        label: "新增连续性检查",
                      }),
                    )
                  }
                >
                  ＋ 添加主题
                </button>
              )}
              <p>来源原文、具体空间事实和使用权利由相应业务资料维护。</p>
            </>
          )}
          {group === "general" && (
            <>
              {text('AI API Key 环境变量名',config.collaboration.apiKeyEnvName||'OPENAI_API_KEY',value=>edit(c=>{c.collaboration.apiKeyEnvName=value.trim();}))}
              <p>仅填写变量名，不填密钥。适用于已接入的 AI API 工作器，保存并发布后重启本地实例生效；Codex 继续使用本机 CLI 认证。</p>
              <div className="configuration-form-grid">
                {(["mark", "description"] as const).map(
                  (k, i) =>
                    text(
                      ["标记", "说明"][i],
                      config.presentation[k],
                      (v) =>
                        edit((c) => {
                          c.presentation[k] = v;
                        }),
                    ),
                )}
                <label className="configuration-field">
                  默认入口
                  <select
                    disabled={readonly}
                    value={config.presentation.landingView}
                    onChange={(e) =>
                      edit((c) => {
                        c.presentation.landingView = e.target.value;
                      })
                    }
                  >
                    {[
                      ["overview", "当前工作"],
                      ["story", "故事创作"],
                      ["settings", "故事设定"],
                      ["materials", "素材管理"],
                      ["pipeline", "全剧制作"],
                      ["system", "系统管理"],
                    ].map(([id, label]) => (
                      <option value={id} key={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="configuration-field">
                  协作偏好
                  <select
                    disabled={readonly}
                    value={config.collaboration.preferredCollaborator}
                    onChange={(e) =>
                      edit((c) => {
                        c.collaboration.preferredCollaborator = e.target.value;
                      })
                    }
                  >
                    {[
                      ["HUMAN_AI", "人和 AI 协作"],
                      ["HUMAN_FIRST", "优先人可推进"],
                      ["AI_FIRST", "优先 AI 可推进"],
                    ].map(([id, label]) => (
                      <option value={id} key={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="configuration-field">
                  默认执行方式
                  <select
                    disabled={readonly}
                    value={config.collaboration.defaultExecutor}
                    onChange={(e) =>
                      edit((c) => {
                        c.collaboration.defaultExecutor = e.target.value;
                      })
                    }
                  >
                    <option value="USER_EXTERNAL">用户外部执行</option>
                    <option value="CODEX">Codex执行</option>
                  </select>
                </label>
              </div>
              <div className="configuration-options">
                <label>
                  <input
                    disabled={readonly}
                    type="checkbox"
                    checked={config.collaboration.assistantEnabled}
                    onChange={(e) =>
                      edit((c) => {
                        c.collaboration.assistantEnabled = e.target.checked;
                      })
                    }
                  />
                  启用本地助手
                </label>
                <label>
                  <input
                    disabled={readonly}
                    type="checkbox"
                    checked={config.presentation.trialEnabled}
                    onChange={(e) =>
                      edit((c) => {
                        c.presentation.trialEnabled = e.target.checked;
                      })
                    }
                  />
                  显示已登记的试制范围入口
                </label>
              </div>
              {text("试制入口名称", config.presentation.trialLabel, (v) =>
                edit((c) => {
                  c.presentation.trialLabel = v;
                }),
              )}
              <p>执行方式只是默认选择，每次执行仍需绑定具体对象与授权。</p>
            </>
          )}
        </section>
      </div>
      <footer className="configuration-footer">
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {preview && (
          <div className="configuration-preview">
            <b>影响预览</b>
            <p>
              {preview.semanticChange
                ? "新对象将采用新规则。"
                : "本次调整展示或协作设置。"}{" "}
              保留 {preview.retainedObjectCount} 个已有对象绑定；显式升级{" "}
              {preview.affectedObjects.length} 个对象。
            </p>
            <ul>
              {preview.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {!readonly && (
          <div className="configuration-actions">
            {state.draft && !state.draft.published && !savedDraftVisible && <button disabled={busy} onClick={()=>{if(!mayReplace())return;setConfig(state.draft!.configuration);setDraftId(state.draft!.revisionId);setUpgradeKeys(state.draft!.upgradeKeys||[]);setDirty(false);setPreview(null);setSavedDraftVisible(true);setMessage('已继续编辑保存的草稿');}}>继续已保存草稿</button>}
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const value = await read<{ revisionId: string }>(
                    await request("/api/instance/configuration", "PUT", {
                      configuration: config,
                      expectedDraftRevision: draftId,
                      expectedReleaseId: state.releaseId,
                      expectedConfigurationRevisionId: state.revisionId,
                      upgradeKeys,
                    }),
                  );
                  setDraftId(value.revisionId);
                  setState({...state,draft:{revisionId:value.revisionId,configuration:structuredClone(config),expectedReleaseId:state.releaseId,upgradeKeys:[...upgradeKeys]}});
                  setDirty(false);
                  setSavedDraftVisible(true);
                  setPreview(null);
                  setMessage("草稿已保存，当前有效规则保持原版本");
                })
              }
            >
              保存草稿
            </button>
            <button
              disabled={busy || dirty || !draftId || !savedDraftVisible}
              onClick={() =>
                void action(async () => {
                  const value = await read<Preview>(
                    await request(
                      "/api/instance/configuration/preview",
                      "POST",
                      { draftRevisionId: draftId },
                    ),
                  );
                  setPreview(value);
                  setMessage("影响预览已完成");
                })
              }
            >
              预览影响
            </button>
            <button
              className="configuration-publish"
              disabled={busy || dirty || !preview}
              onClick={() =>
                void action(async () => {
                  await read(
                    await request(
                      "/api/instance/configuration/publish",
                      "POST",
                      {
                        draftRevisionId: draftId,
                        previewHash: preview!.previewHash,
                      },
                    ),
                  );
                  await load();
                  window.dispatchEvent(
                    new Event("review:configuration-updated"),
                  );
                  setMessage("配置已发布，当前实例已生效");
                })
              }
            >
              {busy ? "处理中…" : "发布配置"}
            </button>
          </div>
        )}
      </footer>
    </section>
  );
}
