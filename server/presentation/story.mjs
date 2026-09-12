import { hash, check } from '../shared/contracts.mjs';
import {archivedPlan} from './archived-story.mjs';
import { present, idsFor, paragraphs } from './read-unit.mjs';

const unknown = () => ({ class: 'U', text: 'UNKNOWN', evidenceRefs: [] });
export function dossier(value = {}) {
  return { schemaVersion: '1.0', progressionSlices: [], comedyBeats: [], causalChainIds: [], ...value,
    purpose: { episodeTask: unknown(), characterAction: unknown(), expressionFocus: unknown(), ...value.purpose },
    informationLayers: { visibleAction: unknown(), hiddenTruth: unknown(), audiencePosition: unknown(), ...value.informationLayers },
    payoff: { deliveredResult: unknown(), changedState: unknown(), unresolvedQuestions: [], ...value.payoff } };
}
export function sceneRow(row) {
  return { ...present(row), slugline: row.content.slugline || '', oldSceneIds: row.content.historicalSourceSceneIds || [], sourceSegmentIds: [], storyTime: '', viewpoint: '', purpose: '', audienceKnown: '', audienceWithheld: '', transition: '',
    ...row.content, id: row.id, displayId: row.displayId || row.id,
    scriptBlocks: row.content.blocks || (row.content.text ? [{ id: row.id + '-body', type: 'action', text: row.content.text, speaker: '', performanceNote: '' }] : []),
    contentHash: row.content.contentHash || row.sha256,
    runtime: { compactSec: null, baseSec: null, spaciousSec: null, ...row.content.runtime },
    scopeRole: row.historical ? 'HISTORICAL' : 'CURRENT', sceneId: row.id,
  };
}
export async function episodePlan(unit, requested, archive = false) {
  let story = (await unit.rows(['STORY']))[0];
  if (!story) return null;
  if(requested&&(archive||requested!==story.revisionId)){
    const preserved=await archivedPlan(unit,requested);
    if(preserved)return preserved;
  }
  if (requested && requested !== story.revisionId) {
    const old = await unit.detail(story.id, requested);
    // Historical plans use only their exact revision memberships and inputs.
    story = { ...story, content: old.revision.content, revisionId: old.revision.id, sha256: old.revision.sha256, links: old.links };
  }
  const historical = Boolean(requested && requested !== (await unit.rows(['STORY']))[0].revisionId);
  async function exactMembers(parent, kind, ids) {
    if(!historical)return unit.rows([kind],{ids});
    const dependencies=(await unit.tx.query('SELECT r.object_id AS id,r.id AS "revisionId" FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id WHERE d.consumer_revision_id=$1 AND r.object_id=ANY($2::text[])',[parent.revisionId,ids])).rows;
    return Promise.all(ids.map(async id=>{
      const matches=dependencies.filter(d=>d.id===id);
      check(matches.length===1,'HISTORICAL_INPUT_MISSING','历史修订缺少唯一的输入版本，不能套用当前正文',409,{objectId:parent.id,revisionId:parent.revisionId,memberId:id});
      const detail=await unit.detail(id,matches[0].revisionId);
      return {...detail,content:detail.revision.content,revisionId:detail.revision.id,sha256:detail.revision.sha256};
    }));
  }
  const episodeIds = idsFor(story, 'EPISODE');
  const episodes = await exactMembers(story,'EPISODE',episodeIds);
  const ordered = episodeIds.map(id => episodes.find(e => e.id === id)).filter(Boolean);
  const sceneIds = ordered.flatMap(e => idsFor(e, 'SCENE'));
  const sceneRows = historical ? (await Promise.all(ordered.map(ep=>exactMembers(ep,'SCENE',idsFor(ep,'SCENE'))))).flat() : await unit.rows(['SCENE'], {ids:sceneIds});
  const scenes = sceneRows.map(sceneRow);
  const entities = await unit.rows(['ENTITY'], { content: false });
  const support = (await unit.rows(['SOURCE'],{roles:['NARRATIVE_SUPPORT']})).filter(r=>r.content.bindings?.some(b=>b.revisionId===story.revisionId));
  const documents = support.map(r=>{
    check(hash(Buffer.from(r.content.text,'utf8'))===r.content.sha256,'SOURCE_SHA','叙事附文原件 SHA 不符',409);
    const binding=r.content.bindings.find(b=>b.revisionId===story.revisionId);
    return {id:binding.documentId,title:r.title,text:r.content.text,sha256:r.content.sha256,objectId:r.id,revisionId:r.revisionId};
  }).sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
  check(new Set(documents.map(d=>d.id)).size===documents.length,'NARRATIVE_DOCUMENT_CONFLICT','叙事附文存在相同身份的多个依据',409);
  const spec = story.content.reviewSpec || { criteria: (await unit.configuration()).reviewProfiles.find(p => p.id === 'episode-plan')?.criteria || [], criteriaVersion: '1.0' };
  const content = {
    planId: story.id, retiredEpisodeUids: [], changeSummary: story.content.changeSummary || '',
    episodes: ordered.map(row => ({ ...present(row), episodeUid: row.id, displayId: row.displayId || row.id, sceneIds: idsFor(row, 'SCENE'), openingHook: row.content.openingHook || '', coreAdvance: row.content.coreAdvance || '', endingCliffhanger: row.content.endingCliffhanger || '', reviewQuestion: row.content.reviewQuestion || '', reviewDossier: dossier(row.content.reviewDossier), objectState: row.state, adoptedRevisionId: row.adoptedRevisionId })),
    narrativeRevision: { schemaVersion: '1.0', sequences: [], causalChains: [], legacySceneEstimates: [], sourceNarrationIndex: [], retiredSceneIds: [], documents, ...story.content, scenes },
  };
  // State transitions change object versions, not authored text. Comments and
  // readers must remain stable when another review is recorded.
  const contentHash = hash({story:story.sha256,episodes:ordered.map(r=>[r.id,r.sha256,idsFor(r,'SCENE')]),scenes:sceneRows.map(r=>[r.id,r.sha256]),documents:documents.map(d=>[d.id,d.sha256])});
  const presentation = Object.fromEntries(content.episodes.map(ep => {
    const excerpt = edge => {
      const boundary = ep.reviewDossier.boundaryEvidence?.[edge];
      const sceneId = boundary?.sceneId || (edge === 'opening' ? ep.sceneIds[0] : ep.sceneIds.at(-1));
      const scene = scenes.find(s => s.id === sceneId);
      if (!scene) return null;
      return { sceneId, blocks: boundary?.blockIds?.length ? scene.scriptBlocks.filter(b => boundary.blockIds.includes(b.id)) : scene.scriptBlocks };
    };
    return [ep.episodeUid, { opening: excerpt('opening'), ending: excerpt('ending') }];
  }));
  return { readOnly:historical, revisionId: story.revisionId, objectVersion: story.version, sourceRole: story.state === 'ADOPTED' ? 'CURRENT' : 'CANDIDATE', snapshotId: await unit.namespace(), contentHash, contextHash: hash({ contentHash, reviewSpec: spec }), baseRevisionHash: story.content.baseScriptSha256 || story.sha256, criteriaVersion: spec.criteriaVersion || '2.0', basisBindingsHash: unit.version(), subjectNames: Object.fromEntries(entities.map(e => [e.id, e.title])), reviewSpec: spec, content, presentation };
}

