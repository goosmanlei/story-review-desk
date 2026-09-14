import {currentSystemEntityTypes} from '../shared/entity-types.mjs';
import { check, hash, canonical, identity, objectValue, expectedVersion } from '../shared/contracts.mjs';

export const SOUND_OWNERSHIP_ROLE = 'SOUND_OWNERSHIP';
export const SOUND_TARGET_KINDS = new Set(['SPACE', 'STORY', 'EPISODE', 'SCENE', 'SHOT']);
export const SOUND_RESOURCE_KINDS = new Set(['STATE', 'REPRESENTATION', 'REQUIREMENT', 'MATERIAL']);
export const pendingSound = content => ['UNKNOWN', 'PENDING_CONFIRMATION'].includes(content.status);
const isSound = content => content?.role === SOUND_OWNERSHIP_ROLE;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const targetRole = kind => ({ EPISODE:'EPISODE', SCENE:'SCENE', SHOT:'SHOT' })[kind] || 'SOURCE';
const resourceRole = kind => ({ STATE:'STATE', REPRESENTATION:'REPRESENTATION', REQUIREMENT:'REQUIREMENT', MATERIAL:'FAMILY' })[kind];
const sameIds = (a, b) => canonical([...a].sort()) === canonical([...b].sort());
const sameReference = (a, b) => a?.objectId === b?.objectId && a?.revisionId === b?.revisionId && a?.sha256 === b?.sha256 && a?.kind === b?.kind;
const matchesKind = (row, ref) => row?.kind === ref.kind || ref.kind === 'SPACE' && row?.kind === 'ENTITY' && row.content?.type === 'LOCATION';
const refOf = row => ({objectId:row.id,kind:row.kind,revisionId:row.revision_id,sha256:row.sha256,expectedVersion:row.version});

function exactReference(value, name) {
  objectValue(value, name);
  identity(value.objectId, name + '.objectId');
  identity(value.revisionId, name + '.revisionId');
  check(sha256(value.sha256), 'SOUND_EXACT_REFERENCE', `${name} 缺少有效 SHA`);
  expectedVersion(value.expectedVersion);
  check(value.expectedVersion > 0, 'SOUND_EXACT_REFERENCE', `${name} 必须引用已存在的对象版本`);
  return value;
}

export function validateSoundOwnershipContent(content, previous) {
  check(!isSound(previous) || isSound(content), 'SOUND_BINDING_IDENTITY', '声音归属记录不能改写为其他记录', 409);
  if (!isSound(content)) return;
  check(content.status === 'ASSIGNED' || pendingSound(content), 'SOUND_OWNERSHIP_STATUS', '声音归属状态无效');
  // New sounds need no legacy ENTITY. Migration keeps an immutable source anchor.
  if (content.source) {
    exactReference(content.source, 'source');
    check(content.source.kind === 'ENTITY', 'SOUND_SOURCE_KIND', '迁移来源必须是历史声音主体');
  }
  check(typeof content.usage === 'string' && content.usage.trim() && content.usage.length <= 500, 'SOUND_USAGE_REQUIRED', '请记录声音的实际用途');
  check(Array.isArray(content.resources) && content.resources.length <= 100 && (content.source || content.resources.length), 'SOUND_RESOURCES', '声音关联资源必须是有界列表，新声音至少关联一项资源');
  const resourceIds = new Set();
  for (const [index, resource] of content.resources.entries()) {
    exactReference(resource, `resources[${index}]`);
    check(SOUND_RESOURCE_KINDS.has(resource.kind), 'SOUND_RESOURCE_KIND', '声音只能关联设定、表现、需求或素材族');
    check(!resourceIds.has(resource.objectId), 'SOUND_RESOURCE_DUPLICATE', '声音关联资源不能重复');
    resourceIds.add(resource.objectId);
  }
  if (content.status === 'ASSIGNED') {
    exactReference(content.target, 'target');
    check(SOUND_TARGET_KINDS.has(content.target.kind), 'SOUND_TARGET_KIND', '声音只能归属空间或剧、集、场、镜');
    check(content.pending === undefined, 'SOUND_PENDING_CONFLICT', '已明确归属不能同时标为待确认');
  } else {
    check(content.target === undefined || content.target === null, 'SOUND_PENDING_TARGET', '待确认声音不能默认归属任何对象');
    objectValue(content.pending, 'pending');
    for (const key of ['reason', 'todo']) check(typeof content.pending[key] === 'string' && content.pending[key].trim() && content.pending[key].length <= 4000, 'SOUND_PENDING_' + key.toUpperCase(), '待确认声音须保留原因和后续核对事项');
    check(Array.isArray(content.pending.missingEvidence) && content.pending.missingEvidence.length > 0 && content.pending.missingEvidence.length <= 20 && content.pending.missingEvidence.every(value => typeof value === 'string' && value.trim() && value.length <= 1000), 'SOUND_PENDING_EVIDENCE', '待确认声音须列出缺少的证据');
  }
  if (isSound(previous)) {
    check(sameReference(previous.source, content.source), 'SOUND_BINDING_IDENTITY', '迁移来源的永久身份与精确修订不能换绑', 409);
    check(sameIds(previous.resources.map(r => r.objectId), content.resources.map(r => r.objectId)), 'SOUND_BINDING_IDENTITY', '声音归属记录不能换绑关联资源；请建立新的永久记录', 409);
    check(previous.status !== 'ASSIGNED' || content.status === 'ASSIGNED' && previous.target.objectId === content.target.objectId && previous.target.kind === content.target.kind, 'SOUND_BINDING_IDENTITY', '已明确的声音归属不能换绑目标；请建立新的永久记录', 409);
  }
}

