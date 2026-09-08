import { defaultDomainConfiguration, validateDomainConfiguration } from "./domain-model.mjs";
import { deliveryAliases, productionGroups } from "./review-standard-catalog.mjs";
import { standardDefaults } from "./review-standard-defaults.mjs";
import { normalizeReviewSnapshot, phaseSpecs } from "./snapshot-contract.mjs";
import { criteriaForReviewScope } from "./review-criteria.mjs";
import { canonicalJson, sha256 } from "./bytes.mjs";

export const CONFIG_ID = "system-configuration";
export const TEMPLATE_ID = "film-production";
export const clone = (value) => structuredClone(value);
export const configHash = (value) => sha256(canonicalJson(value));
export const episodeIds = [
  "opening-boundary",
  "episode-purpose",
  "escalation-turn",
  "information-causality",
  "episode-payoff",
  "ending-propulsion",
];
export const sceneCriteria = [
  {
    id: "source-fidelity",
    label: "原文与改编边界",
    question: "事实、人物关系、事件因果和明确标注的改编边界是否正确？",
  },
  {
    id: "story-function",
    label: "叙事功能",
    question: "本场是否把对应原文节拍转成观众可理解的行动、信息或悬念？",
  },
  {
    id: "shootability-continuity",
    label: "可拍性与连续性",
    question: "动作、空间、道具状态及前后场承接是否可直接进入后续制作？",
  },
];
const episodeCriteria = [
  ["开场与承接", "是否接住上集留下的问题，并清楚建立本集关注点？"],
  ["本集任务", "本集主要任务是否清楚，各场与主副线是否有必要作用？"],
  [
    "推进与转折",
    "压力、信息或人物状态是否发生有意义的变化，转折与节奏是否合适？",
  ],
  [
    "信息与因果",
    "行动是否有依据，人物与观众的知情顺序是否自洽，铺垫与回收是否成立？",
  ],
  ["本集回报", "本集承诺了什么，是否兑现了明确的阶段性结果？"],
  ["结尾与承接", "停在实际结尾是否合适，留下的问题能否被下一集有效承接？"],
].map(([label, question], i) => ({
  id: episodeIds[i],
  label,
  question,
  required: true,
  allowNA: false,
  noteRequiredOnFail: true,
}));
const types = [
  [
    "people",
    "人物",
    "👤",
    "people",
    [
      ["identity", "人物身份", "IMAGE"],
      ["information-card", "人物信息卡", "IMAGE"],
      ["extras", "群演身份", "IMAGE"],
    ],
  ],
  [
    "scene",
    "场景",
    "🏠",
    "scene",
    [
      ["empty-location", "地点空态", "IMAGE"],
      ["location-state", "地点状态", "IMAGE"],
      ["space-reference", "空间证据", "IMAGE"],
    ],
  ],
  [
    "prop",
    "道具",
    "🧰",
    "prop",
    [
      ["key-prop", "关键道具", "IMAGE"],
      ["prop-state", "道具状态", "IMAGE"],
    ],
  ],
  [
    "dialogue",
    "台词",
    "💬",
    "dialogue",
    [["dialogue-text", "对白文本", "TEXT"]],
  ],
  [
    "voice",
    "配音",
    "🎙️",
    "voice",
    [
      ["voice-identity", "声音身份", "AUDIO"],
      ["voice-master", "声音母版", "AUDIO"],
    ],
  ],
  ["foley", "拟音", "👣", "foley", [["action-foley", "动作拟音", "AUDIO"]]],
  [
    "ambience",
    "环境声",
    "🔉",
    "ambience",
    [["ambience-bed", "环境底声", "AUDIO"]],
  ],
  ["music", "配乐", "🎵", "music", [["original-music", "原创配乐", "AUDIO"]]],
  [
    "style",
    "风格与参考",
    "🎨",
    "style",
    [["style-anchor", "风格锚点", "IMAGE"]],
  ],
];
export const missingShotFacts = () => ({
  shot: {
    purpose: { class: "U", text: "UNKNOWN" },
    storyEvent: { text: "UNKNOWN" },
    mustShow: [],
    mustNotImply: [],
  },
  scene: {
    route: "UNKNOWN",
    keyPropsAndState: "UNKNOWN",
    continuity: "UNKNOWN",
    primaryLocation: "UNKNOWN",
  },
  sequence: { title: { text: "UNKNOWN" }, structuralRole: { text: "UNKNOWN" } },
  episode: { reviewQuestion: { text: "UNKNOWN" } },
  neighbours: { next: { id: "UNKNOWN", title: "UNKNOWN" } },
});
const productionScope = (key) =>
  ["ANIMATIC", "SCENE_SOUND_POST"].includes(key)
    ? "SCENE"
    : key.startsWith("EPISODE_")
      ? "EPISODE"
      : key.startsWith("PROJECT_")
        ? "PROJECT"
        : "SHOT";
