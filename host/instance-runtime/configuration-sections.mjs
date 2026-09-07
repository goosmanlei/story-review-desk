// Creator navigation owns presentation only; stored configuration identities remain stable.
export const CONFIGURATION_SECTIONS = Object.freeze([
  { id: 'project', label: '项目与交付', groups: [['technical', '项目目标与规格']] },
  { id: 'setting', label: '资料与设定', groups: [['sources', '来源核对'], ['entities', '实体体系'], ['references', '参考与连续性']] },
  { id: 'production', label: '素材与制作', groups: [['taxonomy', '素材分类'], ['workflow', '制作流程']] },
  { id: 'review', label: '审阅标准', groups: [['review', '审阅标准']] },
  { id: 'collaboration', label: 'AI与界面', groups: [['general', 'AI与界面']] },
]);
