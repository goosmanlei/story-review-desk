// Read-only work organization. Registered objects are the denominator, never a
// claim that the story's full production scope has already been locked.
export const workChains = [
  {
    id: "story",
    title: "故事 → 剧本",
    note: "资料、分集与逐场表达",
    stages: [
      { id: "SOURCE", title: "故事资料", kinds: ["SOURCE"] },
      { id: "STRUCTURE", title: "故事结构与分集", kinds: ["STORY", "EPISODE"] },
      { id: "NARRATIVE", title: "逐场叙事", kinds: ["SCENE"] },
    ],
  },
  {
    id: "materials",
    title: "剧本 → 素材",
    note: "主体、状态与可用版本",
    stages: [
      {
        id: "SETTING",
        title: "主体与状态",
        kinds: ["ENTITY", "STATE", "REPRESENTATION", "SPACE", "RELATION"],
      },
      {
        id: "REQUIREMENT",
        title: "素材需求",
        kinds: ["REQUIREMENT", "MATERIAL"],
      },
      {
        id: "DEFINITION",
        title: "制作定义",
        kinds: ["PROMPT", "CALL", "EXPECTED_OUTPUT"],
      },
      { id: "VERSION", title: "版本与审阅", kinds: ["ASSET"] },
    ],
  },
  {
    id: "production",
    title: "剧本 + 素材 → 全剧制作",
    note: "逐场筹备、镜头与成片",
    stages: [
      {
        id: "PREPARATION",
        title: "前置筹备",
        kinds: ["PREPARATION", "COVERAGE"],
      },
      {
        id: "DESIGN",
        title: "镜头制作",
        kinds: ["SHOT_DESIGN", "SHOT", "INPUT_LOCK"],
      },
      { id: "ASSEMBLY", title: "场景与分集剪辑", kinds: ["ASSEMBLY"] },
      { id: "DELIVERY", title: "成片与交付", kinds: ["DELIVERABLE"] },
    ],
  },
];
export const workStateSql = `CASE
 WHEN EXISTS(SELECT 1 FROM operations op WHERE op.request->>'objectId'=o.id AND op.status='RESULT_UNKNOWN') THEN 'BLOCKED'
 WHEN EXISTS(SELECT 1 FROM operations op WHERE op.request->>'objectId'=o.id AND op.status='RUNNING') THEN 'IN_PROGRESS'
 WHEN EXISTS(SELECT 1 FROM invalidations i WHERE i.consumer_revision_id=COALESCE(o.draft_revision_id,o.adopted_revision_id)) THEN 'WAITING'
 WHEN o.state IN ('REJECTED','DISABLED') THEN 'BLOCKED'
 WHEN o.state='ADOPTED' THEN 'COMPLETE'
 ELSE 'READY' END`;
export const workStateLabels = {
  READY: "可立即开展",
  IN_PROGRESS: "进行中",
  WAITING: "等待依赖核对",
  BLOCKED: "存在阻断",
  COMPLETE: "已完成",
};
