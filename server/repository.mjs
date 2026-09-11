import { check, identity } from "./shared/contracts.mjs";
import { transaction } from "./db.mjs";
import { BoundedCache } from "./shared/cache.mjs";
export const readCache = new BoundedCache();
const summaries = `o.id,o.module,o.kind,o.display_id AS "displayId",o.title,o.version,o.state,o.draft_revision_id AS "draftRevisionId",o.adopted_revision_id AS "adoptedRevisionId",o.position,o.historical,o.updated_at AS "updatedAt"`;
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
  if (state) where.push("o.state=" + bind(state));
  if (!historical) where.push("NOT o.historical");
  if (query)
    where.push(
      `(o.title ILIKE ${bind("%" + query.replace(/[\\%_]/g, "\\$&") + "%")} OR o.display_id ILIKE $${values.length})`,
    );
  if (owner)
    where.push(
      `(EXISTS(SELECT 1 FROM memberships m WHERE m.owner_id=o.id AND m.member_id=${bind(owner)}) OR EXISTS(SELECT 1 FROM episode_scenes es WHERE es.scene_id=o.id AND es.episode_id=$${values.length}) OR EXISTS(SELECT 1 FROM memberships m JOIN episode_scenes es ON es.scene_id=m.member_id WHERE m.owner_id=o.id AND m.role='SCENE' AND es.episode_id=$${values.length}))`,
    );
  const filter = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = Number(
    (await tx.query(`SELECT count(*) AS n FROM objects o ${filter}`, values))
      .rows[0].n,
  );
  const rows = (
    await tx.query(
      `SELECT ${summaries},EXISTS(SELECT 1 FROM invalidations i WHERE i.consumer_revision_id=COALESCE(o.draft_revision_id,o.adopted_revision_id)) AS stale FROM objects o ${filter} ORDER BY o.position,o.id LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
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
      "SELECT module,kind,state,count(*)::integer AS count FROM objects WHERE NOT historical GROUP BY module,kind,state ORDER BY module,kind,state",
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
