import {check, canonical, hash, identity, objectValue, expectedVersion, ReviewError} from '../shared/contracts.mjs';
import {workspaceDraft} from '../workspace-drafts.mjs';

export const MATERIAL_USAGE_SCOPE_ROLE = 'MATERIAL_USAGE_SCOPE_V1';
export const MATERIAL_USAGE_SCOPE_EDIT_ROLE = 'MATERIAL_USAGE_SCOPE_EDIT_V1';
export const isMaterialUsageScope = content => content?.role === MATERIAL_USAGE_SCOPE_ROLE;
const isEdit = content => content?.role === MATERIAL_USAGE_SCOPE_EDIT_ROLE;
const authorizedEdits = new WeakSet();
const scopeKinds = ['EPISODE', 'SCENE', 'SHOT'];
const sourceKinds = ['SOURCE', 'STORY', ...scopeKinds, 'ENTITY', 'STATE', 'REPRESENTATION', 'REQUIREMENT', 'MATERIAL'];
const active = row => row && !row.historical && !['ARCHIVED', 'DISABLED'].includes(row.state);
const reference = row => ({objectId:row.id, revisionId:row.revisionId, expectedVersion:row.version});
const nameFor = usageId => 'material-usage-scope:' + usageId;
const assert = (id, version) => ({type:'assert', id, expectedVersion:version});

function keys(value, allowed, code = 'USAGE_SCOPE_CONTENT') {
  objectValue(value);
  check(Object.keys(value).every(key => allowed.includes(key)), code, '用途记录含有不支持的字段');
}
function ref(value, withKind = false) {
  keys(value, ['objectId','revisionId','expectedVersion', ...(withKind ? ['kind'] : [])]);
  identity(value.objectId); identity(value.revisionId); expectedVersion(value.expectedVersion);
  check(value.expectedVersion > 0, 'USAGE_SCOPE_REFERENCE', '用途必须引用已存在的对象版本');
  if (withKind) check(scopeKinds.includes(value.kind), 'USAGE_SCOPE_PATH', '路径只包含永久集、场、镜');
  return value;
}

