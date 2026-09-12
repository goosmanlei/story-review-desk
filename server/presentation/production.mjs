import { present, idFor, idsFor, stateLabel } from './read-unit.mjs';
import { episodePlan, sceneRow } from './story.mjs';
import { assets, materialRows } from './materials.mjs';
import { workStateSql } from '../shared/workflow.mjs';
import { hash, check } from '../shared/contracts.mjs';
import { reviewEvent } from './review.mjs';
import { materialOccurrences } from './material-occurrences.mjs';

export async function preparationWorkspace(unit, sceneId) {
  const plan = await episodePlan(unit);
  const rows = await unit.rows(['PREPARATION'], { ids: undefined });
  const comments=(await unit.rows(['COMMENT'],{historical:true})).filter(c=>rows.some(r=>r.id===c.content.target?.objectId)&&(!sceneId||idFor(c,'SCENE')===sceneId)).map(c=>({id:c.id,commentId:c.id,sceneId:idFor(c,'SCENE'),text:c.content.text,commentText:c.content.text,status:c.content.status,createdAt:c.updatedAt,revisionId:c.revisionId,target:c.content.target}));
  const scenes = rows.filter(r => !sceneId || idFor(r,'SCENE') === sceneId).map(row => {
    const id = idFor(row,'SCENE'), scene = plan?.content.narrativeRevision.scenes.find(s => s.id === id);
    return { sceneId: id, displayId: scene?.displayId || id, title: scene?.title || row.title, episodeUid: idFor(row,'EPISODE') || plan?.content.episodes.find(e => e.sceneIds.includes(id))?.episodeUid || null,
      sceneContentHash: scene?.contentHash, sourceSummary: scene ? { title: scene.title, slugline: scene.slugline, purpose: scene.purpose, storyTime: scene.storyTime, viewpoint: scene.viewpoint, audienceKnown: scene.audienceKnown, audienceWithheld: scene.audienceWithheld } : {}, preparation: row.content, objectId: row.id, revisionId: row.revisionId, expectedVersion: row.version };
  });
  const episodes=(plan?.content.episodes||[]).map(({episodeUid,displayId,title,sceneIds})=>({episodeUid,displayId,title,sceneIds}));
  const occurrences=await materialOccurrences(unit), materialLinks={...occurrences,scenes:occurrences.scenes.map(({sceneId,sceneContentHash,episodeUid,unboundNeeds,references})=>({sceneId,sceneContentHash,episodeUid,unboundNeeds,references:references.map(({requirementId,requirementHash})=>({requirementId,requirementHash}))}))};
  return { snapshotId: await unit.namespace(), releaseId: unit.version(), revisionId: unit.version(), content: { basis: { planId: plan?.content.planId, planRevisionId: plan?.revisionId }, scenes, episodes }, candidate: plan ? { revisionId: plan.revisionId, contentHash: plan.contentHash, episodes, scenes: plan.content.narrativeRevision.scenes.map(s => ({ id:s.id, displayId:s.displayId, title:s.title, contentHash:s.contentHash })) } : null, materialLinks, comments, stale: false, readOnly: false };
}