export async function sourceCatalog(unit) {
  const rows = (await unit.rows(['SOURCE'],{excludeRoles:['NARRATIVE_SUPPORT','SPATIAL_CATALOG','ARCHIVED_EPISODE_PLAN']}));
  const sources = [];
  for (const row of rows) {
    const original = (await unit.tx.query('SELECT logical_path,mime_type,original_sha256,octet_length(content_bytes) AS bytes FROM source_documents WHERE revision_id=$1', [row.revisionId])).rows[0];
    const textAvailable=row.content.observation!=='ORIGINAL_UNOBSERVED';
    const role = ['PRIMARY','DERIVED','AUXILIARY'].includes(row.content.role) ? row.content.role : row.content.role === 'MACHINE_MODEL_SOURCE' ? 'DERIVED' : 'AUXILIARY';
    sources.push({ ...present(row), role, originalRole: row.content.role, format: original?.mime_type || 'text/plain', sha256: original?.original_sha256 || row.content.sha256 || row.sha256, byteSize: original?.bytes || Buffer.byteLength(row.content.text || ''), documentId: row.id, documentRevisionId: row.revisionId, documentSha256: original?.original_sha256 || row.content.sha256 || row.sha256, aliases: original ? [original.logical_path] : [], textAvailable, status: textAvailable?'TEXT_AVAILABLE':'ORIGINAL_UNOBSERVED', observation: textAvailable?'TEXT_AVAILABLE':'ORIGINAL_UNOBSERVED' });
  }
  return { sources, releaseId: unit.version(), snapshotId: await unit.namespace(), readOnly: false };
}
export async function sourceText(unit, id, revisionId) {
  const row = await unit.detail(id, revisionId);
  const source = (await unit.tx.query('SELECT * FROM source_documents WHERE revision_id=$1', [row.revision.id])).rows[0];
  if (source) check(hash(source.content_bytes) === source.original_sha256, 'SOURCE_SHA', '来源原件 SHA 校验失败', 409);
  const text = source?.content_bytes.toString('utf8') || row.revision.content.text || '';
  return { id, documentId: id, focusId:id, revisionId: row.revision.id, sha256: source?.original_sha256 || row.revision.content.sha256 || row.revision.sha256, contentHash: row.revision.sha256, text, textAvailable: true, mimeType: source?.mime_type || row.revision.content.mimeType || 'text/plain', blocks: paragraphs(text), title: row.title, aliases: source ? [source.logical_path] : [], metadata: row.revision.content, content: { text }, objectVersion: row.version };
}
export async function storySources(unit) {
  const catalog = await sourceCatalog(unit);
  const texts = await Promise.all(catalog.sources.map(s => sourceText(unit, s.id, s.revisionId)));
  // Time-coded paragraphs are identified from the registered document's content,
  // independent of the story title or a machine filesystem path.
  const timed = texts.find(s => /(?:\[|\b)\d{1,2}:\d{2}:\d{2}(?:\]|\b)/.test(s.text));
  const outline = texts.find(s => s !== timed && catalog.sources.find(c => c.id === s.id)?.originalRole === 'SOURCE_DOCUMENT') || texts.find(s => s !== timed);
  const segments = [], sections = [];
  const lines = (timed?.text || '').split('\n');
  let section;
  for (const [i, line] of lines.entries()) {
    if (/^## /.test(line)) {
      const range = line.match(/(\d{2}:\d{2}:\d{2}).*?(\d{2}:\d{2}:\d{2})/);
      section = { id: 'T' + String(sections.length + 1).padStart(2,'0'), title:line.replace(/^#+\s*/,''), startTimecode:range?.[1] || '',endTimecode:range?.[2] || '',segmentCount:0 };
      sections.push(section);
    }
    const match=line.match(/^(?:\*\*)?\[(\d{2}):(\d{2}):(\d{2})\](?:\*\*)?\s*(.*)/);
    if(!match)continue;
    if(!section){section={id:'T01',title:timed.title,startTimecode:match.slice(1,4).join(':'),endTimecode:'',segmentCount:0};sections.push(section);}
    let text=match[4];
    for(let j=i+1;j<lines.length&&!/^(?:#{1,6} |(?:\*\*)?\[\d{2}:\d{2}:\d{2}\])/.test(lines[j]);j++) if(lines[j].trim())text+='\n'+lines[j];
    section.segmentCount++;
    segments.push({id:'TR-'+String(segments.length+1).padStart(3,'0'),sectionId:section.id,timecode:match.slice(1,4).join(':'),seconds:Number(match[1])*3600+Number(match[2])*60+Number(match[3]),text,sourceLine:i+1,characterCount:text.length});
  }
  const recordings=(await unit.tx.query("SELECT sha256,mime_type,byte_size AS bytes,evidence FROM media WHERE mime_type LIKE 'audio/%' AND availability='PRESENT' AND evidence->>'sourceRole'='SOURCE_DOCUMENT' AND evidence->>'evidenceOnly'='true' ORDER BY id")).rows;
  const recording=recordings.length===1?recordings[0]:null;
  return { evidenceOrder:(await unit.configuration()).sources.order.map(s=>s.label),
    audio:recording?{...recording.evidence,audioUrl:'/api/v1/media/'+recording.sha256,byteSize:Number(recording.bytes)}:{title:'原始录音未唯一登记',audioUrl:'',byteSize:0,duration:'UNKNOWN',reviewUse:'尚无可唯一绑定的录音；未自动选择同名或相邻媒体。'},
    transcript:{title:timed?.title||'逐字稿',sourcePath:timed?.aliases[0]||'',payloadCharacterCount:segments.reduce((sum,s)=>sum+s.text.length,0),segmentCount:segments.length,sections,segments,introBlocks:paragraphs((timed?.text||'').split(/^## /m)[0]),rawMarkdown:timed?.text||'',sha256:timed?.sha256},
    outline:{title:outline?.title||'辅助来源',sourcePath:outline?.aliases[0]||'',blocks:paragraphs(outline?.text),rawMarkdown:outline?.text||''} };

}

export async function bootstrap(unit) {
  const model = await unit.blankModel(), snapshotId = await unit.namespace();
  const episodes = await unit.rows(['EPISODE'], { content: false });
  const scenes = await unit.rows(['SCENE'], { content: false });
  const sceneIndex = scenes.map(row => ({ ...sceneRow(row), scriptBlocks: [], number: row.position + 1, phaseId: '', shotRefs: [], assetRefs: [], episodeAssignment: { episodeUid: episodes.find(e => idsFor(e, 'SCENE').includes(row.id))?.id || '' } }));
  const episodeIndex = episodes.map(e => ({ ...present(e), id: e.id, episodeUid: e.id, canonicalScopeId: e.id, sceneIds: idsFor(e, 'SCENE'), label: e.title, status: e.state === 'ADOPTED' ? 'CURRENT' : 'PROPOSED', scopeRole: 'CURRENT' }));
  model.scenes = sceneIndex; model.episodes = episodeIndex;
  const counts = (await unit.tx.query('SELECT kind,count(*)::integer AS count FROM objects WHERE NOT historical GROUP BY kind')).rows;
  const count = kind => counts.find(c => c.kind === kind)?.count || 0;
  model.counts = { scenes: scenes.length, episodes: episodes.length, shots: count('SHOT'), requiredMaterialRequirements: count('REQUIREMENT'), assetFamilies: count('MATERIAL'), assetVersions: count('ASSET') };
  const story = (await unit.rows(['STORY']))[0];
  if(!story||story.content.authoringRootId)model.genericAuthoring={enabled:true};
  return { schemaVersion: '1.0', snapshotId, snapshotDate: new Date().toISOString().slice(0,10), instance: await unit.profile(),
    scope: { storyScenes: scenes.length, episodeCount: episodes.length, formalEpisodeDenominatorState: 'UNKNOWN', formalEpisodeDenominator: null },
    sources: {}, sourceHashes: {}, coverage: {}, unknowns: [], statusModel: { version: '2.0' },
    storySources: { evidenceOrder: [], audio: null, transcript: { sections: [], segments: [], introBlocks: [], rawMarkdown: '' }, outline: { blocks: [], rawMarkdown: '' } },
    adaptationAudit: { beats: [], canonicalStories: [], setupPayoffChains: [], sceneAudits: [], asrIssues: [], productionImpacts: [] }, storyRewrite: {}, characterPerformance: {},
    actionQueueInputs: { rewrittenSceneConfirmations: [], sceneReviewDossiers: [], audioVerifications: [], materialPreparation: [] },
    creativeLineage: { scenes: sceneIndex, episodes: episodeIndex, phases: [], causalChains: story?.content.causalChains || [], spatialEvidence: { mapCards: [], locations: [], locationPackages: [], sceneRouteLocks: [] }, globalBaselineAssetRefs: [], scriptDocument: { rawMarkdown: '', blocks: [] }, storyStructure: { sequences: story?.content.sequences || [], planStatus: 'CURRENT', sourceSha256: story?.sha256 || hash('empty') }, storyOverview: null, coverage: {} },
    productionModel: model, executionRecipeSummary: { executionDocuments: [], executionDefinitions: [], evidenceOnlyDefinitions: [], promptRevisions: [], sceneTimelines: [], postProductionTasks: [], sourceCatalog: [] },
    workItems: [], visualAssets: [], audioAssets: [], shots: [], p07: { storyboards: [], scenes: [], contactSheets: [], materializedCount: 0, releasedCount: 0 }, outputArtifacts: [],
  };
}