/** One NOTE is one tuple. A missing path means unknown ancestry, never a product of ID arrays. */
export function validateMaterialUsageScopeContent(content, previous) {
  if (previous) check(!isMaterialUsageScope(previous) || isMaterialUsageScope(content), 'USAGE_SCOPE_IDENTITY', '用途 NOTE 不能改写为其他记录', 409);
  if (!isMaterialUsageScope(content)) return;
  check(!previous || isMaterialUsageScope(previous), 'USAGE_SCOPE_IDENTITY', '其他记录不能改写为用途 NOTE', 409);
  keys(content, ['role','familyId','familyRevisionId','familyExpectedVersion','scopeType','scopeId','scopeRevisionId','scopeExpectedVersion','purposeNote','path','sourceBindings']);
  ref({objectId:content.familyId, revisionId:content.familyRevisionId, expectedVersion:content.familyExpectedVersion});
  check(!previous || previous.familyId === content.familyId, 'USAGE_SCOPE_FAMILY_IMMUTABLE', '用途 NOTE 不能换绑素材族', 409);
  check(['PROJECT', ...scopeKinds].includes(content.scopeType), 'USAGE_SCOPE_TYPE', '用途范围必须是剧、集、场或镜');
  identity(content.scopeId);
  if (content.scopeType === 'PROJECT') {
    check(content.scopeRevisionId === undefined && content.scopeExpectedVersion === undefined && content.path === undefined,
      'USAGE_SCOPE_PROJECT', '全剧用途使用当前实例永久身份，不伪造对象修订或层级路径');
  } else ref({objectId:content.scopeId, revisionId:content.scopeRevisionId, expectedVersion:content.scopeExpectedVersion});
  check(content.purposeNote === undefined || typeof content.purposeNote === 'string' && content.purposeNote.length <= 4000,
    'USAGE_SCOPE_PURPOSE', '用途说明不能超过 4000 字符');
  if (content.path !== undefined) {
    keys(content.path, ['nodes','relations']);
    const {nodes, relations} = content.path;
    check(Array.isArray(nodes) && nodes.length >= 1 && nodes.length <= 3 && Array.isArray(relations) && relations.length === nodes.length - 1,
      'USAGE_SCOPE_PATH', '路径须为一条连续的集场镜路径');
    nodes.forEach(node => ref(node, true));
    check(new Set(nodes.map(n => n.objectId)).size === nodes.length && nodes.every((n,i) => !i || scopeKinds.indexOf(n.kind) === scopeKinds.indexOf(nodes[i-1].kind) + 1),
      'USAGE_SCOPE_PATH', '路径节点须按集、场、镜顺序且不能重复或跳级');
    const target = nodes.at(-1);
    check(target.kind === content.scopeType && target.objectId === content.scopeId && target.revisionId === content.scopeRevisionId && target.expectedVersion === content.scopeExpectedVersion,
      'USAGE_SCOPE_PATH', '路径末端必须与本条用途的精确范围一致');
    relations.forEach((edge,i) => {
      keys(edge, ['ownerId','memberId','role']);
      const [a,b] = [nodes[i], nodes[i+1]];
      check(edge.ownerId === a.objectId && edge.memberId === b.objectId && edge.role === b.kind ||
        edge.ownerId === b.objectId && edge.memberId === a.objectId && edge.role === a.kind,
      'USAGE_SCOPE_PATH', '每一步须明确登记的关系方向与职责');
    });
  }
  if (content.sourceBindings !== undefined) {
    check(Array.isArray(content.sourceBindings) && content.sourceBindings.length <= 20, 'USAGE_SCOPE_SOURCES', '来源须为不超过 20 条的精确修订');
    content.sourceBindings.forEach(value => ref(value));
    check(new Set(content.sourceBindings.map(r => r.objectId + '\0' + r.revisionId)).size === content.sourceBindings.length,
      'USAGE_SCOPE_SOURCES', '来源修订不能重复');
  }
  const versions = new Map();
  for (const value of materialUsageScopeReferences(content)) {
    check(!versions.has(value.objectId) || versions.get(value.objectId) === value.expectedVersion, 'USAGE_SCOPE_REFERENCE', '同一对象的所见版本必须一致');
    versions.set(value.objectId, value.expectedVersion);
  }
}

export function materialUsageScopeReferences(content) {
  if (!isMaterialUsageScope(content)) return [];
  return [{objectId:content.familyId, revisionId:content.familyRevisionId, expectedVersion:content.familyExpectedVersion, kind:'MATERIAL'},
    ...(content.scopeType === 'PROJECT' ? [] : [{objectId:content.scopeId, revisionId:content.scopeRevisionId, expectedVersion:content.scopeExpectedVersion, kind:content.scopeType}]),
    ...(content.path?.nodes || []), ...(content.sourceBindings || []).map(r => ({...r, source:true}))];
}