export async function productionPage(unit, params, materials = false) {
  const model = await unit.blankModel();
  const requirements = await materialRows(unit, { requirementId: params.get('requirementId') });
  const media = await assets(unit);
  Object.assign(model, media, { materialRequirements: requirements });
  const plan = await episodePlan(unit);
  const scenes = await unit.rows(['SCENE'], { historical:true });
  model.scenes = scenes.map(r => ({ ...sceneRow(r), episodeIds: [], shotIds: [], segmentIds: [], structureCardRefs: [], materialRequirementRefs: requirements.filter(q => q.sceneIds.includes(r.id)).map(q => q.id) }));
  model.episodes = plan?.content.episodes.map(e => ({ ...e, id:e.episodeUid, canonicalScopeId:e.episodeUid, segmentIds:[], shotIds:[], calibrationShotCount:0, scopeRole:'CURRENT', sourceRef:e.revisionId })) || [];
  const designs = await unit.rows(['SHOT_DESIGN']);
  const currentScenes = new Set(plan?.content.episodes.flatMap(e=>e.sceneIds)||[]);
  const currentShots = new Set(designs.filter(d=>currentScenes.has(idFor(d,'SCENE'))&&!['DISABLED','ARCHIVED'].includes(d.state)).flatMap(d=>idsFor(d,'SHOT')));
  const shots = await unit.rows(['SHOT'], { historical:true });
  model.shots = shots.map(r => {const current=!r.historical&&currentScenes.has(idFor(r,'SCENE'))&&currentShots.has(r.id);return { ...present(r), id:r.id, sceneId:idFor(r,'SCENE'), shotId:r.id, shotUid:r.id, scopeRole:current?'CURRENT':'HISTORICAL', historyRole:current?'CURRENT':'HISTORICAL', activeInCurrentProduction:current, requiredAssetRefs:idsFor(r,'REQUIREMENT'), materialRequirementRefs:idsFor(r,'REQUIREMENT'), workPackageRefs:[], workItemRefs:[], segmentId:'', episodeId:plan?.content.episodes.find(e=>e.sceneIds.includes(idFor(r,'SCENE')))?.episodeUid || '', sourceRef:r.revisionId, lifecycleState:stateLabel(r.state) };});
  model.shotPlanSetRevisions = designs.map(r => ({ ...present(r), id:r.revisionId, subjectId:r.id, sceneId:idFor(r,'SCENE'), scopeId:idFor(r,'SCENE'), scopeType:'SCENE', revisionState:r.state, status:r.state, shotSpecs:idsFor(r,'SHOT').map(id=>model.shots.find(s=>s.id===id)).filter(Boolean), shots:idsFor(r,'SHOT').map(id=>model.shots.find(s=>s.id===id)).filter(Boolean) }));
  model.episodePlanRevisions = plan ? [{ id:plan.revisionId, planId:plan.content.planId, episodes:plan.content.episodes, retiredEpisodeUids:[], status:plan.sourceRole, scopeRole:plan.sourceRole === 'CURRENT'?'CURRENT':'PROPOSAL', isCurrentProposal:plan.sourceRole!=='CURRENT' }] : [];
  model.revisionPointers = { currentEpisodePlanRevisionId:plan?.sourceRole==='CURRENT'?plan.revisionId:null, episodePlanProposalRevisionId:plan?.revisionId };
  const planNotes=await unit.rows(['NOTE']),materialPlans=planNotes.filter(r=>r.content.role==='MATERIAL_PRODUCTION');
  const calls=await unit.rows(['CALL']),expectations=await unit.rows(['EXPECTED_OUTPUT']);
  model.expectedOutputs=expectations.map(r=>{const actual=media.assetVersions.find(v=>v.basis?.expectedOutputId===r.id&&v.outputState==='PRESENT');return {...present(r),familyId:idFor(r,'FAMILY'),expectedOutputId:r.id,...(actual?{expectationState:'REALIZED',realizedVersionId:actual.id,realizedVersionSha256:actual.sha256}:{})};});
  model.materialWorkItems=requirements.filter(r=>r.requirementClass!=='EVIDENCE_ONLY').map(r=>{
    const call=calls.find(c=>c.id===materialPlans.find(p=>p.content.requirementId===r.id)?.content.currentCallId)||calls.find(c=>idsFor(c,'REQUIREMENT').includes(r.id)),family=media.assetFamilies.find(f=>r.assetFamilyRefs.includes(f.id)),version=media.assetVersions.find(v=>v.id===family?.currentVersionRef);
    return {id:call?.content.workItemRef||'material:'+r.id,label:r.title,lane:'MATERIAL_PREP',workflowStepId:null,requirementRef:r.id,requirementHash:r.requirementHash,scopeType:'PROJECT',scopeId:r.id,episodeIds:r.episodeIds,episodeUids:r.episodeUids,sceneIds:r.sceneIds,shotIds:r.shotIds,structureCardRefs:r.structureCardRefs,inputAssetRefs:call?idsFor(call,'FAMILY').filter(id=>id!==family?.id):[],outputAssetRef:family?.id||r.plannedAssetFamilyId||null,additionalOutputAssetRefs:r.assetFamilyRefs.filter(id=>id!==family?.id),consumerWorkItemRefs:r.consumerWorkItemRefs,sourceRef:call?.revisionId||r.revisionId,executionDefinitionRef:call?.id||null,definitionAuthoringState:call?'DEFINED':'REQUIRED',declaredExecutionGate:call?.content.declaredGate||'UNKNOWN',generationAllowed:false,executionBlockReasons:['EXPLICIT_GENERATION_AUTHORIZATION_REQUIRED'],applicabilityState:'REQUIRED',lifecycleState:version?.lifecycleState||'PLANNED',outputState:version?.outputState||'NOT_GENERATED',reviewDecision:version?.reviewDecision||'PENDING_REVIEW',canFlowDownstream:version?.canFlowDownstream||false,flowBlockReasons:version?.flowBlockReasons||[],reviewSpec:r.reviewSpec};
  });
  model.materialRequirements=requirements.map(r=>({...r,materialWorkItemRef:model.materialWorkItems.find(i=>i.requirementRef===r.id)?.id||null}));
  const stages={SHOT_PLAN_INPUT_LOCK:['W01','INPUT_LOCK'],STORYBOARD_DIALOGUE:['W02','P07'],ANIMATIC_LOCK:['W03','P09'],KEYFRAMES:['W04','KFA'],SHOT_VIDEO:['W05','P11'],SHOT_LOCK:['W06','SHOT_LOCK_RECORD'],PICTURE_LOCK:['W07','PICTURE_LOCK'],SOUND_MIX_SUBTITLES:['W07','SOUND'],SCENE_QA:['W07','SCENE_QA'],EPISODE_ASSEMBLY:['W08','EPISODE_ASSEMBLY'],EPISODE_REVIEW:['W08','EPISODE_REVIEW'],EPISODE_TECH_QC:['W08','EPISODE_TECH_QC'],SERIES_CONTINUITY:['W09','SERIES_CONTINUITY'],RIGHTS_SAFETY_TECH:['W09','RIGHTS'],DELIVERY_ARCHIVE:['W09','DELIVERY']};
  model.workflowSteps=Object.entries(stages).filter(([,value],i,rows)=>rows.findIndex(([,v])=>v[0]===value[0])===i).map(([gateId,[id]])=>{const gate=model.productionGates.find(g=>g.id===gateId);return {id,order:Number(id.slice(1)),label:gate.label,purpose:gate.purpose,reviewFocus:gate.purpose,output:gate.label,unlock:'经本步骤审阅后进入后续制作',gateIds:Object.entries(stages).filter(([,s])=>s[0]===id).map(([g])=>g)};});
  const settingsByOutput=new Map((await unit.tx.query("SELECT d.consumer_revision_id,r.content FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id WHERE d.consumer_revision_id=ANY($1::text[]) AND r.content->>'role'='SHOT_PRODUCTION_SETTINGS'",[expectations.map(r=>r.revisionId)])).rows.map(r=>[r.consumer_revision_id,r.content.settings]));
  for(const row of expectations.filter(r=>r.content.workItemId&&r.content.workPackageId&&stages[r.content.gateId]&&r.content.expectationState!=='RETIRED')){
    const value=row.content,shot=model.shots.find(s=>s.id===value.shotId),scene=model.scenes.find(s=>s.id===value.sceneId),family=media.assetFamilies.find(f=>f.id===idFor(row,'FAMILY'));
    if(!scene||value.shotId&&!shot||!family)continue;
    const [stepId,stage]=stages[value.gateId],episode=plan?.content.episodes.find(e=>e.sceneIds.includes(value.sceneId));
    const version=media.assetVersions.find(v=>v.id===family.adoptedVersionRef),lifecycleState=version?.lifecycleState||'WAITING_UPSTREAM';
    const settings=settingsByOutput.get(row.revisionId)||{},call=calls.find(c=>c.id===planNotes.find(n=>n.content.role==='SHOT_RECIPE'&&n.content.workItemId===value.workItemId)?.content.currentCallId)||calls.find(c=>c.content.workItemRef===value.workItemId),contextId='production-context:'+row.id;
    const current=(!value.shotId||shot.activeInCurrentProduction)&&scene.scopeRole==='CURRENT';
    model.workItems.push({...value,shotProductionPlanId:value.productionPlanId,id:value.workItemId,label:row.title,scopeRole:current?'CURRENT':'HISTORICAL',activityRole:current?'CURRENT_PRODUCTION':'HISTORICAL_EVIDENCE',activeInCurrentProduction:current,historyRole:current?'CURRENT':'HISTORICAL',workflowStepId:stepId,legacyStageId:stage,stageKey:stage,pipelineStageCode:value.deliverableKey.startsWith('DIALOGUE')?'P08':stage,episodeId:episode?.episodeUid||'',episodeUid:episode?.episodeUid||null,segmentId:null,lineId:value.deliverableKey.startsWith('DIALOGUE')?value.outputSlot:null,inputAssetRefs:[...new Set([...(settings.inputs||[]),...(settings.previsInputs||[])].map(i=>i.familyId))],outputAssetRef:family.id,additionalOutputAssetRefs:[],promptRef:null,sourceRef:row.revisionId,executionDefinitionRef:call?.id||null,definitionStatus:call?'DEFINED':'NOT_AUTHORED',reviewContextRef:contextId,applicabilityState:'REQUIRED',lifecycleState,canFlowDownstream:version?.canFlowDownstream===true,generationAllowed:false,executionBlockReasons:['EXPLICIT_GENERATION_AUTHORIZATION_REQUIRED'],flowBlockReasons:version?.flowBlockReasons||['OUTPUT_NOT_PRESENT']});
    let pkg=model.workPackages.find(p=>p.id===value.workPackageId);
    if(!pkg){pkg={id:value.workPackageId,stepId,label:model.productionGates.find(g=>g.id===value.gateId).label,scopeType:value.scopeType,scopeId:value.scopeId,sceneId:value.sceneId,episodeId:episode?.episodeUid||'',episodeUid:episode?.episodeUid||null,segmentId:null,shotIds:value.shotId?[value.shotId]:model.shots.filter(s=>s.sceneId===value.sceneId&&s.activeInCurrentProduction).map(s=>s.id),workItemRefs:[],applicable:true,applicabilityState:'REQUIRED',notApplicableReason:null,isShared:!value.shotId,phaseId:value.phaseId,gateId:value.gateId,scopeRole:current?'CURRENT':'HISTORICAL',activityRole:current?'CURRENT_PRODUCTION':'HISTORICAL_EVIDENCE',activeInCurrentProduction:current,lifecycleState,canFlowDownstream:false,flowBlockReasons:[]};model.workPackages.push(pkg);}
    pkg.workItemRefs.push(value.workItemId);
    family.expectedOutputRefs=[...new Set([...(family.expectedOutputRefs||[]),row.id])];family.currentExpectedOutputId=family.currentVersionId?null:row.id;family.nextExpectedOutputId=row.id;family.lifecycleState=lifecycleState;
    model.reviewContexts.push({id:contextId,schemaVersion:'2.0',scopeType:value.scopeType,scopeId:value.scopeId,semanticStatus:'AUTHORED_DRAFT',reviewable:current,contextHash:hash({output:row.revisionId,scene:scene.revisionId,shot:shot?.revisionId}),position:{sceneId:scene.id,shotId:shot?.id||null},scene:{id:scene.id,slugline:scene.slugline,scriptExcerpt:scene.text||'',shotIds:pkg.shotIds},sourceRefs:[row.revisionId,scene.revisionId]});
  }
  for(const shot of model.shots){shot.workPackageRefs=model.workPackages.filter(p=>p.shotIds.includes(shot.id)).map(p=>p.id);shot.workItemRefs=model.workItems.filter(w=>w.shotId===shot.id).map(w=>w.id);}
  // Detailed design bodies have their own object endpoint; avoid two more copies of every shot.
  model.shotPlanSetRevisions=model.shotPlanSetRevisions.map(({shots,shotSpecs,...r})=>({...r,shotIds:shots.map(s=>s.id)}));
  model.scenes=model.scenes.map(({blocks,...r})=>r);
  model.episodes=model.episodes.map(({reviewDossier,reviewSpec,...r})=>r);
  model.episodePlanRevisions=model.episodePlanRevisions.map(r=>({...r,episodes:model.episodes}));
  const count = materials ? requirements.length : model.workItems.length;
  const page = model;
  return { schemaVersion:'1.0', snapshotId:await unit.namespace(), readVersion:unit.version(), count, total:count, hasMore:false, nextCursor:null, appliedMode:'requirements', appliedFilters:Object.fromEntries(['phaseId','gateId','scopeType','scopeId'].map(k=>[k,params.get(k)])), page };
}