async function exactRow(tx, reference) {
  return (await tx.query(`SELECT o.id,o.kind,o.title,o.version,o.historical,r.id AS revision_id,r.sha256,r.content,
    COALESCE(o.draft_revision_id,o.adopted_revision_id) AS head_revision_id
    FROM objects o JOIN revisions r ON r.object_id=o.id WHERE o.id=$1 AND r.id=$2`, [reference.objectId, reference.revisionId])).rows[0];
}

export async function validateSoundOwnershipTargets(tx, content, previous, {historicalImport = false} = {}) {
  validateSoundOwnershipContent(content, previous);
  if (!isSound(content)) return;
  for (const [name, ref] of [['SOURCE', content.source], ['TARGET', content.target], ...content.resources.map(r => ['RESOURCE', r])]) {
    if (!ref) continue;
    const row = await exactRow(tx, ref);
    check(row && matchesKind(row, ref) && row.sha256 === ref.sha256 && (name !== 'SOURCE' || row.content.type === 'SOUND'), 'SOUND_' + name + '_CHANGED', '声音引用的永久身份、精确修订或 SHA 不一致', 409, {id:ref.objectId});
    // Import validates immutable evidence; retirement and later edits legitimately
    // change object counters and heads without changing that evidence.
    if (!historicalImport) check(row.version === ref.expectedVersion && (name === 'SOURCE' || !row.historical), 'SOUND_' + name + '_CHANGED', '声音引用对象已改变，请刷新版本', 409, {id:ref.objectId});
  }
}

export function soundOwnershipLinks(content) {
  if (!isSound(content)) return null;
  return [...(content.source ? [{id:content.source.objectId,role:'SOURCE',expectedVersion:content.source.expectedVersion}] : []),
    ...(content.status === 'ASSIGNED' ? [{id:content.target.objectId,role:targetRole(content.target.kind),expectedVersion:content.target.expectedVersion}] : []),
    ...content.resources.map(r => ({id:r.objectId,role:resourceRole(r.kind),expectedVersion:r.expectedVersion}))];
}
export function soundOwnershipDependencies(content) {
  if (!isSound(content)) return [];
  const refs = [...(content.source ? [{revisionId:content.source.revisionId,purpose:'SOURCE'}] : []),
    ...(content.status === 'ASSIGNED' ? [{revisionId:content.target.revisionId,purpose:'CONTENT'}] : []),
    ...content.resources.map(r => ({revisionId:r.revisionId,purpose:'DEFINITION'}))];
  return [...new Map(refs.map(r => [r.revisionId + '\0' + r.purpose, r])).values()];
}