async function exact(tx, value) {
  return (await tx.query(`SELECT o.id,o.kind,o.version,o.state,o.historical,r.id AS "revisionId",r.content,
    COALESCE(o.draft_revision_id,o.adopted_revision_id) AS "headRevisionId"
    FROM objects o JOIN revisions r ON r.object_id=o.id WHERE o.id=$1 AND r.id=$2`, [value.objectId,value.revisionId])).rows[0];
}
export async function validateMaterialUsageScopeTargets(tx, content, previous, {historicalImport = false} = {}) {
  validateMaterialUsageScopeContent(content, previous);
  if (!isMaterialUsageScope(content)) return;
  if (content.scopeType === 'PROJECT') {
    const project = (await tx.query('SELECT instance_id AS "instanceId" FROM project')).rows[0];
    check(project?.instanceId === content.scopeId, 'USAGE_SCOPE_PROJECT', '全剧用途必须引用当前实例永久 ID', 409);
  }
  for (const value of materialUsageScopeReferences(content)) {
    const row = await exact(tx, value);
    check(row && (value.source ? sourceKinds.includes(row.kind) : row.kind === value.kind),
      'USAGE_SCOPE_REFERENCE', '用途引用的永久身份、对象类型或精确修订不符', 409, {objectId:value.objectId});
    if (!historicalImport) check(row.version === value.expectedVersion && (value.source || active(row) && row.headRevisionId === value.revisionId),
      'USAGE_SCOPE_STALE', '用途所用对象版本已改变，请重新核对', 409, {objectId:value.objectId});
  }
  for (const edge of content.path?.relations || []) {
    const owner = content.path.nodes.find(n => n.objectId === edge.ownerId);
    const relation = await tx.query('SELECT 1 FROM revision_memberships WHERE revision_id=$1 AND member_id=$2 AND role=$3',
      [owner.revisionId,edge.memberId,edge.role]);
    check(relation.rowCount > 0, 'USAGE_SCOPE_PATH', '所选精确修订未登记这条层级关系', 409);
  }
}

export function materialUsageScopeLinks(content) {
  if (!isMaterialUsageScope(content)) return [];
  return [{id:content.familyId, role:'FAMILY', expectedVersion:content.familyExpectedVersion},
    ...(content.scopeType === 'PROJECT' ? [] : [{id:content.scopeId, role:content.scopeType, expectedVersion:content.scopeExpectedVersion}])];
}
export function materialUsageScopeLockIds(command) {
  const values = [command.content, command.usageScopeBasis, command.content?.change?.content];
  return [...(isEdit(command.content) ? [command.content.usageId] : []),...values.flatMap(value => materialUsageScopeReferences(value).map(r => r.objectId))];
}
const tupleIdentity = content => [content.familyId,content.scopeType,content.scopeId];

/** Generic transaction saves obey the same contract; JSON flags are not capabilities. */
export async function guardMaterialUsageScopeSave(tx, command, kind, previous, context) {
  const content = command.content;
  if (![content,previous].some(c => isMaterialUsageScope(c) || isEdit(c))) return;
  check(typeof context?.runtimeEpoch === 'string' && context.runtimeEpoch.length > 0, 'RUNTIME_REQUIRED', '用途写入须携带读取时的 runtimeEpoch',409);
  check(kind === 'NOTE', 'USAGE_SCOPE_KIND', '素材用途必须使用独立 NOTE');
  if (isEdit(content) || isEdit(previous)) {
    check(authorizedEdits.has(command),'USAGE_SCOPE_PLANNER_REQUIRED','用途编辑回执只能通过用途工作区保存',403);
    check(isEdit(content) && (!previous || isEdit(previous) && previous.usageId === content.usageId), 'USAGE_SCOPE_IDENTITY', '用途编辑草稿不能换绑身份', 409);
    keys(content, ['role','usageId','status','change']); identity(content.usageId);
    check(command.id === 'workspace-draft:' + nameFor(content.usageId) && ['DRAFT','PUBLISHED'].includes(content.status), 'USAGE_SCOPE_EDIT', '用途编辑草稿身份或状态无效');
    await validateChange(tx,content.usageId,content.change);
    check(!command.links?.length && !command.dependencies?.length && !command.media?.length, 'USAGE_SCOPE_ISOLATION', '用途编辑草稿不绑定素材版本或输入依赖');
    return;
  }
  await validateMaterialUsageScopeTargets(tx,content,previous);
  const old = await currentUsage(tx,command.id);
  check(!old || active(old) && old.state === 'DRAFT' && !old.adopted_revision_id, 'USAGE_SCOPE_DRAFT_ONLY', '用途只能更新业务草稿',409);
  const expectedLinks = materialUsageScopeLinks(content).map(({id,role}) => ({id,role}));
  check(command.links === undefined || Array.isArray(command.links) && canonical(command.links.map(({id,role}) => ({id,role})).sort((a,b) => a.id.localeCompare(b.id))) === canonical([...expectedLinks].sort((a,b) => a.id.localeCompare(b.id))),
    'USAGE_SCOPE_ISOLATION', '用途只关联本条素材族与范围，不能挂接素材版本或额外关联');
  check(command.dependencies === undefined || Array.isArray(command.dependencies) && command.dependencies.length === 0, 'USAGE_SCOPE_ISOLATION', '松散用途的 dependencies 必须为空');
  check(!command.media?.length, 'USAGE_SCOPE_ISOLATION', '松散用途不登记媒体');
}

