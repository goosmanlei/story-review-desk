import {candidateDirectory} from './candidates.mjs';
import {spatialCatalog} from '../production/spatial-views.mjs';
import { present, idsFor, idFor, stateLabel } from './read-unit.mjs';
import { spatialBaseline } from '../workspaces.mjs';
import { hash } from '../shared/contracts.mjs';
import { materialOccurrences } from './material-occurrences.mjs';
import { workspaceDraft } from '../workspace-drafts.mjs';

export function assetReviewContextHash(version,requirements){return hash({version:version.revisionId,sha256:version.sha256,requirements:requirements.filter(r=>r.assetFamilyRefs.includes(version.familyId)).map(r=>[r.id,r.revisionId,r.reviewSpec?.hash]),rights:version.projectRightsGate});}

export async function materialRows(unit, { requirementId } = {}) {
  const rows = await unit.rows(['REQUIREMENT'], { ids: requirementId ? [requirementId] : undefined });
  const occurrences = await materialOccurrences(unit);
  const usages=(await unit.tx.query(`SELECT n.id,r.id AS revision_id,r.content,rv.id AS event_id,
    EXISTS(SELECT 1 FROM invalidations i WHERE i.consumer_revision_id=r.id) AS stale,
    EXISTS(SELECT 1 FROM objects a JOIN rights rt ON rt.revision_id=a.adopted_revision_id
      JOIN asset_media am ON am.revision_id=a.adopted_revision_id AND am.role='OUTPUT'
      JOIN media m ON m.id=am.media_id AND m.version_id=am.media_version_id
      WHERE a.id=r.content#>>'{target,versionId}' AND a.state='ADOPTED' AND am.sha256=r.content#>>'{target,sha256}'
      AND m.availability='PRESENT' AND NOT EXISTS(SELECT 1 FROM invalidations si WHERE si.consumer_revision_id=a.adopted_revision_id) AND (rt.fact='CLEAR' OR rt.fact='UNKNOWN' AND rt.internal_attestation)) AS source_eligible
    FROM objects n JOIN revisions r ON r.id=n.adopted_revision_id
    LEFT JOIN LATERAL(SELECT id FROM reviews WHERE object_id=n.id AND revision_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1)rv ON true
    WHERE n.kind='NOTE' AND n.state NOT IN ('DISABLED','ARCHIVED','CHANGES_REQUESTED') AND r.content->>'role'='MATERIAL_USAGE_REVIEW'`)).rows;
  const usageInputs=usages.length?(await unit.tx.query("SELECT consumer_revision_id,dependency_revision_id FROM dependencies WHERE consumer_revision_id=ANY($1::text[]) AND purpose='DEFINITION'",[usages.map(u=>u.revision_id)])).rows:[];
  const bindingFor=(row)=>usages.filter(u=>u.content.target.requirementId===row.id).map(u=>{const eligible=!u.stale&&u.source_eligible&&usageInputs.some(d=>d.consumer_revision_id===u.revision_id&&d.dependency_revision_id===row.revisionId);return {...u.content.target,usageId:u.id,eventId:u.event_id,usageRevisionId:u.revision_id,usageContextHash:u.content.basisHash,reviewSpecHash:u.content.reviewSpec.hash,eligible,reasons:eligible?[]:['用途依据、原版本采用状态或媒体已改变']};});
  return rows.map(row => ({
    requirementClass: 'REQUIRED', mediaKind: row.content.mediaType || 'UNKNOWN', category: '', reuseScope: 'PROJECT', storyBasis: {}, storyApplicability: {}, acceptanceCriteria: [], acceptanceProfile: '',
    currentShotIds: [], historicalShotIds: [], shotIds: [], episodeIds: [], episodeUids: [], structureCardRefs: [], consumerWorkItemRefs: [], coverageReasons: [], coveredByFamilyRefs: [], coveredByVersionRefs: [], coverageSatisfied: false, bindingStale: false,
    ...present(row), ...(row.content.configurationBinding?{configurationBinding:Object.fromEntries(Object.entries(row.content.configurationBinding).filter(([key])=>key!=='workflow'))}:{}), sceneIds: idsFor(row, 'SCENE'), assetFamilyRefs: idsFor(row, 'FAMILY'), entityRef: idFor(row, 'ENTITY'), representationRef: idFor(row, 'REPRESENTATION'),
    requirementHash: row.content.requirementHash || row.sha256,
    episodeUids: [...new Set([...(row.content.episodeUids || []), ...occurrences.scenes.filter(s => s.references.some(r => r.requirementId === row.id)).map(s => s.episodeUid).filter(Boolean)])],
    materialUsageBindings:bindingFor(row),coverageSatisfied:bindingFor(row).some(b=>b.eligible),coveredByFamilyRefs:bindingFor(row).filter(b=>b.eligible).map(b=>b.familyId),coveredByVersionRefs:bindingFor(row).filter(b=>b.eligible).map(b=>b.versionId),
  }));
}

