/** Rebuildable PostgreSQL read model. Original revisions and events remain authority. */
const array = value => Array.isArray(value) ? value : [];
export const QUERY_MODEL_VERSION = 2;
export async function ensureQueryModel(tx,{releaseId}) {
  if(tx.backend!=='postgres')return;
  const marker=await tx.query('SELECT projection_version FROM read_projection_versions WHERE release_id=$1',[releaseId]);
  if(Number(marker.rows[0]?.projection_version)===QUERY_MODEL_VERSION)return;
  const release=await tx.readRelease(releaseId);
  if(!release)throw new Error('无法重建未登记发布的读模型');
  await rebuildQueryModel(tx,{releaseId,snapshot:JSON.parse(release.snapshotBytes),recipes:JSON.parse(release.recipesBytes)});
}
const bulky = new Set(['configurationBinding','reviewSpec','acceptanceCriteria','cardSpec','rawMarkdown','scriptText','content','prompt','sourceEvidence','sourceBlocks','evidenceCatalog','reviewDossier','review_dossier']);
export function objectSummary(value) {
  return Object.fromEntries(Object.entries(value).filter(([key])=>!bulky.has(key)));
}
export async function installQueryModel(tx) {
  await tx.query(`CREATE TABLE IF NOT EXISTS read_objects (
    release_id text NOT NULL, collection text NOT NULL, object_id text NOT NULL,
    ordinal integer NOT NULL, title text NOT NULL, family_id text, requirement_id text,
    payload jsonb NOT NULL, summary jsonb NOT NULL, projection_only boolean NOT NULL DEFAULT false,
    PRIMARY KEY(release_id,collection,object_id));
    ALTER TABLE read_objects ADD COLUMN IF NOT EXISTS projection_only boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS read_objects_family ON read_objects(release_id,collection,family_id,object_id);
    CREATE INDEX IF NOT EXISTS read_objects_requirement ON read_objects(release_id,collection,requirement_id,object_id);
    CREATE TABLE IF NOT EXISTS read_memberships (
      release_id text NOT NULL, collection text NOT NULL, object_id text NOT NULL,
      scope_type text NOT NULL, scope_id text NOT NULL,
      PRIMARY KEY(release_id,collection,object_id,scope_type,scope_id));
    CREATE INDEX IF NOT EXISTS read_memberships_scope ON read_memberships(release_id,scope_type,scope_id,collection,object_id);
    CREATE TABLE IF NOT EXISTS read_operational_objects (
      release_id text NOT NULL, collection text NOT NULL, object_id text NOT NULL,
      payload jsonb NOT NULL, PRIMARY KEY(release_id,collection,object_id));
    CREATE TABLE IF NOT EXISTS read_projection_versions (
      release_id text PRIMARY KEY, event_sequence bigint NOT NULL DEFAULT -1, projection_version integer NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS read_sections (
      release_id text NOT NULL, section text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(release_id,section));`);
}
function memberships(row) {
  const result=new Map();
  const add=(kind,id)=>{if(typeof id==='string' && id)result.set(kind+':'+id,{scope_type:kind,scope_id:id});};
  for(const id of [...array(row.episodeUids),row.episodeUid,...array(row.episodeIds),row.episodeId])add('EPISODE',id);
  for(const id of [...array(row.sceneIds),row.sceneId])add('SCENE',id);
  for(const id of [...array(row.shotIds),...array(row.currentShotIds),row.shotId])add('SHOT',id);
  add(row.scopeType,row.scopeId);
  return [...result.values()];
}
export async function rebuildQueryModel(tx,{releaseId,snapshot,recipes}) {
  if(tx.backend!=='postgres')return;
  const model=snapshot.productionModel||{},objects=[],scopes=[];
  for(const [collection,rows] of Object.entries(model)) {
    if(!Array.isArray(rows))continue;
    const seen=new Set();
    rows.forEach((row,ordinal)=>{
      if(!row || typeof row!=='object')return;
      const id=row.id||row.revisionId||row.uid;
      if(typeof id!=='string'||seen.has(id))return;
      seen.add(id);
      objects.push({collection,object_id:id,ordinal,title:String(row.title||row.label||row.name||id),family_id:row.familyId||null,requirement_id:row.requirementRef||null,payload:row,summary:objectSummary(row)});
      for(const scope of memberships(row))scopes.push({collection,object_id:id,...scope});
    });
  }
  const sections={};
  for(const [key,value] of Object.entries(snapshot)) {
    if(key==='productionModel')continue;
    sections[key]=value;
  }
  sections.productionMetadata=Object.fromEntries(Object.entries(model).filter(([,v])=>!Array.isArray(v)));
  sections.recipeMetadata=Object.fromEntries(Object.entries(recipes||{}).filter(([,v])=>!Array.isArray(v)));
  for(const [name,rows]of Object.entries(recipes||{}))if(Array.isArray(rows)){
    const seen=new Set(); rows.forEach((row,ordinal)=>{
      const id=row?.id||row?.definitionId||row?.revisionId;
      if(typeof id!=='string'||seen.has(id))return;seen.add(id);
      objects.push({collection:'recipes:'+name,object_id:id,ordinal,title:String(row.title||row.label||id),family_id:row.familyId||null,requirement_id:row.requirementRef||null,payload:row,summary:objectSummary(row)});
    });
  }
  await tx.query('DELETE FROM read_operational_objects WHERE release_id=$1',[releaseId]);
  await tx.query('DELETE FROM read_memberships WHERE release_id=$1',[releaseId]);
  await tx.query('DELETE FROM read_objects WHERE release_id=$1',[releaseId]);
  await tx.query('DELETE FROM read_sections WHERE release_id=$1',[releaseId]);
  for(let i=0;i<objects.length;i+=200)await tx.query(`INSERT INTO read_objects(release_id,collection,object_id,ordinal,title,family_id,requirement_id,payload,summary)
    SELECT $1, x.collection,x.object_id,x.ordinal,x.title,x.family_id,x.requirement_id,x.payload,x.summary
    FROM jsonb_to_recordset($2::jsonb) AS x(collection text,object_id text,ordinal integer,title text,family_id text,requirement_id text,payload jsonb,summary jsonb)`,[releaseId,JSON.stringify(objects.slice(i,i+200))]);
  for(let i=0;i<scopes.length;i+=500)await tx.query(`INSERT INTO read_memberships
    SELECT $1,x.collection,x.object_id,x.scope_type,x.scope_id FROM jsonb_to_recordset($2::jsonb) AS x(collection text,object_id text,scope_type text,scope_id text)
    ON CONFLICT DO NOTHING`,[releaseId,JSON.stringify(scopes.slice(i,i+500))]);
  for(const [section,payload]of Object.entries(sections))await tx.query(`INSERT INTO read_sections VALUES($1,$2,$3::jsonb) ON CONFLICT(release_id,section) DO UPDATE SET payload=excluded.payload`,[releaseId,section,JSON.stringify(payload)]);
  await tx.query('INSERT INTO read_projection_versions(release_id,projection_version,event_sequence) VALUES($1,$2,-1) ON CONFLICT(release_id) DO UPDATE SET projection_version=excluded.projection_version,event_sequence=-1',[releaseId,QUERY_MODEL_VERSION]);
}
export async function queryObjects(tx,{releaseId,collection,ids,scopeType,scopeId,familyIds,requirementIds,after,offset=0,limit=100,summary=false,required=false,search}) {
  const params=[releaseId,collection],clauses=['o.release_id=$1','o.collection=$2'];
  const param=v=>{params.push(v);return '$'+params.length;};
  if(ids)clauses.push('o.object_id=ANY('+param(ids)+'::text[])');
  if(familyIds)clauses.push('o.family_id=ANY('+param(familyIds)+'::text[])');
  if(requirementIds)clauses.push('o.requirement_id=ANY('+param(requirementIds)+'::text[])');
  if(required)clauses.push("o.payload->>'requirementClass'='REQUIRED'");
  if(scopeType&&scopeType!=='PROJECT'&&scopeId)clauses.push(`EXISTS(SELECT 1 FROM read_memberships m WHERE m.release_id=o.release_id AND m.collection=o.collection AND m.object_id=o.object_id AND m.scope_type=${param(scopeType)} AND m.scope_id=${param(scopeId)})`);
  if(search)clauses.push('o.title ILIKE '+param('%'+search.replace(/[\\%_]/g,'\\$&')+'%'));
  const where=clauses.join(' AND ');
  const count=Number((await tx.query('SELECT count(*) AS total FROM read_objects o WHERE '+where,params)).rows[0].total);
  if(after)clauses.push('o.object_id>'+param(after));
  const pageParams=[...params,Math.min(1000,Math.max(1,limit)),Math.max(0,offset)];
  const result=await tx.query(`SELECT o.object_id, o.${summary?'summary':'payload'} || COALESCE(p.payload,'{}'::jsonb) AS payload
    FROM read_objects o LEFT JOIN read_operational_objects p USING(release_id,collection,object_id)
    WHERE ${clauses.join(' AND ')} ORDER BY o.object_id LIMIT $${pageParams.length-1} OFFSET $${pageParams.length}`,pageParams);
  return {items:result.rows.map(r=>summary?objectSummary(r.payload):r.payload),total:count,lastId:result.rows.at(-1)?.object_id||null};
}
const projectionCollections={materialRequirementsById:'materialRequirements',materialWorkItemsById:'materialWorkItems',workItemsById:'workItems',workPackagesById:'workPackages',assetFamiliesById:'assetFamilies',assetVersionsById:'assetVersions',expectedOutputsById:'expectedOutputs',scriptScenesById:'sceneScriptRevisions',scopeLocksById:'scopeLocks'};
export async function updateOperationalProjection(tx,{releaseId,eventSequence,stateProjection}) {
  if(tx.backend!=='postgres')return;
  await ensureQueryModel(tx,{releaseId});
  const version=await tx.query('SELECT event_sequence FROM read_projection_versions WHERE release_id=$1',[releaseId]);
  if(Number(version.rows[0]?.event_sequence)===eventSequence)return;
  const entries=[];
  for(const [key,collection]of Object.entries(projectionCollections))for(const [id,payload]of Object.entries(stateProjection[key]||{}))entries.push({collection,object_id:id,payload});
  // Actual candidates appended after a release are complete read objects as well.
  // This table is disposable; inserting here never creates an authoritative version.
  for(let i=0;i<entries.length;i+=200)await tx.query(`INSERT INTO read_objects(release_id,collection,object_id,ordinal,title,family_id,requirement_id,payload,summary,projection_only)
    SELECT $1,x.collection,x.object_id,0,COALESCE(x.payload->>'title',x.object_id),x.payload->>'familyId',x.payload->>'requirementRef',x.payload,x.summary,true
    FROM jsonb_to_recordset($2::jsonb) AS x(collection text,object_id text,payload jsonb,summary jsonb)
    ON CONFLICT(release_id,collection,object_id) DO UPDATE SET payload=excluded.payload,summary=excluded.summary,family_id=excluded.family_id,requirement_id=excluded.requirement_id
    WHERE read_objects.projection_only=true`,[releaseId,JSON.stringify(entries.slice(i,i+200).map(e=>({...e,payload:{...e.payload,id:e.payload.id||e.object_id},summary:objectSummary({...e.payload,id:e.payload.id||e.object_id})})))]);
  await tx.query(`DELETE FROM read_objects p WHERE release_id=$1 AND projection_only=true AND NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x(collection text,object_id text) WHERE x.collection=p.collection AND x.object_id=p.object_id)`,[releaseId,JSON.stringify(entries.map(({collection,object_id})=>({collection,object_id})))]);
  for(let i=0;i<entries.length;i+=200)await tx.query(`INSERT INTO read_operational_objects
    SELECT $1,x.collection,x.object_id,x.payload FROM jsonb_to_recordset($2::jsonb) AS x(collection text,object_id text,payload jsonb)
    ON CONFLICT(release_id,collection,object_id) DO UPDATE SET payload=excluded.payload
    WHERE read_operational_objects.payload IS DISTINCT FROM excluded.payload`,[releaseId,JSON.stringify(entries.slice(i,i+200))]);
  await tx.query(`DELETE FROM read_operational_objects p WHERE release_id=$1 AND NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS x(collection text,object_id text) WHERE x.collection=p.collection AND x.object_id=p.object_id)`,[releaseId,JSON.stringify(entries.map(({collection,object_id})=>({collection,object_id})))]);
  await tx.query('UPDATE read_projection_versions SET event_sequence=$2,projection_version=$3 WHERE release_id=$1',[releaseId,eventSequence,QUERY_MODEL_VERSION]);
}
