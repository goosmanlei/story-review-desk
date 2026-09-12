export async function workspaceDraft(tx, name) {
  return (await tx.query('SELECT o.id,o.version,o.state,r.id AS "revisionId",r.content FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE o.id=$1', ['workspace-draft:'+name])).rows[0] || null;
}
