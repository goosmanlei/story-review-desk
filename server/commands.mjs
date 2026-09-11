import { mutationGate } from "./runtime-gate.mjs";
import { transaction } from "./db.mjs";
import { moduleFor } from "./modules.mjs";
import {
  check,
  identity,
  identifier,
  hash,
  objectValue,
  expectedVersion,
  ReviewError,
} from "./shared/contracts.mjs";
import { objectDetail } from "./repository.mjs";
import { validateConfiguration } from "./project/service.mjs";

async function invalidate(
  tx,
  oldRevision,
  newRevision,
  operationId,
  { force = false } = {},
) {
  if (!oldRevision || (!force && oldRevision === newRevision)) return [];
  const rows = (
    await tx.query(
      `WITH RECURSIVE affected(id) AS (
    SELECT consumer_revision_id FROM dependencies WHERE dependency_revision_id=$1
    UNION SELECT d.consumer_revision_id FROM dependencies d JOIN affected a ON d.dependency_revision_id=a.id
  ) INSERT INTO invalidations(consumer_revision_id,changed_revision_id,replacement_revision_id,operation_id)
    SELECT id,$1,$2,$3 FROM affected ON CONFLICT DO NOTHING RETURNING consumer_revision_id`,
      [oldRevision, newRevision, operationId],
    )
  ).rows;
  return rows.map((x) => x.consumer_revision_id);
}
async function current(tx, command) {
  identity(command.id);
  expectedVersion(command.expectedVersion);
  const object = (
    await tx.query("SELECT * FROM objects WHERE id=$1", [command.id])
  ).rows[0];
  check(
    (object?.version || 0) === command.expectedVersion,
    "VERSION_CONFLICT",
    "对象已改变，请保留草稿并重新读取",
    409,
    {
      id: command.id,
      expectedVersion: command.expectedVersion,
      actualVersion: object?.version || 0,
    },
  );
  return object;
}
function validateLinks(links) {
  check(
    Array.isArray(links) && links.length <= 2000,
    "INVALID_LINKS",
    "关联必须是有界列表",
  );
  const roles = [
    "ENTITY",
    "STATE",
    "REPRESENTATION",
    "REQUIREMENT",
    "FAMILY",
    "SCENE",
    "SHOT",
    "EPISODE",
    "OUTPUT",
    "SOURCE",
    "COMMENT",
  ];
  const seen = new Set();
  for (const link of links) {
    identity(link.id);
    check(roles.includes(link.role), "INVALID_LINK_ROLE", "关联职责无效");
    const key = link.id + "\0" + link.role;
    check(!seen.has(key), "DUPLICATE_LINK", "关联重复");
    seen.add(key);
  }
}
async function save(tx, command, context) {
  const old = await current(tx, command),
    kind = old?.kind || command.kind,
    module = moduleFor(kind);
  check(
    !old || !command.kind || old.kind === command.kind,
    "KIND_IMMUTABLE",
    "对象类型不能改写",
  );
  check(
    !old || kind !== "ASSET",
    "ASSET_IMMUTABLE",
    "实际素材不可覆盖，请登记新版本",
    409,
  );
  const content = { ...objectValue(command.content) };
  if (!old && !content.reviewSpec) {
    const configuration = (
      await tx.query(
        "SELECT version,content FROM configurations WHERE scope='system'",
      )
    ).rows[0];
    const matches = (configuration?.content.reviewStandards || []).filter(
      (x) =>
        x.subjectKind === kind &&
        (content.reviewStandardId
          ? x.id === content.reviewStandardId
          : x.default !== false &&
            (!x.mediaType || x.mediaType === content.mediaType)),
    );
    const standard = matches.length === 1 ? matches[0] : null;
    if (standard)
      content.reviewSpec = {
        ...standard,
        configurationVersion: configuration.version,
      };
  }
  module.validate?.(kind, content);
  const title = command.title ?? old?.title;
  check(
    typeof title === "string" && title.trim() && title.length <= 500,
    "TITLE_REQUIRED",
    "请填写标题",
  );
  const previous = old?.draft_revision_id || old?.adopted_revision_id || null;
  const links =
    command.links ??
    (previous
      ? (
          await tx.query(
            "SELECT member_id AS id,role,position FROM revision_memberships WHERE revision_id=$1 ORDER BY position,member_id",
            [previous],
          )
        ).rows
      : []);
  validateLinks(links);
  for (const link of links) {
    const target = (
      await tx.query("SELECT version FROM objects WHERE id=$1", [link.id])
    ).rows[0];
    check(target, "LINK_NOT_FOUND", "关联对象不存在", 409, { id: link.id });
    if (link.expectedVersion !== undefined)
      check(
        target.version === link.expectedVersion,
        "VERSION_CONFLICT",
        "关联对象已改变",
        409,
        { id: link.id },
      );
  }
  const dependencies =
    command.dependencies ??
    (previous
      ? (
          await tx.query(
            'SELECT dependency_revision_id AS "revisionId",purpose FROM dependencies WHERE consumer_revision_id=$1',
            [previous],
          )
        ).rows
      : []);
  check(
    Array.isArray(dependencies) && dependencies.length <= 2000,
    "INVALID_DEPENDENCIES",
    "输入依据必须是有界列表",
  );
  for (const dependency of dependencies) {
    check(
      ["SOURCE", "CONTENT", "DEFINITION", "DESIGN", "ACTUAL_INPUT"].includes(
        dependency.purpose,
      ),
      "INVALID_DEPENDENCY",
      "输入依据职责无效",
    );
    const revision = (
      await tx.query("SELECT object_id,sha256 FROM revisions WHERE id=$1", [
        identity(dependency.revisionId),
      ])
    ).rows[0];
    check(
      revision && (!dependency.sha256 || revision.sha256 === dependency.sha256),
      "INPUT_REVISION_CONFLICT",
      "输入修订不存在或 SHA 不符",
      409,
    );
  }
  const number = Number(
      (
        await tx.query(
          "SELECT COALESCE(max(number),0)+1 AS n FROM revisions WHERE object_id=$1",
          [command.id],
        )
      ).rows[0].n,
    ),
    revisionId = identifier();
  if (!old)
    await tx.query(
      "INSERT INTO objects(id,module,kind,title,display_id,state,draft_revision_id,position) VALUES($1,$2,$3,$4,$5,'DRAFT',$6,$7)",
      [
        command.id,
        module.name,
        kind,
        title,
        command.displayId || "",
        revisionId,
        command.position || 0,
      ],
    );
  await tx.query(
    "INSERT INTO revisions(id,object_id,number,previous_id,content,sha256,author) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      revisionId,
      command.id,
      number,
      previous,
      content,
      hash(content),
      context.actor.label,
    ],
  );
  if (old)
    await tx.query(
      "UPDATE objects SET title=$2,display_id=COALESCE($3,display_id),version=version+1,state='DRAFT',draft_revision_id=$4,position=COALESCE($5,position),updated_at=now() WHERE id=$1",
      [
        command.id,
        title,
        command.displayId ?? null,
        revisionId,
        command.position ?? null,
      ],
    );
  await tx.query("DELETE FROM memberships WHERE owner_id=$1", [command.id]);
  for (const [position, link] of links.entries()) {
    await tx.query(
      "INSERT INTO revision_memberships(revision_id,member_id,role,position) VALUES($1,$2,$3,$4)",
      [revisionId, link.id, link.role, position],
    );
    await tx.query(
      "INSERT INTO memberships(owner_id,member_id,role) VALUES($1,$2,$3)",
      [command.id, link.id, link.role],
    );
  }
  for (const dependency of dependencies)
    await tx.query(
      "INSERT INTO dependencies(consumer_revision_id,dependency_revision_id,purpose) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [revisionId, dependency.revisionId, dependency.purpose],
    );
  // Copying an obsolete input into a new draft does not clear its invalidation.
  await tx.query(
    `WITH RECURSIVE inputs(id) AS (
    SELECT dependency_revision_id FROM dependencies WHERE consumer_revision_id=$1
    UNION SELECT d.dependency_revision_id FROM dependencies d JOIN inputs i ON d.consumer_revision_id=i.id
  ), changed AS (
    SELECT v.id,COALESCE(o.adopted_revision_id,v.id) AS replacement FROM inputs i JOIN revisions v ON v.id=i.id JOIN objects o ON o.id=v.object_id
    WHERE o.state='DISABLED' OR (o.adopted_revision_id IS NOT NULL AND o.adopted_revision_id<>v.id AND EXISTS(SELECT 1 FROM reviews r WHERE r.revision_id=v.id AND r.decision='ADOPT'))
    UNION SELECT x.changed_revision_id,x.replacement_revision_id FROM inputs i JOIN invalidations x ON x.consumer_revision_id=i.id
  ) INSERT INTO invalidations(consumer_revision_id,changed_revision_id,replacement_revision_id,operation_id)
    SELECT $1,id,replacement,$2 FROM changed ON CONFLICT DO NOTHING`,
    [revisionId, context.operationId],
  );
  if (previous) {
    await tx.query(
      "INSERT INTO asset_media(revision_id,media_id,media_version_id,sha256,role) SELECT $1,media_id,media_version_id,sha256,role FROM asset_media WHERE revision_id=$2",
      [revisionId, previous],
    );
    await tx.query(
      "INSERT INTO rights(revision_id,fact,internal_attestation,evidence) SELECT $1,fact,internal_attestation,evidence FROM rights WHERE revision_id=$2",
      [revisionId, previous],
    );
  }
  if (previous && kind === "SOURCE")
    await tx.query(
      "INSERT INTO source_documents(revision_id,original_revision_id,original_sha256,mime_type,content_bytes,logical_path,role) SELECT $1,original_revision_id,original_sha256,mime_type,content_bytes,logical_path,role FROM source_documents WHERE revision_id=$2",
      [revisionId, previous],
    );
  for (const media of command.media || []) {
    check(
      ["ASSET", "SOURCE", "DELIVERABLE", "ASSEMBLY"].includes(kind),
      "MEDIA_OBJECT_KIND",
      "此对象类型不能登记实际媒体",
    );
    const registered = (
      await tx.query("SELECT sha256 FROM media WHERE id=$1 AND version_id=$2", [
        media.id,
        media.versionId,
      ])
    ).rows[0];
    check(
      registered && registered.sha256 === media.sha256,
      "MEDIA_NOT_REGISTERED",
      "媒体须先经后台工作器核验登记",
      409,
    );
    await tx.query(
      "INSERT INTO asset_media(revision_id,media_id,media_version_id,sha256,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        revisionId,
        media.id,
        media.versionId,
        media.sha256,
        media.role || "OUTPUT",
      ],
    );
  }
  if (kind === "ASSET")
    await tx.query(
      "INSERT INTO rights(revision_id,fact) VALUES($1,'UNKNOWN') ON CONFLICT DO NOTHING",
      [revisionId],
    );
  await module.projectLinks?.(
    tx,
    { id: command.id, kind, content },
    revisionId,
    links,
  );
  return {
    id: command.id,
    version: old ? old.version + 1 : 1,
    revisionId,
    state: "DRAFT",
  };
}
async function submit(tx, command) {
  const object = await current(tx, command);
  check(object, "NOT_FOUND", "对象不存在", 404);
  check(
    ["DRAFT", "CHANGES_REQUESTED"].includes(object.state) &&
      object.draft_revision_id,
    "STATE_CONFLICT",
    "只有草稿或要求修改的内容可以提交审阅",
    409,
  );
  check(
    !command.revisionId || command.revisionId === object.draft_revision_id,
    "REVISION_CONFLICT",
    "待审修订已改变",
    409,
  );
  await tx.query(
    "UPDATE objects SET state='SUBMITTED',version=version+1,updated_at=now() WHERE id=$1",
    [object.id],
  );
  return {
    id: object.id,
    version: object.version + 1,
    revisionId: object.draft_revision_id,
    state: "SUBMITTED",
  };
}
async function review(tx, command, context) {
  const object = await current(tx, command);
  check(object, "NOT_FOUND", "对象不存在", 404);
  check(
    context.actor.kind !== "ASSISTANT" && command.explicit === true,
    "EXPLICIT_REVIEW_REQUIRED",
    "正式判断需要明确用户动作或本轮精确授权",
    403,
  );
  check(
    ["ADOPT", "REQUEST_CHANGES", "DISABLE"].includes(command.decision),
    "REVIEW_DECISION",
    "正式判断无效",
  );
  const revisionId = command.revisionId;
  check(
    revisionId &&
      (revisionId === object.draft_revision_id ||
        revisionId === object.adopted_revision_id),
    "REVISION_CONFLICT",
    "所审版本已改变",
    409,
  );
  if (command.decision !== "DISABLE")
    check(
      object.state === "SUBMITTED",
      "STATE_CONFLICT",
      "请先提交待审版本",
      409,
    );
  check(typeof command.note === "string", "REVIEW_NOTE", "请提供判断说明");
  const findings = command.findings || [];
  check(Array.isArray(findings), "REVIEW_FINDINGS", "判断条目无效");
  if (command.decision === "ADOPT")
    check(
      !findings.some((x) => x.verdict === "FAIL"),
      "FAILED_CRITERIA",
      "失败标准不能同时采用",
      409,
    );
  const module = moduleFor(object.kind),
    revision = (
      await tx.query("SELECT content FROM revisions WHERE id=$1", [revisionId])
    ).rows[0];
  const criteria =
    revision.content.reviewSpec?.criteria ||
    revision.content.configurationBinding?.reviewSpec?.criteria ||
    [];
  if (criteria.length)
    for (const criterion of criteria.filter((c) => c.required)) {
      const f = findings.find((x) => x.criterionId === criterion.id);
      check(
        f && ["PASS", "FAIL", "NA"].includes(f.verdict),
        "REQUIRED_CRITERION",
        "请完成全部必填判断",
      );
      check(
        f.verdict !== "NA" || criterion.allowNA,
        "NA_NOT_ALLOWED",
        "此标准不能选择不适用",
      );
      check(
        f.verdict !== "FAIL" || !criterion.noteRequiredOnFail || f.note?.trim(),
        "FINDING_NOTE_REQUIRED",
        "未通过标准需要说明",
      );
    }
  if (command.decision === "ADOPT") {
    const stale = (
      await tx.query(
        "SELECT 1 FROM invalidations WHERE consumer_revision_id=$1 LIMIT 1",
        [revisionId],
      )
    ).rowCount;
    check(!stale, "STALE_INPUT", "依据版本已改变，请修订并核对精确输入", 409);
    await module.verifyAdoption?.(tx, object, revisionId, {
      ...command,
      actor: context.actor,
      operationId: context.operationId,
    });
  }
  const reviewId = identifier("review");
  await tx.query(
    "INSERT INTO reviews(id,object_id,revision_id,decision,findings,note,author,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      reviewId,
      object.id,
      revisionId,
      command.decision,
      JSON.stringify(findings),
      command.note,
      context.actor.label,
      context.operationId,
    ],
  );
  const state = {
    ADOPT: "ADOPTED",
    REQUEST_CHANGES: "CHANGES_REQUESTED",
    DISABLE: "DISABLED",
  }[command.decision];
  await tx.query(
    "UPDATE objects SET state=$2,adopted_revision_id=CASE WHEN $3 THEN $4 ELSE adopted_revision_id END,version=version+1,updated_at=now() WHERE id=$1",
    [object.id, state, command.decision === "ADOPT", revisionId],
  );
  let affected = [];
  if (command.decision === "ADOPT") {
    affected = await invalidate(
      tx,
      object.adopted_revision_id,
      revisionId,
      context.operationId,
    );
    await module.afterAdoption?.(tx, object, revisionId);
  }
  if (command.decision === "DISABLE")
    affected = await invalidate(
      tx,
      revisionId,
      revisionId,
      context.operationId,
      { force: true },
    );
  return {
    id: object.id,
    version: object.version + 1,
    revisionId,
    reviewId,
    state,
    affected,
  };
}
async function configuration(tx, command) {
  const content = validateConfiguration(command.scope, command.content);
  expectedVersion(command.expectedVersion);
  const old = (
    await tx.query(
      "SELECT version FROM configurations WHERE scope=$1 FOR UPDATE",
      [command.scope],
    )
  ).rows[0];
  check(
    (old?.version || 0) === command.expectedVersion,
    "VERSION_CONFLICT",
    "配置已改变",
    409,
  );
  await tx.query(
    "INSERT INTO configurations(scope,version,content) VALUES($1,$2,$3) ON CONFLICT(scope) DO UPDATE SET version=EXCLUDED.version,content=EXCLUDED.content",
    [command.scope, command.expectedVersion + 1, content],
  );
  if (command.scope === "project" && content.title)
    await tx.query("UPDATE project SET title=$1", [content.title]);
  return { scope: command.scope, version: command.expectedVersion + 1 };
}
async function recordRights(tx, command, context) {
  const object = await current(tx, command);
  check(
    object?.kind === "ASSET",
    "ASSET_REQUIRED",
    "权利事实必须绑定实际素材版本",
  );
  check(
    context.actor.kind !== "ASSISTANT" && command.explicit === true,
    "EXPLICIT_RIGHTS_REQUIRED",
    "权利事实需要明确用户动作",
    403,
  );
  check(
    command.revisionId === object.draft_revision_id ||
      command.revisionId === object.adopted_revision_id,
    "REVISION_CONFLICT",
    "素材版本已改变",
    409,
  );
  const fact = command.fact;
  check(
    ["UNKNOWN", "CLEAR", "BLOCKED"].includes(fact),
    "RIGHTS_INVALID",
    "权利事实无效",
  );
  check(
    command.evidence &&
      typeof command.evidence.note === "string" &&
      command.evidence.note.trim(),
    "RIGHTS_EVIDENCE",
    "请记录权利事实依据",
  );
  check(
    fact !== "BLOCKED" || !command.internalAttestation,
    "RIGHTS_BLOCKED",
    "权利阻断不能豁免",
  );
  const attestation = command.internalAttestation === true,
    eventId = identifier("rights");
  await tx.query(
    "INSERT INTO rights_events(id,revision_id,fact,internal_attestation,evidence,author,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      eventId,
      command.revisionId,
      fact,
      attestation,
      command.evidence,
      context.actor.label,
      context.operationId,
    ],
  );
  await tx.query(
    "INSERT INTO rights(revision_id,fact,internal_attestation,evidence) VALUES($1,$2,$3,$4) ON CONFLICT(revision_id) DO UPDATE SET fact=EXCLUDED.fact,internal_attestation=EXCLUDED.internal_attestation,evidence=EXCLUDED.evidence",
    [command.revisionId, fact, attestation, command.evidence],
  );
  await tx.query(
    "UPDATE objects SET version=version+1,updated_at=now() WHERE id=$1",
    [object.id],
  );
  const affected =
    fact === "BLOCKED" || (fact === "UNKNOWN" && !attestation)
      ? await invalidate(
          tx,
          command.revisionId,
          command.revisionId,
          context.operationId,
          { force: true },
        )
      : [];
  return { id: object.id, version: object.version + 1, eventId, affected };
}
async function applySuggestion(tx, command, context) {
  const value = (
    await tx.query(
      "SELECT * FROM suggestions WHERE operation_id=$1 FOR UPDATE",
      [command.suggestionId],
    )
  ).rows[0];
  check(
    value &&
      new Date(value.expires_at) > new Date() &&
      !value.applied_revision_id,
    "SUGGESTION_EXPIRED",
    "建议已应用或超过保留期",
    409,
  );
  const object = await current(tx, command);
  check(
    object &&
      object.id === value.object_id &&
      object.draft_revision_id === value.based_on_revision_id,
    "SUGGESTION_STALE",
    "建议依据已改变，请保留预览并重新生成",
    409,
  );
  const revision = (
    await tx.query("SELECT content FROM revisions WHERE id=$1", [
      value.based_on_revision_id,
    ])
  ).rows[0];
  for (const source of value.content.sourceVersions || []) {
    if (source.revisionId) {
      const row = (
        await tx.query(
          "SELECT r.sha256,o.version FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=$1 AND o.id=$2",
          [source.revisionId, source.objectId],
        )
      ).rows[0];
      check(
        row &&
          row.sha256 === source.sha256 &&
          (!source.objectVersion || row.version === source.objectVersion),
        "SUGGESTION_SOURCE_CHANGED",
        "AI 建议读取的依据已改变，请重新核对",
        409,
      );
    } else if (source.sourceRevisionId) {
      const row = (
        await tx.query(
          "SELECT original_sha256 FROM source_documents WHERE revision_id=$1",
          [source.sourceRevisionId],
        )
      ).rows[0];
      check(
        row?.original_sha256 === source.originalSha256,
        "SUGGESTION_SOURCE_CHANGED",
        "AI 建议读取的原始资料不符",
        409,
      );
    }
  }
  const result = await save(
    tx,
    {
      type: "save",
      id: object.id,
      expectedVersion: command.expectedVersion,
      title: object.title,
      content: {
        ...revision.content,
        ...value.content.patch,
        ...(revision.content.reviewSpec
          ? { reviewSpec: revision.content.reviewSpec }
          : {}),
        ...(revision.content.configurationBinding
          ? { configurationBinding: revision.content.configurationBinding }
          : {}),
      },
    },
    { ...context, actor: { kind: "ASSISTANT", label: "用户应用 AI 建议" } },
  );
  await tx.query(
    "UPDATE suggestions SET applied_revision_id=$2 WHERE operation_id=$1",
    [command.suggestionId, result.revisionId],
  );
  return result;
}
export async function execute(pool, request) {
  identity(request.operationId, "operationId");
  check(
    Array.isArray(request.commands) &&
      request.commands.length > 0 &&
      request.commands.length <= 100,
    "COMMANDS_REQUIRED",
    "一个事务须包含 1 至 100 个操作",
  );
  const actor = request.actor || { kind: "HUMAN", label: "用户" };
  check(
    ["HUMAN", "PROJECT_CODEX", "ASSISTANT"].includes(actor.kind) &&
      typeof actor.label === "string",
    "ACTOR_REQUIRED",
    "操作主体无效",
  );
  const requestHash = hash(request);
  return transaction(pool, async (tx) => {
    await mutationGate(tx, request.runtimeEpoch);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      request.operationId,
    ]);
    const prior = (
      await tx.query("SELECT * FROM operations WHERE id=$1", [
        request.operationId,
      ])
    ).rows[0];
    if (prior) {
      check(
        prior.request_hash === requestHash,
        "OPERATION_ID_CONFLICT",
        "同一操作编号不能用于不同请求",
        409,
      );
      return (
        prior.result || {
          operationId: prior.id,
          status: prior.status,
          error: prior.error,
        }
      );
    }
    await tx.query(
      "INSERT INTO operations(id,request_hash,kind,status,request) VALUES($1,$2,'TRANSACTION','RUNNING',$3)",
      [request.operationId, requestHash, request],
    );
    await tx.query("SAVEPOINT commands");
    try {
      const requested = request.commands
        .flatMap((c) => [c.id, ...(c.links || []).map((x) => x.id)])
        .filter(Boolean);
      const suggestionIds = request.commands
        .filter((c) => c.type === "suggestion.apply")
        .map((c) => c.suggestionId);
      if (suggestionIds.length) {
        const suggestions = (
          await tx.query(
            "SELECT content FROM suggestions WHERE operation_id=ANY($1::text[])",
            [suggestionIds],
          )
        ).rows;
        for (const suggestion of suggestions)
          for (const source of suggestion.content.sourceVersions || [])
            if (source.objectId) requested.push(source.objectId);
      }
      const dependencyIds = request.commands.flatMap((c) =>
        (c.dependencies || []).map((d) => d.revisionId),
      );
      const related = (
        await tx.query(
          `WITH RECURSIVE inputs(id) AS (
        SELECT unnest($2::text[]) UNION SELECT d.dependency_revision_id FROM dependencies d JOIN objects o ON d.consumer_revision_id IN(o.draft_revision_id,o.adopted_revision_id) WHERE o.id=ANY($1::text[])
        UNION SELECT d.dependency_revision_id FROM dependencies d JOIN inputs i ON d.consumer_revision_id=i.id
      ) SELECT DISTINCT r.object_id AS id FROM revisions r JOIN inputs i ON i.id=r.id
        UNION SELECT family_id AS id FROM asset_versions WHERE object_id=ANY($1::text[])
        UNION SELECT member_id AS id FROM memberships WHERE owner_id=ANY($1::text[])`,
          [requested, dependencyIds],
        )
      ).rows;
      const ids = [
        ...new Set([
          ...requested,
          ...related.map((r) => r.id),
          ...request.commands
            .filter((c) => c.type === "configuration.save")
            .map((c) => "configuration:" + c.scope),
        ]),
      ].sort();
      // Object locks serialize versions; the operation lock serializes duplicate requests.
      for (const id of ids)
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", [
          id,
        ]);
      await tx.query(
        "SELECT id FROM objects WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
        [ids],
      );
      const results = [];
      for (const command of request.commands) {
        if (actor.kind === "ASSISTANT")
          check(
            command.type === "save",
            "ASSISTANT_DRAFT_ONLY",
            "AI 建议只能保存为草稿",
            403,
          );
        if (command.type === "save")
          results.push(
            await save(tx, command, {
              actor,
              operationId: request.operationId,
            }),
          );
        else if (command.type === "submit")
          results.push(await submit(tx, command));
        else if (command.type === "review")
          results.push(
            await review(tx, command, {
              actor,
              operationId: request.operationId,
            }),
          );
        else if (command.type === "configuration.save")
          results.push(await configuration(tx, command));
        else if (command.type === "rights.record")
          results.push(
            await recordRights(tx, command, {
              actor,
              operationId: request.operationId,
            }),
          );
        else if (command.type === "suggestion.apply")
          results.push(
            await applySuggestion(tx, command, {
              actor,
              operationId: request.operationId,
            }),
          );
        else throw new ReviewError("COMMAND_UNKNOWN", "不支持的业务操作");
      }
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      const result = {
        operationId: request.operationId,
        status: "SUCCEEDED",
        results,
      };
      await tx.query(
        "UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now() WHERE id=$1",
        [request.operationId, result],
      );
      return result;
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT commands");
      const failed = {
        code:
          error instanceof ReviewError ? error.code : "TRANSACTION_REJECTED",
        message:
          error instanceof ReviewError
            ? error.message
            : "事务未通过数据约束，所有修改均已撤销",
        status: error.status || 409,
        ...(error.details ? { details: error.details } : {}),
      };
      const result = {
        operationId: request.operationId,
        status: "FAILED",
        error: failed,
      };
      await tx.query(
        "UPDATE operations SET status='FAILED',error=$2,result=$3,updated_at=now() WHERE id=$1",
        [request.operationId, failed, result],
      );
      return result;
    }
  });
}
export async function operation(pool, id) {
  identity(id);
  const row = (
    await pool.query(
      'SELECT id AS "operationId",kind,status,result,error,provider_request_id AS "providerRequestId",created_at AS "createdAt",updated_at AS "updatedAt" FROM operations WHERE id=$1',
      [id],
    )
  ).rows[0];
  check(row, "NOT_FOUND", "操作编号不存在", 404);
  return row;
}
