function claimSummary(claims) {
  return claims.map((claim) => `${claim.class}：${claim.text}`).join("；");
}

export function reviewCriteria(item, context) {
  const narrative =
    context.shot.purpose.class === "U"
      ? `独立镜头目的仍为U；是否只呈现已登记事件“${context.shot.storyEvent.text}”，没有用画面补造意图？`
      : `是否实现本镜目的：“${context.shot.purpose.text}”？`;
  const common = [
    { id: "narrative-fit", label: "叙事作用", question: narrative },
    {
      id: "fact-boundary",
      label: "事实边界",
      question: `是否遵守必须呈现的F/L，并避免提前暗示：${claimSummary(context.shot.mustNotImply)}`,
    },
  ];
  const byDeliverable = {
    LOC_STATE: [
      ...common,
      {
        id: "space-topology",
        label: "空间拓扑",
        question: `地点、门向、区域和路线是否符合：${context.scene.route}`,
      },
      {
        id: "state-freeze",
        label: "状态与冻结点",
        question: `人物、道具与关键事件状态是否符合：${context.scene.keyPropsAndState}`,
      },
      {
        id: "continuity-handoff",
        label: "连续性接力",
        question: `是否满足本场连续性要求：${context.scene.continuity}`,
      },
    ],
    STORYBOARD: [
      ...common,
      {
        id: "identity-count-position",
        label: "人物与站位",
        question: `人物身份、人数、站位及关系是否符合：${claimSummary(context.shot.mustShow)}`,
      },
      {
        id: "camera-space-axis",
        label: "机位与空间",
        question: "机位、轴线、门向、景别及空间关系是否与锁定参考一致？",
      },
      {
        id: "action-prop-state",
        label: "动作与道具",
        question: `动作起点、关键道具与冻结状态是否准确承接前后镜？`,
      },
      {
        id: "generation-integrity",
        label: "画面完整性",
        question:
          "是否没有身份漂移、肢体错误、镜像、乱码、意外文字或其他可见生成瑕疵？",
      },
    ],
    DIALOGUE_DRY: [
      ...common,
      {
        id: "locked-line-match",
        label: "锁定台词",
        question: "台词是否逐字一致，没有增词、漏词、改词或多余开场语？",
      },
      {
        id: "speaker-voice-performance",
        label: "人物与表演",
        question:
          "说话者、声音身份、方言、情绪和人物处境是否与本镜叙事位置一致？",
      },
      {
        id: "intelligibility-cleanliness",
        label: "可懂度与洁净度",
        question:
          "咬字是否清楚，是否没有底噪、爆音、截断、混响污染或不应存在的背景声？",
      },
      {
        id: "audio-rights",
        label: "声音权利",
        question: "声音来源、参考授权和项目内权利状态是否明确且可下传？",
      },
    ],
    ANIMATIC: [
      ...common,
      {
        id: "shot-duration-rhythm",
        label: "逐镜节奏",
        question: `逐镜时长、停顿和场内节奏是否服务所属序列“${context.sequence.title.text}”？`,
      },
      {
        id: "dialogue-in-out",
        label: "台词入出点",
        question: "台词入点、句尾余量、反应镜和转场空间是否自然？",
      },
      {
        id: "scene-continuity",
        label: "场内连续性",
        question: `前后镜动作、视线、空间与状态是否连续：${context.scene.continuity}`,
      },
      {
        id: "timing-lock-sufficiency",
        label: "锁时充分性",
        question:
          "当前版本是否足以作为正式首尾帧和后续声音工作的共享时长基线？",
      },
    ],
    START_FRAME: [
      ...common,
      {
        id: "frame-role",
        label: "首帧职责",
        question:
          "KFA是否清楚呈现动作或台词开始前的可执行起点，而不是提前呈现结果？",
      },
      {
        id: "identity-space-state",
        label: "身份空间状态",
        question: `人物、地点、机位和状态是否符合：${claimSummary(context.shot.mustShow)}`,
      },
      {
        id: "video-feasibility",
        label: "视频可执行性",
        question: "构图、遮挡、肢体、动作余量和景深是否支持向KFB自然运动？",
      },
      {
        id: "image-integrity",
        label: "图像完整性",
        question:
          "是否没有身份漂移、手部错误、镜像、乱码、意外文字或其他生成瑕疵？",
      },
    ],
    END_FRAME: [
      ...common,
      {
        id: "frame-role",
        label: "尾帧职责",
        question: "KFB是否清楚呈现本镜动作的结束状态，并为下一镜留下正确接点？",
      },
      {
        id: "kfa-kfb-continuity",
        label: "首尾帧连续",
        question:
          "与KFA相比，身份、服装、空间、光线和固定物件是否稳定，只改变允许变化的动作状态？",
      },
      {
        id: "next-shot-handoff",
        label: "下一镜接力",
        question: `是否自然衔接下一镜：${context.neighbours.next.id || ""} ${context.neighbours.next.title}`,
      },
      {
        id: "image-integrity",
        label: "图像完整性",
        question:
          "是否没有身份漂移、手部错误、镜像、乱码、意外文字或其他生成瑕疵？",
      },
    ],
    PRE_LIP_VIDEO: [],
    AUDIO_DRIVEN_VIDEO: [],
    NO_LIP_VIDEO: [],
    MOTION_VIDEO: [],
    POST_LIP_VIDEO: [
      ...common,
      {
        id: "speaker-lip-sync",
        label: "说话者同步",
        question: "唇形是否与锁定干声的音素、句首、句尾和停顿同步？",
      },
      {
        id: "non-speaker-stability",
        label: "非说话者稳定",
        question: "非说话者是否保持闭口和身份稳定，没有抢口型或异常面部运动？",
      },
      {
        id: "picture-preservation",
        label: "画面保持",
        question: "口型处理是否没有破坏已通过的身份、动作、空间、时长与画质？",
      },
      {
        id: "shot-lock-eligibility",
        label: "锁镜资格",
        question: "当前版本是否可作为场声音后期与剪辑唯一有效的锁定镜头候选？",
      },
    ],
    SCENE_SOUND_POST: [
      ...common,
      {
        id: "dialogue-intelligibility",
        label: "对白可懂度",
        question:
          "对白在完整场景声中是否始终清楚、自然且不被环境声、拟音或配乐遮蔽？",
      },
      {
        id: "sync-and-acoustics",
        label: "同步与空间声学",
        question: `动作同步点、声源方位、远近、室内外声学是否符合：${context.scene.primaryLocation}`,
      },
      {
        id: "music-necessity",
        label: "配乐必要性",
        question: `配乐是否确有叙事功能，并服务“${context.sequence.structuralRole.text}”，而不是持续铺满？`,
      },
      {
        id: "sound-rights-and-stems",
        label: "权利与分轨",
        question: "所有声音权利状态、来源、分轨与版本血缘是否完整？",
      },
    ],
    EPISODE_DELIVERY_MASTER: [
      {
        id: "episode-structure",
        label: "分集结构",
        question: context.episode.reviewQuestion.text,
      },
      {
        id: "episode-unknowns",
        label: "分集提案边界",
        question:
          "开场钩子、核心推进和结尾悬念尚未正式结构裁决时，是否保持A类提案边界，没有伪装成已确认结论？",
      },
      {
        id: "episode-rhythm",
        label: "分集节奏",
        question:
          "场次切分、信息释放、情绪曲线和结尾停点是否形成可独立观看的一集？",
      },
      {
        id: "episode-technical",
        label: "成片技术",
        question:
          "画面、声音、字幕、色彩、响度、帧率和交付文件是否齐套且一致？",
      },
      {
        id: "episode-lineage-rights",
        label: "版本与权利",
        question:
          "所有采用镜头、声音、字幕与母版是否指向已放行版本并具备权利依据？",
      },
    ],
    PROJECT_DELIVERY_MANIFEST: [
      {
        id: "whole-story-continuity",
        label: "全剧叙事与连续性",
        question:
          "正式分集方案获批后，是否保持人物关系、时间线、事件因果、关键物件状态及故事结局一致？",
      },
      {
        id: "all-episode-completeness",
        label: "获批分集齐套",
        question:
          "正式分集方案获批后，各集母版、字幕、声音分轨、技术报告与当前版本是否完整对应？",
      },
      {
        id: "global-qa",
        label: "全剧QA",
        question:
          "内容、连续性、技术、敏感内容与发行QA是否全部闭合且无禁用资产下传？",
      },
      {
        id: "global-rights",
        label: "权利与发行",
        question:
          "所有权利放行和发行配置是否有证据；任何仍为UNKNOWN的字段是否继续阻断交付？",
      },
      {
        id: "archive-integrity",
        label: "归档完整性",
        question:
          "哈希、版本血缘、Prompt修订、审阅事件和审计归档是否能重建最终交付来源？",
      },
    ],
  };
  const videoCriteria = [
    ...common,
    {
      id: "identity-space-motion",
      label: "身份空间与运动",
      question:
        "人物身份、空间、机位、运动方向和动作轨迹是否稳定且符合KFA/KFB？",
    },
    {
      id: "timing-performance",
      label: "时长与表演",
      question: "动作节奏、停顿、表情和镜头运动是否符合已锁时长与人物处境？",
    },
    {
      id: "frame-binding",
      label: "首尾帧绑定",
      question:
        "第0帧与最终帧是否分别准确绑定KFA/KFB，中途没有跳变或提前结束？",
    },
    {
      id: "video-integrity",
      label: "视频完整性",
      question:
        "是否没有滑步、肢体/面部畸变、身份漂移、闪烁、错误口动、字幕或水印？",
    },
  ];
  if (
    [
      "PRE_LIP_VIDEO",
      "AUDIO_DRIVEN_VIDEO",
      "NO_LIP_VIDEO",
      "MOTION_VIDEO",
    ].includes(item.deliverableKey)
  )
    return videoCriteria;
  return (
    byDeliverable[item.deliverableKey] || [
      ...common,
      {
        id: "definition-match",
        label: "执行定义",
        question: "结果是否与当前执行定义、输入版本、固定输出和技术规格一致？",
      },
      {
        id: "qa-rights-downstream",
        label: "QA、权利与下游",
        question: "技术/内容QA、权利状态与下游门禁是否都有明确证据？",
      },
    ]
  );
}