// Follow registered membership/dependency identities only, in both directions
// within the setting/requirement/family chain. Never traverse another entity,
// display number, title or textual scope hint to infer ownership.
export async function soundMigrationInventory(tx, sourceId) {
  identity(sourceId, 'sourceId');
  const source = (await tx.query(`SELECT o.id,o.kind,o.title,o.version,o.historical,r.id AS revision_id,r.sha256,r.content
    FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.id=$1`, [sourceId])).rows[0];
  check(source?.kind === 'ENTITY' && source.content.type === 'SOUND', 'SOUND_SOURCE_KIND', '所选对象不是旧声音主体', 409);
  const resources = (await tx.query(`WITH RECURSIVE edges(a,b) AS (
      SELECT owner_id,member_id FROM memberships
      UNION SELECT r.object_id,s.object_id FROM dependencies d JOIN revisions r ON r.id=d.consumer_revision_id
        JOIN objects o ON o.id=r.object_id AND r.id IN(o.draft_revision_id,o.adopted_revision_id)
        JOIN revisions s ON s.id=d.dependency_revision_id
    ), connected(id) AS (
      SELECT $1::text UNION SELECT o.id FROM connected c JOIN edges e ON e.a=c.id OR e.b=c.id
      JOIN objects o ON o.id=CASE WHEN e.a=c.id THEN e.b ELSE e.a END
      WHERE o.kind=ANY($2::text[]) AND NOT o.historical
    ) SELECT o.id,o.kind,o.version,r.id AS revision_id,r.sha256 FROM connected c JOIN objects o ON o.id=c.id
      JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.id<>$1 ORDER BY o.id LIMIT 1001`, [sourceId, [...SOUND_RESOURCE_KINDS]])).rows;
  check(resources.length <= 1000, 'SOUND_INVENTORY_LIMIT', '声音资源关联超过迁移上限，须先人工核查', 413);
  const roots = [sourceId, ...resources.map(r => r.id)];
  // Include every candidate version and recursive exact consumer, even frozen
  // history. The inventory is metadata only and never opens media bytes.
  const related = (await tx.query(`WITH RECURSIVE retained(id) AS (
      SELECT r.id FROM revisions r WHERE r.object_id=ANY($1::text[])
        OR r.object_id IN(SELECT object_id FROM asset_versions WHERE family_id=ANY($1::text[]))
      UNION SELECT d.consumer_revision_id FROM dependencies d JOIN retained r ON d.dependency_revision_id=r.id
    ) SELECT DISTINCT o.id FROM objects o JOIN revisions r ON r.object_id=o.id
    WHERE NOT (o.kind='NOTE' AND COALESCE(r.content->>'role','')=$2) AND (
      r.id IN(SELECT id FROM retained) OR o.id IN(SELECT object_id FROM asset_versions WHERE family_id=ANY($1::text[]))
      OR o.id IN(SELECT owner_id FROM memberships WHERE member_id=ANY($1::text[]))
      OR o.id IN(SELECT object_id FROM entity_relations WHERE from_id=ANY($1::text[]) OR to_id=ANY($1::text[]))
      OR r.id IN(SELECT revision_id FROM revision_memberships WHERE member_id=ANY($1::text[]))) ORDER BY o.id LIMIT 5001`, [roots, SOUND_OWNERSHIP_ROLE])).rows;
  check(related.length <= 5000, 'SOUND_INVENTORY_LIMIT', '声音历史引用超过迁移上限，须先人工核查', 413);
  const retainedObjectIds = [...new Set([...roots, ...related.map(r => r.id)])].sort();
  const snapshot = (await tx.query(`WITH selected AS (SELECT id FROM revisions WHERE object_id=ANY($1::text[]))
    SELECT 'objects' AS section,to_jsonb(o)-'updated_at' AS value FROM objects o WHERE o.id=ANY($1::text[]) AND o.id<>$2
    UNION ALL SELECT 'source-heads',jsonb_build_object('draft',draft_revision_id,'adopted',adopted_revision_id) FROM objects WHERE id=$2
    UNION ALL SELECT 'revisions',to_jsonb(r)-'content' FROM revisions r WHERE r.id IN(SELECT id FROM selected)
    UNION ALL SELECT 'memberships',to_jsonb(m) FROM memberships m WHERE m.owner_id=ANY($1::text[])
    UNION ALL SELECT 'revision_memberships',to_jsonb(m) FROM revision_memberships m WHERE m.revision_id IN(SELECT id FROM selected)
    UNION ALL SELECT 'dependencies',to_jsonb(d) FROM dependencies d WHERE d.consumer_revision_id IN(SELECT id FROM selected)
    UNION ALL SELECT 'entity_relations',to_jsonb(e) FROM entity_relations e WHERE e.object_id=ANY($1::text[])
    UNION ALL SELECT 'asset_versions',to_jsonb(a) FROM asset_versions a WHERE a.family_id=ANY($1::text[])
    UNION ALL SELECT 'material_families',to_jsonb(f) FROM material_families f WHERE f.object_id=ANY($1::text[])
    UNION ALL SELECT 'asset_media',to_jsonb(a) FROM asset_media a WHERE a.revision_id IN(SELECT id FROM selected)
    UNION ALL SELECT 'media',to_jsonb(m) FROM media m WHERE (m.id,m.version_id) IN(SELECT a.media_id,a.media_version_id FROM asset_media a WHERE a.revision_id IN(SELECT id FROM selected))
    UNION ALL SELECT 'source_documents',jsonb_build_object('revisionId',s.revision_id,'originalRevisionId',s.original_revision_id,'sha256',s.original_sha256,'mimeType',s.mime_type,'logicalPath',s.logical_path,'role',s.role) FROM source_documents s WHERE s.revision_id IN(SELECT id FROM selected)
    UNION ALL SELECT 'reviews',to_jsonb(r) FROM reviews r WHERE r.object_id=ANY($1::text[])
    UNION ALL SELECT 'rights',to_jsonb(r) FROM rights r WHERE r.revision_id IN(SELECT id FROM selected)
    UNION ALL SELECT 'rights_events',to_jsonb(r) FROM rights_events r WHERE r.revision_id IN(SELECT id FROM selected)
    UNION ALL SELECT 'invalidations',to_jsonb(i) FROM invalidations i WHERE i.consumer_revision_id IN(SELECT id FROM selected)
    UNION ALL SELECT 'provenance',to_jsonb(p) FROM provenance p WHERE p.object_id=ANY($1::text[]) AND p.kind<>'sound-ownership-migration' LIMIT 50001`, [retainedObjectIds, sourceId])).rows;
  check(snapshot.length <= 50000, 'SOUND_INVENTORY_LIMIT', '声音保真清单超过读取上限', 413);
  const preservationHash = hash(snapshot.map(canonical).sort());
  const result = {source:refOf(source),sourceHistorical:source.historical,resources:resources.map(refOf),retainedObjectIds,preservationHash};
  return {...result, inventoryHash:hash(result)};
}

