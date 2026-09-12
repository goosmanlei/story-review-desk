import { check, hash } from "./shared/contracts.mjs";
import { objectDetail, summaries } from "./repository.mjs";

// A read projection of the selected immutable revision. It neither adopts inputs
// nor turns display scene numbers into identities. All reads share one snapshot.
export async function objectContext(tx, id, { revisionId } = {}) {
  const object = await objectDetail(tx, id, { revisionId });
  const selected = object.revision.id;
  const rows = (
    await tx.query(
      `
    SELECT DISTINCT ${summaries}, m.role FROM objects o JOIN (
      SELECT member_id AS id,role FROM revision_memberships WHERE revision_id=$2
      UNION SELECT owner_id AS id,role FROM memberships WHERE member_id=$1
      UNION SELECT episode_id AS id,'EPISODE' FROM episode_scenes WHERE scene_id=$1
      UNION SELECT scene_id AS id,'SCENE' FROM episode_scenes WHERE episode_id=$1
    ) m ON o.id=m.id WHERE o.id<>$1 ORDER BY o.position,o.id LIMIT 201`,
      [id, selected],
    )
  ).rows;
  const related = rows.slice(0, 200);
  const primary = [];
  for (const kind of ["EPISODE", "SCENE", "REQUIREMENT", "MATERIAL"]) {
    const link = related.find((x) => x.kind === kind);
    if (!link) continue;
    const exact = object.dependencies.find((d) => d.objectId === link.id);
    const detail = await objectDetail(tx, link.id, {
      revisionId: exact?.revisionId,
    });
    primary.push({
      ...detail,
      contextBinding: exact ? "EXACT_INPUT" : "CURRENT_RELATED",
    });
  }
  const comments = (
    await tx.query(
      `SELECT ${summaries},r.content,r.id AS "revisionId" FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
    WHERE o.kind='COMMENT' AND (r.content #>> '{target,objectId}'=$1 OR r.content #>> '{target,subjectId}'=$1 OR r.content->>'sceneId'=$1)
    ORDER BY o.created_at DESC,o.id LIMIT 101`,
      [id],
    )
  ).rows;
  const inputs = (
    await tx.query(
      `SELECT o.id,o.title,o.kind,o.historical,r.id AS "revisionId",r.sha256,d.purpose FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id JOIN objects o ON o.id=r.object_id WHERE d.consumer_revision_id=$1 ORDER BY o.id LIMIT 200`,
      [selected],
    )
  ).rows;
  const consumers = (
    await tx.query(
      `SELECT DISTINCT o.id,o.title,o.kind,o.historical,r.id AS "revisionId",d.purpose FROM dependencies d JOIN revisions r ON r.id=d.consumer_revision_id JOIN objects o ON o.id=r.object_id WHERE d.dependency_revision_id=$1 AND r.id IN(o.draft_revision_id,o.adopted_revision_id) ORDER BY o.id LIMIT 200`,
      [selected],
    )
  ).rows;
  const familyId =
    object.kind === "MATERIAL"
      ? id
      : object.links.find((l) => l.role === "FAMILY")?.id;
  const assets = familyId
    ? (
        await tx.query(
          `SELECT ${summaries},(f.adopted_asset_id=o.id) AS "adoptedAsset" FROM asset_versions a JOIN objects o ON o.id=a.object_id JOIN material_families f ON f.object_id=a.family_id WHERE a.family_id=$1 ORDER BY o.created_at DESC,o.id LIMIT 100`,
          [familyId],
        )
      ).rows
    : [];
  const preview = assets.find((a) => a.adoptedAsset) || assets[0];
  const previewAsset =
    object.kind === "MATERIAL" && assets.length
      ? await objectDetail(tx, preview.id, {
          revisionId: preview.adoptedAsset
            ? preview.adoptedRevisionId
            : undefined,
        })
      : null;
  const sourceIds = object.revision.content.sourceSegmentIds || [];
  const sourceSegments = sourceIds.length
    ? (
        await tx.query(
          `SELECT s.id AS "structureId",r.id AS "revisionId",item FROM objects s JOIN revisions r ON r.id=COALESCE(s.draft_revision_id,s.adopted_revision_id) CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.content->'sourceNarrationIndex','[]')) item WHERE s.kind='STORY' AND item->>'id'=ANY($1::text[]) LIMIT 100`,
          [sourceIds],
        )
      ).rows
    : [];
  const requested = new Map();
  const bind = (revisionId, current = true) => {
    if (revisionId)
      requested.set(revisionId, requested.get(revisionId) || current);
  };
  bind(selected, !revisionId);
  for (const p of primary)
    bind(p.revision.id, p.contextBinding !== "EXACT_INPUT");
  for (const r of [...related, ...assets])
    bind(r.draftRevisionId || r.adoptedRevisionId);
  for (const r of comments) bind(r.revisionId);
  for (const r of sourceSegments) bind(r.revisionId);
  for (const r of inputs) bind(r.revisionId, false);
  if (previewAsset) bind(previewAsset.revision.id, false);
  const basis = (
    await tx.query(
      `SELECT r.object_id AS "objectId",r.id AS "revisionId",r.sha256,o.version AS "objectVersion" FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=ANY($1::text[]) ORDER BY r.id`,
      [[...requested.keys()]],
    )
  ).rows.map((r) => {
    if (!requested.get(r.revisionId)) delete r.objectVersion;
    return r;
  });
  return {
    object,
    objectId: id,
    revisionId: selected,
    version: object.version,
    related,
    relatedTruncated: rows.length > 200,
    primary,
    basis,
    inputs,
    consumers,
    assets,
    previewAsset,
    sourceSegments,
    comments: comments.slice(0, 100),
    commentsTruncated: comments.length > 100,
  };
}