export function criteriaForReviewScope(item, shotContext, context) {
  if (!context || context.scopeType === "SHOT")
    return reviewCriteria(item, shotContext);
  const reviewQuestion =
    context.judgment?.reviewQuestion?.text ||
    `${context.scopeId}的正式判断问题为UNKNOWN；不得借导航镜头补造。`;
  const purpose =
    context.judgment?.purpose?.text ||
    `${context.scopeId}的独立叙事目的为UNKNOWN。`;
  const audience =
    context.judgment?.audienceTakeaway?.text ||
    `${context.scopeId}结束时观众所得为UNKNOWN。`;
  const scopeBoundary = {
    id: "scope-identity",
    label: "审阅范围",
    question: `是否完整覆盖${context.scopeType} ${context.scopeId}，且没有把当前导航镜头当成整个范围的身份？`,
  };
  const narrative = {
    id: "scope-narrative",
    label: "叙事作用与UNKNOWN",
    question: `目的：${purpose}；观众所得：${audience}。是否只按已登记信息判断，并保留UNKNOWN边界？`,
  };
  if (item.deliverableKey === "ANIMATIC")
    return [
      {
        id: "scene-review-question",
        label: "场级核心判断",
        question: reviewQuestion,
      },
      scopeBoundary,
      narrative,
      {
        id: "scene-continuity",
        label: "场内连续性",
        question: `动作、视线、空间、道具状态和节奏是否连续：${context.scene?.continuity || "UNKNOWN"}`,
      },
      {
        id: "timing-lock-sufficiency",
        label: "锁时充分性",
        question:
          "逐镜时长、对白入出点、反应余量和转场空间是否足以成为整场正式首尾帧的共享时长基线？",
      },
    ];
  if (item.deliverableKey === "SCENE_SOUND_POST")
    return [
      {
        id: "scene-review-question",
        label: "场级核心判断",
        question: reviewQuestion,
      },
      scopeBoundary,
      narrative,
      {
        id: "dialogue-intelligibility",
        label: "对白可懂度",
        question:
          "对白在完整场景声中是否始终清楚、自然且不被环境声、拟音或配乐遮蔽？",
      },
      {
        id: "sync-acoustics-continuity",
        label: "同步、声学与连续性",
        question: `动作同步、声源方位、空间声学与场内状态是否符合：${context.scene?.continuity || "UNKNOWN"}`,
      },
      {
        id: "sound-rights-and-stems",
        label: "权利与分轨",
        question: "所有声音来源、项目内权利门禁、分轨和版本血缘是否完整？",
      },
    ];
  if (item.deliverableKey === "EPISODE_DELIVERY_MASTER")
    return [
      {
        id: "episode-review-question",
        label: "分集核心判断",
        question: reviewQuestion,
      },
      scopeBoundary,
      {
        id: "episode-structure",
        label: "开场、推进与悬念",
        question: `开场：${context.episode?.openingHook?.text || "UNKNOWN"}；推进：${context.episode?.coreAdvance?.text || "UNKNOWN"}；结尾：${context.episode?.endingCliffhanger?.text || "UNKNOWN"}。是否保持A/F/L/U边界？`,
      },
      {
        id: "episode-rhythm-technical",
        label: "节奏与技术齐套",
        question:
          "场间承接、音画、字幕、色彩、响度、帧率和交付文件是否齐套一致？",
      },
      {
        id: "episode-lineage-rights",
        label: "版本与权利",
        question:
          "所有采用镜头、声音、字幕和母版是否指向已放行版本，且权利与发行UNKNOWN仍被明确阻断？",
      },
    ];
  if (item.deliverableKey === "PROJECT_DELIVERY_MANIFEST")
    return [
      {
        id: "project-review-question",
        label: "全剧核心判断",
        question: reviewQuestion,
      },
      scopeBoundary,
      {
        id: "whole-story-continuity",
        label: "全剧叙事与连续性",
        question:
          "正式分集方案获批后，是否保持人物关系、时间线、事件因果、关键物件状态及故事结局一致？",
      },
      {
        id: "global-completeness-qa",
        label: "分集提案齐套与全剧QA",
        question:
          "获批后的分集母版、字幕、分轨、技术报告、敏感内容QA与采用版本是否完整对应，且无禁用资产下传？",
      },
      {
        id: "global-rights-archive",
        label: "权利、发行与归档",
        question: `商业发行合规当前为${context.project?.commercialReleaseCompliance || "UNKNOWN"}；是否继续阻断未知项，并保留哈希、版本血缘、Prompt、审阅事件和归档证据？`,
      },
    ];
  return [
    {
      id: "scope-review-question",
      label: "范围核心判断",
      question: reviewQuestion,
    },
    scopeBoundary,
    narrative,
  ];
}