export async function planSoundOwnershipMigration(tx, body) {
  if(body.action==='retire-configuration'){
    expectedVersion(body.expectedVersion);
    const row=(await tx.query("SELECT version,content FROM configurations WHERE scope='system'")).rows[0];
    check((row?.version||0)===body.expectedVersion,'VERSION_CONFLICT','系统配置已改变，请刷新后再退役',409);
    return {commands:[{type:'configuration.save',scope:'system',expectedVersion:body.expectedVersion,content:currentSystemEntityTypes(row?.content||{})}],response:results=>({...results[0],retiredEntityType:'SOUND',formalAdoptionPerformed:false})};
  }
  if (body.action === 'save') {
    validateSoundOwnershipContent(body.content);
    check(isSound(body.content), 'SOUND_OWNERSHIP_ROLE', '请保存声音归属记录');
    return {commands:[{type:'save',id:body.bindingId,kind:'NOTE',expectedVersion:body.expectedVersion,title:body.title,content:body.content}],response:results=>({...results[0],formalAdoptionPerformed:false})};
  }
  check(body.action === 'migrate' && body.explicit === true, 'SOUND_OWNERSHIP_ACTION', '迁移需要明确动作和逐项核对');
  const source = exactReference(body.source, 'source');
  check(source.kind==='ENTITY','SOUND_SOURCE_KIND','迁移来源必须声明为 ENTITY');
  const inventory = await soundMigrationInventory(tx, source.objectId);
  check(!inventory.sourceHistorical && sameReference({...source,kind:'ENTITY'}, inventory.source) && source.expectedVersion === inventory.source.expectedVersion, 'SOUND_SOURCE_CHANGED', '迁移前须刷新声音主体的当前版本和精确修订', 409);
  check(body.inventoryHash === inventory.inventoryHash, 'SOUND_INVENTORY_CHANGED', '声音资源、候选或引用清单已改变，请重新核对', 409);
  check(Array.isArray(body.bindings) && body.bindings.length > 0 && body.bindings.length <= 99, 'SOUND_BINDINGS_REQUIRED', '迁移须提供 1 至 99 条明确或待确认归属记录');
  const ids = new Set(), commands = [], covered = new Set();
  for (const binding of body.bindings) {
    objectValue(binding, 'binding'); identity(binding.bindingId, 'bindingId');
    check(!ids.has(binding.bindingId) && binding.bindingId !== source.objectId, 'SOUND_BINDING_DUPLICATE', '声音归属记录身份不能重复'); ids.add(binding.bindingId);
    check(binding.status==='ASSIGNED'?binding.pending===undefined:binding.target===undefined||binding.target===null,'SOUND_PENDING_CONFLICT','明确归属与待确认信息不能混用');
    const status = binding.status === 'UNKNOWN' ? 'PENDING_CONFIRMATION' : binding.status;
    const content = {role:SOUND_OWNERSHIP_ROLE,schemaVersion:'1.0',status,usage:binding.usage,source:{...source,kind:'ENTITY'},resources:binding.resources || [],
      ...(status === 'ASSIGNED' ? {target:binding.target} : {pending:binding.pending})};
    validateSoundOwnershipContent(content);
    await validateSoundOwnershipTargets(tx, content);
    for (const resource of content.resources) {
      const expected = inventory.resources.find(r => r.objectId === resource.objectId);
      check(expected && sameReference(expected, resource) && expected.expectedVersion === resource.expectedVersion, 'SOUND_RESOURCE_CHANGED', '迁移资源不属于已核对的当前引用闭包', 409, {id:resource.objectId});
      covered.add(resource.objectId);
    }
    commands.push({type:'save',id:binding.bindingId,kind:'NOTE',expectedVersion:0,title:binding.title || '声音归属 · ' + source.objectId,content});
  }
  check(inventory.resources.every(r => covered.has(r.objectId)), 'SOUND_REFERENCES_UNCOVERED', '每项声音设定、表现、需求和素材均须明确归属或记录待确认', 409, {ids:inventory.resources.filter(r=>!covered.has(r.objectId)).map(r=>r.objectId)});
  commands.push({type:'sound.retire',id:source.objectId,expectedVersion:source.expectedVersion,revisionId:source.revisionId,sha256:source.sha256,bindingIds:[...ids],inventoryHash:inventory.inventoryHash,retainedObjectIds:inventory.retainedObjectIds});
  return {commands,response:results=>({sourceId:source.objectId,sourceVersion:results.at(-1).version,sourceHistorical:true,bindingIds:[...ids],bindings:results.slice(0,-1),preservationHash:inventory.preservationHash,formalAdoptionPerformed:false})};
}

