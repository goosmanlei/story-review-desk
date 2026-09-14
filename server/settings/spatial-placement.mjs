import {check, identity, expectedVersion, ReviewError} from '../shared/contracts.mjs';
import {PresentationRead} from '../presentation/read-unit.mjs';
import {spatialBaseline} from '../workspaces.mjs';
import {
  SPATIAL_PLACEMENT_ROLE, SpatialPlacementError, validateSpatialPlacementDraft,
  assessSpatialPlacementDraft, spatialPlacementReferences, projectSpatialPlacements,
} from '../../web/presentation/spatial-placement.mjs';

// Catalog selection must be serialized with every SOURCE mutation, including a
// newly created source (which has no row to lock yet). Object CAS locks still
// protect NOTE, location and scene versions individually.
export const SPATIAL_PLACEMENT_CATALOG_LOCK = '!spatial-placement-source-catalog';
const authorizedSaves = new WeakSet();
export const isSpatialPlacement = content => content?.role === SPATIAL_PLACEMENT_ROLE;
const ref = row => ({id:row.id,revisionId:row.revisionId,sha256:row.sha256,expectedVersion:row.version});
const inactive = row => row.historical || ['ARCHIVED','DISABLED'].includes(row.state);
function contract(fn) {
  try { return fn(); } catch (error) {
    if (error instanceof SpatialPlacementError) throw new ReviewError(error.code,error.message,error.status,{path:error.path});
    throw error;
  }
}
function stored(content) {
  check(isSpatialPlacement(content) && Object.keys(content).every(k=>['role','placement','reviewSpec'].includes(k)),
    'SPATIAL_PLACEMENT_ENVELOPE','空间提案须使用 NOTE 外壳，审阅元数据不能写入严格提案正文');
  return contract(()=>validateSpatialPlacementDraft(content.placement));
}

/** Only planner-created command objects are capabilities; JSON flags grant none. */
export async function guardSpatialPlacementSave(tx, command, kind, previous) {
  const wasPlacement = kind==='NOTE' && (await tx.query("SELECT 1 FROM revisions WHERE object_id=$1 AND content->>'role'=$2 LIMIT 1",[command.id,SPATIAL_PLACEMENT_ROLE])).rowCount;
  if (!isSpatialPlacement(command.content) && !isSpatialPlacement(previous) && !wasPlacement) return;
  check(kind==='NOTE' && authorizedSaves.has(command),'SPATIAL_PLACEMENT_PLANNER_REQUIRED',
    '空间待确认 NOTE 只能通过空间提案工作区保存',403);
  check(!previous || isSpatialPlacement(previous),'SPATIAL_PLACEMENT_IDENTITY','不能把其他记录改为空间提案',409);
  const value=stored(command.content);
  if(previous) contract(()=>validateSpatialPlacementDraft(value,{previous:stored(previous)}));
}
export async function guardSpatialPlacementAction(tx, object) {
  if (!object) return;
  const rows=await tx.query("SELECT 1 FROM revisions WHERE object_id=$1 AND content->>'role'=$2 LIMIT 1",[object.id,SPATIAL_PLACEMENT_ROLE]);
  check(!rows.rowCount,'SPATIAL_PLACEMENT_DRAFT_ONLY','空间待确认 NOTE 只保存提案草稿，不能提交、采用、禁用或归档',409);
}

async function readState(unit) {
  const baseline=await spatialBaseline(unit.tx,{allowUnavailable:true,requireAdopted:true});
  const notes=await unit.rows(['NOTE'],{roles:[SPATIAL_PLACEMENT_ROLE],historical:true});
  const locations=await unit.rows(['ENTITY'],{historical:true,fields:['type','name']});
  const scenes=await unit.rows(['SCENE'],{historical:true,fields:[]});
  const binding=baseline.sourceBinding;
  if(binding) unit.bind({id:binding.id,revisionId:binding.revisionId,sha256:binding.revisionSha256,version:binding.expectedVersion});
  const basis={
    // The pure contract's historical flag means unavailable for current use.
    // SOURCE's persisted history label is preserved in baseline.sourceBinding;
    // spatialBaseline already verified unique selection and effective adoption.
    spatialSource:binding?{id:binding.id,revisionId:binding.revisionId,sha256:binding.revisionSha256,
      expectedVersion:binding.expectedVersion,sourceSha256:binding.sourceSha256,kind:'SOURCE',role:'SPATIAL_SPECIFICATION',historical:false}:null,
    locations:locations.map(row=>({...ref(row),kind:row.kind,type:row.content.type||'UNKNOWN',historical:inactive(row)})),
    scenes:scenes.map(row=>({...ref(row),kind:row.kind,historical:inactive(row)})),
  };
  return {baseline,notes,locations,scenes,basis};
}

