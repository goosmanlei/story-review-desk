import {validateManifestRender} from './production/manifests.mjs';
import {validateAnimaticRender} from './production/animatic-jobs.mjs';
import {executionRecord} from './production/execution.mjs';
import {sourceObjectCommand} from './story/sources.mjs';
import { mutationGate } from "./runtime-gate.mjs";
import {
  maintenanceKinds,
  validateMaintenance,
} from "./project/maintenance-contract.mjs";
import {
  readFile,
  mkdir,
  copyFile,
  rename,
  rm,
  readdir,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { transaction } from "./db.mjs";
import { check, hash, identity, ReviewError } from "./shared/contracts.mjs";
import { importRecords, fileSha } from "./transfer.mjs";
import { readObject } from "./repository.mjs";
import { execute } from "./commands.mjs";
import { verifyAdoption as verifyInputs } from "./production/service.mjs";
import {reserveConversation} from './collaboration/conversations.mjs';
import {assertSourceVersions} from './collaboration/assistant-context.mjs';
import {validateCommentPolish} from './collaboration/comment-polish.mjs';
import {validateMaterialReview,normalizeMaterialReview} from './collaboration/material-review.mjs';
import {normalizeChangePreview} from './collaboration/change-preview.mjs';

export async function enqueue(pool, request) {
  identity(request.operationId);
  check(
    [
      "AI_SUGGEST",
      "IMPORT",
      "MEDIA_REGISTER",
      "SOURCE_IMPORT",
      "GENERATE",
      "MEDIA_PROCESS",
      "ANIMATIC_RENDER",
      "PRODUCTION_MANIFEST_RENDER",
      ...maintenanceKinds,
    ].includes(request.kind),
    "JOB_KIND",
    "后台任务类型无效",
  );
  if (maintenanceKinds.includes(request.kind)) validateMaintenance(request);
  const fingerprint = { ...request };
  delete fingerprint.filename;
  const requestHash = hash(fingerprint);
  return transaction(pool, async (tx) => {
    await mutationGate(tx, request.runtimeEpoch);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      request.operationId,
    ]);
    const old = (
      await tx.query("SELECT request_hash,status FROM operations WHERE id=$1", [
        request.operationId,
      ])
    ).rows[0];
    if (old) {
      check(
        old.request_hash === requestHash,
        "OPERATION_ID_CONFLICT",
        "同一操作编号不能用于不同请求",
        409,
      );
      return {
        operationId: request.operationId,
        status: old.status,
        replayed: true,
      };
    }
    await tx.query("SELECT pg_advisory_xact_lock(890670313)");
    check(
      Number(
        (
          await tx.query(
            "SELECT count(*) AS n FROM operations WHERE status IN ('QUEUED','RUNNING')",
          )
        ).rows[0].n,
      ) < 100,
      "QUEUE_FULL",
      "后台队列已满，请稍后再试",
      429,
    );
    if (["AI_SUGGEST", "GENERATE", "MEDIA_PROCESS"].includes(request.kind)) {
      if(request.assistant||request.commentPolish||request.materialReview){
        const context=(request.assistant||request.commentPolish||request.materialReview).context;
        const ids=[...new Set([request.objectId,...context.sourceVersions.map(s=>s.objectId)])].sort();
        for(const id of ids)await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[id]);
        await tx.query('SELECT id FROM objects WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[ids]);
      }
      const object = (
        await tx.query("SELECT * FROM objects WHERE id=$1 FOR UPDATE", [
          request.objectId,
        ])
      ).rows[0];
      check(
        object && object.version === request.expectedVersion,
        "VERSION_CONFLICT",
        "对象版本已改变",
        409,
      );
      check(
        [object.draft_revision_id, object.adopted_revision_id].includes(
          request.revisionId,
        ),
        "REVISION_CONFLICT",
        "任务依据修订无效",
        409,
      );
      if (request.kind === "AI_SUGGEST") {
        const configuration = (
          await tx.query(
            "SELECT content FROM configurations WHERE scope='system'",
          )
        ).rows[0];
        check(
          configuration?.content.assistant?.enabled !== false,
          "ASSISTANT_DISABLED",
          "系统配置已停用 AI 助手",
          409,
        );
      }
      if (request.kind === "AI_SUGGEST")
        check(
          typeof request.prompt === "string" &&
            request.prompt.trim() &&
            request.prompt.length <= 16000,
          "PROMPT_REQUIRED",
          "请填写有界的问题",
        );
      else {
        check(
          request.authorized === true &&
            request.authorization?.objectId === object.id &&
            request.authorization?.revisionId === request.revisionId,
          "GENERATION_AUTHORIZATION",
          "制作任务需要本轮精确生成授权",
          403,
        );
        check(
          object.kind === "INPUT_LOCK" &&
            object.state === "ADOPTED" &&
            object.adopted_revision_id === request.revisionId,
          "INPUT_LOCK_REQUIRED",
          "制作任务须绑定已采用的实际输入锁定",
          409,
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM invalidations WHERE consumer_revision_id=$1 LIMIT 1",
              [request.revisionId],
            )
          ).rowCount,
          "STALE_INPUT",
          "实际输入依据已改变",
          409,
        );
        await verifyInputs(tx, object, request.revisionId);
        const families = (
          await tx.query(
            "SELECT m.member_id FROM revision_memberships m JOIN material_families f ON f.object_id=m.member_id WHERE m.revision_id=$1 AND m.role='FAMILY'",
            [request.revisionId],
          )
        ).rows;
        check(
          families.length === 1,
          "OUTPUT_FAMILY_REQUIRED",
          "实际输入锁定须明确一个产出素材族",
          409,
        );
      }
    }
    if(request.kind==='PRODUCTION_MANIFEST_RENDER')await validateManifestRender(tx,request);
    if(request.kind==='ANIMATIC_RENDER')await validateAnimaticRender(tx,request);
    if(request.executionRequestId){
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[request.executionRequestId]);
      const grant=await executionRecord(tx,request.executionRequestId),expected=grant.result.workspace.generationRequest;
      check(expected&&grant.request.runtimeEpoch===request.runtimeEpoch&&hash({...request,operationId:expected.operationId})===hash(expected),'EXECUTION_GRANT','任务不符合本轮精确授权',409);
      const used=(await tx.query("SELECT id FROM operations WHERE request->>'executionRequestId'=$1 LIMIT 1",[request.executionRequestId])).rows[0];
      check(!used,'EXECUTION_ALREADY_STARTED','本授权已提交，请查询原操作：'+(used?.id||''),409);
    }
    if(request.assistant)await reserveConversation(tx,request);
    if(request.commentPolish)await validateCommentPolish(tx,request);
    if(request.materialReview)await validateMaterialReview(tx,request);
    await tx.query(
      "INSERT INTO operations(id,request_hash,kind,status,request) VALUES($1,$2,$3,'QUEUED',$4)",
      [request.operationId, requestHash, request.kind, request],
    );
    return { operationId: request.operationId, status: "QUEUED" };
  });
}
export async function cancelJob(
  pool,
  id,
  request = { operationId: "cancel-" + id },
) {
  identity(id);
  identity(request.operationId);
  const fingerprint = hash({
    kind: "CANCEL",
    id,
    runtimeEpoch: request.runtimeEpoch || null,
  });
  return transaction(pool, async (tx) => {
    await mutationGate(tx, request.runtimeEpoch);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      request.operationId,
    ]);
    const old = (
      await tx.query("SELECT * FROM operations WHERE id=$1", [
        request.operationId,
      ])
    ).rows[0];
    if (old) {
      check(
        old.request_hash === fingerprint,
        "OPERATION_ID_CONFLICT",
        "取消操作编号已用于其他请求",
        409,
      );
      return old.result;
    }
    const result = await tx.query(
      "UPDATE operations SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status='QUEUED' RETURNING id",
      [id],
    );
    check(
      result.rowCount === 1,
      "CANCEL_CONFLICT",
      "只有尚未启动的任务可以直接取消；其他状态先查询结果",
      409,
    );
    const receipt = {
      operationId: request.operationId,
      status: "SUCCEEDED",
      cancelledOperationId: id,
    };
    await tx.query(
      "INSERT INTO operations(id,request_hash,kind,status,request,result) VALUES($1,$2,'CANCEL','SUCCEEDED',$3,$4)",
      [request.operationId, fingerprint, { id }, receipt],
    );
    return receipt;
  });
}
export async function suggestion(pool, id) {
  const result = (
    await pool.query(
      'SELECT operation_id AS "operationId",object_id AS "objectId",based_on_revision_id AS "revisionId",content,expires_at AS "expiresAt",applied_revision_id AS "appliedRevisionId" FROM suggestions WHERE operation_id=$1 AND (expires_at>now() OR applied_revision_id IS NOT NULL)',
      [id],
    )
  ).rows[0];
  check(
    result,
    "SUGGESTION_EXPIRED",
    "建议尚未完成或已超过 10 分钟保留期",
    404,
  );
  return result;
}
export async function applySuggestion(pool, id, request) {
  identity(request.objectId);
  return execute(pool, {
    operationId: request.operationId,
    runtimeEpoch: request.runtimeEpoch,
    actor: { kind: "HUMAN", label: "用户应用 AI 建议" },
    commands: [
      {
        type: "suggestion.apply",
        suggestionId: id,
        id: request.objectId,
        expectedVersion: request.expectedVersion,
      },
    ],
  });
}
async function registerMedia(
  pool,
  request,
  root,
  { recordOperation = true } = {},
) {
  check(
    path.dirname(request.filename) === path.join(root, "runtime", "spool"),
    "SPOOL_PATH",
    "媒体须来自当前实例的受控暂存目录",
  );
  check(
    (await fileSha(request.filename)) === request.sha256,
    "MEDIA_HASH",
    "暂存媒体 SHA 不符",
    409,
  );
  await mkdir(path.join(root, "media"), { recursive: true });
  const destination = path.join(root, "media", request.sha256),
    exists = await lstat(destination).catch(() => null);
  if (exists)
    check(
      exists.isFile() &&
        !exists.isSymbolicLink() &&
        (await fileSha(destination)) === request.sha256,
      "MEDIA_COLLISION",
      "同 SHA 媒体目标出现未知内容",
      409,
    );
  else await copyFile(request.filename, destination, 1);
  if (request.forImport)
    return {
      operationId: request.operationId,
      status: "SUCCEEDED",
      sha256: request.sha256,
      bytes: request.bytes,
    };
  return transaction(pool, async (tx) => {
    const old = (
      await tx.query(
        "SELECT sha256,byte_size FROM media WHERE id=$1 AND version_id=$2",
        [request.mediaId, request.versionId],
      )
    ).rows[0];
    check(
      !old ||
        (old.sha256 === request.sha256 &&
          Number(old.byte_size) === request.bytes),
      "MEDIA_VERSION_CONFLICT",
      "媒体版本身份已被其他字节占用",
      409,
    );
    if (!old)
      await tx.query(
        "INSERT INTO media(id,version_id,sha256,byte_size,mime_type,availability,evidence) VALUES($1,$2,$3,$4,$5,'PRESENT',$6)",
        [
          request.mediaId,
          request.versionId,
          request.sha256,
          request.bytes,
          request.mimeType || "application/octet-stream",
          { operationId: request.operationId },
        ],
      );
    const result = {
      operationId: request.operationId,
      status: "SUCCEEDED",
      mediaId: request.mediaId,
      versionId: request.versionId,
      sha256: request.sha256,
    };
    if (recordOperation)
      await tx.query(
        "UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now() WHERE id=$1",
        [request.operationId, result],
      );
    return result;
  });
}
export async function workOnce(pool, { root, workerId, providers = {} }) {
  const job = await transaction(pool, async (tx) => {
    const result = (
      await tx.query(
        "SELECT * FROM operations WHERE status='QUEUED' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!result) return null;
    await tx.query(
      "UPDATE operations SET status='RUNNING',worker_id=$2,lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
      [result.id, workerId],
    );
    return result;
  });
  if (!job) return false;
  const heartbeat = setInterval(
    () =>
      pool
        .query(
          "UPDATE operations SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND worker_id=$2 AND status='RUNNING'",
          [job.id, workerId],
        )
        .catch(() => {}),
    5000,
  );
  heartbeat.unref();
  let externalStarted = false,
    externalCompleted = false;
  try {
    let result;
    const request = job.request;
    if (request.filename)
      check(
        path.dirname(request.filename) === path.join(root, "runtime", "spool"),
        "SPOOL_PATH",
        "任务暂存目录无效",
      );
    if (maintenanceKinds.includes(job.kind)) {
      check(
        typeof providers.maintenance === "function",
        "MAINTENANCE_UNAVAILABLE",
        "本机维护工作器尚未配置",
        503,
      );
      result = await providers.maintenance(request);
    } else if (job.kind === "IMPORT")
      result = await importRecords(pool, request.filename, {
        expectedSha256: request.sha256,
        mediaRoot: path.join(root, "media"),
        operationId: job.id,
      });
    else if (job.kind === "MEDIA_REGISTER")
      result = await registerMedia(pool, request, root);
    else if(job.kind==='SOURCE_IMPORT'){
      let text=null;
      if((request.mimeType.startsWith('text/')||request.mimeType==='application/json'||/\.(txt|md|json|srt|vtt)$/i.test(request.originalFilename))&&request.bytes<=8*1024*1024){
        const bytes=await readFile(request.filename);check(hash(bytes)===request.sha256,'SOURCE_SHA','来源字节 SHA 不符',409);
        try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{/* Keep the exact original when text cannot be decoded. */}
      }
      await registerMedia(pool,request,root,{recordOperation:false});
      const command=sourceObjectCommand(request,text),receipt=await execute(pool,{operationId:job.id+':register-source',runtimeEpoch:request.runtimeEpoch,actor:{kind:'HUMAN',label:'用户导入来源'},commands:[command]});
      check(receipt.status==='SUCCEEDED','SOURCE_REGISTRATION','来源登记未完成，请查询原操作',409,{receipt});
      result={sourceId:command.id,revisionId:receipt.results[0].revisionId,sha256:request.sha256,textAvailable:text!==null,observation:text===null?'ORIGINAL_UNOBSERVED':'TEXT_AVAILABLE',formalAdoptionPerformed:false};
    }
    else if (job.kind === "AI_SUGGEST") {
      const configuration = (
        await pool.query(
          "SELECT content FROM configurations WHERE scope='system'",
        )
      ).rows[0];
      check(
        configuration?.content.assistant?.enabled !== false,
        "ASSISTANT_DISABLED",
        "系统配置已停用 AI 助手",
        409,
      );
      check(
        typeof providers.suggest === "function",
        "ASSISTANT_NOT_CONFIGURED",
        "本机尚未配置 AI 助手",
        503,
      );
      const object = await readObject(pool, request.objectId);
      check(
        object.version === request.expectedVersion &&
          object.revision.id === request.revisionId,
        "SUGGESTION_STALE",
        "排队期间对象已改变",
        409,
      );
      if(request.assistant)await transaction(pool,tx=>assertSourceVersions(tx,request.assistant.context.sourceVersions),{readOnly:true});
      if(request.commentPolish)await transaction(pool,tx=>validateCommentPolish(tx,request),{readOnly:true});
      if(request.materialReview)await transaction(pool,tx=>validateMaterialReview(tx,request),{readOnly:true});
      externalStarted = true;
      const value = await providers.suggest({
        request,
        object,
        onRequestId: (id) =>
          pool.query(
            "UPDATE operations SET provider_request_id=$2 WHERE id=$1",
            [job.id, id],
          ),
      });
      externalCompleted = true;
      check(
        value &&
          typeof value.summary === "string" &&
          value.patch &&
          typeof value.patch === "object" &&
          !Array.isArray(value.patch) &&
          Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024,
        "SUGGESTION_FORMAT",
        "助手输出未通过格式校验",
      );
      if(request.assistant){
        normalizeChangePreview(request,object,value);
        const drafts=value.draftSuggestions||[];
        check(Array.isArray(drafts)&&drafts.length<=8&&new Set(drafts.map(d=>d.targetId)).size===drafts.length&&drafts.every(d=>request.assistant.context.draftTargets.some(t=>t.id===d.targetId)&&typeof d.text==='string'&&d.text.length<=16000),'SUGGESTION_TARGET','助手建议未绑定本轮草稿字段');
        value.draftSuggestions=drafts;
        value.sourceVersions=[...request.assistant.context.sourceVersions,...value.sourceVersions||[]];
        const observed=value.observedImageIds||[];
        check(Array.isArray(observed)&&observed.length<=4&&observed.every(id=>value.sourceVersions.some(s=>s.objectId===id&&s.mediaSha256)),'IMAGE_OBSERVATION','原图观察声明缺少实际读取依据');
        value.observedImageIds=observed;
      }
      if(request.commentPolish){
        check(value.summary.trim()&&value.summary.length<=16000,'COMMENT_SUGGESTION','评论建议为空或过长');
        value.patch={};value.draftSuggestions=[];value.purpose='COMMENT_POLISH';value.sourceVersions=[...request.commentPolish.context.sourceVersions,...value.sourceVersions||[]];
      }
      if(request.materialReview)normalizeMaterialReview(request,value);
      await transaction(pool, async (tx) => {
        await tx.query(
          "INSERT INTO suggestions(operation_id,object_id,based_on_revision_id,content) VALUES($1,$2,$3,$4)",
          [job.id, object.id, request.revisionId, value],
        );
        result = {
          operationId: job.id,
          status: "SUCCEEDED",
          suggestionId: job.id,
        };
        await tx.query(
          "UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now() WHERE id=$1",
          [job.id, result],
        );
      });
    } else {
      check(
        typeof (job.kind==='ANIMATIC_RENDER'?providers.renderAnimatic:job.kind==='PRODUCTION_MANIFEST_RENDER'?providers.renderManifest:providers.generate) === "function",
        "PRODUCTION_NOT_CONFIGURED",
        "本机尚未配置相应制作执行器",
        503,
      );
      const object = await readObject(pool, request.objectId);
      check(
        object.version === request.expectedVersion,
        "VERSION_CONFLICT",
        "排队期间制作定义已改变",
        409,
      );
      const inputs = await transaction(pool, async (tx) => {
        if(job.kind==='PRODUCTION_MANIFEST_RENDER')await validateManifestRender(tx,request);
        else if(job.kind==='ANIMATIC_RENDER')await validateAnimaticRender(tx,request,{running:true});
        else await verifyInputs(tx, object, request.revisionId);
        check(
          !(
            await tx.query(
              "SELECT 1 FROM invalidations WHERE consumer_revision_id=$1 LIMIT 1",
              [request.revisionId],
            )
          ).rowCount,
          "STALE_INPUT",
          "排队期间实际输入依据已改变",
          409,
        );
        if(job.kind==='PRODUCTION_MANIFEST_RENDER')return (await tx.query('SELECT o.id,o.kind,r.id AS revision_id,r.sha256,r.content FROM revisions r JOIN objects o ON o.id=r.object_id WHERE r.id=ANY($1::text[])',[request.dependencies.filter(d=>d.purpose==='ACTUAL_INPUT').map(d=>d.revisionId)])).rows;
        return (
          await tx.query(
            "SELECT o.id,o.kind,r.id AS revision_id,r.sha256,r.content FROM dependencies d JOIN revisions r ON r.id=d.dependency_revision_id JOIN objects o ON o.id=r.object_id WHERE d.consumer_revision_id=$1 AND d.purpose='ACTUAL_INPUT'",
            [request.revisionId],
          )
        ).rows;
      });
      for (const input of inputs) {
        input.media = (
          await pool.query(
            "SELECT m.* FROM asset_media a JOIN media m ON (m.id,m.version_id)=(a.media_id,a.media_version_id) WHERE a.revision_id=$1",
            [input.revision_id],
          )
        ).rows;
        for (const media of input.media) {
          const filename = path.join(root, "media", media.sha256),
            info = await lstat(filename).catch(() => null);
          check(
            info?.isFile() &&
              !info.isSymbolicLink() &&
              (await fileSha(filename)) === media.sha256,
            "INPUT_MEDIA_INTEGRITY",
            "实际输入文件缺失或 SHA 已改变",
            409,
          );
          media.filename = filename;
        }
      }
      externalStarted = true;
      const generated = await (job.kind==='ANIMATIC_RENDER'?providers.renderAnimatic:job.kind==='PRODUCTION_MANIFEST_RENDER'?providers.renderManifest:providers.generate)({
        request,
        object,
        inputs,
        onRequestId: (id) =>
          pool.query(
            "UPDATE operations SET provider_request_id=$2 WHERE id=$1",
            [job.id, id],
          ),
      });
      externalCompleted = true;
      try {
        result = await registerGenerated(pool, root, job, object, generated);
      } catch (error) {
        throw Object.assign(error, { requiresRecovery: true });
      }
    }
    await pool.query(
      "UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now(),lease_until=null WHERE id=$1",
      [job.id, result],
    );
    if (request.filename) await rm(request.filename, { force: true });
  } catch (error) {
    const status =
      error.requiresRecovery ||
      (externalStarted &&
        !externalCompleted &&
        !error.resultReceived &&
        error.externalOutcome !== "NOT_STARTED")
        ? "RESULT_UNKNOWN"
        : "FAILED";
    await pool.query(
      "UPDATE operations SET status=$2,error=$3,updated_at=now(),lease_until=null WHERE id=$1",
      [
        job.id,
        status,
        {
          code: error.code || "WORKER_ERROR",
          message:
            error instanceof ReviewError
              ? error.message
              : "后台执行中断，请先查询原操作",
        },
      ],
    );
    if (
      status === "FAILED" &&
      job.request.filename &&
      path.dirname(job.request.filename) === path.join(root, "runtime", "spool")
    )
      await rm(job.request.filename, { force: true });
  } finally {
    clearInterval(heartbeat);
    if (providers.finalize) {
      const row = (
        await pool.query("SELECT status FROM operations WHERE id=$1", [job.id])
      ).rows[0];
      await providers.finalize({ operationId: job.id, status: row.status });
    }
  }
  return true;
}
export async function sweepJobs(pool) {
  await pool.query(
    "UPDATE operations SET status='RESULT_UNKNOWN',error=jsonb_build_object('code','WORKER_LEASE_EXPIRED','message','工作器中断；先核查原请求，禁止自动重试'),updated_at=now() WHERE status='RUNNING' AND lease_until<now()",
  );
  await pool.query("DELETE FROM suggestions WHERE expires_at<=now()");
}

async function registerGenerated(pool, root, job, object, value) {
  check(
    value &&
      Array.isArray(value.outputs) &&
      value.outputs.length > 0 &&
      value.outputs.length <= (job.request.executionRequestId ? 1 : 16),
    "OUTPUT_FORMAT",
    "制作执行器须返回 1 至 16 个实际产物",
  );
  const family = object.links.filter((x) => x.role === "FAMILY");
  check(family.length === 1, "OUTPUT_FAMILY_REQUIRED", "产出素材族绑定缺失");
  const base = path.resolve(value.outputDirectory),
    commands = [];
  for (const [index, output] of value.outputs.entries()) {
    check(
      typeof output.file === "string" &&
        !path.isAbsolute(output.file) &&
        !output.file.split(/[\\/]/).includes(".."),
      "OUTPUT_PATH",
      "产物须属于本次执行目录",
    );
    const filename = path.join(base, output.file);
    let cursor = base;
    for (const part of output.file.split("/")) {
      cursor = path.join(cursor, part);
      check(
        !(await lstat(cursor)).isSymbolicLink(),
        "OUTPUT_PATH",
        "产物路径不能使用符号链接",
      );
    }
    const info = await lstat(filename);
    check(info.isFile(), "OUTPUT_FILE", "执行器未返回实际文件");
    const sha256 = await fileSha(filename);
    check(
      !output.sha256 || output.sha256 === sha256,
      "OUTPUT_HASH",
      "执行器产物 SHA 不符",
    );
    await mkdir(path.join(root, "runtime/spool"), { recursive: true });
    const staged = path.join(root, "runtime/spool", randomUUID());
    await copyFile(filename, staged);
    const id = job.id + ":output:" + index,
      media = await registerMedia(
        pool,
        {
          operationId: job.id,
          filename: staged,
          sha256,
          bytes: info.size,
          mediaId: id,
          versionId: sha256,
          mimeType: output.mimeType || "application/octet-stream",
        },
        root,
        { recordOperation: false },
      );
    await rm(staged);
    commands.push({
      type: "save",
      id,
      kind: "ASSET",
      expectedVersion: 0,
      title: output.title || object.title + " · 产物 " + (index + 1),
      content: {
        description: output.description || "",
        executionOperationId: job.id,
        ...(job.request.manifest?{productionManifest:job.request.manifest.content}:{}),
        basis:{expectedOutputId:object.revision.content.basis?.outputId||object.revision.content.expectedOutputId||job.request.manifest?.expectedOutputId||null,executionRevisionId:job.request.revisionId},
        mediaType: output.mimeType?.split("/")[0] || "UNKNOWN",
      },
      links: [{ id: family[0].id, role: "FAMILY" }],
      dependencies: [{ revisionId: job.request.revisionId, purpose: "ACTUAL_INPUT" },...(job.request.manifest?job.request.dependencies:[])],
      media: [
        {
          id: media.mediaId,
          versionId: media.versionId,
          sha256,
          role: "OUTPUT",
        },
      ],
    });
  }
  const saved = await execute(pool, {
    operationId: job.id + ":register",
    actor: { kind: "PROJECT_CODEX", label: "受控制作工作器" },
    runtimeEpoch:job.request.runtimeEpoch,
    commands,
  });
  check(
    saved.status === "SUCCEEDED",
    "OUTPUT_REGISTRATION",
    "实际产物登记未完成；保留原执行目录，禁止重新调用",
    409,
  );
  return { operationId: job.id, status: 'SUCCEEDED', outputs: saved.results, ...(job.kind==='ANIMATIC_RENDER'?{mediaUrl:'/api/v1/media/'+commands[0].media[0].sha256,observed:false,frameCount:value.frameCount}: {}) };
}