export async function retireSoundEntity(tx, command, context) {
  check(context.soundMigration === true && context.actor.kind !== 'ASSISTANT', 'EXPLICIT_SOUND_MIGRATION_REQUIRED', '退出旧声音主体必须使用完整声音迁移事务', 403);
  const inventory = await soundMigrationInventory(tx, command.id);
  check(!inventory.sourceHistorical && inventory.inventoryHash === command.inventoryHash && inventory.source.expectedVersion === command.expectedVersion, 'SOUND_INVENTORY_CHANGED', '提交时声音源、资源或引用已改变', 409);
  const bindings = (await tx.query(`SELECT o.id,r.content FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
    WHERE o.id=ANY($1::text[]) AND NOT o.historical AND o.kind='NOTE' AND r.content->>'role'=$2`, [command.bindingIds, SOUND_OWNERSHIP_ROLE])).rows;
  check(bindings.length === command.bindingIds.length && bindings.every(row => sameReference(row.content.source, inventory.source)), 'SOUND_BINDINGS_CHANGED', '声音归属记录未完整保留原修订', 409);
  for (const row of bindings) await validateSoundOwnershipTargets(tx, row.content);
  const covered = new Set(bindings.flatMap(r => r.content.resources.map(ref => ref.objectId)));
  check(inventory.resources.every(r => covered.has(r.objectId)), 'SOUND_REFERENCES_UNCOVERED', '仍有声音资源未记录归属', 409);
  await tx.query("UPDATE objects SET state='ARCHIVED',historical=true,version=version+1,updated_at=now() WHERE id=$1", [command.id]);
  const after = await soundMigrationInventory(tx, command.id);
  check(after.preservationHash === inventory.preservationHash, 'SOUND_PRESERVATION_CHANGED', '迁移影响了原修订、素材或引用，事务已回滚', 409);
  const evidence = {schemaVersion:'1.0',source:inventory.source,bindingIds:command.bindingIds,resources:inventory.resources,retainedObjectIds:inventory.retainedObjectIds,preservationHash:inventory.preservationHash,operationId:context.operationId};
  await tx.query("INSERT INTO provenance(id,object_id,revision_id,kind,original_id,original_sha256,content) VALUES($1,$2,$3,'sound-ownership-migration',$4,$5,$6)", ['sound_migration_' + context.operationId,command.id,command.revisionId,context.operationId,hash(evidence),evidence]);
  return {id:command.id,version:command.expectedVersion + 1,state:'ARCHIVED',historical:true,bindingIds:command.bindingIds,preservationHash:inventory.preservationHash};
}

