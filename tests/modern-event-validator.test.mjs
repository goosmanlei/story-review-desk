// Clean-clone synthetic fiction only; loads real installed TS validators, no DB/services.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const moduleUrl=new URL('../host/instance-modern-event-validator.mjs',import.meta.url);
const {canonical,digest,frozenEventManifest,loadModernEventRuntime,validateModernEventClosure}=await import(moduleUrl);
const here=path.dirname(fileURLToPath(import.meta.url));
const software=path.resolve(here,'..');
export const runtime=loadModernEventRuntime(software);const hash=runtime.api.stableObjectHash;
const claim=text=>({class:'A',text,evidenceRefs:['fixture:source']});
export function fixture(){
 const script=hash('source-script'),transcript=hash('source-transcript'),base=hash('published-plan');
 const snapshot={snapshotId:'snapshot:test',creativeLineage:{storyStructure:{sourceSha256:base},scriptDocument:{sha256:script},scenes:[{id:'OLD'}]},storySources:{transcript:{sha256:transcript,segments:[{id:'seg:one',contentSha256:hash('segment')}]}},productionModel:{storyRevisions:[{id:'story:base',revisionHash:hash('story'),scopeRole:'CURRENT'}],scriptRevisions:[{id:'script:base',revisionHash:hash('script'),scopeRole:'CURRENT'}]}};
 const runtimeEstimate={compactSec:1,baseSec:2,spaciousSec:3,dialogueChars:0,dialogueSec:0,actionSec:2,reactionSec:0,transitionSec:0,overlapSec:0,rationale:'合成动作估时',confidence:'LOW'};
 const scenes=[1,2].map(n=>{const id=`new:${n}`,scriptBlocks=[{id:`${id}-B001`,type:'action',speaker:'',performanceNote:'',text:`人物读取第 ${n} 封信。`}];return {id,displayId:`S0${n}`,title:'信件',slugline:'室内',storyTime:'日',viewpoint:'人物',purpose:'得到消息',audienceKnown:'来信存在',audienceWithheld:'来信者',transition:'行动',oldSceneIds:['OLD'],sourceSegmentIds:['seg:one'],scriptBlocks,contentHash:hash(scriptBlocks),runtime:runtimeEstimate};});
 const reference=s=>({sceneId:s.id,sceneScriptRevisionId:`NSR-${s.contentHash.slice(0,24)}`,sceneContentHash:s.contentHash,blockIds:[s.scriptBlocks[0].id],excerptSha256:digest(JSON.stringify(s.scriptBlocks))});
 const episodes=scenes.map((s,i)=>({episodeUid:`episode:${i+1}`,displayId:`E0${i+1}`,title:'来信',sceneIds:[s.id],openingHook:'看见信',coreAdvance:'读信',endingCliffhanger:'决定回信',reviewDossier:{schemaVersion:'1.1',purpose:{episodeTask:claim('获取消息'),characterAction:claim('阅读'),expressionFocus:claim('作出决定')},informationLayers:{visibleAction:claim('拆信'),hiddenTruth:claim('来源未明'),audiencePosition:claim('同步知情'),characterKnowledge:[]},payoff:{deliveredResult:claim('得到消息'),changedState:claim('决定行动'),unresolvedQuestions:[]},sceneFlow:[{sceneId:s.id,function:claim('获得信息')}],progressionSlices:[],comedyBeats:[],causalChainIds:[],authoringUnknowns:[],boundaryEvidence:{opening:reference(s),ending:reference(s)}}}));
 const content={planId:'plan:test',retiredEpisodeUids:[],episodes,narrativeRevision:{schemaVersion:'1.0',title:'合成叙事',runtimeMethod:'案头估计',baseScriptSha256:script,transcriptSha256:transcript,retiredSceneIds:['OLD'],scenes,sequences:[{id:'seq:one',sceneIds:scenes.map(s=>s.id)}],causalChains:[],legacySceneEstimates:[{sceneId:'OLD',runtime:runtimeEstimate}],sourceNarrationIndex:[{id:'seg:one',sourceSha256:hash('segment'),summary:'来信',viewpoint:'人物',treatment:'保留',reason:'建立行动',sceneIds:scenes.map(s=>s.id)}],documents:[]}};
 const envelope=(id,kind,sequence)=>({eventId:id,eventKind:kind,eventSequence:sequence,recordedAt:`2026-01-01T00:00:${String(sequence).padStart(2,'0')}Z`,snapshotId:snapshot.snapshotId,schemaVersion:'1.2',requestHash:hash(id),idempotencyKeyHash:hash('key:'+id),rawRequestHash:hash('raw:'+id)});
 const bindings=[{bindingType:'SCRIPT_REVISION',bindingId:'script:base',bindingHash:hash('script')},{bindingType:'STORY_REVISION',bindingId:'story:base',bindingHash:hash('story')}],basisBindingsHash=hash(bindings);
 const candidate={...envelope('candidate','creative-revision',2),schemaVersion:'2.0',creativeRevisionId:'cr:test',revisionId:'cr:test',subjectKind:'EPISODE_PLAN',subjectId:'plan:test',creationSnapshotId:snapshot.snapshotId,bindingVersion:'2.0',criteriaVersion:'2.0',basisBindings:bindings,basisBindingsHash,baseRevisionHash:base,content,contentHash:hash(content),contextHash:hash({subjectKind:'EPISODE_PLAN',subjectId:'plan:test',baseRevisionHash:base,basisBindingsHash,criteriaVersion:'2.0'}),revisionState:'CANDIDATE',adoptionPerformed:false,authorityClass:'A',evidenceRefs:[]};candidate.businessContextHash=candidate.contextHash;
 const source=runtime.api.storyCommentSources({content}).find(s=>s.kind==='SCENE_SCRIPT'),contentHash=scenes[0].contentHash;
 const target={...source,revisionId:candidate.creativeRevisionId,planContentHash:candidate.contentHash,contentHash,contextHash:hash({snapshotId:snapshot.snapshotId,planContextHash:candidate.contextHash,basisBindingsHash,revisionId:candidate.creativeRevisionId,planContentHash:candidate.contentHash,kind:source.kind,subjectId:source.subjectId,episodeUid:source.episodeUid,contentHash})};
 const anchor=runtime.api.parseCommentAnchorBlocks(target.blocks,{blockId:target.blocks[0].id,startOffset:0,endOffset:2,quote:target.blocks[0].text.slice(0,2)});
 const create={...envelope('comment:create','script-comment',3),commentId:'comment:new',commentAction:'CREATE',creationSnapshotId:snapshot.snapshotId,target,sceneId:target.subjectId,sceneContentHash:target.contentHash,businessContextHash:target.contextHash,anchor,commentText:'请核对人物所得',initialStatus:'AI_QUEUED'};
 const resolved={...create,...envelope('comment:resolve','script-comment',4),commentAction:'RESOLVE_AI',commentRevisionId:create.eventId,alignedSnapshotId:snapshot.snapshotId,alignedSceneContentHash:contentHash,resolutionNote:'保留明确人物意图'};delete resolved.commentText;delete resolved.initialStatus;
 const old={...envelope('old:create','script-comment',1),schemaVersion:'1.0',commentId:'comment:old',commentAction:'CREATE',creationSnapshotId:snapshot.snapshotId,sceneId:'OLD',sceneContentHash:hash('old scene'),businessContextHash:hash('old context'),anchor:{blockId:'old:block',quote:'旧段'},commentText:'旧意见',initialStatus:'AI_QUEUED'};
 const archive={...envelope('old:archive','script-comment',5),commentId:old.commentId,commentAction:'RESOLVE_AND_DELETE',commentRevisionId:old.eventId,expectedLatestEventId:old.eventId,sceneId:'OLD',previousStatus:'AI_QUEUED',resolutionStatus:'RESOLVED',visibility:'DELETED_AUDIT',physicalHistoryDeleted:false,resolutionNote:'保留历史，关联新场明确内容',resolutionTarget:{candidateRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash,sceneBindings:[{sceneId:scenes[0].id,contentHash:scenes[0].contentHash,blockIds:[scenes[0].scriptBlocks[0].id],blocksHash:hash(scenes[0].scriptBlocks)}]}};
 const submission={...envelope('submission','episode-plan-submission',6),schemaVersion:'1.0',candidateCreationSnapshotId:candidate.snapshotId,operation:'SUBMIT_EPISODE',subjectType:'EPISODE_PLAN_EPISODE',subjectKind:'EPISODE_PLAN',subjectId:candidate.subjectId,subjectRevisionId:candidate.creativeRevisionId,creativeRevisionId:candidate.creativeRevisionId,subjectRevisionHash:candidate.contentHash,baseRevisionHash:base,basisBindings:bindings,basisBindingsHash,contextHash:candidate.contextHash,criteriaVersion:'2.0',scopeType:'EPISODE',scopeId:episodes[0].episodeUid,episodeUid:episodes[0].episodeUid,displayId:episodes[0].displayId,criterionFindings:runtime.api.expectedEpisodeCriterionIds(episodes[0].episodeUid).map(criterionId=>({criterionId,verdict:'PASS',note:''})),recommendation:'APPROVE_AND_RELEASE',note:'六项检查完成',supersedesEpisodeSubmissionEventId:null,submissionState:'SUBMITTED',canFlowDownstream:false,internalDownstreamEligibility:'INELIGIBLE_PENDING_COMPLETE_PLAN_REVIEW',sourceSyncRequired:false,sourceSyncState:'NOT_REQUIRED',applicationStatus:'RECORDED',effect:'REVIEW_INPUT_ONLY',totalEpisodeCount:2};
 const events=[old,candidate,create,resolved,archive,submission];
 snapshot.instance={episodePlanId:'plan:test'};
 const f={events,snapshot,binding:{releaseId:'release:test',snapshotId:snapshot.snapshotId,snapshotSha256:digest(JSON.stringify(snapshot)),snapshotCanonicalSha256:digest(snapshot),eventManifest:frozenEventManifest(events)},candidate,create,resolved,old,archive,submission};
 f.rebind=()=>{f.binding.eventManifest=frozenEventManifest(events);f.binding.snapshotCanonicalSha256=digest(snapshot);};
 return f;
}
test('real runtime validates two-episode synthetic narrative and complete comment histories without mutation',()=>{const f=fixture(),before=canonical(f.events),r=validateModernEventClosure(f,runtime);assert.equal(r.manifest.count,6);assert.equal(r.modernCandidates[0].episodeCount,2);assert.equal(r.partition.find(e=>e.eventId==='old:create').recordValidator,'LEGACY');assert.equal(r.partition.find(e=>e.eventId==='old:create').relationValidator,'RUNTIME_MODERN');assert.equal(r.eventsOmitted,0);assert.equal(canonical(f.events),before);assert.equal(r.formalModernReviewSupported,false);});
const mutations={
 'candidate content SHA':f=>{f.candidate.content.episodes[0].title='changed';},
 'candidate author basis':f=>{f.snapshot.productionModel.scriptRevisions[0].revisionHash=hash('other');},
 'candidate false adoption':f=>{f.candidate.adoptionPerformed=true;},
 'foreign instance plan':f=>{f.snapshot.instance.episodePlanId='plan:other';},
 'partial basis scope':f=>{f.candidate.basisBindings[0].scopeType='PROJECT';},
 'duplicate event sequence':f=>{f.create.eventSequence=f.candidate.eventSequence;},
 'missing comment CREATE':f=>{f.events.splice(f.events.indexOf(f.old),1);},
 'archive stale latest CAS':f=>{f.archive.expectedLatestEventId='foreign';},
 'archive physical deletion claim':f=>{f.archive.physicalHistoryDeleted=true;},
 'archive wrong scene SHA':f=>{f.archive.resolutionTarget.sceneBindings[0].contentHash=hash('foreign');},
 'archive wrong block SHA':f=>{f.archive.resolutionTarget.sceneBindings[0].blocksHash=hash('foreign');},
 'comment original label substitution':f=>{f.create.target.label='changed';},
 'comment anchor text mutation':f=>{f.create.anchor.quote='不同';},
 'comment immutable binding mutation':f=>{f.resolved.businessContextHash=hash('foreign');},
 'comment stale revision':f=>{f.resolved.commentRevisionId='foreign';},
 'resolution missing concrete note':f=>{f.resolved.resolutionNote='';},
 'resolution wrong aligned content hash':f=>{f.resolved.alignedSceneContentHash=hash('foreign');},
 'submission display alias identity':f=>{f.submission.episodeUid=f.submission.displayId;},
 'submission invented denominator':f=>{f.submission.totalEpisodeCount=7;},
 'submission illegal downflow':f=>{f.submission.canFlowDownstream=true;},
 'submission NA verdict':f=>{f.submission.criterionFindings[0].verdict='NA';},
 'submission broken predecessor':f=>{f.submission.supersedesEpisodeSubmissionEventId='foreign';},
 'modern formal review unsupported':f=>{f.events.push({...f.submission,eventId:'review:forbidden',eventSequence:7,eventKind:'review'});},
 'modern source sync unsupported':f=>{f.events.push({...f.submission,eventId:'sync:forbidden',eventSequence:7,eventKind:'source-operation'});},
};
for(const [name,mutate] of Object.entries(mutations))test(name+' fails closed',()=>{const f=fixture();mutate(f);f.rebind();assert.throws(()=>validateModernEventClosure(f,runtime));});
test('frozen complete event manifest cannot drop an unclassified legacy record',()=>{const f=fixture();f.events.pop();assert.throws(()=>validateModernEventClosure(f,runtime),/complete frozen event set/);});
test('both historical close contracts preserve original evidence',()=>{const f=fixture();f.archive.commentAction='RESOLVE_WITH_HISTORY';f.archive.visibility='CLOSED_HISTORY';f.rebind();assert.equal(validateModernEventClosure(f,runtime).modernCommentHistories.find(c=>c.commentId===f.old.commentId).archived,true);});
function changedResolution(){
 const f=fixture(),next=structuredClone(f.candidate);next.eventId='candidate:replacement';next.eventSequence=4;next.creativeRevisionId=next.revisionId='cr:replacement';
 const scene=next.content.narrativeRevision.scenes[0];scene.scriptBlocks[0].text='修改后的选择不再保留原来的字句。';scene.contentHash=hash(scene.scriptBlocks);
 for(const ref of Object.values(next.content.episodes[0].reviewDossier.boundaryEvidence)){ref.sceneContentHash=scene.contentHash;ref.sceneScriptRevisionId=`NSR-${scene.contentHash.slice(0,24)}`;ref.excerptSha256=digest(JSON.stringify(scene.scriptBlocks));}
 next.contentHash=hash(next.content);f.resolved.eventSequence=5;f.resolved.alignedSceneContentHash=scene.contentHash;
 f.events.splice(0,f.events.length,f.candidate,f.create,next,f.resolved);f.rebind();return {f,next};
}
test('historical resolution may change original selected prose, with exact old and replacement bindings',()=>{const {f}=changedResolution(),r=validateModernEventClosure(f,runtime);assert.equal(r.historicalResolutions[0].selectionState,'ORIGINAL_SELECTION_CHANGED_AT_RESOLUTION');assert.equal(r.historicalResolutions[0].candidateRevisionId,'cr:replacement');assert.deepEqual(f.resolved.anchor,f.create.anchor);});
test('resolution cannot borrow a future candidate even if its aligned hash matches',()=>{const {f,next}=changedResolution();next.eventSequence=6;f.rebind();assert.throws(()=>validateModernEventClosure(f,runtime),/resolution alignment differs/);});