export async function guardMaterialUsageScopeAction(tx, object, command, context) {
  if (!object || object.kind !== 'NOTE') return;
  const content = (await tx.query('SELECT content FROM revisions WHERE id=$1',[object.draft_revision_id || object.adopted_revision_id])).rows[0]?.content;
  if (!isMaterialUsageScope(content) && !isEdit(content)) return;
  check(command.type === 'archive' && isMaterialUsageScope(content) && object.state === 'DRAFT' && !object.historical && !object.adopted_revision_id,
    'USAGE_SCOPE_DRAFT_ONLY', '素材用途只保存或移除业务草稿，不能提交审阅、采用或登记权利', 409);
  check(typeof context?.runtimeEpoch === 'string' && context.runtimeEpoch.length > 0, 'RUNTIME_REQUIRED', '移除用途须携带读取时的 runtimeEpoch',409);
  const basis = command.usageScopeBasis;
  check(isMaterialUsageScope(basis) && canonical(tupleIdentity(basis)) === canonical(tupleIdentity(content)), 'USAGE_SCOPE_REMOVE_BASIS', '移除须核对原用途及范围，不能借移除改绑', 409);
  await validateMaterialUsageScopeTargets(tx,basis,content);
}

async function currentUsage(tx, usageId) {
  return (await tx.query(`SELECT o.id,o.kind,o.version,o.state,o.historical,o.draft_revision_id,o.adopted_revision_id,
    r.id AS "revisionId",r.content FROM objects o LEFT JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.id=$1`,[usageId])).rows[0];
}
async function validateChange(tx, usageId, change) {
  keys(change, ['type','expectedVersion','expectedRevisionId','content']);
  check(['UPSERT','REMOVE'].includes(change.type), 'USAGE_SCOPE_CHANGE', '用途修改须为 UPSERT 或 REMOVE');
  expectedVersion(change.expectedVersion);
  check(Object.hasOwn(change,'expectedRevisionId') && (change.expectedRevisionId === null || typeof change.expectedRevisionId === 'string'), 'USAGE_SCOPE_CAS', '须携带用途精确修订或 null');
  const old = await currentUsage(tx,usageId);
  check((old?.version || 0) === change.expectedVersion && (old?.revisionId || null) === change.expectedRevisionId, 'VERSION_CONFLICT', '用途版本或修订已改变', 409);
  check(!old || old.kind === 'NOTE' && isMaterialUsageScope(old.content) && active(old) && old.state === 'DRAFT' && !old.adopted_revision_id, 'USAGE_SCOPE_READ_ONLY', '用途身份已存在或已退出可编辑草稿', 409);
  check(isMaterialUsageScope(change.content), 'USAGE_SCOPE_CONTENT', '请提供单条用途内容');
  await validateMaterialUsageScopeTargets(tx,change.content,old?.content);
  if (change.type === 'REMOVE') check(old && canonical(tupleIdentity(change.content)) === canonical(tupleIdentity(old.content)), 'USAGE_SCOPE_REMOVE_BASIS', '移除须核对现有用途范围', 409);
  return old;
}
function assertions(usageId, change) {
  return [...new Map([[usageId,assert(usageId,change.expectedVersion)], ...materialUsageScopeReferences(change.content).map(r => [r.objectId,assert(r.objectId,r.expectedVersion)])]).values()];
}
export async function planMaterialUsageScopeChange(tx, body, context) {
  check(typeof context?.runtimeEpoch === 'string' && context.runtimeEpoch.length > 0, 'RUNTIME_REQUIRED', '用途动作须携带读取时的 runtimeEpoch',409);
  keys(body, ['action','usageId','change','expectedDraftRevisionId','draftRevisionId','previewHash','operationId']);
  identity(body.usageId);
  check(body.usageId.length <= 900 && !body.usageId.startsWith('workspace-draft:'), 'USAGE_SCOPE_IDENTITY', '请使用独立的用途永久 ID');
  const name = nameFor(body.usageId), old = await workspaceDraft(tx,name);
  const draftRevisionId = body.action === 'save' ? body.expectedDraftRevisionId : body.draftRevisionId;
  check(draftRevisionId !== undefined && draftRevisionId === (old?.revisionId || null), 'VERSION_CONFLICT', '用途编辑草稿已改变，请保留修改后重新读取', 409);
  if (body.action !== 'save') check(old?.content.status === 'DRAFT', 'DRAFT_REQUIRED', '请先保存用途编辑草稿', 409);
  const change = body.action === 'save' ? body.change : old?.content.change;
  await validateChange(tx,body.usageId,change);
  const validateAfterLock = async () => { await validateChange(tx,body.usageId,change); };
  const draft = status => {
    const command = {type:'save',id:'workspace-draft:'+name,kind:'NOTE',title:'素材用途编辑',expectedVersion:old?.version || 0,
      content:{role:MATERIAL_USAGE_SCOPE_EDIT_ROLE,usageId:body.usageId,status,change},links:[],dependencies:[]};
    authorizedEdits.add(command);return command;
  };
  const checks = assertions(body.usageId,change);
  if (body.action === 'save') return {commands:[...checks,draft('DRAFT')],validateAfterLock,
    response:results => ({usageId:body.usageId,draftRevisionId:results.at(-1).revisionId,formalAdoptionPerformed:false,dependencies:[]})};
  const previewHash = hash({draftRevisionId:old.revisionId,usageId:body.usageId,change});
  const impact = {tuples:[{usageId:body.usageId,change:change.type,...change.content}],invalidations:[],dependencies:[],formalAdoptionPerformed:false};
  if (body.action === 'preview') return {commands:[...checks,assert(old.id,old.version)],validateAfterLock,response:() => ({previewHash,...impact})};
  check(body.action === 'publish' && body.previewHash === previewHash, 'PREVIEW_STALE', '用途预览已改变，请重新预览', 409);
  const mutation = change.type === 'REMOVE'
    ? {type:'archive',id:body.usageId,expectedVersion:change.expectedVersion,usageScopeBasis:change.content}
    : {type:'save',id:body.usageId,kind:'NOTE',expectedVersion:change.expectedVersion,title:'素材用途',content:change.content,links:materialUsageScopeLinks(change.content),dependencies:[]};
  // The edit receipt is saved before the mutation so its CAS still validates the old usage head.
  return {commands:[...checks,draft('PUBLISHED'),mutation],validateAfterLock,
    response:results => ({...impact,...results.at(-1),usageId:body.usageId,draftRevisionId:results.at(-2).revisionId})};
}