export async function soundOwnershipBindings(tx, {ownerId, resourceIds, sourceId, status, query = '', limit = 500, offset = 0, objectId, page = false} = {}) {
  for (const id of [ownerId, sourceId, objectId].filter(v=>v!==undefined)) identity(id);
  if (resourceIds !== undefined) {check(Array.isArray(resourceIds) && resourceIds.length <= 5000, 'SOUND_RESOURCES', '资源筛选须为有界列表');resourceIds.forEach(id=>identity(id));}
  check(Number.isInteger(limit) && limit > 0 && limit <= 1000 && Number.isInteger(offset) && offset >= 0, 'PAGE_RANGE', '声音归属读取范围无效');
  check(!status || ['ASSIGNED','UNKNOWN','PENDING_CONFIRMATION'].includes(status), 'SOUND_OWNERSHIP_STATUS', '声音归属筛选状态无效');
  check(typeof query === 'string' && query.length <= 300, 'SEARCH_RANGE', '声音搜索词过长');
  let rows = (await tx.query(`SELECT o.id,o.title,o.version,o.state,r.id AS revision_id,r.sha256,r.content,
      EXISTS(SELECT 1 FROM invalidations i WHERE i.consumer_revision_id=r.id) AS stale
    FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
    WHERE o.kind='NOTE' AND NOT o.historical AND r.content->>'role'=$1
      AND ($2::text IS NULL OR r.content#>>'{target,objectId}'=$2)
      AND ($3::text IS NULL OR r.content#>>'{source,objectId}'=$3)
      AND ($4::text IS NULL OR CASE WHEN r.content->>'status' IN('UNKNOWN','PENDING_CONFIRMATION') THEN 'UNKNOWN' ELSE r.content->>'status' END=$4)
      AND ($5::text[] IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.content->'resources') ref WHERE ref->>'objectId'=ANY($5)))
      AND ($9::text IS NULL OR r.content#>>'{target,objectId}'=$9 OR r.content#>>'{source,objectId}'=$9 OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.content->'resources') ref WHERE ref->>'objectId'=$9))
      AND ($6='' OR o.title ILIKE $6 OR r.content->>'usage' ILIKE $6 OR r.content->'pending'->>'reason' ILIKE $6)
    ORDER BY o.position,o.id LIMIT $7 OFFSET $8`, [SOUND_OWNERSHIP_ROLE,ownerId || null,sourceId || null,status ? (status === 'ASSIGNED' ? status : 'UNKNOWN') : null,resourceIds || null,query ? '%' + query.replace(/[\\%_]/g,'\\$&') + '%' : '',limit + 1,offset,objectId || null])).rows;
  const hasMore=rows.length>limit;
  check(page || !hasMore, 'WORKSPACE_LIMIT', '声音归属记录超过读取范围，请按永久目标、资源筛选或使用 offset', 413);
  rows=rows.slice(0,limit);
  const refs = [...new Map(rows.flatMap(row=>[row.content.source,row.content.target,...row.content.resources].filter(Boolean)).map(ref=>[ref.objectId+'\0'+ref.revisionId,ref])).values()];
  const exact = refs.length ? (await tx.query(`SELECT o.id,o.kind,o.version,o.historical,r.id AS revision_id,r.sha256,r.content,
      COALESCE(o.draft_revision_id,o.adopted_revision_id) AS head_revision_id
    FROM objects o JOIN revisions r ON r.object_id=o.id WHERE (o.id,r.id) IN (SELECT * FROM unnest($1::text[],$2::text[]))`, [refs.map(r=>r.objectId),refs.map(r=>r.revisionId)])).rows : [];
  const verified = ref => Boolean(ref && exact.some(row=>row.id===ref.objectId && row.revision_id===ref.revisionId && matchesKind(row,ref) && row.sha256===ref.sha256));
  const current = ref => Boolean(ref && exact.some(row=>row.id===ref.objectId && row.head_revision_id===ref.revisionId && !row.historical));
  const result=rows.map(row=>({...row.content,id:row.id,title:row.title,version:row.version,revisionId:row.revision_id,revisionSha256:row.sha256,state:row.state,stale:row.stale,resolution:pendingSound(row.content)?'UNKNOWN':'ASSIGNED',
    exactReferences:{source:row.content.source?verified(row.content.source):null,target:row.content.target?verified(row.content.target):null,resources:Object.fromEntries(row.content.resources.map(ref=>[ref.objectId,verified(ref)]))},
    currentReferences:{target:row.content.target?current(row.content.target):null,resources:Object.fromEntries(row.content.resources.map(ref=>[ref.objectId,current(ref)]))}}));
  Object.defineProperty(result,'hasMore',{value:hasMore});
  return result;
}

