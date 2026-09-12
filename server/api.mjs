import {prepareManifestRender} from './production/manifests.mjs';
import {cachedWorkspace} from './presentation/cache.mjs';
import {prepareAnimaticRender} from './production/animatic-jobs.mjs';
import {sourceUploadRequest} from './story/sources.mjs';
import { mutationGate } from "./runtime-gate.mjs";
import { database, machineConfiguration, transaction } from "./db.mjs";
import { catalog, objectDetail, workSummary } from "./repository.mjs";
import {
  objectContext,
  facets,
  relationshipGraph,
  spatialBaseline,
} from "./workspaces.mjs";
import { execute, operation } from "./commands.mjs";
import { workspaceRead } from "./presentation/workspaces.mjs";
import { check, ReviewError, errorBody } from "./shared/contracts.mjs";
import { exportRecords } from "./transfer.mjs";
import { mediaResponse, receiveFile } from "./files.mjs";
import { enqueue, cancelJob, suggestion, applySuggestion } from "./jobs.mjs";
import {assistantContext,publicContext} from './collaboration/assistant-context.mjs';
import {conversationList,prepareConversation,archiveConversation,checkDraftSuggestion,readConversation,turnId} from './collaboration/conversations.mjs';
import {conversationEvents} from './collaboration/events.mjs';
import {prepareCommentPolish,commentPolishResult} from './collaboration/comment-polish.mjs';
import {prepareMaterialReview,materialReviewResult} from './collaboration/material-review.mjs';
import { rm } from "node:fs/promises";
import {
  maintenanceState,
  backupDownload,
  maintenanceKinds,
  workspaceMaintenanceRequest,
} from "./project/maintenance-contract.mjs";

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function requestJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    check(
      size <= 16 * 1024 * 1024,
      "REQUEST_TOO_LARGE",
      "请求超过 16 MiB",
      413,
    );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReviewError("INVALID_JSON", "请求 JSON 无效");
  }
}
export async function dispatch(request) {
  try {
    const url = new URL(request.url),
      route = url.pathname
        .replace(/^.*\/api\/v1\/?/, "")
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent),
      method = request.method;
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      check(
        !origin ||
          new URL(origin).host === request.headers.get("host") ||
          new URL(origin).host === url.host,
        "ORIGIN_REJECTED",
        "请求来源与当前审阅台不一致",
        403,
      );
      if (!["import", "upload"].includes(route[0]) && !['workspaces/sources/file','workspaces/maintenance/upload'].includes(route.join('/'))) {
        check(
          request.headers.get("content-type")?.split(";")[0] ===
            "application/json",
          "CONTENT_TYPE",
          "此接口需要 JSON 请求",
          415,
        );
        const length = Number(request.headers.get("content-length") || 0);
        check(
          length <= 16 * 1024 * 1024,
          "REQUEST_TOO_LARGE",
          "请求超过 16 MiB",
          413,
        );
      }
    }
    const pool = await database();
    const runtimeEpoch = request.headers.get("x-review-runtime");
    if(method==='GET'&&route[0]==='assistant'){
      if(route[1]==='events')return conversationEvents(pool,request,url.searchParams);
      if(route[1]==='conversations')return json(await transaction(pool,tx=>conversationList(tx,url.searchParams),{readOnly:true}));
    }
    if (method === 'GET' && route[0] === 'workspaces') {
      if(route.slice(1).join('/')==='material-review-drafts')return json(await transaction(pool,tx=>materialReviewResult(tx,url.searchParams.get('operationId')),{readOnly:true}));
      if(route.slice(1).join('/')==='script-comments/polish')return json(await transaction(pool,tx=>commentPolishResult(tx,url.searchParams.get('operationId')),{readOnly:true}));
      if (route[1] === 'media' && route[2]) return mediaResponse(request, pool, (await machineConfiguration()).root, route[2]);
      if (route[1] === 'maintenance') {
        const state=await maintenanceState(pool),project=(await pool.query('SELECT instance_id AS "instanceId",runtime_epoch AS "runtimeEpoch" FROM project')).rows[0];
        return json({...state,runtime:{...project,status:'运行中'},storage:{provider:'PostgreSQL',authority:'对象与不可变修订'},capabilities:{verify:true,backup:true,export:true,restore:true}});
      }
      const value=await transaction(pool,tx=>cachedWorkspace(tx,route.slice(1),url.searchParams,request.headers.get('if-none-match')),{readOnly:true});
      return value.value?json(value.value):new Response(value.unchanged?null:value.body,{status:value.unchanged?304:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',ETag:value.etag}});
    }
    if (method === "GET" && route[0] === "maintenance") {
      if (route[1] && route[2] === "download")
        return backupDownload(
          pool,
          (await machineConfiguration()).root,
          route[1],
        );
      return json(await maintenanceState(pool));
    }
    if (method !== "GET") {
      check(
        runtimeEpoch && /^[a-f0-9-]{36}$/.test(runtimeEpoch),
        "RUNTIME_REQUIRED",
        "写入须携带当前实例运行期",
        409,
      );
      await transaction(pool, (tx) => mutationGate(tx, runtimeEpoch));
    }
    if(method==='POST'&&route.join('/')==='workspaces/maintenance/upload'){
      const operationId=request.headers.get('idempotency-key'),{root}=await machineConfiguration(),file=await receiveFile(request,root,{});
      try{const receipt=await enqueue(pool,{kind:'MAINTENANCE_IMPORT',operationId,runtimeEpoch,...file});if(receipt.replayed)await rm(file.filename,{force:true});return json(receipt,202);}catch(error){await rm(file.filename,{force:true});throw error;}
    }
    if(method==='POST'&&route.join('/')==='workspaces/sources/file'){
      const operationId=request.headers.get('idempotency-key'),{root}=await machineConfiguration();
      check(Number(request.headers.get('content-length'))<=128*1024*1024,'SOURCE_SIZE','单份来源文件至多 128 MiB',413);
      const file=await receiveFile(request,root,{});
      try{const value=sourceUploadRequest(file,Object.fromEntries(url.searchParams),{operationId,runtimeEpoch});const receipt=await enqueue(pool,value);if(receipt.replayed)await rm(file.filename,{force:true});return json(receipt,202);}
      catch(error){await rm(file.filename,{force:true});throw error;}
    }
    if(method!=='GET'&&route[0]==='workspaces') {
      const input=await requestJson(request),operationId=request.headers.get('idempotency-key')||input.operationId;
      if(route.slice(1).join('/')==='shot-production'&&input.action==='manifest-render'){const receipt=await enqueue(pool,await prepareManifestRender(pool,input,{operationId,runtimeEpoch}));return json({...receipt,jobId:receipt.operationId},202);}
      if(route.slice(1).join('/')==='shot-production/animatics'&&input.action==='render'){const receipt=await enqueue(pool,await prepareAnimaticRender(pool,input,{operationId,runtimeEpoch}));return json({...receipt,jobId:receipt.operationId},202);}
      if(route.slice(1).join('/')==='material-review-drafts')return json(await enqueue(pool,await prepareMaterialReview(pool,input,{operationId,runtimeEpoch})),202);
      if(route.slice(1).join('/')==='script-comments/polish')return json(await enqueue(pool,await prepareCommentPolish(pool,input,{operationId,runtimeEpoch})),202);
      if(route.length===2&&route[1]==='maintenance')return json(await enqueue(pool,workspaceMaintenanceRequest(input,{operationId,runtimeEpoch})),202);
      const result=await execute(pool,{operationId,runtimeEpoch,actor:{kind:'HUMAN',label:'网页用户'},commands:[{type:'workspace.change',workspace:route.slice(1).join('/'),input}]});
      if(result.status==='FAILED')return json({operationId:result.operationId,error:result.error.message,code:result.error.code,details:result.error.details},result.error.status||409);
      return json({...result.workspace,operationId:result.operationId,status:result.status,results:result.results});
    }
    if(method==='POST'&&route[0]==='assistant'){
      const body=await requestJson(request),operationId=request.headers.get('idempotency-key');
      if(route[1]==='context')return json({context:publicContext(await transaction(pool,tx=>assistantContext(tx,body),{readOnly:true}))});
      if(route[1]==='suggestions'&&route[2]==='check')return json(await transaction(pool,tx=>checkDraftSuggestion(tx,body),{readOnly:true}));
      if(route[1]==='conversations'){
        let id=body.conversationId,receipt;
        if(['START','SEND'].includes(body.action)){
          const prepared=await prepareConversation(pool,body,{operationId,runtimeEpoch});id=prepared.conversationId;
          receipt=prepared.replayed?{operationId,replayed:true}:await enqueue(pool,prepared.request);
        }else if(body.action==='CANCEL'){
          const job=await transaction(pool,async tx=>{
            const current=await readConversation(tx,id);check(current.headHash===body.expectedTurnHeadHash&&current.activeTurnId===body.turnId,'CONVERSATION_HEAD','对话请求已改变，请核查原状态',409);
            const rows=(await tx.query("SELECT id FROM operations WHERE request #>> '{assistant,conversationId}'=$1 AND status IN('QUEUED','RUNNING','RESULT_UNKNOWN')",[id])).rows;
            const row=rows.find(r=>turnId(r.id)===body.turnId);check(row,'CONVERSATION_TURN','原请求不存在',409);return row;
          },{readOnly:true});receipt=await cancelJob(pool,job.id,{operationId,runtimeEpoch});
        }else receipt=await archiveConversation(pool,body,{operationId,runtimeEpoch});
        return json({...receipt,...await transaction(pool,tx=>conversationList(tx,new URLSearchParams({conversationId:id})),{readOnly:true})});
      }
    }
    if (method === "GET" && route[0] === "media" && route[1])
      return mediaResponse(
        request,
        pool,
        (await machineConfiguration()).root,
        route[1],
      );
    if (method === "GET" && route[0] === "export") {
      const iterator = exportRecords(pool),
        encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(encoder.encode(next.value));
            } catch (error) {
              controller.error(error);
              await iterator.return();
            }
          },
          async cancel() {
            await iterator.return();
          },
        }),
        {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Content-Disposition": 'attachment; filename="project-data.ndjson"',
            "Cache-Control": "no-store",
          },
        },
      );
    }
    if (method === "POST" && ["import", "upload"].includes(route[0])) {
      const operationId = url.searchParams.get("operationId"),
        sha256 = url.searchParams.get("sha256");
      check(
        operationId &&
          ((route[0] === "upload" && !sha256) ||
            /^[a-f0-9]{64}$/.test(sha256 || "")),
        "UPLOAD_IDENTITY",
        "上传需要 operationId；项目导入须提供完整 SHA",
      );
      const { root } = await machineConfiguration(),
        file = await receiveFile(request, root, { sha256 });
      try {
        const request = {
          operationId,
          runtimeEpoch,
          kind: route[0] === "import" ? "IMPORT" : "MEDIA_REGISTER",
          ...file,
          ...(route[0] === "upload"
            ? {
                mediaId: url.searchParams.get("mediaId") || file.sha256,
                versionId: url.searchParams.get("versionId") || file.sha256,
                mimeType:
                  url.searchParams.get("mimeType") ||
                  "application/octet-stream",
                forImport: url.searchParams.get("forImport") === "true",
              }
            : {}),
        };
        const receipt = await enqueue(pool, request);
        if (receipt.replayed) await rm(file.filename, { force: true });
        return json(receipt, 202);
      } catch (error) {
        await rm(file.filename, { force: true });
        throw error;
      }
    }
    if (method === "POST" && route[0] === "jobs") {
      const body = await requestJson(request);
      check(
        [
          "AI_SUGGEST",
          "GENERATE",
          "MEDIA_PROCESS",
          ...maintenanceKinds,
        ].includes(body.kind) && !Object.hasOwn(body, "filename"),
        "JOB_KIND",
        "请使用受控上传或业务任务入口",
      );
      return json(await enqueue(pool, { ...body, runtimeEpoch }), 202);
    }
    if (method === "POST" && route[0] === "operations" && route[2] === "cancel")
      return json(
        await cancelJob(pool, route[1], {
          ...(await requestJson(request)),
          runtimeEpoch,
        }),
      );
    if (route[0] === "suggestions" && route[1]) {
      if (method === "GET") return json(await suggestion(pool, route[1]));
      if (method === "POST" && route[2] === "apply") {
        const body=await requestJson(request),operationId=request.headers.get('idempotency-key')||body.operationId;
        check(!body.operationId||body.operationId===operationId,'OPERATION_ID_CONFLICT','请求编号不一致',409);
        const result=await applySuggestion(pool,route[1],{...body,operationId,runtimeEpoch});
        return json(result,result.status==='FAILED'?result.error.status||409:200);
      }
    }
    if (method === "GET" && route[0] === "health") {
      const [project, schema, worker] = await Promise.all([
        pool.query(
          'SELECT instance_id AS "instanceId",runtime_epoch AS "runtimeEpoch",title FROM project',
        ),
        pool.query(
          "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
        ),
        pool.query(
          "SELECT value,updated_at AS \"updatedAt\" FROM runtime_status WHERE name='worker'",
        ),
      ]);
      return json({
        status: "ok",
        softwareCommit: process.env.REVIEW_SOFTWARE_COMMIT || "DEVELOPMENT",
        schemaVersion: schema.rows[0]?.version,
        project: project.rows[0],
        worker: worker.rows[0] || null,
      });
    }
    if (method === "GET" && route[0] === "work")
      return json(await transaction(pool, workSummary, { readOnly: true }));
    if (method === "GET" && route[0] === "contexts" && route[1])
      return json(
        await transaction(
          pool,
          (tx) =>
            objectContext(tx, route[1], {
              revisionId: url.searchParams.get("revisionId") || undefined,
            }),
          { readOnly: true },
        ),
      );
    if (method === "GET" && route[0] === "facets")
      return json(
        await transaction(
          pool,
          (tx) => facets(tx, url.searchParams.get("kind")),
          { readOnly: true },
        ),
      );
    if (
      method === "GET" &&
      route[0] === "settings" &&
      route[1] === "spatial-baseline"
    )
      return json(await transaction(pool, spatialBaseline, { readOnly: true }));
    if (method === "GET" && route[0] === "relationships")
      return json(
        await transaction(
          pool,
          (tx) =>
            relationshipGraph(tx, {
              owner: url.searchParams.get("owner"),
              offset: Number(url.searchParams.get("offset") || 0),
            }),
          { readOnly: true },
        ),
      );
    if (method === "GET" && route[0] === "objects") {
      if (route[1] || url.searchParams.has("id"))
        return json(
          await transaction(
            pool,
            (tx) =>
              objectDetail(tx, route[1] || url.searchParams.get("id"), {
                revisionId: url.searchParams.get("revisionId") || undefined,
              }),
            { readOnly: true },
          ),
        );
      const options = Object.fromEntries(
        [
          "module",
          "kind",
          "owner",
          "state",
          "query",
          "category",
          "mediaType",
          "entity",
          "lane",
          "gate",
          "attention",
          "actor",
          "chain",
          "workStage",
          "workState",
        ].map((k) => [k, url.searchParams.get(k) || undefined]),
      );
      options.limit = Number(url.searchParams.get("limit") || 50);
      options.offset = Number(url.searchParams.get("offset") || 0);
      options.historical = url.searchParams.get("historical") === "true";
      return json(
        await transaction(pool, (tx) => catalog(tx, options), {
          readOnly: true,
        }),
      );
    }
    if (method === "GET" && route[0] === "configurations")
      return json({
        items: (
          await pool.query(
            "SELECT scope,version,content FROM configurations ORDER BY scope",
          )
        ).rows,
      });
    if (method === "GET" && route[0] === "operations" && route[1])
      return json(await operation(pool, route[1]));
    if (method === "POST" && route[0] === "transactions") {
      const body = await requestJson(request);
      const receipt = await execute(pool, { ...body, runtimeEpoch });
      return json(
        receipt,
        receipt.status === "FAILED" ? receipt.error.status || 409 : 200,
      );
    }
    if (method === "GET" && route[0] === "source" && route[1]) {
      const offset = Number(url.searchParams.get("offset") || 0),
        limit = Number(url.searchParams.get("limit") || 16000);
      check(
        Number.isSafeInteger(offset) &&
          offset >= 0 &&
          Number.isSafeInteger(limit) &&
          limit > 0 &&
          limit <= 64000,
        "SOURCE_RANGE",
        "来源读取范围无效",
      );
      const row = (
        await pool.query(
          "SELECT original_revision_id,original_sha256,logical_path,mime_type,substring(convert_from(content_bytes,'UTF8') FROM $2+1 FOR $3) AS text,length(convert_from(content_bytes,'UTF8')) AS total FROM source_documents WHERE revision_id=$1",
          [route[1], offset, limit],
        )
      ).rows[0];
      check(row, "NOT_FOUND", "来源修订不存在", 404);
      return json({
        ...row,
        offset,
        nextOffset:
          offset + row.text.length < row.total
            ? offset + row.text.length
            : null,
      });
    }
    throw new ReviewError("NOT_FOUND", "接口不存在", 404);
  } catch (error) {
    if (!(error instanceof ReviewError))
      console.error("review-api", error.code || error.name);
    return json(errorBody(error), error.status || 500);
  }
}