/** This projection never adds proposals to spatial.locations or spatialCatalog. */
export async function spatialPlacementWorkspace(unit,{spatial}={}) {
  const state=await readState(unit),{baseline,notes,basis}=state;
  const map=spatial===undefined?baseline.specification:spatial;
  const entries=[],pendingOverlays=[],staleDrafts=[],conflicts=[];
  const targets=new Map();
  for(const row of notes.filter(row=>!row.historical)) {
    const id=row.content.placement?.location?.id;
    if(typeof id==='string')targets.set(id,(targets.get(id)||0)+1);
  }
  for(const row of notes) {
    const note=ref(row),base={note,title:row.title,historical:row.historical,state:row.state,
      draftHeadRevisionId:row.draftRevisionId,adoptedRevisionId:row.adoptedRevisionId};
    let entry,overlay;
    try {
      const content=stored(row.content);
      const projection=contract(()=>projectSpatialPlacements({spatial:map,drafts:[{note,content}],basis}));
      entry={...base,...projection.entries[0]};overlay=projection.pendingOverlays[0];
      if(inactive(row)||row.state!=='DRAFT'||row.adoptedRevisionId) {
        entry={...entry,classification:'STALE_DRAFT',freshness:'STALE',issues:[...entry.issues,
          {code:'NOTE_READ_ONLY',message:'NOTE 已退出可编辑草稿状态，保留原修订供核对'}]};
      }
      if(!row.historical&&targets.get(content.location.id)>1) {
        entry={...entry,classification:'CONFLICT',issues:[...entry.issues,
          {code:'DUPLICATE_ACTIVE_NOTE',message:'同一地点有多个当前 NOTE，未自动选择或合并'}]};
      }
    } catch(error) {
      // Malformed legacy input is readable through the exact NOTE link, never
      // passed to the typed card renderer as if it were a valid placement.
      entry={...base,content:null,classification:'INVALID_DRAFT',freshness:'STALE',
        issues:[{code:error.code||'SPATIAL_PLACEMENT_INVALID',message:error.message}]};
    }
    entries.push(entry);
    if(entry.classification==='PENDING_OVERLAY')pendingOverlays.push(overlay);
    else if(['CONFLICT','PUBLISHED_ANCHOR_EXISTS'].includes(entry.classification))conflicts.push(entry);
    else staleDrafts.push(entry);
  }
  const visible=new Set(pendingOverlays.map(v=>v.targetEntityId));
  const anchored=new Set((map?.locations||[]).filter(v=>v.pos?.length===2&&v.pos.every(Number.isFinite)).map(v=>v.id));
  return {status:baseline.status,basis,entries,pendingOverlays,staleDrafts,conflicts,
    issues:baseline.issues||[],unplacedLocationIds:basis.locations.filter(v=>v.type==='LOCATION'&&!v.historical&&!anchored.has(v.id)&&!visible.has(v.id)).map(v=>v.id),
    locations:state.locations.filter(v=>v.content.type==='LOCATION').map(v=>({id:v.id,title:v.title,historical:v.historical})),
    formalAdoptionPerformed:false};
}

