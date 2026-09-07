import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,runtime} from './modern-event-validator.test.mjs';
import {hostedEventProjection} from '../scripts/export-hosted-material-events.mjs';
const api=runtime.api,hash=api.stableObjectHash;
function setup(){
  const f=fixture(),spec={profileId:'episode-auto',criteria:[],legacy:false};
  f.candidate.reviewSpec={...spec,hash:hash(spec)};f.submission.reviewSpecHash=f.candidate.reviewSpec.hash;
  const candidate={...structuredClone(f.candidate),eventId:'next-candidate',creativeRevisionId:'cr:next',revisionId:'cr:next',eventSequence:10};
  candidate.content.changeSummary='仅更新全剧说明';candidate.contentHash=hash(candidate.content);
  const candidates=[candidate,f.candidate],submissions=[f.submission];
  const build=()=>api.automaticEpisodeSubmissions(candidate,candidates,submissions,candidate.reviewSpec,f.snapshot.snapshotId);
  return {...f,target:candidate,candidates,submissions,build};
}
function event(row,sequence=11){return {...row.payload,eventId:'auto:'+sequence,eventKind:row.kind,eventSequence:sequence,recordedAt:'2026-01-01T00:01:00Z',requestHash:row.requestHash,idempotencyKeyHash:hash(row.idempotencyKey)};}
function fail(source,id,sequence){const e={...structuredClone(source),eventId:id,eventSequence:sequence,supersedesEpisodeSubmissionEventId:source.eventId,recommendation:'REQUEST_REVISION',note:'行动依据不足'};e.criterionFindings[0]={...e.criterionFindings[0],verdict:'FAIL',note:'开场缺少明确行动'};return e;}
test('automatic carry creates a fully validated target head without modifying source or releasing anything',()=>{
  const f=setup(),before=JSON.stringify([f.candidates,f.submissions]),rows=f.build();assert.equal(rows.length,1);
  const e=event(rows[0]);api.assertEpisodeSubmissionBindings(e,f.target,e.episodeUid);api.assertEpisodeSubmissionInput(e,f.target,f.candidates,[...f.submissions,e]);
  assert.deepEqual(e.criterionFindings,f.submission.criterionFindings);assert.equal(e.note,f.submission.note);assert.equal(e.recommendation,f.submission.recommendation);
  assert.equal(e.effect,'REVIEW_INPUT_ONLY');assert.equal(e.canFlowDownstream,false);assert.equal(e.sourceSyncRequired,false);
  assert.equal(JSON.stringify([f.candidates,f.submissions]),before);assert.deepEqual(f.build(),rows);
  f.submissions.push(e);assert.deepEqual(f.build(),[]);
});
test('latest correction FAIL is retained, never an earlier PASS',()=>{const f=setup(),latest=fail(f.submission,'failed:latest',7);f.submissions.push(latest);const e=event(f.build()[0]);assert.equal(e.recommendation,'REQUEST_REVISION');assert.equal(e.carryForward.sourceSubmissionEventId,latest.eventId);assert.deepEqual(e.criterionFindings,latest.criterionFindings);});
test('newer candidate FAIL takes priority over older PASS',()=>{const f=setup(),middle={...structuredClone(f.candidate),eventId:'middle',creativeRevisionId:'cr:middle',revisionId:'cr:middle',eventSequence:7};const latest={...fail(f.submission,'middle:fail',8),subjectRevisionId:middle.creativeRevisionId,creativeRevisionId:middle.creativeRevisionId,supersedesEpisodeSubmissionEventId:null};f.candidates.push(middle);f.submissions.push(latest);assert.equal(f.build()[0].payload.carryForward.sourceSubmissionEventId,latest.eventId);});
test('changed or invalid latest evidence does not fall back to old PASS',()=>{for(const invalid of [false,true]){const f=setup(),middle={...structuredClone(f.candidate),eventId:'middle',creativeRevisionId:'cr:middle',revisionId:'cr:middle',eventSequence:7};middle.content.episodes[0].coreAdvance='不同的本集行动';middle.contentHash=hash(middle.content);const latest={...fail(f.submission,'middle:fail',8),subjectRevisionId:middle.creativeRevisionId,creativeRevisionId:middle.creativeRevisionId,subjectRevisionHash:middle.contentHash,supersedesEpisodeSubmissionEventId:null};if(invalid)latest.contextHash=hash('invalid');f.candidates.push(middle);f.submissions.push(latest);assert.deepEqual(f.build(),[]);}});
test('existing target head including mismatched standard is never overwritten',()=>{for(const stale of [false,true]){const f=setup(),existing=event(f.build()[0]);if(stale)existing.reviewSpecHash=hash('old standard');else{existing.recommendation='REQUEST_REVISION';existing.criterionFindings[0].verdict='FAIL';}f.submissions.push(existing);assert.deepEqual(f.build(),[]);}});
test('own prose, neighbor boundary and standard changes require new input',()=>{for(const mutate of [f=>{f.target.content.episodes[0].coreAdvance='改写';},f=>{f.target.content.episodes[1].openingHook='改写';},f=>{f.target.reviewSpec.hash=hash('new');}]){const f=setup();mutate(f);f.target.contentHash=hash(f.target.content);assert.deepEqual(f.build(),[]);}});
test('second-generation automatic provenance remains verifiable',()=>{const f=setup(),first=event(f.build()[0]);const next={...structuredClone(f.target),eventId:'third-candidate',creativeRevisionId:'cr:third',revisionId:'cr:third',eventSequence:12};const candidates=[...f.candidates,next],submissions=[...f.submissions,first];const second=event(api.automaticEpisodeSubmissions(next,candidates,submissions,next.reviewSpec,f.snapshot.snapshotId)[0],13);api.assertEpisodeSubmissionInput(second,next,candidates,[...submissions,second]);assert.equal(second.carryForward.sourceSubmissionEventId,first.eventId);});
test('workbench has no manual carry control, badge or automatic read-side POST',()=>{const source=fs.readFileSync(new URL('../app/episode-plan-workbench.tsx',import.meta.url),'utf8');assert.doesNotMatch(source,/确认沿用|已沿用|可沿用·待确认|CARRY_FORWARD_EPISODE|selectedCarryForward/);assert.match(source,/<small>\{selectedEpisode.displayId\}已提交<\/small>/);});
test('22 episodes across six automatic generations validate and export complete provenance',async()=>{
  const f=setup(),base=f.candidate,template=structuredClone(base.content.episodes[0]),sceneTemplate=structuredClone(base.content.narrativeRevision.scenes[0]);
  base.content.episodes=Array.from({length:22},(_,index)=>{const episode=structuredClone(template),id='many:'+index;episode.episodeUid='episode:many:'+index;episode.displayId='E'+String(index+1).padStart(2,'0');episode.sceneIds=[id];episode.reviewDossier.sceneFlow[0].sceneId=id;for(const ref of Object.values(episode.reviewDossier.boundaryEvidence))ref.sceneId=id;return episode;});
  base.content.narrativeRevision.scenes=base.content.episodes.map(e=>({...structuredClone(sceneTemplate),id:e.sceneIds[0]}));
  base.content.narrativeRevision.sequences=[];base.content.narrativeRevision.sourceNarrationIndex=[];base.contentHash=hash(base.content);
  let sequence=3;
  const candidates=[base],submissions=base.content.episodes.map(episode=>({...structuredClone(f.submission),eventId:'initial:'+episode.episodeUid,eventSequence:sequence++,episodeUid:episode.episodeUid,scopeId:episode.episodeUid,displayId:episode.displayId,subjectRevisionHash:base.contentHash,totalEpisodeCount:22,criterionFindings:api.expectedEpisodeCriterionIds(episode.episodeUid).map(criterionId=>({criterionId,verdict:'PASS',note:''}))}));
  const started=performance.now();
  for(let generation=1;generation<=6;generation++){
    const candidate={...structuredClone(base),eventId:'generation:'+generation,creativeRevisionId:'cr:generation:'+generation,revisionId:'cr:generation:'+generation,eventSequence:sequence++};candidates.push(candidate);
    const rows=api.automaticEpisodeSubmissions(candidate,candidates,submissions,candidate.reviewSpec,f.snapshot.snapshotId);assert.equal(rows.length,22);
    for(const row of rows){const e=event(row,sequence++);submissions.push(e);api.assertEpisodeSubmissionBindings(e,candidate,e.episodeUid);api.assertEpisodeSubmissionInput(e,candidate,candidates,submissions);}
  }
  f.snapshot.productionModel.materialWorkItems=[];
  const bundle=await hostedEventProjection({snapshot:f.snapshot,profile:{episodePlanId:base.subjectId},eventsByKind:{'creative-revision':[...candidates].reverse(),'episode-plan-submission':[...submissions].reverse()}});
  assert.equal(bundle.events['episode-plan-submission'].length,154);assert.equal(bundle.events['creative-revision'].length,7);
  assert(performance.now()-started<5000,'provenance must not expand all 22 episodes at each recursive edge');
});