export async function assets(unit, familyIds) {
  const families = await unit.rows(['MATERIAL'], { ids: familyIds });
  const rows = await unit.rows(['ASSET'], { historical: true }),expectations=await unit.rows(['EXPECTED_OUTPUT']);
  const allowed = new Set(families.map(f => f.id));
  const relationships = (await unit.tx.query('SELECT object_id AS id,family_id AS "familyId",parent_asset_id AS "parentAssetId" FROM asset_versions')).rows;
  const media = (await unit.tx.query('SELECT a.revision_id AS "revisionId",a.role,m.* FROM asset_media a JOIN media m ON m.id=a.media_id AND m.version_id=a.media_version_id ORDER BY (a.role=\'OUTPUT\') DESC')).rows;
  const adopted = (await unit.tx.query('SELECT object_id AS id,adopted_asset_id AS "adoptedAssetId" FROM material_families')).rows;
  const rights=(await unit.tx.query('SELECT * FROM rights')).rows;
  const stale=new Set((await unit.tx.query('SELECT DISTINCT consumer_revision_id FROM invalidations')).rows.map(r=>r.consumer_revision_id));
  const versions = rows.flatMap(row => {
    const relation = relationships.find(r => r.id === row.id);
    if (!relation || !allowed.has(relation.familyId)) return [];
    const file = media.find(m => m.revisionId === row.revisionId && m.role === 'OUTPUT');
    const preview = media.find(m => m.revisionId === row.revisionId && m.role === 'PREVIEW' && m.availability === 'PRESENT');
    const right=rights.find(r=>r.revision_id===row.revisionId),rightsAllowed=right?.fact==='CLEAR'||right?.fact!=='BLOCKED'&&right?.internal_attestation===true;
    const lifecycle=row.state==='DRAFT'||row.state==='SUBMITTED'?'REVIEW_PENDING':stateLabel(row.state);
    return [{ ...present(row), familyId: relation.familyId, parentVersionId: relation.parentAssetId, label: row.content.label || row.title,
      path: file?.original_path || row.content.path || null, sha256: file?.sha256 || row.content.sha256 || null,
      mediaUrl: file?.availability === 'PRESENT' ? '/api/v1/media/' + file.sha256 : null,
      mediaToken: file?.sha256 || null, preview: preview ? '/api/v1/media/' + preview.sha256 : file?.mime_type.startsWith('image/') && file.availability === 'PRESENT' ? '/api/v1/media/' + file.sha256 : null,
      mediaKind: file?.mime_type.startsWith('audio/') ? 'AUDIO' : file?.mime_type.startsWith('video/') ? 'VIDEO' : file?.mime_type.startsWith('image/') ? 'IMAGE' : 'TEXT',
      outputState: file?.availability || row.content.outputState || 'MISSING', bytes: file ? Number(file.byte_size) : null,
      reviewDecision: stateLabel(row.state), lifecycleState: lifecycle,
      historyRole: row.historical ? 'HISTORICAL' : row.content.historyRole || 'CURRENT', rightsWarning: right?.fact||'UNKNOWN', projectRightsGate:right?.fact==='CLEAR'?'CLEAR':right?.fact==='BLOCKED'?'BLOCKED':right?.internal_attestation?'PROJECT_INTERNAL_CONFIRMED':'UNKNOWN',
      rightsFact:right?.fact||'UNKNOWN',internalAttestation:right?.internal_attestation===true,canFlowDownstream:row.state==='ADOPTED'&&row.adoptedRevisionId===row.revisionId&&file?.availability==='PRESENT'&&rightsAllowed&&!stale.has(row.revisionId),
      flowBlockReasons: [...(stale.has(row.revisionId)?['EXACT_INPUT_CHANGED']:[]),...(file?.availability!=='PRESENT'?['MEDIA_UNAVAILABLE']:[]),...(!rightsAllowed?['RIGHTS_UNKNOWN_OR_BLOCKED']:[]),...(row.state!=='ADOPTED'?['VERSION_NOT_ADOPTED']:[])],
    }];
  });
  return { assetVersions: versions, assetFamilies: families.map(row => {
    const owned = versions.filter(v => v.familyId === row.id), adoptedId = adopted.find(f => f.id === row.id)?.adoptedAssetId;
    const outputs=expectations.filter(o=>idFor(o,'FAMILY')===row.id),planned=outputs.filter(o=>o.content.expectationState==='PLANNED').sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))[0];
    return { ...present(row), label: row.content.label || row.title, kind: row.content.kind || owned[0]?.mediaKind || 'UNKNOWN', versionRefs: owned.map(v => v.id), currentVersionRef: adoptedId || owned.filter(v => v.historyRole !== 'HISTORICAL').at(-1)?.id || owned.at(-1)?.id || null,
      expectedOutputRefs:outputs.map(o=>o.id),nextExpectedOutputId:planned?.id||null,currentExpectedOutputId:adoptedId?null:planned?.id||null,
      adoptedVersionRef: adoptedId || null, currentVersionId: adoptedId || null, sceneIds: idsFor(row,'SCENE'), shotIds: idsFor(row,'SHOT'), episodeIds: row.content.episodeIds || [], usedByRefs: row.content.usedByRefs || [], flowBlockReasons: row.content.flowBlockReasons || [],
    };
  }) };
}