async function tuple(tx, row) {
  const issues = [];
  try { await validateMaterialUsageScopeTargets(tx,row.content); } catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    issues.push({code:error.code,message:error.message});
  }
  const completePath = row.content.path?.nodes?.[0]?.kind === 'EPISODE' || ['PROJECT','EPISODE'].includes(row.content.scopeType);
  return {...row.content,usageId:row.id,revisionId:row.revisionId,objectVersion:row.version,state:row.state,historical:row.historical,
    freshness:issues.length ? 'STALE' : 'CURRENT',pathResolution:!issues.length && completePath ? 'EXACT' : 'UNKNOWN',issues,dependencies:[]};
}
export async function materialUsageScopes(unit, {familyIds, historical = false} = {}) {
  if (familyIds?.length === 0) return [];
  const rows = (await unit.tx.query(`SELECT o.id,o.version,o.state,o.historical,r.id AS "revisionId",r.sha256,r.content
    FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
    WHERE o.kind='NOTE' AND r.content->>'role'=$1 AND ($2 OR NOT o.historical)
      AND ($3::text[] IS NULL OR r.content->>'familyId'=ANY($3)) ORDER BY o.id LIMIT 5001`,[MATERIAL_USAGE_SCOPE_ROLE,historical,familyIds || null])).rows;
  check(rows.length<=5000,'WORKSPACE_LIMIT','请按素材族进一步读取用途',413);
  return Promise.all(rows.map(row => {unit.bind(row);return tuple(unit.tx,row);}));
}
export async function materialUsageScopeCatalog(unit) {
  const project = (await unit.tx.query('SELECT instance_id AS "instanceId" FROM project')).rows[0];
  const families = (await unit.rows(['MATERIAL'],{fields:[]})).filter(active);
  const rows = (await unit.rows(scopeKinds,{fields:[]})).filter(active);
  const byId = new Map(rows.map(r => [r.id,r]));
  const relations = rows.flatMap(owner => owner.links.flatMap(link => {
    const member = byId.get(link.id);
    return member && link.role === member.kind && Math.abs(scopeKinds.indexOf(member.kind) - scopeKinds.indexOf(owner.kind)) === 1
      ? [{owner:{...reference(owner),kind:owner.kind},member:{...reference(member),kind:member.kind},role:link.role}] : [];
  }));
  return {project:{scopeType:'PROJECT',scopeId:project.instanceId},families:families.map(row=>({familyId:row.id,title:row.title,...reference(row)})),scopes:rows.map(row => ({scopeType:row.kind,scopeId:row.id,title:row.title,...reference(row)})),relations};
}
export async function materialUsageScopeWorkspace(unit, options = {}) {
  if (options.usageId) {
    identity(options.usageId);
    const current = await currentUsage(unit.tx,options.usageId);
    check(!current || current.kind === 'NOTE' && isMaterialUsageScope(current.content), 'USAGE_SCOPE_IDENTITY', '该身份不是素材用途', 409);
    const draft = await workspaceDraft(unit.tx,nameFor(options.usageId));
    let detail = null;
    if (current) {
      const selected = await unit.detail(current.id,options.revisionId);
      check(isMaterialUsageScope(selected.revision.content),'USAGE_SCOPE_IDENTITY','所选历史修订不是用途记录',409);
      detail = {...selected,tuple:await tuple(unit.tx,{...current,revisionId:selected.revision.id,content:selected.revision.content})};
    } else check(!options.revisionId,'NOT_FOUND','用途修订不存在',404);
    return {usageId:options.usageId,detail,draft,formalAdoptionPerformed:false};
  }
  return {tuples:await materialUsageScopes(unit,{familyIds:options.familyId ? [options.familyId] : undefined,historical:options.historical === '1'}),
    ...(options.catalog === '1' ? {catalog:await materialUsageScopeCatalog(unit)} : {}),formalAdoptionPerformed:false};
}