export async function facets(tx, kind) {
  check(
    typeof kind === "string" && kind.length <= 40,
    "KIND_REQUIRED",
    "请选择目录类型",
  );
  const rows = (
    await tx.query(
      `SELECT COALESCE(r.content->>'businessCategoryPrimaryId',fr.content->>'businessCategoryPrimaryId',r.content->>'type',r.content->>'category',r.content->>'subtype',fr.content->>'type',fr.content->>'category','') AS category,
    COALESCE(r.content->>'businessCategoryPrimaryName',fr.content->>'businessCategoryPrimaryName',r.content->>'type',r.content->>'category',r.content->>'subtype',fr.content->>'type',fr.content->>'category','未分类') AS label,
    COALESCE(r.content->>'mediaType',r.content->>'mediaKind',r.content->>'kind',fr.content->>'mediaType',fr.content->>'mediaKind',fr.content->>'kind','') AS "mediaType",
    COALESCE(r.content->>'activityRole',fr.content->>'activityRole',r.content->>'productionLane',fr.content->>'productionLane','') AS lane,count(*)::integer AS count
    FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) LEFT JOIN asset_versions av ON av.object_id=o.id LEFT JOIN objects f ON f.id=av.family_id LEFT JOIN revisions fr ON fr.id=COALESCE(f.draft_revision_id,f.adopted_revision_id) WHERE o.kind=$1 AND NOT o.historical GROUP BY 1,2,3,4 ORDER BY count(*) DESC LIMIT 200`,
      [kind],
    )
  ).rows;
  return { items: rows };
}

export async function relationshipGraph(tx, { owner, offset = 0 } = {}) {
  check(
    Number.isSafeInteger(offset) && offset >= 0,
    "PAGE_RANGE",
    "分页范围无效",
  );
  const rows = (
    await tx.query(
      `SELECT o.id,o.title,o.version,o.state,e.from_id AS "fromId",e.to_id AS "toId",e.relation_type AS type,a.title AS "fromTitle",b.title AS "toTitle",r.content
    FROM entity_relations e JOIN objects o ON o.id=e.object_id JOIN objects a ON a.id=e.from_id JOIN objects b ON b.id=e.to_id JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
    WHERE NOT o.historical AND ($1::text IS NULL OR e.from_id=$1 OR e.to_id=$1) ORDER BY o.position,o.id LIMIT 51 OFFSET $2`,
      [owner || null, offset],
    )
  ).rows;
  return {
    items: rows.slice(0, 50),
    nextOffset: rows.length > 50 ? offset + 50 : null,
  };
}

export async function spatialBaseline(tx) {
  // This is a logical source alias in the business snapshot, never a filesystem
  // lookup or a compiler/read-model dependency. Original coordinates stay read-only.
  const row = (
    await tx.query(
      `SELECT o.id,r.id AS "revisionId",s.logical_path AS "logicalPath",s.original_sha256 AS sha256,s.content_bytes AS bytes
    FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) JOIN source_documents s ON s.revision_id=r.id
    WHERE s.logical_path=$1 ORDER BY o.updated_at DESC,o.id LIMIT 1`,
      ["data/production_map_spec.json"],
    )
  ).rows[0];
  if (!row)
    return {
      status: "NOT_CONFIGURED",
      sourceBinding: null,
      specification: null,
    };
  check(
    row.bytes.byteLength <= 8 * 1024 * 1024 && hash(row.bytes) === row.sha256,
    "SOURCE_HASH",
    "空间来源字节与登记 SHA 不符",
    409,
  );
  let specification;
  try {
    specification = JSON.parse(row.bytes.toString("utf8"));
  } catch {
    check(false, "SPATIAL_FORMAT", "空间来源不是有效的结构化资料", 409);
  }
  const { bytes, ...sourceBinding } = row;
  return { status: "AVAILABLE", sourceBinding, specification };
}
