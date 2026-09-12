/** Disposable catalogue of production outputs. Work products and asset versions
 * remain the only producers and review/adoption authorities. No domain entity,
 * representation, material requirement or asset is created by this projection. */
const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(list(values).filter(value => typeof value === 'string' && value))];
const current = row => row && row.activeInCurrentProduction === true && !['HISTORICAL','EVIDENCE_ONLY','PROPOSAL'].includes(row.scopeRole) && !['HISTORICAL_EVIDENCE','MATERIAL_COMPATIBILITY','PLANNING_SKELETON'].includes(row.activityRole) && row.historyRole !== 'EVIDENCE_ONLY' && row.templateOnly !== true;

export const productionMaterialKinds = Object.freeze([
  {id:'INPUT_LOCK',label:'输入锁定记录',mediaType:'TEXT'},
  {id:'STORYBOARD',label:'粗分镜',mediaType:'IMAGE'},
  {id:'TEMP_DIALOGUE',label:'临时对白',mediaType:'AUDIO'},
  {id:'DIALOGUE',label:'正式对白',mediaType:'AUDIO'},
  {id:'ANIMATIC',label:'Animatic',mediaType:'VIDEO'},
  {id:'START_FRAME',label:'首帧',mediaType:'IMAGE'},
  {id:'END_FRAME',label:'尾帧',mediaType:'IMAGE'},
  {id:'MIDDLE_FRAME',label:'中间关键帧',mediaType:'IMAGE'},
  {id:'KEYFRAME_SET',label:'关键帧集合',mediaType:'TEXT'},
  {id:'SHOT_VIDEO',label:'镜头视频',mediaType:'VIDEO'},
  {id:'LOCKED_SHOT',label:'单镜锁定',mediaType:'VIDEO'},
  {id:'OTHER',label:'其他制作产物',mediaType:'UNKNOWN'},
]);
const aliases = {
  SHOT_INPUT_LOCK:'INPUT_LOCK',
  STORYBOARD:'STORYBOARD',SB:'STORYBOARD',STORYBOARD_IMAGE:'STORYBOARD',
  TEMP_DIALOGUE:'TEMP_DIALOGUE',DIALOGUE_TEMP:'TEMP_DIALOGUE',DIALOGUE_SCRATCH:'TEMP_DIALOGUE',
  DIALOGUE_DRY:'DIALOGUE',DIALOGUE:'DIALOGUE',FINAL_DIALOGUE:'DIALOGUE',
  ANIMATIC:'ANIMATIC',ANIMATIC_TIMING_LOCK:'ANIMATIC',
  START_FRAME:'START_FRAME',END_FRAME:'END_FRAME',MIDDLE_FRAME:'MIDDLE_FRAME',INTERMEDIATE_FRAME:'MIDDLE_FRAME',
  SHOT_KEYFRAME_SET:'KEYFRAME_SET',KEYFRAME_SET:'KEYFRAME_SET',
  SHOT_VIDEO:'SHOT_VIDEO',MOTION_VIDEO:'SHOT_VIDEO',PRE_LIP_VIDEO:'SHOT_VIDEO',AUDIO_DRIVEN_VIDEO:'SHOT_VIDEO',NO_LIP_VIDEO:'SHOT_VIDEO',
  LOCKED_SHOT:'LOCKED_SHOT',POST_LIP_VIDEO:'LOCKED_SHOT',
};

export function overlayProductionMaterialModel(model, projection = {}) {
  const result = {...model};
  for (const name of ['workItems','workPackages','assetFamilies','assetVersions','expectedOutputs']) {
    const byId = new Map(list(model[name]).map(row => [row.id,row]));
    for (const [id,row] of Object.entries(projection[name+'ById'] || {})) {
      if (!row || typeof row !== 'object') continue;
      // Identity cannot be moved by a disposable status projection.
      const before = byId.get(id);
      if (row.id && row.id !== id || before?.familyId && row.familyId && before.familyId !== row.familyId) continue;
      byId.set(id,{...before,...row,id});
    }
    result[name] = [...byId.values()];
  }
  return result;
}