/** Conservative read-only migration: every candidate comes from a single registered permanent relationship. */
export async function materialUsageScopeMigrationPreview(unit, {familyId} = {}) {
  const rows = await unit.rows(['MATERIAL','REQUIREMENT'],{historical:true});
  const families = new Map(rows.filter(r => r.kind === 'MATERIAL').map(r => [r.id,r]));
  const candidates = [], unknown = [], skipped = [];
  const sources = rows.filter(r => !familyId || r.id === familyId || r.links.some(l => l.role === 'FAMILY' && l.id === familyId));
  for (const row of sources) {
    const linkedFamilies = [...new Set([...(row.kind === 'MATERIAL' ? [row.id] : []),...row.links.filter(l => l.role === 'FAMILY').map(l => l.id)])];
    const uncertainArrays = [];
    const inspect = (value, prefix = '', depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 10) return;
      for (const [key,item] of Object.entries(value)) {
        const path = prefix + key;
        if (['scope','scopes','episodeIds','episodeUids','sceneIds','shotIds','familyIds','assetFamilyIds','assetFamilyRefs','usedByRefs'].includes(key) && Array.isArray(item) && item.length) uncertainArrays.push(path);
        else if (item && typeof item === 'object' && !Array.isArray(item)) inspect(item,path + '.',depth + 1);
      }
    };
    inspect(row.content);
    if (uncertainArrays.length) { unknown.push({source:reference(row),code:'UNPAIRED_LEGACY_ARRAYS',fields:uncertainArrays}); continue; }
    if (linkedFamilies.length !== 1) { (linkedFamilies.length ? unknown : skipped).push({source:reference(row),code:linkedFamilies.length ? 'MULTIPLE_FAMILIES' : 'NO_PERMANENT_FAMILY'}); continue; }
    const family = families.get(linkedFamilies[0]);
    if (!active(row) || !active(family)) { skipped.push({source:reference(row),code:'HISTORICAL_OR_UNAVAILABLE'}); continue; }
    const links = row.links.filter(l => scopeKinds.includes(l.role));
    if (!links.length) { skipped.push({source:reference(row),code:'NO_PERMANENT_SCOPE'}); continue; }
    for (const link of links) {
      const scope = (await unit.rows([link.role],{ids:[link.id],fields:[]})).find(active);
      if (!scope) { unknown.push({source:reference(row),code:'SCOPE_ID_OR_KIND_UNKNOWN',scopeId:link.id}); continue; }
      const content = {role:MATERIAL_USAGE_SCOPE_ROLE,familyId:family.id,familyRevisionId:family.revisionId,familyExpectedVersion:family.version,
        scopeType:scope.kind,scopeId:scope.id,scopeRevisionId:scope.revisionId,scopeExpectedVersion:scope.version,sourceBindings:[reference(row)]};
      candidates.push({candidateId:hash({source:reference(row),familyId:family.id,scopeId:scope.id,scopeType:scope.kind}),content,pathResolution:'UNKNOWN'});
    }
  }
  return {status:'PREVIEW_ONLY',tuples:candidates,unknown,skipped,dependencies:[],writesPerformed:false,formalAdoptionPerformed:false};
}

