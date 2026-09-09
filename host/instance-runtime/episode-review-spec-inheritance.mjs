import {canonicalJson,sha256} from './bytes.mjs';
import {configHash,reviewSpec} from './configuration-model.mjs';

const protocol='EPISODE_REVIEW_SPEC_INHERITANCE_V1';
const hash=value=>sha256(Buffer.from(canonicalJson(value)));
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const own=(value,key)=>value!=null&&Object.hasOwn(value,key);
const fail=message=>{throw Object.assign(new Error(message),{code:'EPISODE_REVIEW_SPEC_INHERITANCE',status:409});};
const check=(ok,message)=>{if(!ok)fail(message);};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=value=>typeof value==='string'&&value.length>0;
function checkedSpec(spec){
  check(spec&&sha(spec.hash)&&sha(spec.configurationHash)&&text(spec.profileId)&&Array.isArray(spec.criteria)&&spec.criteria.length>0,'前驱缺少完整有效的冻结审阅标准');
  const {hash:expected,...body}=spec;
  check(hash(body)===expected,'前驱冻结审阅标准哈希不符');
  check(new Set(spec.criteria.map(c=>c.id)).size===spec.criteria.length&&spec.criteria.every(c=>text(c.id)&&text(c.label)&&text(c.question)&&['required','allowNA','noteRequiredOnFail'].every(k=>typeof c[k]==='boolean')),'前驱冻结审阅标准条目不完整');
  return spec;
}
export function episodeReviewSpecSemantics(spec){
  checkedSpec(spec);const body=structuredClone(spec);delete body.hash;delete body.configurationHash;return body;
}
export function hasEpisodeReviewSpecInheritance(event){return own(event,'reviewSpecInheritance')||event?.configurationBinding?.createdBy===protocol;}

/** Read only the actual latest same-subject candidate. A projected binding may
 * represent an explicit published configuration upgrade; its immutable release
 * is the authority, not a caller-supplied old spec. Historical callers must pass
 * the captured creation snapshot and only the real event prefix. */
export function episodeCandidateConfiguration({model,events,subjectId,creativeRevisionId,criteriaVersion}){
  const config=model.systemConfiguration?.config;
  const predecessors=events.filter(e=>e.eventKind==='creative-revision'&&e.subjectKind==='EPISODE_PLAN'&&e.subjectId===subjectId);
  check(predecessors.every(e=>Number.isSafeInteger(e.eventSequence)&&e.eventSequence>0&&text(e.eventId)&&text(e.creativeRevisionId)),'分集方案前驱事件身份或序号不完整');
  check(new Set(predecessors.map(e=>e.eventSequence)).size===predecessors.length,'分集方案前驱序号不唯一');
  predecessors.sort((a,b)=>b.eventSequence-a.eventSequence);
  const parent=predecessors[0];
  if(!parent){
    // Source-only legacy plans have no candidate event to inherit from. If a
    // source already has a frozen binding, do not silently replace it.
    check(!(model.episodePlanRevisions||[]).some(row=>row.planId===subjectId&&row.scopeRole!=='PROPOSAL'&&(row.reviewSpec||row.configurationBinding)),'已有源方案的冻结标准缺少可核验候选前驱，须先核对历史来源');
    if(!config)return {};
    const spec=reviewSpec(config,'EPISODE_PLAN',{});
    return {reviewSpec:spec,configurationBinding:{key:`candidate:${creativeRevisionId}`,kind:'EPISODE_PLAN',reviewSpec:spec,technical:structuredClone(config.technical),workflow:structuredClone(config.workflow),sources:structuredClone(config.sources),configurationHash:configHash(config),createdBy:'CANDIDATE_REGISTRATION'}};
  }
  check(parent.creativeRevisionId!==creativeRevisionId,'候选内容与最新前驱身份相同，不能重复登记为其自身后继');
  check(config,'无法核验当前发布配置与前驱冻结标准');
  const projected=(model.configurationCandidates||[]).filter(row=>row.id===parent.creativeRevisionId||row.creativeRevisionId===parent.creativeRevisionId);
  check(projected.length<=1,'前驱发布配置绑定不唯一');
  const binding=projected[0]?.configurationBinding||parent.configurationBinding;
  const effectiveSpec=projected[0]?.reviewSpec||parent.reviewSpec;
  checkedSpec(effectiveSpec);
  check(binding&&binding.kind==='EPISODE_PLAN'&&binding.key===`candidate:${parent.creativeRevisionId}`&&equal(binding.reviewSpec,effectiveSpec)&&sha(binding.configurationHash)&&binding.technical&&binding.workflow&&binding.sources,'前驱完整配置绑定缺失或与生效标准不一致');
  check(parent.criteriaVersion===criteriaVersion,'审阅契约版本已改变，须显式核准标准升级');
  const current=reviewSpec(config,'EPISODE_PLAN',{});
  check(equal(episodeReviewSpecSemantics(effectiveSpec),episodeReviewSpecSemantics(current)),'分集审阅条目或判断规则已改变，须显式核准标准升级；不能通过新候选自动迁移');
  const inherited=structuredClone(binding);inherited.key=`candidate:${creativeRevisionId}`;inherited.createdBy=protocol;
  return {reviewSpec:structuredClone(effectiveSpec),configurationBinding:inherited,reviewSpecInheritance:{schemaVersion:protocol,subjectId,parentEventId:parent.eventId,parentEventSha256:hash(parent),parentCreativeRevisionId:parent.creativeRevisionId,parentConfigurationBindingHash:hash(binding),reviewSpecHash:effectiveSpec.hash}};
}

/** New protocol only. Old immutable candidates are never reinterpreted. */
export function assertEpisodeReviewSpecInheritance({event,model,events}){
  if(!hasEpisodeReviewSpecInheritance(event))return;
  check(event.eventKind==='creative-revision'&&event.subjectKind==='EPISODE_PLAN'&&event.reviewSpecInheritance?.schemaVersion===protocol,'不支持的分集冻结标准继承协议');
  check(Number.isSafeInteger(event.eventSequence)&&event.eventSequence>0,'继承候选缺少实际事件序号');
  const prefix=events.filter(e=>e.eventSequence<event.eventSequence);
  const expected=episodeCandidateConfiguration({model,events:prefix,subjectId:event.subjectId,creativeRevisionId:event.creativeRevisionId,criteriaVersion:event.criteriaVersion});
  check(expected.reviewSpecInheritance&&equal(expected.reviewSpecInheritance,event.reviewSpecInheritance)&&equal(expected.reviewSpec,event.reviewSpec)&&equal(expected.configurationBinding,event.configurationBinding),'分集冻结标准继承与实际前驱／发布配置不符');
}
