import {decodeAssetContextDocuments,assetContextDocumentsHash} from './instance-asset-context-proof.mjs';
import {validateAssetContextLedger} from './instance-runtime/asset-context-revalidation-model.mjs';
import {historicalEventContextReader} from './instance-historical-event-context.mjs';
import {decodeMaterialUsageDocuments,materialUsageDocumentsHash} from './instance-material-usage-proof.mjs';
import {validateMaterialUsageLedger} from './instance-runtime/material-usage-model.mjs';
import {planningReviewVersion} from './instance-runtime/shot-design-contract.mjs';
// Pure validation of a frozen event set. No repository, network or mutation API is invoked.
// Invoke in an isolated Node process: TypeScript loading must not alter a web process.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {episodeSourceCompiler} from './instance-runtime/episode-source-sync.mjs';
import {assertScopedShotProjections} from './instance-runtime/scoped-production-projection.mjs';
export const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
// Pipe boundaries are byte boundaries, not Unicode boundaries. Decode exactly
// once after collecting bytes, so the frozen snapshot hash remains meaningful.
export async function readFrozenModernEventInput(stream) {
  const chunks=[];let byteLength=0;
  for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);byteLength+=bytes.length;if(byteLength>128*1024*1024)throw Error('MODERN_EVENT_QA: frozen input exceeds 128 MiB');chunks.push(bytes);}
  return JSON.parse(Buffer.concat(chunks,byteLength).toString('utf8'));
}
const requireThat = (condition, message) => { if (!condition) throw Error(`MODERN_EVENT_QA: ${message}`); };
const text = value => typeof value === 'string' && Boolean(value.trim());
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (left, right) => canonical(left) === canonical(right);
const closed = event => ['RESOLVE_AND_DELETE', 'RESOLVE_WITH_HISTORY'].includes(event.commentAction);
const eventRow = event => ({eventId:event.eventId,eventKind:event.eventKind,eventSequence:event.eventSequence,sha256:digest(event)});

