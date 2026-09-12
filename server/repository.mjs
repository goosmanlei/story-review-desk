import { check, identity } from "./shared/contracts.mjs";
import { transaction } from "./db.mjs";
import { BoundedCache } from "./shared/cache.mjs";
import { workChains, workStateSql } from "./shared/workflow.mjs";
export const readCache = new BoundedCache();
export const summaries = `o.id,o.module,o.kind,o.display_id AS "displayId",o.title,o.version,o.state,o.draft_revision_id AS "draftRevisionId",o.adopted_revision_id AS "adoptedRevisionId",o.position,o.historical,o.updated_at AS "updatedAt"`;
export async function catalog(
  tx,
  {
    module,
    kind,
    owner,
    state,
    query = "",
    offset = 0,
    limit = 50,
    historical = false,
    category,
    mediaType,
    entity,
    lane,
    gate,
    attention,
    actor,
    chain,
    workStage,
    workState,
  } = {},
) {
  check(
    Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 200 &&
      Number.isInteger(offset) &&
      offset >= 0,
    "PAGE_RANGE",
    "分页范围无效",
  );
  const values = [],
    where = [],
    bind = (value) => {
      values.push(value);
      return "$" + values.length;
    };
  if (module) where.push("o.module=" + bind(module));
  if (kind) where.push("o.kind=" + bind(kind));
  if (chain) {
    const group = workChains.find((c) => c.id === chain);
    check(group, "WORK_CHAIN", "工作链无效");
    const stages = workStage
      ? group.stages.filter((s) => s.id === workStage)
      : group.stages;
    check(stages.length, "WORK_STAGE", "工作阶段无效");
    where.push(
      "o.kind=ANY(" + bind(stages.flatMap((s) => s.kinds)) + "::text[])",
    );
  }
  if (workState && workState !== "ALL")
    where.push(
      workState === "NOW"
        ? `(${workStateSql}) IN ('READY','IN_PROGRESS')`
        : `(${workStateSql})=${bind(workState)}`,
    );
  if (state) where.push("o.state=" + bind(state));
  if (category)
    where.push(
      "COALESCE(r.content->>'businessCategoryPrimaryId',fr.content->>'businessCategoryPrimaryId',r.content->>'type',r.content->>'category',r.content->>'subtype',fr.content->>'type',fr.content->>'category','')=" +
        bind(category),
    );
  if (mediaType)
    where.push(
      "COALESCE(r.content->>'mediaType',r.content->>'mediaKind',r.content->>'kind',fr.content->>'mediaType',fr.content->>'mediaKind',fr.content->>'kind','')=" +
        bind(mediaType),
    );
  if (entity)
    where.push(
      `(EXISTS(SELECT 1 FROM memberships m WHERE m.owner_id IN(o.id,fo.id) AND m.member_id=${bind(entity)}) OR (r.content #> '{domainContext,entityIds}') ? $${values.length} OR (fr.content #> '{domainContext,entityIds}') ? $${values.length})`,
    );
  const activity =
    "COALESCE(r.content->>'activityRole',fr.content->>'activityRole',r.content->>'productionLane',fr.content->>'productionLane','')";
  if (lane && ["MATERIAL", "ASSET"].includes(kind)) {
    if (lane === "BASE")
      where.push(activity + " IN ('MATERIAL_PREPARATION','')");
    else if (lane === "PROCESS")
      where.push(activity + " NOT IN ('MATERIAL_PREPARATION','')");
    else where.push(activity + "=" + bind(lane));
  }
  if (gate && ["ASSET", "ASSEMBLY", "DELIVERABLE"].includes(kind))
    where.push(
      "COALESCE(r.content->>'gateId',r.content->>'productionGateId',r.content->>'productionStageId',r.content #>> '{workflow,gateId}','')=" +
        bind(gate),
    );
  if (attention === "true")
    where.push(
      "(o.state IN ('DRAFT','SUBMITTED','CHANGES_REQUESTED') OR EXISTS(SELECT 1 FROM invalidations i WHERE i.consumer_revision_id=COALESCE(o.draft_revision_id,o.adopted_revision_id)))",
    );
  if (actor === "HUMAN") where.push("o.state='SUBMITTED'");
  if (["BOTH", "AI"].includes(actor))
    where.push("o.state IN ('DRAFT','CHANGES_REQUESTED') AND o.kind<>'SOURCE'");
  if (actor === "AUTOMATION")
    where.push(
      "EXISTS(SELECT 1 FROM operations op WHERE op.request->>'objectId'=o.id AND op.status IN ('QUEUED','RUNNING','RESULT_UNKNOWN'))",
    );
  check(
    typeof query === "string" && query.length <= 300,
    "SEARCH_RANGE",
    "搜索词不能超过 300 字",
  );
  if (!historical) where.push("NOT o.historical");
  if (query)
    where.push(
      `(o.title ILIKE ${bind("%" + query.replace(/[\\%_]/g, "\\$&") + "%")} OR o.display_id ILIKE $${values.length} OR (o.kind IN ('SCENE','EPISODE') AND (r.content->>'text' ILIKE $${values.length} OR r.content->>'blocks' ILIKE $${values.length} OR r.content->>'coreAdvance' ILIKE $${values.length})))`,
    );
  if (owner)
    where.push(
      `(EXISTS(SELECT 1 FROM memberships m WHERE m.owner_id IN(o.id,fo.id) AND m.member_id=${bind(owner)}) OR EXISTS(SELECT 1 FROM episode_scenes es WHERE es.scene_id=o.id AND es.episode_id=$${values.length}) OR EXISTS(SELECT 1 FROM memberships m JOIN episode_scenes es ON es.scene_id=m.member_id WHERE m.owner_id IN(o.id,fo.id) AND m.role='SCENE' AND es.episode_id=$${values.length}))`,
    );
  const filter = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(
    (
      await tx.query(
        `SELECT count(*) AS n FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) LEFT JOIN asset_versions fav ON fav.object_id=o.id LEFT JOIN objects fo ON fo.id=fav.family_id LEFT JOIN revisions fr ON fr.id=COALESCE(fo.draft_revision_id,fo.adopted_revision_id) ${filter}`,
        values,
      )
    ).rows[0].n,
  );
  const rows = (
    await tx.query(
      `SELECT ${summaries},r.sha256 AS "revisionSha256",${workStateSql} AS "workState",EXISTS(SELECT 1 FROM invalidations i WHERE i.consumer_revision_id=COALESCE(o.draft_revision_id,o.adopted_revision_id)) AS stale,
       jsonb_strip_nulls(jsonb_build_object('category',COALESCE(r.content->>'businessCategoryPrimaryName',fr.content->>'businessCategoryPrimaryName',r.content->>'type',r.content->>'category',fr.content->>'type',fr.content->>'category'), 'description',left(COALESCE(r.content->>'description',r.content->>'purpose',r.content->>'coreAdvance',r.content->>'narrativeBeat',''),240),'mediaType',COALESCE(r.content->>'mediaType',r.content->>'mediaKind',r.content->>'kind',fr.content->>'kind'),'lane',COALESCE(r.content->>'activityRole',r.content->>'productionLane'),'seconds',r.content #> '{runtime,baseSec}')) AS preview,
       (SELECT jsonb_build_object('id',fo.id,'title',fo.title) FROM asset_versions av JOIN objects fo ON fo.id=av.family_id WHERE av.object_id=o.id) AS family,
       (SELECT jsonb_build_object('sha256',m.sha256,'mimeType',m.mime_type,'availability',m.availability,'assetId',ar.object_id,'adopted',EXISTS(SELECT 1 FROM material_families f WHERE f.object_id=o.id AND f.adopted_asset_id=ar.object_id)) FROM revisions ar JOIN asset_media am ON am.revision_id=ar.id JOIN media m ON m.id=am.media_id AND m.version_id=am.media_version_id WHERE ar.id=CASE WHEN o.kind='ASSET' THEN r.id ELSE COALESCE((SELECT COALESCE(a.adopted_revision_id,a.draft_revision_id) FROM material_families f JOIN objects a ON a.id=f.adopted_asset_id WHERE f.object_id=o.id),(SELECT COALESCE(a.draft_revision_id,a.adopted_revision_id) FROM asset_versions v JOIN objects a ON a.id=v.object_id WHERE v.family_id=o.id ORDER BY a.created_at DESC,a.id LIMIT 1)) END ORDER BY (am.role='OUTPUT') DESC,m.id LIMIT 1) AS thumbnail
       FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) LEFT JOIN asset_versions fav ON fav.object_id=o.id LEFT JOIN objects fo ON fo.id=fav.family_id LEFT JOIN revisions fr ON fr.id=COALESCE(fo.draft_revision_id,fo.adopted_revision_id) ${filter} ORDER BY o.position,o.id LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
      values,
    )
  ).rows;
  return {
    items: rows,
    total,
    offset,
    limit,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
  };
}
export async function objectDetail(tx, id, { revisionId } = {}) {
  identity(id);
  const object = (
    await tx.query(`SELECT ${summaries} FROM objects o WHERE o.id=$1`, [id])
  ).rows[0];
  check(object, "NOT_FOUND", "对象不存在", 404);
  const selected =
    revisionId || object.draftRevisionId || object.adoptedRevisionId;
  const revision = (
    await tx.query(
      'SELECT id,object_id AS "objectId",number,previous_id AS "previousId",content,sha256,author,created_at AS "createdAt" FROM revisions WHERE id=$1 AND object_id=$2',
      [selected, id],
    )
  ).rows[0];
  check(revision, "REVISION_NOT_FOUND", "所选修订不属于该对象", 404);
  const [links, dependencies, media, reviews, invalidations, versions] =
    await Promise.all([
      tx.query(
        "SELECT m.member_id AS id,m.role,m.position,o.title,o.kind,o.version FROM revision_memberships m JOIN objects o ON o.id=m.member_id WHERE m.revision_id=$1 ORDER BY m.position,m.member_id",
        [selected],
      ),
      tx.query(
        'SELECT d.dependency_revision_id AS "revisionId",d.purpose,r.object_id AS "objectId",r.sha256,o.title,o.kind FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id JOIN objects o ON o.id=r.object_id WHERE d.consumer_revision_id=$1 ORDER BY r.object_id',
        [selected],
      ),
      tx.query(
        "SELECT m.*,a.role FROM asset_media a JOIN media m ON m.id=a.media_id AND m.version_id=a.media_version_id WHERE a.revision_id=$1 ORDER BY a.role,m.id",
        [selected],
      ),
      tx.query(
        "SELECT * FROM reviews WHERE object_id=$1 ORDER BY created_at DESC,id LIMIT 20",
        [id],
      ),
      tx.query("SELECT * FROM invalidations WHERE consumer_revision_id=$1", [
        selected,
      ]),
      tx.query(
        'SELECT id,number,sha256,created_at AS "createdAt",author FROM revisions WHERE object_id=$1 ORDER BY number DESC LIMIT 50',
        [id],
      ),
    ]);
  const rights =
    (
      await tx.query(
        'SELECT fact,internal_attestation AS "internalAttestation",evidence FROM rights WHERE revision_id=$1',
        [selected],
      )
    ).rows[0] || null;
  return {
    ...object,
    revision,
    links: links.rows,
    dependencies: dependencies.rows,
    media: media.rows,
    reviews: reviews.rows,
    invalidations: invalidations.rows,
    versions: versions.rows,
    rights,
  };
}
export async function readObject(pool, id, options = {}) {
  return transaction(pool, (tx) => objectDetail(tx, id, options), {
    readOnly: true,
  });
}
export async function workSummary(tx) {
  const project = (
    await tx.query('SELECT instance_id AS "instanceId",title FROM project')
  ).rows[0];
  const counts = (
    await tx.query(
      `SELECT module,kind,state,${workStateSql} AS "workState",count(*)::integer AS count FROM objects o WHERE NOT historical GROUP BY module,kind,state,4 ORDER BY module,kind,state`,
    )
  ).rows;
  const jobs = (
    await tx.query(
      "SELECT id,kind,status,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM operations WHERE status IN ('QUEUED','RUNNING','RESULT_UNKNOWN') ORDER BY created_at LIMIT 100",
    )
  ).rows;
  const attention = (
    await tx.query(
      `SELECT ${summaries} FROM objects o WHERE NOT o.historical AND o.state IN ('SUBMITTED','CHANGES_REQUESTED') ORDER BY o.updated_at DESC LIMIT 30`,
    )
  ).rows;
  return { project, counts, operations: jobs, attention };
}