export async function soundOwnershipProjection(unit, options = {}) {
  const bindings = await soundOwnershipBindings(unit.tx, options);
  for (const binding of bindings) unit.bind?.({id:binding.id,revisionId:binding.revisionId,version:binding.version,sha256:binding.revisionSha256});
  return bindings;
}
export function soundResourceScope(bindings, resourceId) {
  const relevant = bindings.filter(binding=>binding.resources.some(ref=>ref.objectId===resourceId));
  const targets = relevant.filter(b=>b.status==='ASSIGNED' && b.exactReferences.target && b.exactReferences.resources[resourceId]);
  const current=targets.filter(b=>!b.stale&&b.currentReferences.target&&b.currentReferences.resources[resourceId]);
  const ids = kind => [...new Set(current.filter(b=>b.target.kind===kind).map(b=>b.target.objectId))];
  return {soundOwnership:relevant,soundOwnerIds:targets.map(b=>b.target.objectId),soundSpaceIds:ids('SPACE'),soundStoryIds:ids('STORY'),soundEpisodeIds:ids('EPISODE'),soundSceneIds:ids('SCENE'),soundShotIds:ids('SHOT'),soundOwnershipPending:relevant.some(pendingSound),soundOwnershipStale:targets.length!==current.length};
}
export async function legacySoundSources(tx, sourceId) {
  const rows=(await tx.query(`SELECT o.id,o.title,o.version,o.historical,r.id AS "revisionId",r.sha256 AS "revisionSha256"
    FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
    WHERE o.kind='ENTITY' AND r.content->>'type'='SOUND' AND ($1::text IS NULL OR o.id=$1) ORDER BY o.id LIMIT 1001`, [sourceId || null])).rows;
  check(rows.length<=1000,'SOUND_INVENTORY_LIMIT','旧声音来源超过读取上限，请按 sourceId 读取',413);
  return rows;
}
export async function soundOwnershipWorkspace(unit, options = {}) {
  const bindings = await soundOwnershipProjection(unit, {...options,page:true});
  return {hasMore:bindings.hasMore,nextOffset:bindings.hasMore?(options.offset||0)+(options.limit||500):null,schemaVersion:'1.0',snapshotId:await unit.namespace(),bindings,pending:bindings.filter(pendingSound),
    ...(!options.ownerId && !options.resourceIds ? {legacySources:await legacySoundSources(unit.tx,options.sourceId)} : {}),
    counts:{assigned:bindings.filter(b=>b.status==='ASSIGNED').length,pending:bindings.filter(pendingSound).length}};
}