const templateShot = () => ({
  shot: {
    purpose: { class: "L", text: "{{shot.purpose}}" },
    storyEvent: { text: "{{shot.event}}" },
    mustShow: [{ class: "", text: "{{shot.mustShow}}" }],
    mustNotImply: [{ class: "", text: "{{shot.mustNotImply}}" }],
  },
  scene: {
    route: "{{scene.route}}",
    keyPropsAndState: "{{scene.state}}",
    continuity: "{{scene.continuity}}",
    primaryLocation: "{{scene.location}}",
  },
  sequence: {
    title: { text: "{{sequence.title}}" },
    structuralRole: { text: "{{sequence.role}}" },
  },
  episode: { reviewQuestion: { text: "{{episode.question}}" } },
  neighbours: { next: { id: "{{next.id}}", title: "{{next.title}}" } },
});
const templateScope = (key) => ({
  scopeType: productionScope(key),
  scopeId: "{{scope.id}}",
  judgment: {
    reviewQuestion: { text: "{{scope.question}}" },
    purpose: { text: "{{scope.purpose}}" },
    audienceTakeaway: { text: "{{scope.audience}}" },
  },
  scene: { continuity: "{{scene.continuity}}" },
  episode: {
    openingHook: { text: "{{episode.opening}}" },
    coreAdvance: { text: "{{episode.advance}}" },
    endingCliffhanger: { text: "{{episode.ending}}" },
  },
});
function renderCriteria(criteria, shot = missingShotFacts(), scope = {}) {
  const claims = (rows) =>
    (rows || []).map((c) => `${c.class}：${c.text}`).join("；") || "UNKNOWN";
  const facts = {
    "shot.purpose":
      shot.shot?.purpose?.class === "U" ? "UNKNOWN" : shot.shot?.purpose?.text,
    "shot.event": shot.shot?.storyEvent?.text,
    "shot.mustShow": claims(shot.shot?.mustShow),
    "shot.mustNotImply": claims(shot.shot?.mustNotImply),
    "scene.route": shot.scene?.route,
    "scene.state": shot.scene?.keyPropsAndState,
    "scene.continuity": scope.scene?.continuity || shot.scene?.continuity,
    "scene.location": shot.scene?.primaryLocation,
    "sequence.title": shot.sequence?.title?.text,
    "sequence.role": shot.sequence?.structuralRole?.text,
    "episode.question": shot.episode?.reviewQuestion?.text,
    "next.id": shot.neighbours?.next?.id,
    "next.title": shot.neighbours?.next?.title,
    "scope.id": scope.scopeId,
    "scope.question": scope.judgment?.reviewQuestion?.text,
    "scope.purpose": scope.judgment?.purpose?.text,
    "scope.audience": scope.judgment?.audienceTakeaway?.text,
    "episode.opening": scope.episode?.openingHook?.text,
    "episode.advance": scope.episode?.coreAdvance?.text,
    "episode.ending": scope.episode?.endingCliffhanger?.text,
  };
  return criteria.map((c) => ({
    ...c,
    question: c.question.replace(/\{\{([a-zA-Z.]+)\}\}/g, (_, key) =>
      typeof facts[key] === "string" && facts[key] ? facts[key] : "UNKNOWN",
    ),
  }));
}
const normalizeCriteria = (rows) =>
  rows.map((row) => ({
    required: true,
    allowNA: true,
    noteRequiredOnFail: true,
    ...row,
  }));