export async function domainWorkspace(unit, owner = 'SETTINGS') {
  const rows = await unit.rows(['ENTITY','STATE','REPRESENTATION','RELATION','REQUIREMENT']);
  const relations = (await unit.tx.query('SELECT object_id AS id,from_id AS "fromId",to_id AS "toId" FROM entity_relations')).rows;
  const kindById = new Map(rows.map(r => [r.id, r.kind]));
  const graph = { schemaVersion: '1.0', entities: [], states: [], representations: [], relations: [], requirements: [] };
  const collectionByKind = { ENTITY:'entities', STATE:'states', REPRESENTATION:'representations', RELATION:'relations', REQUIREMENT:'requirements' };
  const ownership = {};
  for (const row of rows) {
    const collection = collectionByKind[row.kind];
    const editable=present(row);for(const key of ['configurationBinding','reviewSpec','storyBasis'])delete editable[key];
    const record = { aliases: [], evidence: [], scope: [], dimensions: {}, authority: 'U', ...editable };
    if (row.kind === 'ENTITY') { record.name = row.content.name || row.title; record.type = row.content.type || 'UNRESOLVED'; record.description ||= ''; }
    if (['STATE','REPRESENTATION'].includes(row.kind)) { record.entityId = idFor(row,'ENTITY'); record.stateId = idFor(row,'STATE'); record.label = row.content.label || row.title; }
    if (row.kind === 'REPRESENTATION') { record.requirementIds = idsFor(row,'REQUIREMENT'); record.assetFamilyIds = idsFor(row,'FAMILY'); }
    if (row.kind === 'REQUIREMENT') { record.representationId = idFor(row,'REPRESENTATION'); record.acceptanceCriteria ||= []; record.mediaType ||= row.content.mediaKind || 'UNKNOWN'; }
    if (row.kind === 'RELATION') {
      const edge = relations.find(r => r.id === row.id);
      record.from = { kind: kindById.get(edge?.fromId) || 'ENTITY', id: edge?.fromId };
      record.to = { kind: kindById.get(edge?.toId) || 'ENTITY', id: edge?.toId };
      record.inherit ||= []; record.exclude ||= []; record.purpose ||= ''; record.label ||= row.title;
    }
    graph[collection].push(record);
    const rowOwner = row.kind === 'ENTITY' || row.kind === 'RELATION' && record.from.kind === 'ENTITY' && record.to.kind === 'ENTITY' ? 'SETTINGS' : 'MATERIAL';
    ownership[collection + ':' + row.id] = { owner: rowOwner, reason: '由登记对象类型和精确关联确定维护入口', recordHash: hash(record), expectedVersion: row.version, revisionId: row.revisionId };
  }
  const baseline = await spatialBaseline(unit.tx);
  const spec = baseline.specification,catalog=await spatialCatalog(unit);
  const spatial = spec ? { version: spec.version, orientation: spec.orientation, sourceRef: baseline.sourceBinding.logicalPath, sourceSha256: baseline.sourceBinding.sha256, locations: catalog.locations, locationPackages: catalog.locations.map(value=>({...value,locationId:value.id})), mapCards: [], sceneRouteLocks: spec.scene_route_locks || [] } : null;
  const material = await assets(unit);
  const businessFacts = {}, locationVisuals = {};
  for (const entity of graph.entities) {
    const representations = graph.representations.filter(r => r.entityId === entity.id);
    businessFacts[entity.id] = { entityId: entity.id, type: entity.type, summary: entity.description, aliases: entity.aliases, stateCount: graph.states.filter(s => s.entityId === entity.id).length, representationCount: representations.length, requirementCount: representations.flatMap(r => r.requirementIds).length, mediaCounts: {}, members: [], relations: graph.relations.filter(r => r.from.id === entity.id || r.to.id === entity.id).map(r => { const id = r.from.id === entity.id ? r.to.id : r.from.id; return { ...r, entityId: id, name: graph.entities.find(e => e.id === id)?.name || id }; }) };
    if (entity.type === 'LOCATION') locationVisuals[entity.id] = representations.flatMap(rep => rep.assetFamilyIds.map(familyId => {
      const family = material.assetFamilies.find(f => f.id === familyId), version = material.assetVersions.find(v => v.id === family?.currentVersionRef && v.mediaKind === 'IMAGE' && v.outputState === 'PRESENT');
      return { entityId: entity.id, representationId: rep.id, stateId: rep.stateId, type: rep.type, label: rep.label, dimensions: rep.dimensions, authority: rep.authority, association: 'DIRECT', compositeName: null, familyId, version: version ? { ...version, imageUrl: version.mediaUrl, previewUrl: version.preview } : null };
    }));
  }
  const requirements = await materialRows(unit);
  const savedDraft=await workspaceDraft(unit.tx,'domain:'+owner);
  return { owner, snapshotId: await unit.namespace(), releaseId: unit.version(), revisionId: unit.version(), readOnly: false, graph, ownership, configuration: (await unit.configuration()).domain, spatial, businessFacts, locationVisuals,
    requirements: requirements.map(r => ({ ...Object.fromEntries(Object.entries(r).filter(([k])=>!['configurationBinding','reviewSpec','storyBasis','evidence','sourceBindings','domainContext','structureCardRefs'].includes(k))), scopeBindings: [], entityRef: r.entityRef || graph.representations.find(rep => rep.requirementIds.includes(r.id))?.entityId, representationRef: r.representationRef || graph.representations.find(rep => rep.requirementIds.includes(r.id))?.id })),
    context: { candidateRevisionId: (await unit.rows(['STORY']))[0]?.revisionId || null, currentEpisodePlanRevisionId: null }, counts: Object.fromEntries(Object.entries(graph).filter(([,v]) => Array.isArray(v)).map(([k,v]) => [k,v.length])), uncertainCount: 0, draft: savedDraft?.content.status==='DRAFT'?{...savedDraft.content,revisionId:savedDraft.revisionId}:null, draftHeadRevisionId: savedDraft?.revisionId||null, legacyDrafts: [],
  };
}

export async function materialDirectory(unit, compact=false) {
  const workspace = await domainWorkspace(unit, 'MATERIAL');
  const bindings = workspace.requirements.map(r => {
    const representation = workspace.graph.representations.find(rep => rep.id === r.representationRef || rep.requirementIds.includes(r.id));
    return { requirementId: r.id, entityId: r.entityRef || representation?.entityId || 'UNASSIGNED', stateId: representation?.stateId || 'BASE', representationId: representation?.id, reviewFocus: { points: r.acceptanceCriteria.map(label => ({ label })) } };
  });
  return { snapshotId: workspace.snapshotId, releaseId: workspace.releaseId, revisionId: workspace.revisionId, ...(compact?{}:{graph: workspace.graph}), bindings, trials: await candidateDirectory(unit,workspace.graph), staleIds: [] };
}
