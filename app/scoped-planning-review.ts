/** Versioned questions for the two existing scene-scoped creative contracts. */
export const SCOPED_PLANNING_CRITERIA = {
  SCENE_COVERAGE: [
    ['narrative','叙事节拍','本场节拍是否完整承接已发布正文与本集任务？'],
    ['audience','观众所得','各节拍让观众得到的信息及知情边界是否明确？'],
    ['visual','画面与行动','画面、动作意图是否可拍，且未虚构正式镜头身份？'],
    ['sound','声音与对白','声音、对白上下文是否保持人物意图及原场因果？'],
    ['materials','素材需求','每项实际需要是否引用准确需求，缺项有无遗漏？'],
    ['continuity','连续性','人物、地点、时空、物证及前后承接是否自洽？'],
  ],
  SHOT_PLAN_SET: [
    ['coverage','节拍覆盖','正式镜头是否完整覆盖已采用镜头意图，没有遗漏或越界？'],
    ['expression','每镜表达','每镜的叙事、观众所得、画面、动作与声音是否具体？'],
    ['identity','镜头身份','镜头身份、顺序、增删理由与所属永久场是否准确？'],
    ['inputs','精确输入','素材与正文是否绑定实际采用的精确版本及哈希？'],
    ['continuity','连续性','空间、人物和关键道具条件是否足以进入后续输入锁定？'],
    ['scope','制作范围','镜头范围是否完整明确；未锁定输入和媒体是否仍如实留待后续检查？'],
  ],
} as const;
// V1 wording above remains byte-for-byte frozen for existing candidate hashes.
export const SHOT_DESIGN_CRITERIA_V2 = [
  ['coverage','节拍与需求覆盖','镜头设计是否完整覆盖已采用场级镜头意图及各节拍需求，不通过删除缺项掩盖不足？'],
  ['expression','每镜表达','每镜叙事、观众所得、画面、动作、对白和声音意图是否具体且可执行？'],
  ['identity','镜头身份','镜头永久身份、顺序、增删理由与所属永久场是否准确？'],
  ['requirements','需求依据','是否精确冻结已采用场级意图及 REQUIRED 素材身份、需求哈希和对应状态条件，而未冒充实际素材版本？'],
  ['continuity','连续性与未知','空间、人物、道具条件与叙事是否一致，待核条件是否明确列出且未伪造锁定？'],
  ['boundary','设计采用边界','是否只采用镜头设计和范围；实际素材、权利、LOC/STATE/ZONE/CAM/FREEZE、Prompt及生成授权仍由后续输入锁独立检查？'],
] as const;
export type ScopedPlanningKind=keyof typeof SCOPED_PLANNING_CRITERIA;

// New candidates freeze this complete V3 standard; V1/V2 wording stays intact.
export const SHOT_DESIGN_CRITERIA_V3 = [
  ...SHOT_DESIGN_CRITERIA_V2,
  ['design-spec','镜头规格','景别、机位、运镜、构图、人物表演和光线是否明确，未知是否如实标注？'],
  ['estimated-timing','设计估时','估时是否为可复核的设计建议，尚未冒充实际对白时长或 Animatic 锁时？'],
  ['frame-strategy','关键帧策略','单首帧、首尾帧或多关键帧策略及依据是否合理，首尾状态和本场相邻镜头是否准确？'],
] as const;
