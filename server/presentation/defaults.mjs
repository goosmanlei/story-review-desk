// Original UI presentation defaults from 26efbef. No runtime, project data or frozen object standards.
export const configurationDefaults = {
  "schemaVersion": "2.0",
  "domain": {
    "entityTypes": [
      {
        "id": "CHARACTER",
        "label": "人物"
      },
      {
        "id": "GROUP",
        "label": "群体"
      },
      {
        "id": "LOCATION",
        "label": "地点"
      },
      {
        "id": "PROP",
        "label": "道具"
      },
      {
        "id": "ORGANIZATION",
        "label": "组织"
      },
      {
        "id": "SOUND",
        "label": "声音主题"
      },
      {
        "id": "STYLE",
        "label": "风格"
      },
      {
        "id": "UNRESOLVED",
        "label": "待确认主体"
      }
    ],
    "relationTypes": [
      {
        "id": "KINSHIP",
        "label": "血缘关系",
        "class": "STORY",
        "directed": false,
        "acyclic": false
      },
      {
        "id": "SOCIAL",
        "label": "社会关系",
        "class": "STORY",
        "directed": false,
        "acyclic": false
      },
      {
        "id": "LOCATED_IN",
        "label": "位于",
        "class": "STORY",
        "directed": true,
        "acyclic": true
      },
      {
        "id": "PART_OF",
        "label": "组成",
        "class": "COMPOSITION",
        "directed": true,
        "acyclic": true
      },
      {
        "id": "STATE_TRANSITION",
        "label": "状态变化",
        "class": "CONTINUITY",
        "directed": true,
        "acyclic": true
      },
      {
        "id": "SAME_IDENTITY",
        "label": "同一身份参考",
        "class": "REFERENCE",
        "directed": true,
        "acyclic": true
      },
      {
        "id": "FAMILY_RESEMBLANCE",
        "label": "有限亲缘参考",
        "class": "REFERENCE",
        "directed": true,
        "acyclic": true
      },
      {
        "id": "VISUAL_REFERENCE",
        "label": "视觉参考",
        "class": "REFERENCE",
        "directed": true,
        "acyclic": true
      },
      {
        "id": "VOICE_REFERENCE",
        "label": "声音参考",
        "class": "REFERENCE",
        "directed": true,
        "acyclic": true
      },
      {
        "id": "DETERMINISTIC_DERIVATION",
        "label": "确定性派生",
        "class": "REFERENCE",
        "directed": true,
        "acyclic": true
      }
    ],
    "representationTypes": [
      {
        "id": "IDENTITY",
        "label": "身份母版",
        "mediaType": "IMAGE",
        "dimensions": [
          "age",
          "costume"
        ]
      },
      {
        "id": "APPEARANCE",
        "label": "人物情节状态",
        "mediaType": "IMAGE",
        "dimensions": [
          "age",
          "costume",
          "bodyState"
        ]
      },
      {
        "id": "HEAD",
        "label": "首级身份代理",
        "mediaType": "IMAGE",
        "dimensions": [
          "bodyState",
          "concealment"
        ]
      },
      {
        "id": "BODY",
        "label": "尸身状态",
        "mediaType": "IMAGE",
        "dimensions": [
          "bodyState",
          "concealment"
        ]
      },
      {
        "id": "INFO_CARD",
        "label": "人物信息卡",
        "mediaType": "IMAGE",
        "dimensions": [
          "audienceKnowledge"
        ]
      },
      {
        "id": "LOCATION_EMPTY",
        "label": "地点空态",
        "mediaType": "IMAGE",
        "dimensions": [
          "viewpoint",
          "time",
          "weather"
        ]
      },
      {
        "id": "LOCATION_STATE",
        "label": "地点状态",
        "mediaType": "IMAGE",
        "dimensions": [
          "viewpoint",
          "time",
          "weather",
          "storyState"
        ]
      },
      {
        "id": "PROP_STATE",
        "label": "道具状态",
        "mediaType": "IMAGE",
        "dimensions": [
          "storyState"
        ]
      },
      {
        "id": "VOICE_IDENTITY",
        "label": "声音身份",
        "mediaType": "AUDIO",
        "dimensions": [
          "age",
          "dialect"
        ]
      },
      {
        "id": "DIALOGUE",
        "label": "对白表演",
        "mediaType": "AUDIO",
        "dimensions": [
          "emotion",
          "performanceContext"
        ]
      },
      {
        "id": "DIALOGUE_TEXT",
        "label": "台词文本",
        "mediaType": "TEXT",
        "dimensions": [
          "audienceKnowledge"
        ]
      },
      {
        "id": "AMBIENCE",
        "label": "环境底声",
        "mediaType": "AUDIO",
        "dimensions": [
          "time",
          "weather",
          "acoustics"
        ]
      },
      {
        "id": "FOLEY",
        "label": "动作拟音",
        "mediaType": "AUDIO",
        "dimensions": [
          "syncPoint"
        ]
      },
      {
        "id": "MUSIC",
        "label": "配乐",
        "mediaType": "AUDIO",
        "dimensions": [
          "emotion"
        ]
      },
      {
        "id": "STYLE_ANCHOR",
        "label": "风格参考",
        "mediaType": "IMAGE",
        "dimensions": []
      },
      {
        "id": "UNRESOLVED",
        "label": "待确认表现",
        "mediaType": "TEXT",
        "dimensions": []
      }
    ],
    "stateDimensions": [
      {
        "id": "age",
        "label": "年龄"
      },
      {
        "id": "costume",
        "label": "服饰"
      },
      {
        "id": "bodyState",
        "label": "身体状态"
      },
      {
        "id": "concealment",
        "label": "遮挡"
      },
      {
        "id": "viewpoint",
        "label": "方位与机位"
      },
      {
        "id": "time",
        "label": "时辰"
      },
      {
        "id": "storyTime",
        "label": "故事内时间"
      },
      {
        "id": "presentationTime",
        "label": "观众呈现时序"
      },
      {
        "id": "weather",
        "label": "天气"
      },
      {
        "id": "storyState",
        "label": "故事状态"
      },
      {
        "id": "audienceKnowledge",
        "label": "观众所知"
      },
      {
        "id": "dialect",
        "label": "口音"
      },
      {
        "id": "emotion",
        "label": "情绪"
      },
      {
        "id": "performanceContext",
        "label": "表演上下文"
      },
      {
        "id": "acoustics",
        "label": "空间声学"
      },
      {
        "id": "syncPoint",
        "label": "同步点"
      }
    ],
    "referencePolicies": [
      {
        "id": "CLEAN_MASTER",
        "label": "干净母版锚定",
        "purposes": [
          "identity",
          "composition",
          "style",
          "space"
        ],
        "requireApprovedVersion": true,
        "maxDerivedGenerations": 2,
        "allowIdentityTransfer": false
      },
      {
        "id": "LIMITED_KINSHIP",
        "label": "有限亲缘相似",
        "purposes": [
          "family-resemblance"
        ],
        "requireApprovedVersion": true,
        "maxDerivedGenerations": 1,
        "allowIdentityTransfer": false
      },
      {
        "id": "VOICE_MASTER",
        "label": "原创声音母版",
        "purposes": [
          "voice-identity",
          "performance",
          "dialect"
        ],
        "requireApprovedVersion": true,
        "maxDerivedGenerations": 2,
        "allowIdentityTransfer": false
      },
      {
        "id": "SOUND_CONTEXT",
        "label": "声音空间与事件参考",
        "purposes": [
          "acoustics",
          "ambience",
          "event-timing",
          "music-structure"
        ],
        "requireApprovedVersion": true,
        "maxDerivedGenerations": 2,
        "allowIdentityTransfer": false
      },
      {
        "id": "EXACT_DERIVATION",
        "label": "确定性裁切与合成",
        "purposes": [
          "crop",
          "scale",
          "compose"
        ],
        "requireApprovedVersion": true,
        "maxDerivedGenerations": 0,
        "allowIdentityTransfer": false
      }
    ]
  },
  "template": {
    "id": "film-production",
    "version": "1.1"
  },
  "reviewProfiles": [
    {
      "id": "episode-plan",
      "label": "分集剧情设计",
      "subjectKind": "EPISODE_PLAN",
      "criteria": [
        {
          "id": "opening-boundary",
          "label": "开场与承接",
          "question": "是否接住上集留下的问题，并清楚建立本集关注点？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "episode-purpose",
          "label": "本集任务",
          "question": "本集主要任务是否清楚，各场与主副线是否有必要作用？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "escalation-turn",
          "label": "推进与转折",
          "question": "压力、信息或人物状态是否发生有意义的变化，转折与节奏是否合适？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "information-causality",
          "label": "信息与因果",
          "question": "行动是否有依据，人物与观众的知情顺序是否自洽，铺垫与回收是否成立？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "episode-payoff",
          "label": "本集回报",
          "question": "本集承诺了什么，是否兑现了明确的阶段性结果？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "ending-propulsion",
          "label": "结尾与承接",
          "question": "停在实际结尾是否合适，留下的问题能否被下一集有效承接？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ],
      "firstQuestion": "开场能否独立建立人物困境、主要冲突和观看关注点？",
      "lastQuestion": "终局是否兑现主要承诺、闭合应闭合的因果，并留下合适的余韵？"
    },
    {
      "id": "script-scene",
      "label": "场正文",
      "subjectKind": "SCRIPT_SCENE",
      "criteria": [
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "source-fidelity",
          "label": "原文与改编边界",
          "question": "事实、人物关系、事件因果和明确标注的改编边界是否正确？"
        },
        {
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": false,
          "id": "episode-inheritance",
          "label": "分集意图与本场落实",
          "question": "本场是否落实本集任务与本场责任，正确承接前后场、信息释放、笑点及铺垫回收，且没有遗漏、偏离或提前泄露？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "shootability-continuity",
          "label": "可拍性与连续性",
          "question": "动作、空间、道具状态及前后场承接是否可直接进入后续制作？"
        }
      ]
    },
    {
      "id": "material-image",
      "label": "图像素材",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "purpose",
          "label": "用途与内容",
          "question": "是否满足已登记用途、内容要求与当前故事依据？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "continuity",
          "label": "身份与连续性",
          "question": "是否与已采用输入、人物、空间及状态一致？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "technical-quality",
          "label": "制作质量",
          "question": "实际文件是否符合已确认制作规格，没有影响使用的质量问题？"
        }
      ]
    },
    {
      "id": "material-audio",
      "label": "声音素材",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "purpose",
          "label": "用途与内容",
          "question": "是否满足已登记用途、内容要求与当前故事依据？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "continuity",
          "label": "身份与连续性",
          "question": "是否与已采用输入、人物、空间及状态一致？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "technical-quality",
          "label": "制作质量",
          "question": "实际文件是否符合已确认制作规格，没有影响使用的质量问题？"
        }
      ]
    },
    {
      "id": "material-video",
      "label": "视频素材",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "purpose",
          "label": "用途与内容",
          "question": "是否满足已登记用途、内容要求与当前故事依据？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "continuity",
          "label": "身份与连续性",
          "question": "是否与已采用输入、人物、空间及状态一致？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "technical-quality",
          "label": "制作质量",
          "question": "实际文件是否符合已确认制作规格，没有影响使用的质量问题？"
        }
      ]
    },
    {
      "id": "material-text",
      "label": "文本素材",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "purpose",
          "label": "用途与内容",
          "question": "是否满足已登记用途、内容要求与当前故事依据？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "continuity",
          "label": "身份与连续性",
          "question": "是否与已采用输入、人物、空间及状态一致？"
        },
        {
          "required": true,
          "allowNA": true,
          "noteRequiredOnFail": false,
          "id": "technical-quality",
          "label": "制作质量",
          "question": "实际文件是否符合已确认制作规格，没有影响使用的质量问题？"
        }
      ]
    },
    {
      "id": "production-storyboard",
      "label": "粗分镜",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "STORYBOARD",
      "criteria": [
        {
          "id": "narrative-fit",
          "label": "画面表达",
          "question": "画面是否准确表达本镜行动和观众应获得的信息？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "identity-space",
          "label": "人物与空间",
          "question": "人物身份、人数、站位、机位和轴线是否符合已锁定依据？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "action-continuity",
          "label": "动作与衔接",
          "question": "动作、视线和道具状态是否能接住前后镜？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "image-quality",
          "label": "画面质量",
          "question": "是否没有影响理解的肢体错误、镜像、乱码或身份漂移？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-dialogue_dry",
      "label": "对白干声",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "DIALOGUE_DRY",
      "criteria": [
        {
          "id": "line-match",
          "label": "台词准确",
          "question": "对白是否符合已锁定文本，没有增词、漏词或改词？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "voice-performance",
          "label": "角色与表演",
          "question": "音色、口音、情绪和停顿是否符合说话者与当前处境？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "audio-quality",
          "label": "清楚干净",
          "question": "咬字是否清楚，没有底噪、爆音、截断或多余背景声？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-start_frame",
      "label": "首帧",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "START_FRAME",
      "criteria": [
        {
          "id": "frame-role",
          "label": "动作起点",
          "question": "首帧是否呈现动作开始前的正确状态，没有提前出现结果？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "identity-space",
          "label": "人物与空间",
          "question": "人物、服装、地点、机位与关键道具是否符合已采用参考？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "motion-room",
          "label": "运动余量",
          "question": "构图、遮挡和肢体姿态是否支持向尾帧自然运动？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "image-quality",
          "label": "画面质量",
          "question": "画面是否清晰完整，没有身份漂移、手部错误、镜像或意外文字？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-end_frame",
      "label": "尾帧",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "END_FRAME",
      "criteria": [
        {
          "id": "frame-role",
          "label": "动作终点",
          "question": "尾帧是否呈现本镜动作结束后的正确状态？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "frame-continuity",
          "label": "首尾一致",
          "question": "身份、服装、空间、光线和固定物件是否与首帧一致，仅发生允许的变化？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "next-handoff",
          "label": "下镜衔接",
          "question": "结束姿态、视线和道具状态是否能接入下一镜？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "image-quality",
          "label": "画面质量",
          "question": "画面是否清晰完整，没有身份漂移、肢体错误或意外文字？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-post_lip_video",
      "label": "口型修正",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "POST_LIP_VIDEO",
      "criteria": [
        {
          "id": "speaker-sync",
          "label": "口型同步",
          "question": "说话者的口型是否与锁定干声的句首、句尾、停顿和发音同步？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "other-faces",
          "label": "其他人物稳定",
          "question": "非说话者是否没有抢口型或异常面部运动？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "picture-preservation",
          "label": "画面保持",
          "question": "口型处理是否保留已通过的身份、动作、空间、时长和画质？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-locked_shot",
      "label": "单镜锁定",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "LOCKED_SHOT",
      "criteria": [
        {
          "id": "picture-complete",
          "label": "镜头完整",
          "question": "本镜画面是否完成应有表达，起止状态可接入剪辑？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "continuity",
          "label": "连续一致",
          "question": "采用的画面和适用声音是否符合本镜已锁定输入？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "lip-branch",
          "label": "对白与口型",
          "question": "需要口型时，是否已完成对应分支检查；无需口型时是否保持自然口部状态？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-technical_report",
      "label": "附加技术报告",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "TECHNICAL_REPORT",
      "criteria": [
        {
          "id": "target",
          "label": "检查对象",
          "question": "报告是否明确检查的对象、文件版本及适用技术要求？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "measurements",
          "label": "实测证据",
          "question": "检查结果是否有实际测量或工具输出支持，未检查项是否明确标为待确认？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "conclusion",
          "label": "结论完整",
          "question": "通过项、异常项及处理结果是否清楚，结论是否与证据一致？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-continuity_report",
      "label": "附加连续性报告",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "CONTINUITY_REPORT",
      "criteria": [
        {
          "id": "scope",
          "label": "检查范围",
          "question": "报告是否明确对象和前后衔接范围？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "continuity",
          "label": "连续性依据",
          "question": "人物、动作、空间和状态的检查是否有实际画面或权威资料支持？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "issues",
          "label": "问题与结论",
          "question": "问题位置、影响范围和处理结果是否清楚，结论是否与证据一致？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-subtitle_file",
      "label": "字幕",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SUBTITLE_FILE",
      "criteria": [
        {
          "id": "text-match",
          "label": "文字准确",
          "question": "字幕是否符合锁定对白与已确认写法，没有错漏、擅改或提前剧透？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "subtitle-sync",
          "label": "时间同步",
          "question": "字幕入出点是否与对白匹配，持续时间是否便于阅读？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "layout",
          "label": "排版可读",
          "question": "断行、字体、位置与安全区是否清晰，并避开人物信息卡和关键画面？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "output-quality",
          "label": "文件可用",
          "question": "字幕编码、格式和时间基线是否符合交付要求，能与对应成片正确加载？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-audio_stems",
      "label": "声音分轨",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "AUDIO_STEMS",
      "criteria": [
        {
          "id": "content",
          "label": "分轨内容",
          "question": "对白、环境、拟音和配乐是否按要求独立导出，没有漏声或混入其他轨道？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "alignment",
          "label": "时间对齐",
          "question": "各轨起点、时长和同步事件是否与锁定画面及最终混音一致？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "audio-quality",
          "label": "声音质量",
          "question": "采样、声道与音量是否符合已确认规格，没有爆音、截断或异常静音？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-shot_plan_set",
      "label": "镜头设计与输入锁定",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SHOT_PLAN_SET",
      "criteria": [
        {
          "id": "coverage",
          "label": "节拍覆盖",
          "question": "镜头安排是否完整覆盖已确认的场级镜头意图，且每镜都有明确作用？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "shootability",
          "label": "可执行性",
          "question": "景别、机位、动作、对白与空间安排是否能实际制作并连贯剪辑？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "input-readiness",
          "label": "输入齐备",
          "question": "每镜需要的人物、地点、道具和声音输入是否明确，缺项是否已说明？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-storyboard_dialogue_package",
      "label": "分镜与对白齐套",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "STORYBOARD_DIALOGUE_PACKAGE",
      "criteria": [
        {
          "id": "coverage",
          "label": "内容齐套",
          "question": "所需粗分镜和适用对白是否全部经过各自验收？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "alignment",
          "label": "相互对应",
          "question": "画面节拍与对白顺序、说话者和反应位置是否一一对应？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-animatic_timing_lock",
      "label": "场级预演与锁时",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "ANIMATIC_TIMING_LOCK",
      "criteria": [
        {
          "id": "narrative-fit",
          "label": "场景表达",
          "question": "完整预演是否实现本场叙事任务，信息清楚且没有提前揭晓？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "scene-continuity",
          "label": "前后衔接",
          "question": "动作、视线、空间和道具状态是否连贯？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "timing",
          "label": "节奏与对白",
          "question": "逐镜时长、对白入出点、反应余量和转场是否自然？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "timing-lock",
          "label": "锁时条件",
          "question": "当前预演是否足以作为后续画面与声音制作的共同时间基线？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-shot_keyframe_set",
      "label": "首尾帧齐套",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SHOT_KEYFRAME_SET",
      "criteria": [
        {
          "id": "pair-completeness",
          "label": "首尾齐套",
          "question": "首帧与尾帧是否分别通过验收，并对应同一镜头和时间范围？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "motion-feasibility",
          "label": "运动可达",
          "question": "首尾之间的动作变化是否可实现，没有空间或状态跳变？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-shot_video",
      "label": "镜头视频",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SHOT_VIDEO",
      "criteria": [
        {
          "id": "narrative-fit",
          "label": "镜头表达",
          "question": "动作、表情与镜头运动是否实现已确认的镜头意图？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "identity-space-motion",
          "label": "身份与运动",
          "question": "人物、空间、方向及运动轨迹是否稳定，并符合首尾帧？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "timing-performance",
          "label": "时长与节奏",
          "question": "动作节奏、停顿和表演是否符合锁定时长及人物处境？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "frame-handoff",
          "label": "起止衔接",
          "question": "开始与结束状态是否准确承接已确认首尾帧？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "video-quality",
          "label": "视频质量",
          "question": "是否没有滑步、畸变、闪烁、异常口动、字幕或水印？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-scene_picture_lock_edl",
      "label": "场剪辑与画面锁定",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SCENE_PICTURE_LOCK_EDL",
      "criteria": [
        {
          "id": "scene-expression",
          "label": "场景表达",
          "question": "场剪辑是否实现本场任务，行动、信息与情绪清晰？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "scene-continuity",
          "label": "剪辑连续",
          "question": "动作、视线、空间、道具状态和镜头衔接是否连贯？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "edit-list",
          "label": "剪辑表准确",
          "question": "剪辑表是否逐项对应实际画面，包含准确的镜头、版本和入出点？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "picture-lock",
          "label": "画面可锁定",
          "question": "镜头顺序、时长及人物信息卡是否已确定，足以开始同步声音制作？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-scene_sound_mix_subtitles",
      "label": "场声音与混音",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SCENE_SOUND_MIX_SUBTITLES",
      "criteria": [
        {
          "id": "dialogue",
          "label": "对白清晰",
          "question": "完整场景中对白是否自然清楚，不被其他声音遮蔽？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "sync",
          "label": "声音同步",
          "question": "拟音、事件声和声源方向是否与锁定画面准确对应？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "acoustics",
          "label": "空间与层次",
          "question": "环境、混响、远近和配乐层次是否符合场景且过渡自然？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "mix-quality",
          "label": "混音质量",
          "question": "音量与动态是否适合已确认规格，没有爆音、截断或突变？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-scene_qa_report",
      "label": "场级质量检查",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SCENE_QA_REPORT",
      "criteria": [
        {
          "id": "picture-sound-text",
          "label": "音画字幕",
          "question": "完整场景的画面、声音和字幕是否匹配且可正常观看？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "continuity",
          "label": "场景连续",
          "question": "动作、空间、人物和道具状态是否连贯，问题是否已有处理结论？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "report-evidence",
          "label": "结论与证据",
          "question": "检查范围、所审版本、发现的问题和处理结果是否清楚且有对应证据？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-episode_master",
      "label": "分集组装",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "EPISODE_MASTER",
      "criteria": [
        {
          "id": "scene-completeness",
          "label": "场景齐套",
          "question": "当前分集方案要求的场景是否齐全且采用已放行版本？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "assembly-order",
          "label": "组装顺序",
          "question": "场次顺序、入出点与集边界是否符合当前分集方案？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "assembly-handoff",
          "label": "连接完整",
          "question": "场间音画是否正确连接，没有缺段、重段、黑帧或异常静音？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-episode_review_decision",
      "label": "分集审阅",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "EPISODE_REVIEW_DECISION",
      "criteria": [
        {
          "id": "episode-purpose",
          "label": "本集表达",
          "question": "成片是否实现本集任务，并兑现应有的阶段回报？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "rhythm",
          "label": "节奏与表演",
          "question": "事件推进、表演和情绪变化是否自然，是否存在拖沓或理解困难？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "information",
          "label": "信息与因果",
          "question": "人物行动、观众知情顺序和线索回收是否清楚、自洽？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "boundaries",
          "label": "开场与结尾",
          "question": "开场承接和结尾停点是否有效；首集能否独立建立，末集能否完成收束？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-episode_tech_qc_report",
      "label": "分集技术检查",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "EPISODE_TECH_QC_REPORT",
      "criteria": [
        {
          "id": "picture-technical",
          "label": "画面规格",
          "question": "画幅、尺寸和帧率是否符合当前画面基线，编码与色彩是否已对实际文件完成检查？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "audio-technical",
          "label": "声音规格",
          "question": "声道、采样、响度和峰值是否已对实际文件完成检查并记录结果？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "playback",
          "label": "播放与同步",
          "question": "完整文件是否可正常解码播放，音画及字幕是否同步？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "report-evidence",
          "label": "检查证据",
          "question": "报告是否对应实际交付文件，并清楚记录检查结果和未解决问题？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-series_continuity_report",
      "label": "跨集连续性",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "SERIES_CONTINUITY_REPORT",
      "criteria": [
        {
          "id": "story-continuity",
          "label": "剧情连续",
          "question": "跨集人物关系、时间线、事件因果和结局是否一致？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "visual-continuity",
          "label": "画面连续",
          "question": "人物、地点、道具及关键状态是否在跨集衔接处一致？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "information",
          "label": "信息衔接",
          "question": "跨集线索、知情顺序、铺垫与回收是否成立？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "issues",
          "label": "问题闭合",
          "question": "连续性问题是否定位到具体集与时间段，并已有处理结论？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-final_rights_safety_tech_report",
      "label": "权利、敏感内容与技术终检",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "FINAL_RIGHTS_SAFETY_TECH_REPORT",
      "criteria": [
        {
          "id": "rights",
          "label": "发行权利",
          "question": "全部采用内容是否具备目标发行用途的权利依据，项目内部确认是否仍与发行授权分开？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "safety",
          "label": "内容尺度",
          "question": "敏感内容和人物表现是否符合已确认的平台、受众与尺度要求？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "technical",
          "label": "技术终检",
          "question": "发行规格和技术检查是否齐备，未确认或未通过事项是否继续阻断交付？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "production-delivery_manifest_archive",
      "label": "交付归档",
      "subjectKind": "WORK_PRODUCT",
      "deliverableKey": "DELIVERY_MANIFEST_ARCHIVE",
      "criteria": [
        {
          "id": "completeness",
          "label": "交付齐套",
          "question": "分集母版、字幕、分轨和所需报告是否按最终清单齐全交付？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "version-match",
          "label": "版本对应",
          "question": "清单是否逐项对应实际交付文件及其已批准版本？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "traceability",
          "label": "来源可追溯",
          "question": "文件校验值、采用依据、审阅记录和必要制作资料是否足以追溯交付来源？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-identity",
      "label": "人物身份",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "身份与外观",
          "question": "年龄、身份和成年外观是否符合角色设定？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "身份稳定",
          "question": "脸型、体态、发式和服装是否稳定，能作为后续身份参考？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "角色区分",
          "question": "是否没有误复制其他无亲缘角色的面部特征？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "参考与规格",
          "question": "参考来源、身份隔离和实际文件规格是否满足当前要求？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-information-card",
      "label": "人物信息卡",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "文字准确",
          "question": "文字是否逐字符合已登记内容，没有错漏或扩写？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "出现时机",
          "question": "出现时机是否符合首次清晰出场或已确认变体，不提前剧透？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "版式可读",
          "question": "版式、字号与对比度是否便于短时阅读，并继承已采用模板？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "合成质量",
          "question": "透明边缘和输出质量是否满足合成要求，没有水印或多余人物肖像？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-extras",
      "label": "群演身份",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "身份与外观",
          "question": "年龄、职业与外观是否符合群体设定？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "人物区分",
          "question": "人物是否有必要区分，没有重复人脸或误用主要角色身份？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "画面质量",
          "question": "服装、人数、动作与画面质量是否满足使用要求？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "参考来源",
          "question": "参考来源与授权事实是否可追溯？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-empty-location",
      "label": "地点空态",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "空间布局",
          "question": "门向、区域、机位和固定物件是否符合空间依据？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "空态纯净",
          "question": "是否保持空态，没有混入单场人物或临时状态？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "方位一致",
          "question": "方位和轴线是否一致，没有镜像？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "合成条件",
          "question": "尺寸、构图和固定物件是否支持后续合成？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-location-state",
      "label": "地点状态",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "空间继承",
          "question": "空间布局是否继承已采用地点空态？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "状态准确",
          "question": "人物、关键物件及事件状态是否符合当前冻结时点？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "变化范围",
          "question": "是否仅改变当前时点允许变化的元素？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "前后衔接",
          "question": "状态是否可以准确接入使用场次及前后镜？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-key-prop",
      "label": "关键道具",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "造型与用途",
          "question": "造型、时代、材质、尺寸和用途是否符合当前依据？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "身份稳定",
          "question": "关键特征是否清楚且可以跨镜识别？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "状态边界",
          "question": "是否未混入其他时间点或场次的状态？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "制作质量",
          "question": "细节、画质与合成条件是否满足实际使用？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-prop-state",
      "label": "道具状态",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "状态准确",
          "question": "当前状态是否符合已确认事件和使用时点？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "变化合理",
          "question": "变化是否符合物理关系和已采用道具母版？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "前后衔接",
          "question": "前后状态是否连续，没有新增无依据的信息？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "制作质量",
          "question": "细节和画面质量是否支持后续合成？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-voice-identity",
      "label": "声音身份",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "角色与口音",
          "question": "年龄、身份、性格和口音是否符合角色设定？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "音色稳定",
          "question": "音色是否自然、稳定、清楚且不模仿未经授权的真人？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "声音干净",
          "question": "是否没有多余台词、背景声或异常表演？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "参考与规格",
          "question": "参考授权与技术规格是否满足当前要求？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-ambience-bed",
      "label": "环境底声",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "环境符合",
          "question": "地点、时辰、天气和空间声学是否符合已锁定设定？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "内容纯净",
          "question": "是否没有动作同步事件、对白或可识别音乐？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "循环自然",
          "question": "循环接缝是否自然，声音质量是否满足要求？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "使用范围",
          "question": "是否适合作为可复用底声，且没有被当作最终混音？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-action-foley",
      "label": "动作拟音",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "材质与力度",
          "question": "动作材质与力度是否符合锁定画面？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "动作同步",
          "question": "同步点、远近和声源方向是否准确？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "事件准确",
          "question": "是否没有添加画面中不存在的事件？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "分轨与来源",
          "question": "分轨、技术规格和参考来源是否符合要求？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-original-music",
      "label": "原创配乐",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "叙事作用",
          "question": "配乐是否服务当前段落的叙事作用？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "情绪与信息",
          "question": "是否没有提前揭晓悬念或持续遮蔽对白与表演？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "原创来源",
          "question": "旋律、演奏和声音来源是否原创且可追溯？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "剪辑适配",
          "question": "分轨、循环或收束是否适合锁定剪辑？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    },
    {
      "id": "material-type-style-anchor",
      "label": "风格参考",
      "subjectKind": "ASSET",
      "criteria": [
        {
          "id": "check-1",
          "label": "风格符合",
          "question": "时代、季节、色调和摄影质感是否符合当前风格设定？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-2",
          "label": "身份隔离",
          "question": "是否没有可误认作剧情身份的无关人脸？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-3",
          "label": "材质与光线",
          "question": "服化材质和光线是否足以稳定复用？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        },
        {
          "id": "check-4",
          "label": "画面质量",
          "question": "是否没有乱码、镜像或其他明显生成瑕疵？",
          "required": true,
          "allowNA": false,
          "noteRequiredOnFail": true
        }
      ]
    }
  ],
  "taxonomy": {
    "categories": [
      {
        "id": "people",
        "label": "人物",
        "icon": "👤",
        "tone": "people",
        "aliases": [
          "人物"
        ],
        "types": [
          {
            "id": "identity",
            "label": "人物身份",
            "aliases": [
              "人物身份"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-identity",
            "productionLane": "MANUAL_OR_ASSISTED"
          },
          {
            "id": "information-card",
            "label": "人物信息卡",
            "aliases": [
              "人物信息卡"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-information-card",
            "productionLane": "MANUAL_OR_ASSISTED"
          },
          {
            "id": "extras",
            "label": "群演身份",
            "aliases": [
              "群演身份"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-extras",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "scene",
        "label": "场景",
        "icon": "🏠",
        "tone": "scene",
        "aliases": [
          "场景"
        ],
        "types": [
          {
            "id": "empty-location",
            "label": "地点空态",
            "aliases": [
              "地点空态"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-empty-location",
            "productionLane": "MANUAL_OR_ASSISTED"
          },
          {
            "id": "location-state",
            "label": "地点状态",
            "aliases": [
              "地点状态"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-location-state",
            "productionLane": "MANUAL_OR_ASSISTED"
          },
          {
            "id": "space-reference",
            "label": "空间证据",
            "aliases": [
              "空间证据"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-image",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "prop",
        "label": "道具",
        "icon": "🧰",
        "tone": "prop",
        "aliases": [
          "道具"
        ],
        "types": [
          {
            "id": "key-prop",
            "label": "关键道具",
            "aliases": [
              "关键道具"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-key-prop",
            "productionLane": "MANUAL_OR_ASSISTED"
          },
          {
            "id": "prop-state",
            "label": "道具状态",
            "aliases": [
              "道具状态"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-prop-state",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "dialogue",
        "label": "台词",
        "icon": "💬",
        "tone": "dialogue",
        "aliases": [
          "台词"
        ],
        "types": [
          {
            "id": "dialogue-text",
            "label": "对白文本",
            "aliases": [
              "对白文本"
            ],
            "mediaType": "TEXT",
            "reviewProfileId": "material-text",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "voice",
        "label": "配音",
        "icon": "🎙️",
        "tone": "voice",
        "aliases": [
          "配音"
        ],
        "types": [
          {
            "id": "voice-identity",
            "label": "声音身份",
            "aliases": [
              "声音身份"
            ],
            "mediaType": "AUDIO",
            "reviewProfileId": "material-type-voice-identity",
            "productionLane": "MANUAL_OR_ASSISTED"
          },
          {
            "id": "voice-master",
            "label": "声音母版",
            "aliases": [
              "声音母版"
            ],
            "mediaType": "AUDIO",
            "reviewProfileId": "material-audio",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "foley",
        "label": "拟音",
        "icon": "👣",
        "tone": "foley",
        "aliases": [
          "拟音"
        ],
        "types": [
          {
            "id": "action-foley",
            "label": "动作拟音",
            "aliases": [
              "动作拟音"
            ],
            "mediaType": "AUDIO",
            "reviewProfileId": "material-type-action-foley",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "ambience",
        "label": "环境声",
        "icon": "🔉",
        "tone": "ambience",
        "aliases": [
          "环境声"
        ],
        "types": [
          {
            "id": "ambience-bed",
            "label": "环境底声",
            "aliases": [
              "环境底声"
            ],
            "mediaType": "AUDIO",
            "reviewProfileId": "material-type-ambience-bed",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "music",
        "label": "配乐",
        "icon": "🎵",
        "tone": "music",
        "aliases": [
          "配乐"
        ],
        "types": [
          {
            "id": "original-music",
            "label": "原创配乐",
            "aliases": [
              "原创配乐"
            ],
            "mediaType": "AUDIO",
            "reviewProfileId": "material-type-original-music",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      },
      {
        "id": "style",
        "label": "风格与参考",
        "icon": "🎨",
        "tone": "style",
        "aliases": [
          "风格与参考"
        ],
        "types": [
          {
            "id": "style-anchor",
            "label": "风格锚点",
            "aliases": [
              "风格锚点"
            ],
            "mediaType": "IMAGE",
            "reviewProfileId": "material-type-style-anchor",
            "productionLane": "MANUAL_OR_ASSISTED"
          }
        ]
      }
    ]
  },
  "workflow": {
    "phases": [
      {
        "id": "PREVIS",
        "label": "镜头方案与预演",
        "purpose": "从当前正文和采用素材出发，完成镜头设计、对白并行与场级锁时。"
      },
      {
        "id": "SHOT_FINISH",
        "label": "镜头成品",
        "purpose": "完成每个当前镜头的关键帧、运动画面和最终锁镜版本。"
      },
      {
        "id": "SCENE_FINISH",
        "label": "场景成片",
        "purpose": "将已锁镜头剪成场，先锁画面，再完成声音、字幕和场级QA。"
      },
      {
        "id": "EPISODE_FINISH",
        "label": "分集成片",
        "purpose": "只对正式分集对象完成组装、审阅和技术QC。"
      },
      {
        "id": "SERIES_DELIVERY",
        "label": "全剧交付",
        "purpose": "完成跨集连续性、终检以及可追溯的全剧交付归档。"
      }
    ],
    "gates": [
      {
        "id": "SHOT_PLAN_INPUT_LOCK",
        "label": "镜头设计与输入锁定",
        "phaseId": "PREVIS",
        "scopeType": "SCENE",
        "purpose": "先以场为单位完成镜头计划，再冻结每个镜头的剧本、空间坐标与采用素材版本。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "STORYBOARD_DIALOGUE",
        "label": "粗分镜与对白并行",
        "phaseId": "PREVIS",
        "scopeType": "SHOT",
        "purpose": "并行确认镜头结构和适用对白干声。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "ANIMATIC_LOCK",
        "label": "Animatic锁时",
        "phaseId": "PREVIS",
        "scopeType": "SCENE",
        "purpose": "汇合粗分镜和锁定干声，形成场级时长基线。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "KEYFRAMES",
        "label": "正式首尾帧",
        "phaseId": "SHOT_FINISH",
        "scopeType": "SHOT",
        "purpose": "分别审阅首帧与尾帧。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "SHOT_VIDEO",
        "label": "镜头视频",
        "phaseId": "SHOT_FINISH",
        "scopeType": "SHOT",
        "purpose": "按锁定关键帧和分支生成运动画面。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "SHOT_LOCK",
        "label": "单镜锁定",
        "phaseId": "SHOT_FINISH",
        "scopeType": "SHOT",
        "purpose": "所有镜头都必须形成最终锁镜版本；口型仅是条件分支。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "PICTURE_LOCK",
        "label": "场剪辑与画面锁定",
        "phaseId": "SCENE_FINISH",
        "scopeType": "SCENE",
        "purpose": "登记场剪辑母版、EDL与连续性检查，先锁画面再进入同步声音。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "SOUND_MIX_SUBTITLES",
        "label": "场声音与混音字幕",
        "phaseId": "SCENE_FINISH",
        "scopeType": "SCENE",
        "purpose": "按锁定画面完成声音后期、混音与字幕。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "SCENE_QA",
        "label": "场级QA",
        "phaseId": "SCENE_FINISH",
        "scopeType": "SCENE",
        "purpose": "对锁定画面、声音、字幕和连续性形成独立场级结论。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "EPISODE_ASSEMBLY",
        "label": "分集组装",
        "phaseId": "EPISODE_FINISH",
        "scopeType": "EPISODE",
        "purpose": "按当前已确认分集方案与完整剧本发布快照组装已放行场景。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "EPISODE_REVIEW",
        "label": "分集审阅",
        "phaseId": "EPISODE_FINISH",
        "scopeType": "EPISODE",
        "purpose": "对每个正式分集对象形成独立审阅结论。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "EPISODE_TECH_QC",
        "label": "分集技术QC",
        "phaseId": "EPISODE_FINISH",
        "scopeType": "EPISODE",
        "purpose": "按发行配置完成技术检查；配置未确认时保持UNKNOWN。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "SERIES_CONTINUITY",
        "label": "跨集连续性",
        "phaseId": "SERIES_DELIVERY",
        "scopeType": "PROJECT",
        "purpose": "核对跨集剧情、人物、空间、物证和版本血缘。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "RIGHTS_SAFETY_TECH",
        "label": "权利敏感技术终检",
        "phaseId": "SERIES_DELIVERY",
        "scopeType": "PROJECT",
        "purpose": "汇总权利事实、敏感内容与技术门禁；未核实事实继续保持UNKNOWN。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      },
      {
        "id": "DELIVERY_ARCHIVE",
        "label": "交付归档",
        "phaseId": "SERIES_DELIVERY",
        "scopeType": "PROJECT",
        "purpose": "形成交付清单、哈希和审计归档。",
        "extraPrerequisites": [],
        "additionalOutputTypes": []
      }
    ],
    "lipSync": "WHEN_REQUIRED",
    "earlyAmbience": true,
    "materialPrerequisites": []
  },
  "technical": {
    "picture": {
      "aspectRatio": "UNKNOWN",
      "width": "UNKNOWN",
      "height": "UNKNOWN",
      "fps": "UNKNOWN",
      "confirmation": "UNKNOWN"
    },
    "delivery": {
      "platform": "UNKNOWN",
      "audience": "UNKNOWN",
      "codec": "UNKNOWN",
      "color": "UNKNOWN",
      "loudness": "UNKNOWN",
      "confirmation": "UNKNOWN"
    }
  },
  "sources": {
    "order": [
      {
        "id": "primary",
        "label": "原始资料",
        "role": "PRIMARY"
      },
      {
        "id": "derived",
        "label": "整理文本",
        "role": "DERIVED"
      },
      {
        "id": "auxiliary",
        "label": "辅助资料",
        "role": "AUXILIARY"
      }
    ],
    "continuity": {
      "specAlias": "",
      "requiredCoordinates": [
        "LOC",
        "STATE",
        "ZONE",
        "CAM",
        "FREEZE"
      ],
      "themes": [
        {
          "id": "character",
          "label": "人物关系"
        },
        {
          "id": "time",
          "label": "时间与因果"
        },
        {
          "id": "space",
          "label": "空间与状态"
        }
      ]
    }
  },
  "collaboration": {
    "assistantEnabled": true,
    "preferredCollaborator": "HUMAN_AI",
    "defaultExecutor": "USER_EXTERNAL",
    "apiKeyEnvName": "OPENAI_API_KEY",
    "codexBridge": {
      "autoStart": false,
      "model": "gpt-5.6-sol",
      "maxConcurrent": 5,
      "idleTtlSeconds": 600
    }
  },
  "presentation": {
    "storyTitle": "新故事",
    "title": "新故事",
    "mark": "阅",
    "description": "故事创作、素材审阅与全剧制作。",
    "landingView": "overview",
    "trialEnabled": false,
    "trialLabel": "本剧试制"
  }
};
export const modelArrayKeys = ["workflowSteps","continuityGroups","stageDefinitions","episodes","scenes","segments","beats","shots","reviewContexts","structureCards","workItems","workPackages","materialRequirements","materialWorkItems","stageInstances","productionReferences","deletionTombstones","assetRetirementEvents","assetFamilies","assetVersions","expectedOutputs","dependencyEdges","issues","storyRevisions","scriptRevisions","sceneScriptRevisions","episodePlanRevisions","sceneCoveragePlanRevisions","screenplayReleaseSnapshots","scopeLocks","shotPlanSetRevisions"];
export const productionGraphDefaults = {
  "productionPhases": [
    {
      "id": "PREVIS",
      "slug": "previs",
      "order": 1,
      "label": "镜头方案与预演",
      "purpose": "从当前正文和采用素材出发，完成镜头设计、对白并行与场级锁时。",
      "gateIds": [
        "SHOT_PLAN_INPUT_LOCK",
        "STORYBOARD_DIALOGUE",
        "ANIMATIC_LOCK"
      ],
      "entryGateId": "SHOT_PLAN_INPUT_LOCK",
      "exitGateId": "ANIMATIC_LOCK",
      "exitScopeType": "SCENE",
      "exitObjectType": "LOCKED_AUDIOVISUAL_PLAN",
      "denominatorUnit": "SCENE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_PHASE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SHOT_FINISH",
      "slug": "shot-finish",
      "order": 2,
      "label": "镜头成品",
      "purpose": "完成每个当前镜头的关键帧、运动画面和最终锁镜版本。",
      "gateIds": [
        "KEYFRAMES",
        "SHOT_VIDEO",
        "SHOT_LOCK"
      ],
      "entryGateId": "KEYFRAMES",
      "exitGateId": "SHOT_LOCK",
      "exitScopeType": "SHOT",
      "exitObjectType": "LOCKED_SHOT",
      "denominatorUnit": "SHOT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_PHASE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SCENE_FINISH",
      "slug": "scene-finish",
      "order": 3,
      "label": "场景成片",
      "purpose": "将已锁镜头剪成场，先锁画面，再完成声音、字幕和场级QA。",
      "gateIds": [
        "PICTURE_LOCK",
        "SOUND_MIX_SUBTITLES",
        "SCENE_QA"
      ],
      "entryGateId": "PICTURE_LOCK",
      "exitGateId": "SCENE_QA",
      "exitScopeType": "SCENE",
      "exitObjectType": "LOCKED_SCENE",
      "denominatorUnit": "SCENE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_PHASE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "EPISODE_FINISH",
      "slug": "episode-finish",
      "order": 4,
      "label": "分集成片",
      "purpose": "只对正式分集对象完成组装、审阅和技术QC。",
      "gateIds": [
        "EPISODE_ASSEMBLY",
        "EPISODE_REVIEW",
        "EPISODE_TECH_QC"
      ],
      "entryGateId": "EPISODE_ASSEMBLY",
      "exitGateId": "EPISODE_TECH_QC",
      "exitScopeType": "EPISODE",
      "exitObjectType": "EPISODE_MASTER",
      "denominatorUnit": "EPISODE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_PHASE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SERIES_DELIVERY",
      "slug": "series-delivery",
      "order": 5,
      "label": "全剧交付",
      "purpose": "完成跨集连续性、终检以及可追溯的全剧交付归档。",
      "gateIds": [
        "SERIES_CONTINUITY",
        "RIGHTS_SAFETY_TECH",
        "DELIVERY_ARCHIVE"
      ],
      "entryGateId": "SERIES_CONTINUITY",
      "exitGateId": "DELIVERY_ARCHIVE",
      "exitScopeType": "PROJECT",
      "exitObjectType": "SERIES_DELIVERY_PACKAGE",
      "denominatorUnit": "PROJECT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_PHASE_DEFINITION",
      "countsTowardCurrent": false
    }
  ],
  "productionGates": [
    {
      "id": "SHOT_PLAN_INPUT_LOCK",
      "slug": "shot-plan-input-lock",
      "phaseId": "PREVIS",
      "order": 1,
      "label": "镜头设计与输入锁定",
      "scopeType": "SCENE",
      "purpose": "先以场为单位完成镜头计划，再冻结每个镜头的剧本、空间坐标与采用素材版本。",
      "denominatorUnit": "SCENE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "STORYBOARD_DIALOGUE",
      "slug": "storyboard-dialogue",
      "phaseId": "PREVIS",
      "order": 2,
      "label": "粗分镜与对白并行",
      "scopeType": "SHOT",
      "purpose": "并行确认镜头结构和适用对白干声。",
      "denominatorUnit": "SHOT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "ANIMATIC_LOCK",
      "slug": "animatic-lock",
      "phaseId": "PREVIS",
      "order": 3,
      "label": "Animatic锁时",
      "scopeType": "SCENE",
      "purpose": "汇合粗分镜和锁定干声，形成场级时长基线。",
      "denominatorUnit": "SCENE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "KEYFRAMES",
      "slug": "keyframes",
      "phaseId": "SHOT_FINISH",
      "order": 1,
      "label": "正式首尾帧",
      "scopeType": "SHOT",
      "purpose": "分别审阅首帧与尾帧。",
      "denominatorUnit": "SHOT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SHOT_VIDEO",
      "slug": "shot-video",
      "phaseId": "SHOT_FINISH",
      "order": 2,
      "label": "镜头视频",
      "scopeType": "SHOT",
      "purpose": "按锁定关键帧和分支生成运动画面。",
      "denominatorUnit": "SHOT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SHOT_LOCK",
      "slug": "shot-lock",
      "phaseId": "SHOT_FINISH",
      "order": 3,
      "label": "单镜锁定",
      "scopeType": "SHOT",
      "purpose": "所有镜头都必须形成最终锁镜版本；口型仅是条件分支。",
      "denominatorUnit": "SHOT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "PICTURE_LOCK",
      "slug": "picture-lock",
      "phaseId": "SCENE_FINISH",
      "order": 1,
      "label": "场剪辑与画面锁定",
      "scopeType": "SCENE",
      "purpose": "登记场剪辑母版、EDL与连续性检查，先锁画面再进入同步声音。",
      "denominatorUnit": "SCENE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SOUND_MIX_SUBTITLES",
      "slug": "sound-mix-subtitles",
      "phaseId": "SCENE_FINISH",
      "order": 2,
      "label": "场声音与混音字幕",
      "scopeType": "SCENE",
      "purpose": "按锁定画面完成声音后期、混音与字幕。",
      "denominatorUnit": "SCENE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SCENE_QA",
      "slug": "scene-qa",
      "phaseId": "SCENE_FINISH",
      "order": 3,
      "label": "场级QA",
      "scopeType": "SCENE",
      "purpose": "对锁定画面、声音、字幕和连续性形成独立场级结论。",
      "denominatorUnit": "SCENE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "EPISODE_ASSEMBLY",
      "slug": "episode-assembly",
      "phaseId": "EPISODE_FINISH",
      "order": 1,
      "label": "分集组装",
      "scopeType": "EPISODE",
      "purpose": "按当前已确认分集方案与完整剧本发布快照组装已放行场景。",
      "denominatorUnit": "EPISODE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "EPISODE_REVIEW",
      "slug": "episode-review",
      "phaseId": "EPISODE_FINISH",
      "order": 2,
      "label": "分集审阅",
      "scopeType": "EPISODE",
      "purpose": "对每个正式分集对象形成独立审阅结论。",
      "denominatorUnit": "EPISODE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "EPISODE_TECH_QC",
      "slug": "episode-tech-qc",
      "phaseId": "EPISODE_FINISH",
      "order": 3,
      "label": "分集技术QC",
      "scopeType": "EPISODE",
      "purpose": "按发行配置完成技术检查；配置未确认时保持UNKNOWN。",
      "denominatorUnit": "EPISODE",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "SERIES_CONTINUITY",
      "slug": "series-continuity",
      "phaseId": "SERIES_DELIVERY",
      "order": 1,
      "label": "跨集连续性",
      "scopeType": "PROJECT",
      "purpose": "核对跨集剧情、人物、空间、物证和版本血缘。",
      "denominatorUnit": "PROJECT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "RIGHTS_SAFETY_TECH",
      "slug": "rights-safety-tech",
      "phaseId": "SERIES_DELIVERY",
      "order": 2,
      "label": "权利敏感技术终检",
      "scopeType": "PROJECT",
      "purpose": "汇总权利事实、敏感内容与技术门禁；未核实事实继续保持UNKNOWN。",
      "denominatorUnit": "PROJECT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    },
    {
      "id": "DELIVERY_ARCHIVE",
      "slug": "delivery-archive",
      "phaseId": "SERIES_DELIVERY",
      "order": 3,
      "label": "交付归档",
      "scopeType": "PROJECT",
      "purpose": "形成交付清单、哈希和审计归档。",
      "denominatorUnit": "PROJECT",
      "denominatorState": "UNKNOWN",
      "denominator": null,
      "globalDenominatorState": "UNKNOWN",
      "globalDenominator": null,
      "discoveredCount": 0,
      "currentObjectCount": 0,
      "currentWorkPackageCount": 0,
      "currentWorkItemCount": 0,
      "releasedWorkPackageCount": 0,
      "releasedObjectCount": 0,
      "completionState": "UNKNOWN",
      "lifecycleRollup": {},
      "flowBlockReasons": [],
      "scopeRole": "CURRENT",
      "activityRole": "PRODUCTION_GATE_DEFINITION",
      "countsTowardCurrent": false
    }
  ]
};
