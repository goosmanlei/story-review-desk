export const EPISODE_REVIEW_CRITERIA = [
  { id: 'opening-boundary', label: '开场与承接', question: '是否接住上集留下的问题，并清楚建立本集关注点？' },
  { id: 'episode-purpose', label: '本集任务', question: '本集主要任务是否清楚，各场与主副线是否有必要作用？' },
  { id: 'escalation-turn', label: '推进与转折', question: '压力、信息或人物状态是否发生有意义的变化，转折与节奏是否合适？' },
  { id: 'information-causality', label: '信息与因果', question: '行动是否有依据，人物与观众的知情顺序是否自洽，铺垫与回收是否成立？' },
  { id: 'episode-payoff', label: '本集回报', question: '本集承诺了什么，是否兑现了明确的阶段性结果？' },
  { id: 'ending-propulsion', label: '结尾与承接', question: '停在实际结尾是否合适，留下的问题能否被下一集有效承接？' },
] as const;
export type EpisodeCriterionId = typeof EPISODE_REVIEW_CRITERIA[number]['id'];
const LEGACY_QUESTIONS = [
  ['起集点','是否有效承接上一集，并让本集冲突迅速成立？'],
  ['本集任务','本集要解决的问题是否单一、清楚，所含场次是否都服务于它？'],
  ['递进与转折','集内事件是否持续升级，并在关键位置形成有效转折？'],
  ['信息与因果','明线、暗线与观众所得是否清楚，因果链是否连续且不过早剧透？'],
  ['本集回报','本集是否兑现了阶段性结果，而不是只把内容机械截断？'],
  ['断集与追看','结尾是否由本集行动自然产生，并明确驱动下一集或终局余韵？'],
];
export function episodeReviewCriteria(index: number, count: number, criteriaVersion = '2.0', spec?: import('../presentation/configuration-model.mjs').ReviewSpec) {
  if(spec) return spec.criteria.map(item=>({...item,id:item.id as EpisodeCriterionId,label:criteriaVersion!=='1.0'&&index===count-1&&item.id==='ending-propulsion'&&item.label==='结尾与承接'?'终局收束':item.label,question:criteriaVersion!=='1.0'&&index===0&&item.id==='opening-boundary'?spec.firstQuestion||item.question:criteriaVersion!=='1.0'&&index===count-1&&item.id==='ending-propulsion'?spec.lastQuestion||item.question:item.question}));
  if (criteriaVersion === '1.0') return EPISODE_REVIEW_CRITERIA.map((item, position) => ({...item,label:LEGACY_QUESTIONS[position][0],question:LEGACY_QUESTIONS[position][1]}));
  return EPISODE_REVIEW_CRITERIA.map((item) => ({ ...item,
    label: item.id === 'ending-propulsion' && index === count - 1 ? '终局收束' : item.label,
    question: item.id === 'opening-boundary' && index === 0
      ? '开场能否独立建立人物困境、主要冲突和观看关注点？'
      : item.id === 'ending-propulsion' && index === count - 1
        ? '终局是否兑现主要承诺、闭合应闭合的因果，并留下合适的余韵？' : item.question,
  }));
}
export function episodeCriteriaVersion(schema: string) { return schema === '1.1' ? '2.0' : '1.0'; }