const modernDeliverables = {
  SHOT_PLAN_SET: ["镜头设计与输入锁定", "SCENE", null],
  STORYBOARD_DIALOGUE_PACKAGE: ["粗分镜与对白", "SHOT", "STORYBOARD"],
  ANIMATIC_TIMING_LOCK: ["场级预演锁时", "SCENE", "ANIMATIC"],
  SHOT_KEYFRAME_SET: ["正式首尾帧", "SHOT", "START_FRAME"],
  SHOT_VIDEO: ["镜头视频", "SHOT", "MOTION_VIDEO"],
  SCENE_PICTURE_LOCK_EDL: ["场画面锁与剪辑表", "SCENE", null],
  SCENE_SOUND_MIX_SUBTITLES: ["场声音混音与字幕", "SCENE", "SCENE_SOUND_POST"],
  SCENE_QA_REPORT: ["场级质量检查", "SCENE", null],
  EPISODE_MASTER: ["分集组装母版", "EPISODE", "EPISODE_DELIVERY_MASTER"],
  EPISODE_REVIEW_DECISION: ["分集审阅", "EPISODE", "EPISODE_DELIVERY_MASTER"],
  EPISODE_TECH_QC_REPORT: ["分集技术检查", "EPISODE", null],
  SERIES_CONTINUITY_REPORT: [
    "跨集连续性",
    "PROJECT",
    "PROJECT_DELIVERY_MANIFEST",
  ],
  FINAL_RIGHTS_SAFETY_TECH_REPORT: [
    "权利敏感与技术终检",
    "PROJECT",
    "PROJECT_DELIVERY_MANIFEST",
  ],
  DELIVERY_MANIFEST_ARCHIVE: [
    "交付归档",
    "PROJECT",
    "PROJECT_DELIVERY_MANIFEST",
  ],
};
export function defaultConfiguration(profile = {}) {
  const graph = phaseSpecs.flatMap(([phaseId, , , , , gates]) =>
    gates.map(([id, label, scopeType, purpose]) => ({
      id,
      label,
      phaseId,
      scopeType,
      purpose,
      extraPrerequisites: [],
      additionalOutputTypes: [],
    })),
  );
  const deliveries = [
    "LOC_STATE",
    "STORYBOARD",
    "DIALOGUE_DRY",
    "ANIMATIC",
    "START_FRAME",
    "END_FRAME",
    "PRE_LIP_VIDEO",
    "AUDIO_DRIVEN_VIDEO",
    "NO_LIP_VIDEO",
    "MOTION_VIDEO",
    "POST_LIP_VIDEO",
    "LOCKED_SHOT",
    "SCENE_SOUND_POST",
    "EPISODE_DELIVERY_MASTER",
    "PROJECT_DELIVERY_MANIFEST",
    "TECHNICAL_REPORT",
    "CONTINUITY_REPORT",
    "SUBTITLE_FILE",
    "AUDIO_STEMS",
    ...Object.keys(modernDeliverables),
  ];
  const reviewProfiles = [
    {
      id: "episode-plan",
      label: "分集剧情设计",
      subjectKind: "EPISODE_PLAN",
      criteria: episodeCriteria,
      firstQuestion: "开场能否独立建立人物困境、主要冲突和观看关注点？",
      lastQuestion:
        "终局是否兑现主要承诺、闭合应闭合的因果，并留下合适的余韵？",
    },
    {
      id: "script-scene",
      label: "场正文",
      subjectKind: "SCRIPT_SCENE",
      criteria: normalizeCriteria(sceneCriteria.map(c=>c.id === "story-function" ? {id:"episode-inheritance",allowNA:false,label:"分集意图与本场落实",question:"本场是否落实本集任务与本场责任，正确承接前后场、信息释放、笑点及铺垫回收，且没有遗漏、偏离或提前泄露？"} : c)).map((c) => ({
        ...c,
        noteRequiredOnFail: false,
      })),
    },
    ...["IMAGE", "AUDIO", "VIDEO", "TEXT"].map((media) => ({
      id: `material-${media.toLowerCase()}`,
      label: {
        IMAGE: "图像素材",
        AUDIO: "声音素材",
        VIDEO: "视频素材",
        TEXT: "文本素材",
      }[media],
      subjectKind: "ASSET",
      criteria: normalizeCriteria([
        {
          id: "purpose",
          label: "用途与内容",
          question: "是否满足已登记用途、内容要求与当前故事依据？",
        },
        {
          id: "continuity",
          label: "身份与连续性",
          question: "是否与已采用输入、人物、空间及状态一致？",
        },
        {
          id: "technical-quality",
          label: "制作质量",
          question: "实际文件是否符合已确认制作规格，没有影响使用的质量问题？",
        },
      ]).map((row) => ({ ...row, noteRequiredOnFail: false })),
    })),
    ...deliveries.map((id) => ({
      id: `production-${id.toLowerCase()}`,
      label:
        modernDeliverables[id]?.[0] ||
        {
          LOC_STATE: "地点状态",
          STORYBOARD: "粗分镜",
          DIALOGUE_DRY: "对白干声",
          ANIMATIC: "场级预演与锁时",
          START_FRAME: "正式首帧",
          END_FRAME: "正式尾帧",
          PRE_LIP_VIDEO: "口型前视频",
          AUDIO_DRIVEN_VIDEO: "音频驱动视频",
          NO_LIP_VIDEO: "无口型视频",
          MOTION_VIDEO: "镜头运动视频",
          POST_LIP_VIDEO: "口型后视频",
          LOCKED_SHOT: "单镜锁定",
          SCENE_SOUND_POST: "场声音后期",
          EPISODE_DELIVERY_MASTER: "分集母版",
          PROJECT_DELIVERY_MANIFEST: "全剧交付",
          TECHNICAL_REPORT: "技术报告",
          CONTINUITY_REPORT: "连续性报告",
          SUBTITLE_FILE: "字幕文件",
          AUDIO_STEMS: "声音分轨",
        }[id],
      subjectKind: "WORK_PRODUCT",
      deliverableKey: id,
      criteria: normalizeCriteria(
        criteriaForReviewScope(
          { deliverableKey: modernDeliverables[id]?.[2] || id },
          templateShot(),
          {
            ...templateScope(id),
            ...(modernDeliverables[id]
              ? { scopeType: modernDeliverables[id][1] }
              : {}),
          },
        ),
      ),
    })),
  ];
  return standardDefaults({
    schemaVersion: "2.0",
    domain: defaultDomainConfiguration(),
    template: { id: TEMPLATE_ID, version: "1.0" },
    reviewProfiles,
    taxonomy: {
      categories: types.map(([id, label, icon, tone, children]) => ({
        id,
        label,
        icon,
        tone,
        aliases: [label],
        types: children.map(([id, label, mediaType]) => ({
          id,
          label,
          aliases: [label],
          mediaType,
          reviewProfileId: `material-${mediaType.toLowerCase()}`,
          productionLane: "MANUAL_OR_ASSISTED",
        })),
      })),
    },
    workflow: {
      phases: phaseSpecs.map(([id, label, , , purpose]) => ({
        id,
        label,
        purpose,
      })),
      gates: graph,
      lipSync: "WHEN_REQUIRED",
      earlyAmbience: true,
      materialPrerequisites: [],
    },
    technical: {
      picture: {
        aspectRatio: "UNKNOWN",
        width: "UNKNOWN",
        height: "UNKNOWN",
        fps: "UNKNOWN",
        confirmation: "UNKNOWN",
      },
      delivery: {
        platform: "UNKNOWN",
        audience: "UNKNOWN",
        codec: "UNKNOWN",
        color: "UNKNOWN",
        loudness: "UNKNOWN",
        confirmation: "UNKNOWN",
      },
    },
    sources: {
      order: [
        { id: "primary", label: "原始资料", role: "PRIMARY" },
        { id: "derived", label: "整理文本", role: "DERIVED" },
        { id: "auxiliary", label: "辅助资料", role: "AUXILIARY" },
      ],
      continuity: {
        specAlias: "",
        requiredCoordinates: ["LOC", "STATE", "ZONE", "CAM", "FREEZE"],
        themes: [
          { id: "character", label: "人物关系" },
          { id: "time", label: "时间与因果" },
          { id: "space", label: "空间与状态" },
        ],
      },
    },
    collaboration: {
      assistantEnabled: profile.capabilities?.assistantEnabled !== false,
      preferredCollaborator:
        profile.capabilities?.preferredCollaborator || "HUMAN_AI",
      defaultExecutor: "USER_EXTERNAL",
      apiKeyEnvName: profile.capabilities?.apiKeyEnvName || "OPENAI_API_KEY",
    },
    presentation: {
      storyTitle: profile.storyTitle || "新故事",
      title: profile.title || "故事审阅台",
      mark: profile.branding?.mark || "阅",
      description:
        profile.branding?.description || "故事创作、素材审阅与全剧制作。",
      landingView: profile.capabilities?.landingView || "overview",
      trialEnabled: false,
      trialLabel: "本剧试制",
    },
  });
}
const fail = (message, path = "") => {
  throw Object.assign(new Error(message), {
    code: "CONFIGURATION_INVALID",
    path,
  });
};
const ids = (rows, path) => {
  if (!Array.isArray(rows)) fail("需要列表", path);
  const set = new Set();
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(row.id) ||
      set.has(row.id)
    )
      fail("标识缺失、重复或无效", path);
    set.add(row.id);
  }
  return set;
};
const string = (value, path, max = 4000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("内容为空或过长", path);
};
function shape(value, keys, path) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => value[k] === undefined)
  )
    fail("配置字段缺失或包含不支持字段", path);
}
function validateShapes(c) {
  shape(
    c,
    [
      "schemaVersion",
      "template",
      "reviewProfiles",
      "taxonomy",
      "workflow",
      "technical",
      "sources",
      "collaboration",
      "presentation",
      ...(c.schemaVersion === "2.0" ? ["domain"] : []),
    ],
    "configuration",
  );
  shape(c.template, ["id", "version"], "template");
  if (!Array.isArray(c.reviewProfiles)) fail("审阅模板必须为列表");
  for (const p of c.reviewProfiles) {
    const keys = [
      "id",
      "label",
      "subjectKind",
      "criteria",
      ...(p.subjectKind === "WORK_PRODUCT" ? ["deliverableKey"] : []),
      ...(p.id === "episode-plan" ? ["firstQuestion", "lastQuestion"] : []),
    ];
    shape(p, keys, "reviewProfile");
    if (
      (p.id === "episode-plan" && p.subjectKind !== "EPISODE_PLAN") ||
      (p.id === "script-scene" && p.subjectKind !== "SCRIPT_SCENE")
    )
      fail("固定模板的审阅对象不可更改");
    if (!Array.isArray(p.criteria)) fail("审阅项必须为列表");
    for (const row of p.criteria)
      shape(
        row,
        [
          "id",
          "label",
          "question",
          "required",
          "allowNA",
          "noteRequiredOnFail",
        ],
        "criterion",
      );
  }
  shape(c.taxonomy, ["categories"], "taxonomy");
  if (!Array.isArray(c.taxonomy.categories)) fail("分类必须为列表");
  for (const cat of c.taxonomy.categories) {
    shape(cat, ["id", "label", "aliases", "icon", "tone", "types"], "category");
    if (!Array.isArray(cat.types)) fail("类型必须为列表");
    for (const t of cat.types)
      shape(
        t,
        [
          "id",
          "label",
          "aliases",
          "mediaType",
          "reviewProfileId",
          "productionLane",
        ],
        "type",
      );
  }
  shape(
    c.workflow,
    [
      "phases",
      "gates",
      "lipSync",
      "earlyAmbience",
      ...(c.workflow?.materialPrerequisites !== undefined
        ? ["materialPrerequisites"]
        : []),
    ],
    "workflow",
  );
  if (c.workflow.materialPrerequisites !== undefined) {
    ids(c.workflow.materialPrerequisites, "materialPrerequisites");
    for (const rule of c.workflow.materialPrerequisites) {
      shape(
        rule,
        ["id", "label", "requirementIds", "requiredSceneIds"],
        "materialPrerequisite",
      );
      string(rule.label, rule.id);
      for (const key of ["requirementIds", "requiredSceneIds"])
        if (
          !Array.isArray(rule[key]) ||
          !rule[key].length ||
          rule[key].some((v) => typeof v !== "string" || !v.trim()) ||
          new Set(rule[key]).size !== rule[key].length
        )
          fail("前置规则须使用唯一非空对象标识");
    }
  }
  if (!Array.isArray(c.workflow.phases) || !Array.isArray(c.workflow.gates))
    fail("流程必须为列表");
  for (const p of c.workflow.phases) {
    shape(p, ["id", "label", "purpose"], "phase");
    string(p.label, p.id);
    string(p.purpose, p.id);
  }
  for (const g of c.workflow.gates)
    shape(
      g,
      [
        "id",
        "label",
        "phaseId",
        "scopeType",
        "purpose",
        "extraPrerequisites",
        "additionalOutputTypes",
      ],
      "gate",
    );
  shape(c.technical, ["picture", "delivery"], "technical");
  shape(
    c.technical.picture,
    ["aspectRatio", "width", "height", "fps", "confirmation"],
    "picture",
  );
  const delivery = ["platform", "audience", "codec", "color", "loudness"];
  shape(c.technical.delivery, [...delivery, "confirmation"], "delivery");
  for (const key of delivery) string(c.technical.delivery[key], key, 300);
  for (const key of ["width", "height"])
    if (
      c.technical.picture[key] !== "UNKNOWN" &&
      !Number.isSafeInteger(c.technical.picture[key])
    )
      fail("像素尺寸必须为整数");
  shape(c.sources, ["order", "continuity"], "sources");
  if (!Array.isArray(c.sources.order) || !c.sources.order.length)
    fail("来源顺序不能为空");
  for (const row of c.sources.order)
    shape(row, ["id", "label", "role"], "source");
  shape(
    c.sources.continuity,
    ["specAlias", "requiredCoordinates", "themes"],
    "continuity",
  );
  if (!Array.isArray(c.sources.continuity.themes)) fail("连续性主题须为列表");
  for (const row of c.sources.continuity.themes)
    shape(row, ["id", "label"], "theme");
  shape(
    c.collaboration,
    ["assistantEnabled", "preferredCollaborator", "defaultExecutor", ...(c.collaboration?.apiKeyEnvName!==undefined?["apiKeyEnvName"]:[])],
    "collaboration",
  );
  shape(
    c.presentation,
    [
      "storyTitle",
      "title",
      "mark",
      "description",
      "landingView",
      "trialEnabled",
      "trialLabel",
    ],
    "presentation",
  );
  const uniqueAliases = (rows, path) => {
    const owners = new Map();
    for (const row of rows)
      for (const alias of new Set([
        row.id,
        row.label,
        ...(Array.isArray(row.aliases) ? row.aliases : []),
      ])) {
        if (owners.has(alias) && owners.get(alias) !== row.id)
          fail("分类名称或别名不唯一", path);
        owners.set(alias, row.id);
      }
  };
  uniqueAliases(c.taxonomy.categories, "taxonomy");
  for (const cat of c.taxonomy.categories) uniqueAliases(cat.types, cat.id);
}
export function validateConfiguration(config, previous) {
  validateShapes(config);
  if (
    !config ||
    !["1.0", "2.0"].includes(config.schemaVersion) ||
    config.template?.id !== TEMPLATE_ID ||
    !["1.0", "1.1"].includes(config.template?.version)
  )
    fail("不支持的配置模板");
  const top = [
    "schemaVersion",
    "template",
    "reviewProfiles",
    "taxonomy",
    "workflow",
    "technical",
    "sources",
    "collaboration",
    "presentation",
    ...(config.schemaVersion === "2.0" ? ["domain"] : []),
  ];
  if (
    Object.keys(config).some((k) => !top.includes(k)) ||
    top.some((k) => config[k] == null)
  )
    fail("配置分组不完整或包含不支持字段");
  if (config.schemaVersion === "2.0") validateDomainConfiguration(config.domain);
  const profiles = ids(config.reviewProfiles, "reviewProfiles");
  if (!profiles.has("episode-plan") || !profiles.has("script-scene"))
    fail("缺少必要审阅模板");
  if (config.template.version === "1.1") {
    const required = new Set(productionGroups.flatMap(([, , gates])=>gates.flatMap(([, , keys])=>keys.map(k=>deliveryAliases[k] || k))));
    for (const key of required) if(!profiles.has(`production-${key.toLowerCase()}`)) fail("缺少必要的制作审阅标准",key);
  }
  for (const profile of config.reviewProfiles) {
    string(profile.label, "reviewProfiles.label");
    if (
      !["EPISODE_PLAN", "SCRIPT_SCENE", "ASSET", "WORK_PRODUCT"].includes(
        profile.subjectKind,
      )
    )
      fail("不支持的审阅对象");
    const names = ids(profile.criteria, profile.id);
    if (
      !names.size ||
      names.size > (profile.subjectKind === "ASSET" ? 80 : 200)
    )
      fail("素材审阅项为1到80项，其他对象为1到200项");
    for (const c of profile.criteria) {
      string(c.label, c.id);
      string(c.question, c.id);
      for (const k of ["required", "allowNA", "noteRequiredOnFail"])
        if (typeof c[k] !== "boolean") fail("审阅条件必须为布尔值", c.id);
      if (!c.required)
        fail("正式判断项必须逐项回答；通过不适用配置处理适用性", c.id);
    }
    if (profile.subjectKind === "EPISODE_PLAN") {
      if (
        profile.id !== "episode-plan" ||
        names.size !== 6 ||
        episodeIds.some((id) => !names.has(id)) ||
        profile.criteria.some((c) => c.allowNA || !c.noteRequiredOnFail)
      )
        fail("分集方案须保留六项必答判断及失败意见");
      string(profile.firstQuestion, "firstQuestion");
      string(profile.lastQuestion, "lastQuestion");
    }
  }
  ids(config.taxonomy.categories, "taxonomy");
  const typeIds = new Set();
  for (const cat of config.taxonomy.categories) {
    string(cat.label, cat.id);
    string(cat.icon, cat.id, 12);
    if (
      ![
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
      ].includes(cat.tone)
    )
      fail("不支持的色调", cat.id);
    if (
      !Array.isArray(cat.aliases) ||
      cat.aliases.some((a) => typeof a !== "string")
    )
      fail("分类别名无效");
    ids(cat.types, cat.id);
    for (const t of cat.types) {
      if (typeIds.has(t.id)) fail("二级类型标识必须全局唯一");
      typeIds.add(t.id);
      string(t.label, t.id);
      if (
        !["IMAGE", "AUDIO", "VIDEO", "TEXT"].includes(t.mediaType) ||
        !profiles.has(t.reviewProfileId) ||
        config.reviewProfiles.find((p) => p.id === t.reviewProfileId)
          .subjectKind !== "ASSET"
      )
        fail("素材媒介或审阅模板无效", t.id);
      if (
        !["MANUAL_OR_ASSISTED", "CODEX", "USER_EXTERNAL"].includes(
          t.productionLane,
        )
      )
        fail("生产泳道无效");
      if (
        !Array.isArray(t.aliases) ||
        t.aliases.some((a) => typeof a !== "string")
      )
        fail("分类别名无效");
    }
  }
  const phaseIds = ids(config.workflow.phases, "phases"),
    gateIds = ids(config.workflow.gates, "gates");
  const defaults = defaultConfiguration();
  if (
    phaseIds.size !== 5 ||
    gateIds.size !== 15 ||
    defaults.workflow.phases.some((p) => !phaseIds.has(p.id))
  )
    fail("保留五阶段十五门禁");
  for (const gate of config.workflow.gates) {
    const base = defaults.workflow.gates.find((g) => g.id === gate.id);
    if (
      !base ||
      gate.phaseId !== base.phaseId ||
      gate.scopeType !== base.scopeType
    )
      fail("门禁身份与所属范围不可更改");
    string(gate.label, gate.id);
    string(gate.purpose, gate.id);
    if (
      !Array.isArray(gate.extraPrerequisites) ||
      gate.extraPrerequisites.some(
        (id) =>
          !gateIds.has(id) ||
          id === gate.id ||
          defaults.workflow.gates.findIndex((g) => g.id === id) >=
            defaults.workflow.gates.findIndex((g) => g.id === gate.id) ||
          defaults.workflow.gates.find((g) => g.id === id)?.scopeType !==
            gate.scopeType,
      )
    )
      fail("额外前置门禁无效");
    if (
      !Array.isArray(gate.additionalOutputTypes) ||
      gate.additionalOutputTypes.some(
        (x) =>
          ![
            "TECHNICAL_REPORT",
            "CONTINUITY_REPORT",
            "SUBTITLE_FILE",
            "AUDIO_STEMS",
          ].includes(x),
      )
    )
      fail("不支持的附加交付类型");
  }
  const visit = (id, stack = new Set()) => {
    if (stack.has(id)) fail("门禁依赖不能成环");
    for (const dep of config.workflow.gates.find((g) => g.id === id)
      .extraPrerequisites)
      visit(dep, new Set([...stack, id]));
  };
  for (const id of gateIds) visit(id);
  if (
    config.workflow.lipSync !== "WHEN_REQUIRED" ||
    typeof config.workflow.earlyAmbience !== "boolean"
  )
    fail("口型条件或环境声规则无效");
  for (const group of ["picture", "delivery"]) {
    const v = config.technical[group];
    if (!v || !["UNKNOWN", "SUGGESTED", "CONFIRMED"].includes(v.confirmation))
      fail("规格须声明确认状态");
  }
  for (const key of ["width", "height", "fps"]) {
    const value = config.technical.picture[key];
    if (
      value !== "UNKNOWN" &&
      (!Number.isFinite(value) ||
        value <= 0 ||
        value > (key === "fps" ? 240 : 16384))
    )
      fail("尺寸或帧率无效", key);
  }
  const picture = config.technical.picture;
  if (
    picture.aspectRatio !== "UNKNOWN" &&
    !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(picture.aspectRatio)
  )
    fail("画幅应为宽:高");
  if (
    picture.width !== "UNKNOWN" &&
    picture.height !== "UNKNOWN" &&
    picture.aspectRatio !== "UNKNOWN"
  ) {
    const [w, h] = picture.aspectRatio.split(":").map(Number);
    if (h <= 0 || Math.abs(picture.width / picture.height - w / h) > 0.001)
      fail("画幅与尺寸不一致");
  }
  if (
    picture.confirmation === "CONFIRMED" &&
    ["width", "height", "fps", "aspectRatio"].some(
      (k) => picture[k] === "UNKNOWN",
    )
  )
    fail("确认画面规格前须填写全部字段");
  if (
    config.technical.delivery.confirmation === "CONFIRMED" &&
    Object.entries(config.technical.delivery).some(
      ([k, v]) => k !== "confirmation" && (!v || v === "UNKNOWN"),
    )
  )
    fail("确认交付规格前须填写全部字段");
  ids(config.sources.order, "sources");
  for (const source of config.sources.order) {
    string(source.label, source.id);
    if (!["PRIMARY", "DERIVED", "AUXILIARY"].includes(source.role))
      fail("来源角色无效");
  }
  ids(config.sources.continuity.themes, "continuity");
  for (const theme of config.sources.continuity.themes)
    string(theme.label, theme.id);
  const coords = config.sources.continuity.requiredCoordinates;
  if (
    !Array.isArray(coords) ||
    ["LOC", "STATE", "ZONE", "CAM", "FREEZE"].some(
      (k) => !coords.includes(k),
    ) ||
    coords.some((k) => !["LOC", "STATE", "ZONE", "CAM", "FREEZE"].includes(k))
  )
    fail("必须保留完整空间绑定字段");
  const alias = config.sources.continuity.specAlias;
  if (
    typeof alias !== "string" ||
    (alias &&
      (alias.startsWith("/") ||
        alias.split("/").some((p) => !p || p === "." || p === "..") ||
        alias.includes("\\")))
  )
    fail("连续性规范必须为实例文档别名");
  if (
    typeof config.collaboration.assistantEnabled !== "boolean" ||
    !["HUMAN_AI", "HUMAN_FIRST", "AI_FIRST"].includes(
      config.collaboration.preferredCollaborator,
    ) ||
    !["CODEX", "USER_EXTERNAL"].includes(config.collaboration.defaultExecutor)
  )
    fail("协作配置无效");
  if(config.collaboration.apiKeyEnvName!==undefined&&(!/^[A-Z][A-Z0-9_]{2,127}$/.test(config.collaboration.apiKeyEnvName)||!config.collaboration.apiKeyEnvName.endsWith('_API_KEY')))fail('只填写以 _API_KEY 结尾的环境变量名，不填写密钥');
  for (const k of ["storyTitle", "title", "mark", "description", "trialLabel"])
    string(config.presentation[k], k, k === "mark" ? 4 : 300);
  if (
    !["overview", "story", "settings", "materials", "pipeline", "system"].includes(
      config.presentation.landingView,
    ) ||
    typeof config.presentation.trialEnabled !== "boolean"
  )
    fail("界面配置无效");
  if (previous) {
    for (const old of previous.taxonomy.categories) {
      const next = config.taxonomy.categories.find((c) => c.id === old.id);
      if (next && old.aliases.some((a) => !next.aliases.includes(a)))
        fail("历史分类别名不可移除");
      for (const t of old.types) {
        const n = config.taxonomy.categories
          .flatMap((c) => c.types)
          .find((c) => c.id === t.id);
        if (n && t.aliases.some((a) => !n.aliases.includes(a)))
          fail("历史类型别名不可移除");
      }
    }
  }
  return clone(config);
}
export function semanticConfiguration(config) {
  const c = clone(config);
  delete c.presentation;
  delete c.collaboration;
  for (const cat of c.taxonomy.categories) {
    delete cat.label;
    delete cat.icon;
    delete cat.tone;
    delete cat.aliases;
    for (const t of cat.types) {
      delete t.label;
      delete t.aliases;
    }
    cat.types.sort((a, b) => a.id.localeCompare(b.id));
  }
  c.taxonomy.categories.sort((a, b) => a.id.localeCompare(b.id));
  for (const x of [...c.workflow.phases, ...c.workflow.gates]) {
    delete x.label;
    delete x.purpose;
  }
  return c;
}
export function categoryFor(config, primary, secondary) {
  const categories = config.taxonomy.categories;
  const cat =
    categories.find((c) => c.id === primary) ||
    categories.find((c) => c.label === primary || c.aliases.includes(primary));
  const t =
    cat?.types.find((t) => t.id === secondary) ||
    cat?.types.find(
      (t) => t.label === secondary || t.aliases.includes(secondary),
    );
  return { category: cat, type: t };
}
export function profileFor(config, kind, object) {
  if (kind === "ASSET") {
    const { type } = categoryFor(
      config,
      object.businessCategoryPrimaryId || object.businessCategoryPrimary,
      object.businessCategorySecondaryId || object.businessCategorySecondary,
    );
    return (
      type?.reviewProfileId ||
      `material-${String(object.mediaType || "").toLowerCase()}`
    );
  }
  if (kind === "SCRIPT_SCENE") return "script-scene";
  if (kind === "EPISODE_PLAN") return "episode-plan";
  const key = String(object.deliverableKey || "");
  const direct = `production-${key.toLowerCase()}`;
  // An explicitly configured branch wins; otherwise compatible output keys share one canonical standard.
  return config.reviewProfiles.some(p=>p.id===direct) ? direct : `production-${(deliveryAliases[key] || key).toLowerCase()}`;
}
export function reviewSpec(
  config,
  kind,
  object,
  { legacy = false, shotContext, scopeContext } = {},
) {
  const profileId = profileFor(config, kind, object);
  const profile = config.reviewProfiles.find((p) => p.id === profileId);
  if (profile && profile.subjectKind !== kind)
    fail("审阅模板与对象类型不一致", profileId);
  let criteria = profile?.criteria;
  if (legacy && kind === "ASSET")
    criteria = (object.acceptanceCriteria || []).map((label, i) => ({
      id: `material-${String(i + 1).padStart(2, "0")}`,
      label,
      question: label,
      required: true,
      allowNA: true,
      noteRequiredOnFail: false,
    }));
  if (
    legacy &&
    kind === "EPISODE_PLAN" &&
    (object.criteriaVersion === "1.0" ||
      object.episodes?.[0]?.reviewDossier?.schemaVersion === "1.0")
  ) {
    const legacyQuestions = [
      ["起集点", "是否有效承接上一集，并让本集冲突迅速成立？"],
      ["本集任务", "本集要解决的问题是否单一、清楚，所含场次是否都服务于它？"],
      ["递进与转折", "集内事件是否持续升级，并在关键位置形成有效转折？"],
      [
        "信息与因果",
        "明线、暗线与观众所得是否清楚，因果链是否连续且不过早剧透？",
      ],
      ["本集回报", "本集是否兑现了阶段性结果，而不是只把内容机械截断？"],
      [
        "断集与追看",
        "结尾是否由本集行动自然产生，并明确驱动下一集或终局余韵？",
      ],
    ];
    criteria = episodeCriteria.map((c, i) => ({
      ...c,
      label: legacyQuestions[i][0],
      question: legacyQuestions[i][1],
    }));
  }
  if (legacy && kind === "SCRIPT_SCENE")
    criteria = normalizeCriteria(
      sceneCriteria.map((c) =>
        c.id === "source-fidelity"
          ? {
              ...c,
              question:
                "事实、人物关系、案件因果和明确标注的改编边界是否正确？",
            }
          : c,
      ),
    ).map((c) => ({ ...c, noteRequiredOnFail: false }));
  if (kind === "WORK_PRODUCT" && (!profile || legacy))
    criteria = normalizeCriteria(
      criteriaForReviewScope(
        object,
        shotContext || missingShotFacts(),
        scopeContext || null,
      ),
    );
  if (kind === "WORK_PRODUCT" && !legacy)
    criteria = renderCriteria(criteria || [], shotContext, scopeContext || {});
  if (!legacy && kind === "WORK_PRODUCT" && config.template.version === "1.1" && criteria?.length &&
      ["SHOT_PLAN_SET", "ANIMATIC", "ANIMATIC_TIMING_LOCK", "SCENE_PICTURE_LOCK_EDL", "EPISODE_REVIEW_DECISION", "SERIES_CONTINUITY_REPORT"].includes(object.deliverableKey)) {
    const scope = scopeContext || {};
    const basis = `审阅范围：${scope.scopeId || "待确认"}。当前依据：${scope.judgment?.reviewQuestion?.text || "待确认"}；目的：${scope.judgment?.purpose?.text || "待确认"}；观众所得：${scope.judgment?.audienceTakeaway?.text || "待确认"}。`;
    criteria = criteria.map((c,i)=>i===0 ? {...c,question:`${c.question} ${basis}`} : c);
  }
  if (!legacy && criteria?.length && kind !== "EPISODE_PLAN") {
    const picture = config.technical.picture;
    const specs = `本对象制作基线：${picture.aspectRatio}，${picture.width}×${picture.height}，${picture.fps} fps（${picture.confirmation}）。未确认值仍为 UNKNOWN，须以实际文件核验。`;
    const continuity = `连续性依据：${config.sources.continuity.specAlias || "UNKNOWN"}；检查主题：${config.sources.continuity.themes.map((t) => t.label).join("、")}；必需坐标：${config.sources.continuity.requiredCoordinates.join("、")}。缺失依据须明确说明。`;
    criteria = criteria.map((c) => ({
      ...c,
      question:
        c.question +
        (/technical|quality|output|delivery/.test(c.id)
          ? ` ${specs}`
          : /continuity/.test(c.id)
            ? ` ${continuity}`
            : ""),
    }));
  }
  if (!criteria?.length) fail("对象缺少可用审阅标准", profileId);
  const value = {
    profileId,
    legacy,
    criteria: clone(criteria),
    ...(profile?.firstQuestion
      ? {
          firstQuestion: profile.firstQuestion,
          lastQuestion: profile.lastQuestion,
        }
      : {}),
    configurationHash: configHash(semanticConfiguration(config)),
  };
  return { ...value, hash: configHash(value) };
}
export function configurationObjects(snapshot) {
  const m = snapshot.productionModel || {};
  return [
    ...(m.materialRequirements || [])
      .filter((r) => r.requirementClass === "REQUIRED")
      .map((object) => ({
        key: `material:${object.id}`,
        kind: "ASSET",
        object,
      })),
    ...(snapshot.actionQueueInputs?.sceneReviewDossiers || []).map(
      (object) => ({
        key: `scene:${object.sceneId || object.id}`,
        kind: "SCRIPT_SCENE",
        object,
      }),
    ),
    ...[
      ...(m.episodePlanRevisions || []),
      ...(m.configurationCandidates || []),
    ].map((object) => ({
      key: `candidate:${object.id || object.revisionId}`,
      kind: "EPISODE_PLAN",
      object,
    })),
    ...(m.workItems || [])
      .filter((r) => r.activeInCurrentProduction)
      .map((object) => ({
        key: `work:${object.id}`,
        kind: "WORK_PRODUCT",
        object,
      })),
  ];
}
export function bindConfiguration(
  snapshot,
  config,
  previous = {},
  upgradeKeys = [],
  legacy = false,
) {
  const bindings = clone(previous);
  for (const { key, kind, object } of configurationObjects(snapshot)) {
    if (
      !bindings[key] &&
      object.configurationBinding &&
      !upgradeKeys.includes(key)
    )
      bindings[key] = { ...clone(object.configurationBinding), key };
    if (
      !bindings[key] &&
      kind === "EPISODE_PLAN" &&
      object.creativeRevisionId &&
      bindings[`candidate:${object.creativeRevisionId}`]
    )
      bindings[key] = {
        ...clone(bindings[`candidate:${object.creativeRevisionId}`]),
        key,
      };
    if (bindings[key] && !upgradeKeys.includes(key)) continue;
    const m = snapshot.productionModel;
    const scopeContext = (m.reviewContexts || []).find(
      (c) => c.id === object.reviewContextRef,
    ) ||
      (m.reviewContexts || []).find(
        (c) => c.scopeType === object.scopeType && c.scopeId === object.scopeId,
      ) || { scopeType: object.scopeType, scopeId: object.scopeId };
    const shot = (m.shots || []).find((s) => s.id === object.scopeId);
    const spec =
      object.reviewSpec && !upgradeKeys.includes(key)
        ? clone(object.reviewSpec)
        : reviewSpec(config, kind, object, {
            legacy,
            shotContext: shot?.reviewContext || missingShotFacts(),
            scopeContext,
          });
    bindings[key] = {
      key,
      kind,
      reviewSpec: spec,
      technical: clone(config.technical),
      productionLane:
        kind === "ASSET"
          ? categoryFor(
              config,
              object.businessCategoryPrimaryId ||
                object.businessCategoryPrimary,
              object.businessCategorySecondaryId ||
                object.businessCategorySecondary,
            ).type?.productionLane || "MANUAL_OR_ASSISTED"
          : "MANUAL_OR_ASSISTED",
      defaultExecutor: config.collaboration.defaultExecutor,
      workflow: clone(config.workflow),
      sources: clone(config.sources),
      configurationHash: configHash(config),
      createdBy: legacy ? "LEGACY_MIGRATION" : "CONFIGURATION_PUBLISH",
    };
  }
  return bindings;
}
export function projectConfiguration(snapshot, config, bindings, reference) {
  const out = clone(normalizeReviewSnapshot(snapshot));
  const model = out.productionModel;
  model.systemConfiguration = {
    reference,
    config: clone(config),
    defaults: defaultConfiguration(),
  };
  const presentation = config.presentation;
  out.instance = {
    ...out.instance,
    configurationRef: reference,
    branding: {
      ...out.instance?.branding,
      title: presentation.title,
      mark: presentation.mark,
      description: presentation.description,
    },
    title: presentation.title,
    storyTitle: presentation.storyTitle,
    capabilities: {
      ...out.instance?.capabilities,
      landingView: presentation.landingView,
      assistantEnabled: config.collaboration.assistantEnabled,
      preferredCollaborator: config.collaboration.preferredCollaborator,
      defaultExecutor: config.collaboration.defaultExecutor,
      apiKeyEnvName: config.collaboration.apiKeyEnvName || 'OPENAI_API_KEY',
    },
  };
  model.instance = out.instance;
  for (const row of model.materialRequirements || []) {
    const { category, type } = categoryFor(
      config,
      row.businessCategoryPrimaryId || row.businessCategoryPrimary,
      row.businessCategorySecondaryId || row.businessCategorySecondary,
    );
    if (category) {
      row.businessCategoryPrimaryId = category.id;
      row.businessCategoryPrimary = category.label;
    }
    if (type) {
      row.businessCategorySecondaryId = type.id;
      row.businessCategorySecondary = type.label;
    }
    row.classificationPresentation = {
      icon: category?.icon || "◇",
      tone: category?.tone || "neutral",
      primaryOrder: config.taxonomy.categories.findIndex(
        (c) => c.id === category?.id,
      ),
      secondaryOrder: category?.types.findIndex((t) => t.id === type?.id) ?? -1,
    };
    row.reviewSpec = bindings[`material:${row.id}`]?.reviewSpec;
    row.configurationBinding = bindings[`material:${row.id}`];
    if (row.configurationBinding)
      row.productionLane = row.configurationBinding.productionLane;
  }
  for (const work of model.materialWorkItems || []) {
    const requirement = model.materialRequirements?.find(
      (r) => r.id === work.requirementRef,
    );
    work.configurationBinding = requirement?.configurationBinding;
    work.requiredSceneConfirmationIds = (
      requirement?.configurationBinding?.workflow.materialPrerequisites || []
    )
      .filter((r) => r.requirementIds.includes(work.requirementRef))
      .flatMap((r) => r.requiredSceneIds);
  }
  for (const row of out.actionQueueInputs?.sceneReviewDossiers || []) {
    row.reviewSpec = bindings[`scene:${row.sceneId || row.id}`]?.reviewSpec;
    row.configurationBinding = bindings[`scene:${row.sceneId || row.id}`];
  }
  for (const row of [
    ...(model.episodePlanRevisions || []),
    ...(model.configurationCandidates || []),
  ]) {
    row.reviewSpec =
      bindings[`candidate:${row.id || row.revisionId}`]?.reviewSpec;
    row.configurationBinding =
      bindings[`candidate:${row.id || row.revisionId}`];
  }
  for (const row of model.workItems || []) {
    row.reviewSpec = bindings[`work:${row.id}`]?.reviewSpec;
    row.configurationBinding = bindings[`work:${row.id}`];
  }
  for (const phase of model.productionPhases || []) {
    const match = config.workflow.phases.find((p) => p.id === phase.id);
    if (match)
      Object.assign(phase, { label: match.label, purpose: match.purpose });
  }
  for (const gate of model.productionGates || []) {
    const match = config.workflow.gates.find((g) => g.id === gate.id);
    if (match)
      Object.assign(gate, { label: match.label, purpose: match.purpose });
  }
  if (out.storySources)
    out.storySources.evidenceOrder = config.sources.order.map(
      (row) => row.label,
    );
  return out;
}
export function exportConfigurationTemplate(config) {
  const result = clone(config);
  result.presentation = defaultConfiguration().presentation;
  result.sources.continuity.specAlias = "";
  result.workflow.materialPrerequisites = [];
  for (const category of result.taxonomy.categories)
    for (const type of category.types) {
      if (/^material-(legacy|instance)-/.test(type.reviewProfileId || ""))
        type.reviewProfileId = `material-${String(type.mediaType || "IMAGE").toLowerCase()}`;
    }
  result.reviewProfiles = result.reviewProfiles.filter(
    (p) => !/^material-(legacy|instance)-/.test(p.id),
  );
  return {
    schemaVersion: "1.0",
    kind: "REVIEW_CONFIGURATION_TEMPLATE",
    configuration: result,
  };
}