const chainDefinitions = [
  { id:'STORY_CREATION', label:'故事 → 剧本', href:'?view=story&storyMode=logic', stages:[['EPISODE_PLAN','分集剧情设计',['STORY','EPISODE'],'EPISODE_PLANNING'],['STORY_CONFIRMATION','逐场叙事',['SCENE'],'STORY_CONFIRMATION'],['SCENE_COVERAGE','场级镜头意图',['COVERAGE'],'SCENE_COVERAGE']] },
  { id:'WORLD_AND_MATERIALS', label:'剧本 → 素材', href:'?view=materials', stages:[['INITIAL','已定义',['REQUIREMENT','MATERIAL'],'MATERIAL_PREP'],['PRODUCTION_READY','待生成',['EXPECTED_OUTPUT'],'MATERIAL_PREP'],['PENDING_REVIEW','待审阅',['ASSET'],'MATERIAL_PREP'],['APPROVED','已通过',[],'MATERIAL_PREP']] },
  { id:'FULL_PRODUCTION', label:'剧本 + 素材 → 全剧制作', href:'?view=pipeline', stages:[['SHOT_PRODUCTION','镜头制作',['PREPARATION','COVERAGE','SHOT_DESIGN','SHOT','INPUT_LOCK'],'SHOT_PLAN_SET'],['SCENE_EDIT','场景剪辑',['ASSEMBLY'],'GENERATION'],['EPISODE_EDIT','分集成片',['DELIVERABLE'],'GENERATION']] },
];
export async function workflowWorkspace(unit) {
  const model = await unit.blankModel(), snapshotId = await unit.namespace();
  const states = (await unit.tx.query('SELECT o.id,o.kind,o.title,o.state,o.version,' + workStateSql + ' AS work_state FROM objects o WHERE NOT o.historical AND o.kind NOT IN (\'SOURCE\',\'NOTE\',\'GUIDANCE\',\'COMMENT\') ORDER BY o.position,o.id')).rows;
  const episodeRows = await unit.rows(['EPISODE'], { content:false });
  const summaryRows = await unit.rows(['REQUIREMENT','PREPARATION','SHOT_DESIGN'], { content:false });
  const items = [], nodes = [];
  const domains = chainDefinitions.map(chain => {
    const stages = chain.stages.map(([id,label,kinds,workstream]) => {
      const rows = states.filter(row => kinds.includes(row.kind) && !(chain.id==='WORLD_AND_MATERIALS' && row.kind==='ASSET' && row.state==='ADOPTED'));
      if(id==='APPROVED')rows.push(...states.filter(r=>r.kind==='ASSET'&&r.state==='ADOPTED'));
      const count = rows.filter(r=>r.state==='ADOPTED').length;
      const stage = { id,label,count,denominator:null,denominatorState:'UNKNOWN',status:rows.some(r=>r.work_state==='READY')?'ACTIVE':rows.length?'WAITING':'UNKNOWN' };
      nodes.push({ id,label,title:label,href:chain.href,detail:'按已登记对象及其精确依赖查看当前状态；登记数量不作为正式锁定范围。' });
      for(const row of rows.filter(r=>r.state!=='ADOPTED')) {
        const detail = summaryRows.find(r=>r.id===row.id), sceneId=idFor(detail||{},'SCENE');
        const episode=episodeRows.find(ep=>ep.id===row.id||idsFor(ep,'SCENE').includes(sceneId||row.id));
        const href = row.kind==='EPISODE' ? '?view=story&storyMode=logic&episode='+encodeURIComponent(row.id) : row.kind==='SCENE' ? '?view=story&storyMode=audit&scene='+encodeURIComponent(row.id)+'&episode='+encodeURIComponent(episode?.id||'') : chain.id==='WORLD_AND_MATERIALS' ? '?view=materials&material='+encodeURIComponent(row.kind==='MATERIAL'?detail?.id||row.id:row.id) : chain.href+'&preparationScene='+encodeURIComponent(sceneId||'')+'&preparationEpisode='+encodeURIComponent(episode?.id||'');
        const workType=row.state==='SUBMITTED'?'FORMAL_REVIEW':'AUTHORING';
        items.push({actionKey:row.id,targetKey:row.id,workUnitKey:row.id,sourceActionKeys:[row.id],basisHash:String(row.version),ownerModule:chain.id,workstream,materialCreatorStage:chain.id==='WORLD_AND_MATERIALS'?id:undefined,productionGateId:chain.id==='FULL_PRODUCTION'?'SHOT_PLAN_INPUT_LOCK':null,subjectType:row.kind,subjectId:row.id,title:row.title,groupKey:id,lane:'OBJECT',actor:'USER',workState:row.work_state,workType,actionability:row.work_state==='READY'?'ACTIONABLE':'WAITING_DEPENDENCY',requiredAction:workType,currentAssignee:null,progressCapabilities:[{actorGroup:'HUMAN',actorKind:'USER',level:'ADVANCE',availability:'NOW',actionType:workType,label:'人可推进',nextActionText:'在所属工作区核对'}],priorityTier:'SUPPORTING',reasonText:row.state==='SUBMITTED'?'已有待审稿，结合上下文作出判断':'保留当前对象及依据，继续在所属工作区处理',nextActionText:'打开对象并查看依据',reasonCodes:[],impactSummary:{},navigationIntent:{href,label:'打开所属工作区'},advisoryRefs:[],evidenceRefs:[],blockers:[],coordinates:sceneId?{sceneId,episodeUid:episode?.id}:{} });
      }
      return stage;
    });
    const owned=items.filter(i=>i.ownerModule===chain.id);
    const counts={ready:owned.filter(i=>i.workState==='READY').length,inProgress:owned.filter(i=>i.workState==='IN_PROGRESS').length,waiting:owned.filter(i=>i.workState==='WAITING').length,blocked:owned.filter(i=>i.workState==='BLOCKED').length};
    return {id:chain.id,label:chain.label,stages,status:counts.ready?'ACTIVE':counts.blocked?'BLOCKED':'UNKNOWN',counts,headline:'按阶段查看已登记对象',currentGate:'',nextUnlockText:'从所选阶段进入具体对象，核对其当前版本。',navigationIntent:{href:chain.href,label:'打开工作区'}};
  });
  return { definition:{phases:model.productionPhases,gates:model.productionGates}, queue:{snapshotId,items,workspaceSummary:{domains},recommendations:{mainline:null},readOnly:false}, workflow:{nodes,edges:[],modules:[],freshness:{snapshotId,mode:'OBJECT_READ'},preparationWork:null} };
}
