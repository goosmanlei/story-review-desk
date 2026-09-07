import {SCOPED_PLANNING_CRITERIA,SHOT_DESIGN_CRITERIA_V2,type ScopedPlanningKind} from '../../../scoped-planning-review';
import {HttpError,stableObjectHash,type EventRecord} from '../_store';

export function scopedPlanningReviewSpec(kind:ScopedPlanningKind, version = '1.0') {
  if (!['1.0','2.0'].includes(version) || version === '2.0' && kind !== 'SHOT_PLAN_SET') throw new HttpError(422,'不支持的场级规划审阅标准版本');
  const criteria = version === '2.0' ? SHOT_DESIGN_CRITERIA_V2 : SCOPED_PLANNING_CRITERIA[kind];
  const value={schemaVersion:version,subjectKind:kind,criteria:criteria.map(([id,label,question])=>({id:`${kind.toLowerCase()}:${id}`,label,question}))};
  return {...value,hash:stableObjectHash(value)};
}
export function assertScopedPlanningFindings(candidate:EventRecord,findings:unknown,reviewSpecHash:unknown) {
  if(!candidate.scopedReviewSpec)return;
  const spec=candidate.scopedReviewSpec as ReturnType<typeof scopedPlanningReviewSpec>;
  const expectedVersion = candidate.planningContractVersion === '2.0' ? '2.0' : '1.0';
  if (stableObjectHash(spec) !== stableObjectHash(scopedPlanningReviewSpec(candidate.subjectKind as ScopedPlanningKind,expectedVersion))) throw new HttpError(409,'审阅标准必须匹配此候选冻结的设计契约');
  if(stableObjectHash({...spec,hash:undefined})!==spec.hash||reviewSpecHash!==spec.hash||!Array.isArray(findings)||findings.length!==spec.criteria.length)throw new HttpError(409,'本场审阅标准或判断项不完整');
  const ids=new Set<string>();for(const finding of findings){
    if(!finding||!spec.criteria.some(c=>c.id===finding.criterionId)||ids.has(finding.criterionId)||!['PASS','FAIL'].includes(finding.verdict)||finding.verdict==='FAIL'&&!(typeof finding.note==='string'&&finding.note.trim()))throw new HttpError(422,'请独立完成本场全部判断，问题项需要具体说明');
    ids.add(finding.criterionId);
  }
}