export async function validateStoredMaterialUsageScope(tx, revisionId, content, previous) {
  await validateMaterialUsageScopeTargets(tx,content,previous,{historicalImport:true});
  if (!isMaterialUsageScope(content)) return;
  const links = (await tx.query('SELECT member_id AS id,role FROM revision_memberships WHERE revision_id=$1',[revisionId])).rows;
  const sort = rows => rows.map(r => r.id + '\0' + r.role).sort();
  check(canonical(sort(links)) === canonical(sort(materialUsageScopeLinks(content))), 'USAGE_SCOPE_ISOLATION', '用途历史关系与正文不一致',409);
  check(!(await tx.query('SELECT 1 FROM dependencies WHERE consumer_revision_id=$1 LIMIT 1',[revisionId])).rowCount, 'USAGE_SCOPE_ISOLATION', '用途历史不能携带输入依赖',409);
  check(!(await tx.query(`SELECT 1 FROM rights WHERE revision_id=$1 UNION ALL SELECT 1 FROM asset_media WHERE revision_id=$1
    UNION ALL SELECT 1 FROM reviews WHERE revision_id=$1
    UNION ALL SELECT 1 FROM objects o JOIN revisions r ON r.object_id=o.id WHERE r.id=$1 AND (o.adopted_revision_id IS NOT NULL OR o.state NOT IN ('DRAFT','ARCHIVED')) LIMIT 1`,[revisionId])).rowCount,
  'USAGE_SCOPE_ISOLATION','用途历史不能包含媒体、权利或采用判断',409);
}
