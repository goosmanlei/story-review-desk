"use client";
const labels: Record<string, string> = {
  reviewStandards: "审阅标准",
  entityTypes: "主体类型",
  materialTypes: "素材类型",
  productionStages: "制作阶段",
  sourceRules: "来源规则",
  assistant: "助手",
  limits: "资源限制",
  technicalStandards: "技术标准",
  title: "名称",
  label: "名称",
  name: "名称",
  description: "说明",
  question: "核对问题",
  required: "必填",
  allowNA: "允许不适用",
  criteria: "验收要点",
  enabled: "启用",
  locale: "语言",
  branding: "项目外观",
  storyRules: "故事规则",
  pictureBaseline: "画面基准",
  defaultWorkspace: "默认入口",
  sourcePriority: "来源优先级",
  id: "标识",
  type: "类型",
  version: "版本",
  note: "说明",
  width: "宽度",
  height: "高度",
  fps: "帧率",
  format: "格式",
  duration: "时长",
  value: "值",
  order: "顺序",
  design: "详细镜头设计",
  shotSize: "景别",
  cameraAngle: "机位角度",
  cameraMovement: "机位运动",
  estimatedDurationSeconds: "估计时长（秒）",
  keyframeStrategy: "关键帧策略",
  negative: "负向提示词",
  main: "主提示词",
  dressing: "场景陈设",
  segments: "制作段落",
  camera: "机位与摄影",
  composition: "构图",
  motion: "运动",
  lighting: "光线",
  timing: "时间设计",
  durationSeconds: "时长（秒）",
  beats: "节拍",
  shots: "镜头安排",
  constraints: "约束",
  visual: "画面",
  sound: "声音",
  performance: "表演",
  continuity: "连续性",
  outputSpec: "产出规格",
};
export function ConfigEditor({
  value,
  onChange,
  name = "",
  depth = 0,
  readOnly = false,
}: {
  value: any;
  onChange: (v: any) => void;
  name?: string;
  depth?: number;
  readOnly?: boolean;
}) {
  const title = labels[name] || name;
  const locked = readOnly || name === "id" || /(?:Id|Ids|Ref|Refs|Hash|Sha256)$/.test(name);
  if (name === "limits")
    return <p>资源上限：缓存 24 MiB，空闲 5 分钟淘汰；后台队列最多 100 项。</p>;
  if (typeof value === "boolean")
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={value}
          disabled={locked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {title}
      </label>
    );
  if (typeof value === "number")
    return (
      <label>
        {title}
        <input
          type="number"
          readOnly={locked}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
        />
      </label>
    );
  if (typeof value === "string")
    return (
      <label>
        {title}
        <textarea
          value={value}
          readOnly={locked}
          rows={value.length > 120 ? 4 : 2}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  if (value === null) return <p>{title}：未设置</p>;
  if (Array.isArray(value))
    return (
      <details open={depth < 1}>
        <summary>
          {title} · {value.length} 项
        </summary>
        {value.map((item, index) => (
          <div className="config-item" key={item?.id || index}>
            <ConfigEditor
              name={item?.label || item?.title || String(index + 1)}
              value={item}
              depth={depth + 1}
              readOnly={locked}
              onChange={(v) =>
                onChange(value.map((x, i) => (i === index ? v : x)))
              }
            />
          </div>
        ))}
      </details>
    );
  if (typeof value === "object")
    return (
      <details open={depth < 1}>
        <summary>{title || "配置字段"}</summary>
        {Object.entries(value).map(([key, item]) => (
          <ConfigEditor
            key={key}
            name={key}
            value={item}
            depth={depth + 1}
            readOnly={locked}
            onChange={(v) => onChange({ ...value, [key]: v })}
          />
        ))}
      </details>
    );
  return null;
}