export function projectProductionMaterials(sourceModel, projection = {}) {
  const model = overlayProductionMaterialModel(sourceModel,projection), issues = [], rows = [];
  const items = list(model.workItems).filter(current), packages = list(model.workPackages), families = list(model.assetFamilies);
  const byVersion = new Map(list(model.assetVersions).map(row => [row.id,row]));
  const byExpected = new Map(list(model.expectedOutputs).map(row => [row.id,row]));
  for (const family of families) {
    const producers = items.filter(item => item.outputAssetRef === family.id || list(item.additionalOutputAssetRefs).includes(family.id));
    if (!producers.length) continue;
    const reject = code => issues.push({familyId:family.id,code});
    if (producers.length !== 1 || families.filter(row=>row.id===family.id).length !== 1) { reject('AMBIGUOUS_PRODUCER'); continue; }
    const item = producers[0];
    if (family.ownerRef && family.ownerRef !== item.id) { reject('PRODUCER_OWNER_CONFLICT'); continue; }
    if (['HISTORICAL','EVIDENCE_ONLY'].includes(family.scopeRole) || ['EVIDENCE_ONLY','DELETED_AUDIT'].includes(family.historyRole) || family.mediaRetirement) continue;
    const parents = packages.filter(row=>list(row.workItemIds).includes(item.id) || list(row.workItemRefs).includes(item.id));
    if (parents.length !== 1) { reject('WORK_PACKAGE_NOT_UNIQUE'); continue; }
    const parent = parents[0];
    if (parent.activeInCurrentProduction === false || ['HISTORICAL','EVIDENCE_ONLY'].includes(parent.scopeRole)) { reject('WORK_PACKAGE_NOT_CURRENT'); continue; }
    const scope = ['SHOT','SCENE','EPISODE','PROJECT'].includes(item.scopeType) ? item : parent;
    if (!['SHOT','SCENE','EPISODE','PROJECT'].includes(scope.scopeType) || !scope.scopeId) { reject('BUSINESS_SCOPE_UNKNOWN'); continue; }
    const ownerShot = scope.scopeType === 'SHOT' ? list(model.shots).find(row=>row.id===scope.scopeId) : null;
    if (scope.scopeType === 'SHOT' && !ownerShot) { reject('SHOT_OWNER_MISSING'); continue; }
    const scopeOwner = {type:scope.scopeType,id:scope.scopeId,revisionId:scope.scopeRevisionId || scope.shotProductionRevisionId || scope.sourceRevisionId || scope.shotPlanSetRevisionId || ownerShot?.shotPlanSetRevisionId || parent.scopeRevisionId || null};
    const versionIds = unique(family.versionRefs).filter(id=>byVersion.get(id)?.familyId===family.id);
    const currentVersionId = family.currentVersionId || null;
    if (currentVersionId && (!versionIds.includes(currentVersionId) || !byVersion.get(currentVersionId))) { reject('CURRENT_VERSION_BINDING_INVALID'); continue; }
    const currentVersion = currentVersionId ? byVersion.get(currentVersionId) : null;
    const expectedOutputIds = unique(family.expectedOutputRefs).filter(id=>byExpected.get(id)?.familyId===family.id);
    const currentExpectedOutputId = family.currentExpectedOutputId || null;
    if (currentVersionId && currentExpectedOutputId || currentExpectedOutputId && !expectedOutputIds.includes(currentExpectedOutputId)) { reject('EXPECTED_OUTPUT_BINDING_INVALID'); continue; }
    const expected = currentExpectedOutputId ? byExpected.get(currentExpectedOutputId) : null;
    const primary = item.outputAssetRef === family.id;
    const deliverableKey = family.deliverableKey || expected?.deliverableKey || (primary ? item.deliverableKey : null) || null;
    const usageRole = family.usageRole || item.productionPurpose || item.usageRole || null;
    let kind = aliases[deliverableKey] || 'OTHER';
    if (kind === 'DIALOGUE' && ['TEMPORARY','SCRATCH','TEMP'].includes(usageRole)) kind = 'TEMP_DIALOGUE';
    const definition = productionMaterialKinds.find(row=>row.id===kind);
    const explicitMediaType = [family.mediaType,expected?.mediaType,currentVersion?.mediaType,item.mediaType,family.kind].find(value=>['IMAGE','AUDIO','VIDEO','TEXT'].includes(value));
    const shotIds = unique(scopeOwner.type === 'SHOT' ? [scopeOwner.id] : [...list(parent.shotIds),...list(family.shotIds)]);
    const sceneIds = unique([scopeOwner.type === 'SCENE' ? scopeOwner.id : null,item.sceneId,parent.sceneId,ownerShot?.sceneId,...list(family.sceneIds)]);
    const episodeUids = unique([scopeOwner.type === 'EPISODE' ? scopeOwner.id : null,item.episodeUid,parent.episodeUid,ownerShot?.episodeUid,...list(family.episodeUids)]);
    const inputBindings = list(currentVersion?.inputVersionBindings);
    const consumers = list(model.workItems).filter(current).filter(row=>list(row.inputAssetRefs).includes(family.id));
    const actualConsumers = list(model.assetVersions).flatMap(version=>list(version.inputVersionBindings).flatMap(binding=>{
      const id = binding.versionId || binding.assetVersionRef, source = byVersion.get(id);
      return source?.familyId===family.id && source.sha256 && binding.sha256===source.sha256 ? [{familyId:version.familyId,versionId:version.id,inputVersionId:id,sha256:binding.sha256}] : [];
    }));
    const presentVersionIds = versionIds.filter(id=>{const version=byVersion.get(id);return version.path && /^[a-f0-9]{64}$/i.test(version.sha256||'') && !version.mediaRetirement && !['DELETED_AUDIT','EVIDENCE_ONLY'].includes(version.historyRole);});
    rows.push({id:family.id,familyId:family.id,title:family.label || family.id,workItemId:item.id,workPackageId:parent.id,producerOwnerRef:family.ownerRef || null,scopeOwner,
      kind,kindLabel:definition.label,mediaType:explicitMediaType || definition.mediaType,deliverableKey,usageRole,
      gateId:item.gateId || parent.gateId || null,phaseId:item.phaseId || parent.phaseId || null,episodeUids,sceneIds,shotIds,
      currentVersionId,currentExpectedOutputId,versionIds,expectedOutputIds,presentVersionIds,
      lifecycleState:currentVersion?.lifecycleState || family.lifecycleState || item.lifecycleState || 'UNKNOWN',
      canFlowDownstream:currentVersion?.canFlowDownstream===true,flowBlockReasons:unique([...(currentVersion?.flowBlockReasons||[]),...(item.flowBlockReasons||[])]),
      inputFamilyIds:unique(item.inputAssetRefs),inputVersionBindings:inputBindings,declaredConsumerWorkItemIds:consumers.map(row=>row.id),actualConsumers,
      materialRequirementIds:unique(family.materialRequirementRefs),sourceRef:family.sourceRef || item.sourceRef || null,
      outputState:currentVersion?.path && currentVersion.sha256 ? 'PRESENT' : presentVersionIds.length ? 'CANDIDATES' : 'NOT_PRODUCED'});
  }
  rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return {schemaVersion:'1.0',rows,issues};
}

export function filterProductionMaterials(rows, filters = {}) {
  const query = String(filters.search || '').trim().toLocaleLowerCase();
  return rows.filter(row=>(!filters.familyId || row.familyId===filters.familyId) && (!filters.workItemId || row.workItemId===filters.workItemId)
    && (!filters.kind || row.kind===filters.kind) && (!filters.mediaType || row.mediaType===filters.mediaType)
    && (!filters.lifecycleState || row.lifecycleState===filters.lifecycleState) && (!filters.gateId || row.gateId===filters.gateId)
    && (!filters.episodeUid || row.episodeUids.includes(filters.episodeUid)) && (!filters.sceneId || row.sceneIds.includes(filters.sceneId))
    && (!filters.shotId || row.shotIds.includes(filters.shotId))
    && (!query || [row.id,row.title,row.kindLabel,row.workItemId,row.scopeOwner.id,...row.episodeUids,...row.sceneIds,...row.shotIds].join(' ').toLocaleLowerCase().includes(query)));
}

export function productionMaterialLocation(row, versionId = null) {
  const query = new URLSearchParams({view:'materials',materialCatalog:'production',productionMaterial:row.familyId});
  if (versionId) query.set('productionMaterialVersion',versionId);
  return '/?'+query.toString();
}