// SQL fragment built only from trusted column expressions and bound parameters.
export function soundResourceOwnerSql(resourceIdsSql, ownerSql) {
  return `EXISTS(SELECT 1 FROM objects so JOIN revisions sr ON sr.id=COALESCE(so.draft_revision_id,so.adopted_revision_id)
    WHERE so.kind='NOTE' AND NOT so.historical AND sr.content->>'role'='SOUND_OWNERSHIP' AND sr.content->>'status'='ASSIGNED'
      AND sr.content#>>'{target,objectId}'=${ownerSql}
      AND sr.content#>>'{target,revisionId}'=(SELECT COALESCE(t.draft_revision_id,t.adopted_revision_id) FROM objects t WHERE t.id=${ownerSql} AND NOT t.historical)
      AND NOT EXISTS(SELECT 1 FROM invalidations i WHERE i.consumer_revision_id=sr.id)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(sr.content->'resources') ref JOIN objects ro ON ro.id=ref->>'objectId'
        WHERE ro.id IN(${resourceIdsSql}) AND ref->>'revisionId'=COALESCE(ro.draft_revision_id,ro.adopted_revision_id)))`;
}

export async function validateStoredSoundOwnership(tx, revisionId, content) {
  if (!isSound(content)) return;
  await validateSoundOwnershipTargets(tx,content,undefined,{historicalImport:true});
  const links=(await tx.query('SELECT member_id AS id,role FROM revision_memberships WHERE revision_id=$1',[revisionId])).rows;
  check(sameIds(links.map(l=>l.id+'\0'+l.role),soundOwnershipLinks(content).map(l=>l.id+'\0'+l.role)), 'SOUND_STORED_LINKS', '导入声音归属的永久关系与正文不一致', 409);
  const dependencies=(await tx.query('SELECT dependency_revision_id AS "revisionId",purpose FROM dependencies WHERE consumer_revision_id=$1',[revisionId])).rows;
  check(soundOwnershipDependencies(content).every(d=>dependencies.some(row=>row.revisionId===d.revisionId&&row.purpose===d.purpose)), 'SOUND_STORED_DEPENDENCIES', '导入声音归属缺少精确修订依据', 409);
}