export async function planSpatialPlacementChange(tx,input,context) {
  check(typeof context.runtimeEpoch==='string'&&context.runtimeEpoch.length>0,
    'RUNTIME_REQUIRED','保存空间提案须携带本次读取的实例运行版本',409);
  check(context.actor?.kind!=='ASSISTANT','SPATIAL_PLACEMENT_PLANNER_REQUIRED','AI 建议须经明确应用后才能登记空间提案',403);
  check(input && Object.keys(input).every(k=>['action','drafts','operationId'].includes(k)) && input.action==='save',
    'SPATIAL_PLACEMENT_ACTION','空间提案仅支持批量保存待确认草稿');
  check(Array.isArray(input.drafts)&&input.drafts.length>0&&input.drafts.length<=100,
    'SPATIAL_PLACEMENT_BATCH','一次保存须包含 1 至 100 个空间提案');
  const noteIds=new Set(),locationIds=new Set();
  const drafts=input.drafts.map(row=>{
    check(row&&Object.keys(row).every(k=>['noteId','expectedVersion','expectedDraftRevisionId','title','content'].includes(k)) &&
      Object.hasOwn(row,'expectedDraftRevisionId'),'SPATIAL_PLACEMENT_CAS','必须明确提供 NOTE 版本及草稿头');
    identity(row.noteId);expectedVersion(row.expectedVersion);
    check(row.expectedDraftRevisionId===null||typeof row.expectedDraftRevisionId==='string','SPATIAL_PLACEMENT_CAS','草稿头必须是精确修订或 null');
    const content=contract(()=>validateSpatialPlacementDraft(row.content));
    check(!noteIds.has(row.noteId)&&!locationIds.has(content.location.id),'SPATIAL_PLACEMENT_DUPLICATE','批量 NOTE 或地点重复',409);
    noteIds.add(row.noteId);locationIds.add(content.location.id);
    check(!spatialPlacementReferences(content).some(r=>r.id===row.noteId),'SPATIAL_PLACEMENT_IDENTITY','NOTE 不能占用依据对象身份',409);
    return {...row,content};
  });
  async function validate() {
    const state=await readState(new PresentationRead(tx));
    check(state.baseline.status==='AVAILABLE','SPATIAL_PLACEMENT_SOURCE','须有唯一且可核验的当前空间 SOURCE',409,{status:state.baseline.status});
    const existing=(await tx.query(`SELECT o.id,o.kind,o.version,o.state,o.historical,o.draft_revision_id,o.adopted_revision_id,r.content
      FROM objects o LEFT JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.id=ANY($1::text[])`,[[...noteIds]])).rows;
    for(const row of drafts) {
      const old=existing.find(v=>v.id===row.noteId);
      check((old?.version||0)===row.expectedVersion&&(old?.draft_revision_id||null)===row.expectedDraftRevisionId,
        'VERSION_CONFLICT','NOTE 版本或草稿头已改变，保留原稿后重新核对',409,{id:row.noteId});
      check(!old||old.kind==='NOTE'&&isSpatialPlacement(old.content),'SPATIAL_PLACEMENT_IDENTITY','NOTE 身份已用于其他记录',409);
      check(!old||!old.historical&&old.state==='DRAFT'&&!old.adopted_revision_id,'SPATIAL_PLACEMENT_READ_ONLY','不能覆盖历史、锁定或已采用的 NOTE',409);
      if(old)contract(()=>validateSpatialPlacementDraft(row.content,{previous:stored(old.content)}));
      const assessment=contract(()=>assessSpatialPlacementDraft(row.content,state.basis));
      check(assessment.freshness==='CURRENT','SPATIAL_PLACEMENT_STALE','地点、空间来源或场依据已变化，不能套用过期提案',409,{issues:assessment.issues});
      check(!state.notes.some(v=>!v.historical&&v.id!==row.noteId&&v.content.placement?.location?.id===row.content.location.id),
        'SPATIAL_PLACEMENT_DUPLICATE','地点已有当前 NOTE，请核对原草稿，不能静默替换',409);
      const location=state.baseline.specification?.locations?.find(v=>v.id===row.content.location.id);
      check(!(location?.pos?.length===2&&location.pos.every(Number.isFinite)) && location?.status!=='LOCKED',
        'SPATIAL_PLACEMENT_ANCHOR_EXISTS','地点已有空间锚点或已锁定，不能用待确认提案覆盖',409);
    }
    return existing;
  }
  const existing=await validate();
  const assertions=new Map();
  for(const row of drafts)for(const r of spatialPlacementReferences(row.content)) {
    check(!noteIds.has(r.id),'SPATIAL_PLACEMENT_IDENTITY','NOTE 不能占用另一提案的依据身份',409);
    const before=assertions.get(r.id);
    check(!before||before.expectedVersion===r.expectedVersion,'SPATIAL_PLACEMENT_STALE','批量依据版本不一致',409);
    assertions.set(r.id,{type:'assert',id:r.id,expectedVersion:r.expectedVersion});
  }
  const saves=drafts.map(row=>{
    const old=existing.find(v=>v.id===row.noteId),refs=spatialPlacementReferences(row.content);
    const command={type:'save',id:row.noteId,kind:'NOTE',expectedVersion:row.expectedVersion,
      title:row.title||'待确认空间位置',content:{role:SPATIAL_PLACEMENT_ROLE,placement:row.content,
        ...(old?.content.reviewSpec?{reviewSpec:old.content.reviewSpec}:{})},
      links:refs.map(r=>({id:r.id,role:r.kind==='ENTITY'?'ENTITY':r.kind,expectedVersion:r.expectedVersion})),
      dependencies:refs.map(r=>({revisionId:r.revisionId,sha256:r.sha256,purpose:r.purpose}))};
    authorizedSaves.add(command);return command;
  });
  return {commands:[...assertions.values(),...saves],lockIds:[SPATIAL_PLACEMENT_CATALOG_LOCK],validateAfterLock:validate,
    response:results=>({drafts:results.slice(-saves.length).map(v=>({...v,status:'PENDING_CONFIRMATION'})),modelCalls:0,formalAdoptionPerformed:false})};
}