export function loadModernEventRuntime(softwareRoot) {
  const root = fs.realpathSync(softwareRoot), require = createRequire(path.join(root, 'package.json'));
  const ts = require('typescript'), loaded = new Map(), previous = new Map();
  for (const ext of ['.ts','.tsx']) {
    previous.set(ext, require.extensions[ext]);
    require.extensions[ext] = (module, filename) => {
      const absolute = fs.realpathSync(filename);
      requireThat(absolute.startsWith(path.join(root,'app')+path.sep), 'runtime TypeScript must come from this installed application');
      const bytes = fs.readFileSync(absolute); loaded.set(path.relative(root,absolute),digest(bytes));
      // Node16 retains native import(fileURL), used by controlled media/repository
      // readers. CommonJS rewrites it to require(fileURL), which Node cannot load.
      module._compile(ts.transpileModule(bytes.toString('utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.Node16,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,absolute);
    };
  }
  try {
    const api = {
      ...require(path.join(root,'app/api/v8/_episode-plan.ts')),
      ...require(path.join(root,'app/api/v8/episode-plan-reviews/_contract.ts')),
      ...require(path.join(root,'app/api/v8/episode-plan-reviews/_scope.ts')),
      ...require(path.join(root,'app/api/v8/episode-plan-reviews/_automatic.ts')),
      ...require(path.join(root,'app/api/v8/episode-plan-reviews/_release.ts')),
      ...require(path.join(root,'app/api/v8/episode-plan-reviews/_planning.ts')),
      ...require(path.join(root,'app/api/v8/_review-spec.ts')),
      canonicalSceneScopedContent:require(path.join(root,'app/api/v8/creative-revisions/route.ts')).canonicalSceneScopedContent,
      ...require(path.join(root,'app/api/v8/script-comments/_context.ts')),
      ...require(path.join(root,'app/story-comment-model.ts')),
      ...require(path.join(root,'app/instance-profile.ts')),
      ...require(path.join(root,'app/api/v8/_store.ts')),
      ...require(path.join(root,'app/api/v8/_workflow.ts')),
      configuredGates:require(path.join(root,'app/gate-evaluation.ts')).configuredGates,
    };
    requireThat(loaded.size > 0,'a fresh isolated process is required; runtime module cache was already populated');
    return {api,codeBindings:[...loaded].sort(([a],[b])=>a.localeCompare(b)).map(([alias,sha256])=>({alias,sha256})),typescriptVersion:ts.version};
  } finally { for (const [ext, loader] of previous) { if(loader)require.extensions[ext]=loader;else delete require.extensions[ext]; } }
}

export function frozenEventManifest(events) {
  requireThat(Array.isArray(events),'complete frozen events must be an array');
  const rows=events.map(eventRow).sort((a,b)=>a.eventId.localeCompare(b.eventId));
  requireThat(new Set(rows.map(row=>row.eventId)).size===rows.length,'duplicate event identity');
  return {count:rows.length,eventSequenceHighWater:Math.max(0,...rows.map(row=>Number(row.eventSequence)||0)),events:rows,eventsHash:digest(rows)};
}

export function validateModernEventClosure({events,snapshot,binding,historicalContexts,materialUsageSources=[],assetContextSources=[]},runtime) {
  const {api}=runtime, before=canonical(events), manifest=frozenEventManifest(events);
  requireThat(binding && text(binding.releaseId) && sha(binding.snapshotSha256) && text(binding.snapshotId),'exact base release binding required');
  requireThat(snapshot?.snapshotId===binding.snapshotId && digest(snapshot)===binding.snapshotCanonicalSha256,'frozen snapshot bytes/canonical binding mismatch');
  requireThat(equal(manifest,binding.eventManifest),'complete frozen event set differs from capture');
  const usageDocuments=decodeMaterialUsageDocuments(materialUsageSources);
  const usageRows=validateMaterialUsageLedger({snapshot,documents:usageDocuments,events});
  if(usageRows.length||materialUsageSources.length||binding.materialUsageSourcesHash!==undefined)requireThat(materialUsageDocumentsHash(materialUsageSources)===binding.materialUsageSourcesHash,'material usage fixed source capture differs');
  const usageIds=new Set(usageRows.map(row=>row.event.eventId));
  assertScopedShotProjections(snapshot.productionModel||{});
  // Imported pre-sequence evidence keeps its original absence; never backfill it.
  // This is the runtime projection order, with original date/id as the legacy tie breaker.
  const ordered=[...events].sort((a,b)=>(Number(a.eventSequence)||0)-(Number(b.eventSequence)||0)||String(a.recordedAt).localeCompare(String(b.recordedAt))||a.eventId.localeCompare(b.eventId));
  const sequences=new Set();
  for(const e of ordered){
    requireThat(text(e.eventId)&&text(e.eventKind)&&(usageIds.has(e.eventId)||text(e.snapshotId))&&text(e.schemaVersion),'event envelope identity is incomplete');
    requireThat(sha(e.requestHash)&&sha(e.idempotencyKeyHash)&&(!('rawRequestHash'in e)||sha(e.rawRequestHash)),'event request digest is invalid: '+e.eventId);
    requireThat(text(e.recordedAt)&&Number.isFinite(Date.parse(e.recordedAt)),'event recordedAt invalid');
    if(e.eventSequence!=null){requireThat(Number.isSafeInteger(e.eventSequence)&&e.eventSequence>0&&!sequences.has(e.eventSequence),'duplicate/invalid event sequence: '+e.eventId+' / '+e.eventSequence);sequences.add(e.eventSequence);}
    else requireThat(!(e.eventKind==='script-comment'&&e.schemaVersion==='1.2')&&e.eventKind!=='episode-plan-submission'&&!e.content?.narrativeRevision,'modern event lacks formal sequence');
  }
  const candidates=ordered.filter(e=>e.eventKind==='creative-revision'&&e.subjectKind==='EPISODE_PLAN');
  const byRevision=new Map(candidates.map(e=>[e.creativeRevisionId,e]));
  requireThat(byRevision.size===candidates.length,'duplicate immutable candidate revision');
  const modernCandidates=candidates.filter(e=>e.content?.narrativeRevision!==undefined);
  const modernIds=new Set(modernCandidates.map(e=>e.creativeRevisionId));
  const modernCommentIds=new Set(ordered.filter(e=>e.eventKind==='script-comment'&&e.schemaVersion==='1.2').map(e=>e.commentId));
  const recordIds=new Set(),relationIds=new Set(), candidateReports=[],commentReports=[],submissionReports=[],resolutionReports=[];
  for(const id of usageIds){recordIds.add(id);relationIds.add(id);}
  const latestCandidate=(event,subjectId)=>candidates.filter(c=>c.eventSequence<event.eventSequence&&(!subjectId||c.subjectId===subjectId)).at(-1);
  const historicalSnapshot=historicalEventContextReader(historicalContexts,{events,expectedHash:binding.historicalContextsHash,instanceId:snapshot.instance?.instanceId||snapshot.productionModel?.instance?.instanceId,directory:runtime.historicalContextDirectory});
  const contextDocuments=decodeAssetContextDocuments(assetContextSources);
  const contextRows=validateAssetContextLedger({snapshot,documents:contextDocuments,events,releaseContext:event=>historicalSnapshot.releaseContext(event)});
  if(contextRows.length||assetContextSources.length||binding.assetContextSourcesHash!==undefined)requireThat(assetContextDocumentsHash(assetContextSources)===binding.assetContextSourcesHash,'asset context fixed source capture differs');
  for(const row of contextRows){recordIds.add(row.event.eventId);relationIds.add(row.event.eventId);}
  function scopedViewBefore(event){
    const before=ordered.filter(e=>e.eventSequence<event.eventSequence);
    const eventsByKind={};for(const e of [...before].reverse())(eventsByKind[e.eventKind]||=[]).push(e);
    return {snapshot:historicalSnapshot(event),eventsByKind};
  }
  for(const c of modernCandidates){
    requireThat(c.schemaVersion==='2.0'&&c.criteriaVersion==='2.0'&&c.revisionId===c.creativeRevisionId,'modern candidate envelope unsupported');
    requireThat(c.creationSnapshotId===c.snapshotId&&c.bindingVersion==='2.0'&&c.businessContextHash===c.contextHash,'candidate immutable context differs');
    requireThat(c.revisionState==='CANDIDATE'&&c.adoptionPerformed===false&&['A','L'].includes(c.authorityClass),'candidate cannot claim adoption/authority');
    requireThat(Array.isArray(c.evidenceRefs)&&c.evidenceRefs.length<=200&&c.evidenceRefs.every(text)&&new Set(c.evidenceRefs).size===c.evidenceRefs.length,'candidate evidence references invalid');
    requireThat(c.subjectId===api.episodePlanIdFor(snapshot),'candidate belongs to a different instance plan');
    requireThat(Array.isArray(c.basisBindings)&&c.basisBindings.every(b=>text(b.bindingType)&&text(b.bindingId)&&sha(b.bindingHash)&&(!('scopeType'in b||'scopeId'in b)||(text(b.scopeType)&&text(b.scopeId)))),'candidate basis contains an incomplete identity/scope');
    api.assertEpisodeCandidateContract(c);
    api.assertCreativeRevisionBasisCurrent(snapshot,{},c);
    const identities=api.episodeIdentities(c.content);
    requireThat(c.content.planId===c.subjectId&&c.content.episodes.flatMap(e=>e.sceneIds).join('|')===c.content.narrativeRevision.scenes.map(s=>s.id).join('|'),'episode partition must cover every narrative scene exactly once in order');
    api.validateEpisodePlanEvidence(snapshot,c.content,false);
    requireThat(c.content.episodes.every(e=>e.reviewDossier.schemaVersion==='1.1'),'modern narrative candidate requires uniformly authored v1.1 dossiers');
    recordIds.add(c.eventId);relationIds.add(c.eventId);
    candidateReports.push({eventId:c.eventId,revisionId:c.creativeRevisionId,contentHash:c.contentHash,episodeCount:identities.length,sceneCount:c.content.narrativeRevision.scenes.length,adoptionPerformed:false});
  }
  for(const event of ordered){
    const referencesModern=[event.creativeRevisionId,event.subjectRevisionId,event.resolutionTarget?.candidateRevisionId].some(id=>modernIds.has(id));
    if(event.eventKind==='review'&&event.subjectType==='EPISODE_NARRATIVE'){
      api.assertEpisodeNarrativeReview(event,candidates,ordered.filter(e=>e.eventKind==='episode-plan-submission'));
      recordIds.add(event.eventId);relationIds.add(event.eventId);continue;
    }
    if(event.eventKind==='source-operation'&&event.protocol==='EPISODE_DATABASE_COMPILER_V1'){
      api.assertEpisodeSourceOperation(snapshot,event,candidates,ordered.filter(e=>e.eventKind==='review'),ordered.filter(e=>e.eventKind==='episode-plan-submission'));
      recordIds.add(event.eventId);relationIds.add(event.eventId);continue;
    }
    if(event.eventKind==='creative-revision'&&event.scopedReviewSpec){
      requireThat(['SCENE_COVERAGE','SHOT_PLAN_SET'].includes(event.subjectKind)&&event.scopeType==='SCENE'&&event.scopeId===event.content?.sceneId,'scoped candidate scope differs');
      requireThat(event.schemaVersion==='2.0'&&event.revisionState==='CANDIDATE'&&event.adoptionPerformed===false&&digest(event.content)===event.contentHash&&digest(event.basisBindings)===event.basisBindingsHash,'scoped candidate content/basis differs');
      requireThat(equal(event.scopedReviewSpec,api.scopedPlanningReviewSpec(event.subjectKind,planningReviewVersion(event.planningContractVersion))),'scoped planning standard differs');
      requireThat(event.creativeRevisionId===event.revisionId&&event.contextHash===api.stableObjectHash({subjectKind:event.subjectKind,subjectId:event.subjectId,baseRevisionHash:event.baseRevisionHash,basisBindingsHash:event.basisBindingsHash,...(event.planningContractVersion==='3.0'?{planningContractVersion:'3.0'}:{})}),'scoped candidate identity/context differs');
      const view=scopedViewBefore(event);
      const canonicalContent=api.canonicalSceneScopedContent(view.snapshot,event.subjectKind,event.subjectId,event.content,event.basisBindings,event.planningContractVersion);
      requireThat(equal(canonicalContent,event.content),'scoped candidate content is not canonical');
      api.assertCreativeRevisionBasisCurrent(view.snapshot,episodeSourceCompiler(api).stateFor(view),event,{requireCurrentPredecessor:true});
      recordIds.add(event.eventId);relationIds.add(event.eventId);continue;
    }
    const planningCandidate=ordered.find(e=>e.eventKind==='creative-revision'&&e.scopedReviewSpec&&e.creativeRevisionId===event.creativeRevisionId);
    if(event.eventKind==='review'&&planningCandidate){
      requireThat(planningCandidate.eventSequence<event.eventSequence&&event.subjectRevisionId===planningCandidate.creativeRevisionId&&event.baseRevisionHash===planningCandidate.baseRevisionHash&&equal(event.basisBindings,planningCandidate.basisBindings),'scoped planning review precedes or misbinds candidate');
      requireThat(event.subjectType==='CREATIVE_REVISION'&&event.schemaVersion==='2.2'&&event.subjectKind===planningCandidate.subjectKind&&event.subjectId===planningCandidate.subjectId&&event.scopeType==='SCENE'&&event.scopeId===planningCandidate.content.sceneId&&event.contextHash===planningCandidate.contextHash&&event.subjectRevisionHash===planningCandidate.contentHash&&event.basisBindingsHash===planningCandidate.basisBindingsHash,'scoped planning review binding differs');
      api.assertScopedPlanningFindings(planningCandidate,event.criterionFindings,event.reviewSpecHash);
      requireThat(['APPROVE_AND_RELEASE','REQUEST_REVISION','DO_NOT_USE'].includes(event.action)&&event.applicationStatus==='APPLIED'&&event.effect==='APPLIED'&&event.canFlowDownstream===false,'scoped planning review outcome invalid');
      requireThat(event.action!=='APPROVE_AND_RELEASE'||event.criterionFindings.every(f=>f.verdict==='PASS'),'scoped release contains failure');
      requireThat(event.sourceSyncRequired===(event.action==='APPROVE_AND_RELEASE')&&event.sourceSyncState===(event.action==='APPROVE_AND_RELEASE'?'PENDING':'NOT_REQUIRED'),'scoped review source state differs');
      recordIds.add(event.eventId);relationIds.add(event.eventId);continue;
    }
    if(event.eventKind==='source-operation'&&event.protocol==='SCOPED_SCENE_DATABASE_COMPILER_V1'){
      const review=ordered.find(e=>e.eventId===event.reviewEventId&&e.eventKind==='review');
      const historical=historicalSnapshot(event);
      requireThat(review&&review.eventSequence<event.eventSequence&&planningCandidate&&planningCandidate.eventSequence<review.eventSequence,'scoped source operation lacks prior review/candidate');
      api.assertScopedSceneSyncBinding(historical,event,review);
      recordIds.add(event.eventId);relationIds.add(event.eventId);continue;
    }
    if(['review','source-operation'].includes(event.eventKind)&&(referencesModern||event.subjectKind==='EPISODE_PLAN'&&modernCandidates.length)) {
      throw Error('MODERN_EVENT_QA: modern formal Review/source-sync is not supported by this validated bridge');
    }
    if(event.eventKind==='episode-plan-submission'&&modernIds.has(event.subjectRevisionId)){
      const c=byRevision.get(event.subjectRevisionId);
      requireThat(c.eventSequence<event.eventSequence,'submission precedes candidate');
      api.assertEpisodeSubmissionBindings(event,c,event.episodeUid);
      const findings=api.parseEpisodeFindings(event.criterionFindings,event.episodeUid);
      requireThat(equal(findings,event.criterionFindings),'submission findings are not exact canonical runtime findings');
      requireThat(typeof event.note==='string'&&event.note.length<=20000,'submission note invalid');
      api.validateEpisodeAction(event.recommendation,findings,event.note);
      requireThat(['1.0','1.1'].includes(event.schemaVersion),'unsupported submission schema');
      requireThat(event.schemaVersion==='1.0'?event.operation==='SUBMIT_EPISODE':['SUBMIT_EPISODE','CARRY_FORWARD_EPISODE'].includes(event.operation),'unsupported submission operation');
      api.assertEpisodeSubmissionInput(event,c,modernCandidates,ordered.filter(e=>e.eventKind==='episode-plan-submission'));
      for(const[key,value]of Object.entries({submissionState:'SUBMITTED',applicationStatus:'RECORDED',effect:'REVIEW_INPUT_ONLY',canFlowDownstream:false,sourceSyncRequired:false,sourceSyncState:'NOT_REQUIRED',internalDownstreamEligibility:'INELIGIBLE_PENDING_COMPLETE_PLAN_REVIEW'}))requireThat(event[key]===value,'submission cannot claim downstream eligibility: '+key);
      recordIds.add(event.eventId);relationIds.add(event.eventId);submissionReports.push({eventId:event.eventId,candidateRevisionId:c.creativeRevisionId,episodeUid:event.episodeUid,effect:event.effect});
    }
  }
  for(const c of modernCandidates)api.episodeSubmissionHeads(ordered.filter(e=>e.eventKind==='episode-plan-submission'),c.creativeRevisionId);

  function targetFor(candidate,kind,subjectId,snapshotId){
    requireThat(candidate&&modernIds.has(candidate.creativeRevisionId),'comment target lacks an independently validated immutable candidate');
    const plan={content:candidate.content},sources=api.storyCommentSources(plan);
    const source=sources.find(s=>s.kind===kind&&s.subjectId===subjectId);
    requireThat(source&&new Set(source.blocks.map(b=>b.id)).size===source.blocks.length,'comment target missing or ambiguous');
    const contentHash=kind==='SCENE_SCRIPT'?candidate.content.narrativeRevision.scenes.find(s=>s.id===subjectId).contentHash:api.stableObjectHash(source.blocks);
    const contextHash=api.stableObjectHash({snapshotId,planContextHash:candidate.contextHash,basisBindingsHash:candidate.basisBindingsHash,revisionId:candidate.creativeRevisionId,planContentHash:candidate.contentHash,kind,subjectId,episodeUid:source.episodeUid,contentHash});
    return {...source,revisionId:candidate.creativeRevisionId,planContentHash:candidate.contentHash,contentHash,contextHash};
  }
  for(const commentId of modernCommentIds){
    requireThat(text(commentId),'comment identity missing');
    const rows=ordered.filter(e=>e.eventKind==='script-comment'&&e.commentId===commentId);
    const first=rows[0];requireThat(first.commentAction==='CREATE','modern comment closure omits original CREATE');
    let status=null,revisionId=null,latestId=null,archived=false,originalBinding=null,commentText=null;
    for(const e of rows){
      relationIds.add(e.eventId);
      requireThat(['1.0','1.1','1.2'].includes(e.schemaVersion),'unsupported comment schema');
      requireThat(!archived,'closed historical comments cannot be edited or reopened');
      const action=e.commentAction,isModern=e.schemaVersion==='1.2';
      if(isModern)recordIds.add(e.eventId);
      if(closed(e)){
        requireThat(isModern&&status&&e.commentRevisionId===revisionId&&e.expectedLatestEventId===latestId&&e.previousStatus===status,'historical resolution lacks exact thread CAS');
        requireThat(e.sceneId===first.sceneId&&e.resolutionStatus==='RESOLVED'&&e.visibility===(action==='RESOLVE_AND_DELETE'?'DELETED_AUDIT':'CLOSED_HISTORY')&&e.physicalHistoryDeleted===false&&text(e.resolutionNote),'historical closure must preserve original evidence');
        const ref=e.resolutionTarget,c=byRevision.get(ref?.candidateRevisionId);
        requireThat(c&&modernIds.has(c.creativeRevisionId)&&c===latestCandidate(e,c.subjectId)&&ref.candidateContentHash===c.contentHash,'historical closure candidate exact identity/order differs');
        requireThat(Array.isArray(ref.sceneBindings)&&ref.sceneBindings.length>0&&new Set(ref.sceneBindings.map(s=>s.sceneId)).size===ref.sceneBindings.length,'historical closure scene evidence missing/duplicate');
        for(const s of ref.sceneBindings){
          const scene=c.content.narrativeRevision.scenes.find(v=>v.id===s.sceneId);
          requireThat(scene&&scene.oldSceneIds.includes(first.sceneId)&&s.contentHash===scene.contentHash,'historical closure scene lineage/hash differs');
          requireThat(Array.isArray(s.blockIds)&&s.blockIds.length>0&&new Set(s.blockIds).size===s.blockIds.length,'historical closure blocks missing/duplicate');
          const blocks=s.blockIds.map(id=>scene.scriptBlocks.find(b=>b.id===id));
          requireThat(blocks.every(Boolean)&&api.stableObjectHash(blocks)===s.blocksHash,'historical closure block evidence differs');
        }
        status='RESOLVED';archived=true;latestId=e.eventId;continue;
      }
      const immutable={creationSnapshotId:e.creationSnapshotId,sceneId:e.sceneId,sceneContentHash:e.sceneContentHash,businessContextHash:e.businessContextHash,anchor:e.anchor,target:e.target??null};
      if(isModern){
        requireThat(['CREATE','EDIT','RESOLVE_USER','REOPEN','AI_START','RESOLVE_AI'].includes(action),'unsupported modern comment action');
        requireThat(!['CREATE','EDIT'].includes(action)||(text(e.commentText)&&e.commentText===e.commentText.trim()&&e.commentText.length<=20000),'modern comment text is invalid');
        const c=byRevision.get(e.target?.revisionId);
        requireThat(c&&c.eventSequence<e.eventSequence,'comment precedes its candidate');
        const expected=targetFor(c,e.target.kind,e.target.subjectId,e.creationSnapshotId);
        requireThat(equal(e.target,expected)&&e.sceneId===(expected.kind==='SCENE_SCRIPT'?expected.subjectId:'')&&e.sceneContentHash===expected.contentHash&&e.businessContextHash===expected.contextHash,'comment immutable target does not match exact authored catalog');
        requireThat(equal(api.parseCommentAnchorBlocks(expected.blocks,e.anchor,{allowFieldSelection:expected.kind==='EPISODE_DESIGN'}),e.anchor),'comment anchor bytes do not match exact authored blocks');
        if(['EDIT','REOPEN','AI_START'].includes(action)){
          const current=targetFor(latestCandidate(e,c.subjectId),expected.kind,expected.subjectId,e.snapshotId);
          try{api.parseCommentAnchorBlocks(current.blocks,e.anchor,{allowFieldSelection:current.kind==='EPISODE_DESIGN'});}catch(error){throw Error(`MODERN_EVENT_QA: ${e.eventId} ${action} alignment against ${current.revisionId}: ${error.message}`);}
          const segments=e.anchor.segments||[e.anchor];
          requireThat(segments.every(s=>current.blocks.find(b=>b.id===s.blockId)?.text===expected.blocks.find(b=>b.id===s.blockId)?.text),'comment anchor silently moved to changed authored text');
        }
      }
      if(action==='CREATE'){
        requireThat(status===null&&e.commentRevisionId==null&&text(e.commentText),'duplicate/invalid comment CREATE');
        requireThat(!isModern||e.initialStatus==='AI_QUEUED','modern CREATE initial status invalid');
        status=e.initialStatus==='AI_QUEUED'?'AI_QUEUED':'OPEN';revisionId=e.eventId;originalBinding=immutable;commentText=e.commentText;
      }else{
        requireThat(status!==null&&equal(immutable,originalBinding),'comment immutable history binding changed');
        requireThat((e.commentRevisionId==null&&!isModern&&!(e.schemaVersion==='1.1'&&['EDIT','AI_START','RESOLVE_AI'].includes(action)))||e.commentRevisionId===revisionId,'comment revision chain is stale');
        if(action==='EDIT'){
          requireThat(['1.1','1.2'].includes(e.schemaVersion)&&status!=='RESOLVED'&&text(e.commentText)&&e.commentText!==commentText,'invalid comment EDIT');
          commentText=e.commentText;revisionId=e.eventId;status='AI_QUEUED';
        }else{
          requireThat(e.commentText==null||e.commentText==='','non-edit changed comment text');
          const transitions={OPEN:{ASSIGN_AI:'AI_QUEUED',RESOLVE_USER:'RESOLVED'},AI_QUEUED:{AI_START:'AI_PROCESSING',RESOLVE_AI:'RESOLVED',RESOLVE_USER:'RESOLVED'},AI_PROCESSING:{RESOLVE_AI:'RESOLVED',RESOLVE_USER:'RESOLVED'},RESOLVED:{REOPEN:'OPEN'}};
          requireThat(transitions[status]?.[action],'invalid comment transition '+status+' -> '+action);status=transitions[status][action];
        }
      }
      if(['RESOLVE_AI','RESOLVE_USER'].includes(action)){
        requireThat(text(e.resolutionNote)&&text(e.alignedSnapshotId)&&sha(e.alignedSceneContentHash),'comment resolution evidence incomplete');
        if(isModern){
          const c=byRevision.get(e.target.revisionId);
          // The immutable event may close its explicitly named original version; it
          // does not thereby attest that a newer candidate addressed the request.
          const original=targetFor(c,e.target.kind,e.target.subjectId,e.alignedSnapshotId);
          let target=original,alignmentRole='ORIGINAL_TARGET_VERSION';
          if(original.contentHash!==e.alignedSceneContentHash){
            const matches=candidates.filter(row=>modernIds.has(row.creativeRevisionId)&&row.subjectId===c.subjectId&&row.eventSequence>=c.eventSequence&&row.eventSequence<e.eventSequence).map(row=>{
              const source=api.storyCommentSources({content:row.content}).find(s=>s.kind===e.target.kind&&s.subjectId===e.target.subjectId);
              return source?targetFor(row,e.target.kind,e.target.subjectId,e.alignedSnapshotId):null;
            }).filter(row=>row?.contentHash===e.alignedSceneContentHash);
            requireThat(matches.length===1,`comment resolution alignment differs: ${e.eventId}; exact prior replacement candidate count ${matches.length}`);
            target=matches[0];alignmentRole='EXACT_LATER_CANDIDATE_VERSION';
          }
          requireThat(e.alignedSnapshotId===e.snapshotId&&e.alignedSceneContentHash===target.contentHash,'comment resolution alignment differs');
          // Historical resolution is an immutable fact, not a replay of today's POST preflight.
          // Fixing selected prose may change its old quote; the original catalog/anchor was
          // verified above, and the resolution independently binds exact replacement bytes.
          let originalSelectionUnchanged=true;
          try{api.parseCommentAnchorBlocks(target.blocks,e.anchor,{allowFieldSelection:target.kind==='EPISODE_DESIGN'});}catch{originalSelectionUnchanged=false;}
          const segments=e.anchor.segments||[e.anchor];
          originalSelectionUnchanged=originalSelectionUnchanged&&segments.every(s=>target.blocks.find(b=>b.id===s.blockId)?.text===e.target.blocks.find(b=>b.id===s.blockId)?.text);
          resolutionReports.push({eventId:e.eventId,commentId,candidateRevisionId:target.revisionId,alignedSnapshotId:e.alignedSnapshotId,alignedContentHash:target.contentHash,alignmentRole,originalTargetHash:digest(e.target),originalAnchorHash:digest(e.anchor),selectionState:originalSelectionUnchanged?'ORIGINAL_SELECTION_UNCHANGED':'ORIGINAL_SELECTION_CHANGED_AT_RESOLUTION',mode:'HISTORICAL_RESOLUTION_NOT_CURRENT_WRITE_PREFLIGHT'});
        }
      }
      latestId=e.eventId;
    }
    commentReports.push({commentId,firstEventId:first.eventId,latestEventId:latestId,commentRevisionId:revisionId,status,archived,eventIds:rows.map(e=>e.eventId),originalEvidenceHash:digest(first)});
  }
  const partition=manifest.events.map(row=>({...row,recordValidator:recordIds.has(row.eventId)?'RUNTIME_MODERN':'LEGACY',relationValidator:relationIds.has(row.eventId)?'RUNTIME_MODERN':'LEGACY'}));
  requireThat(canonical(events)===before,'validation modified immutable events');
  return {schemaVersion:'1.0',mode:'VALIDATION_DELEGATION_ONLY',eventSerialization:'EXISTING_COMPILER_CANONICAL_JSON_NO_FIELD_CHANGES',originalDatabaseEventBytesRead:false,binding,manifest,partition,partitionHash:digest(partition),modernCandidates:candidateReports,modernSubmissions:submissionReports,modernCommentHistories:commentReports,historicalResolutions:resolutionReports,codeBindings:runtime.codeBindings,typescriptVersion:runtime.typescriptVersion,formalModernReviewSupported:false,formalModernSourceSyncSupported:false,originalEventsUnchanged:true,eventsOmitted:0};
}
