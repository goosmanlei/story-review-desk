import {prepareManifestRender} from '../server/production/manifests.mjs';
import {hash} from '../server/shared/contracts.mjs';
import {exportRecords} from '../server/transfer.mjs';
import {cachedWorkspace,presentationToken} from '../server/presentation/cache.mjs';
import {prepareAnimaticRender} from '../server/production/animatic-jobs.mjs';
import {renderAnimatic,animaticProcess} from '../server/production/animatic-render.mjs';
import {canonicalShotDesign} from '../web/presentation/shot-design-contract.mjs';
import {fileSha} from '../server/transfer.mjs';
import {workspaceRead} from '../server/presentation/workspaces.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { requiredPhase } from "../tools/process-resources.mjs";
import { execute } from "../server/commands.mjs";
import { readObject, catalog } from "../server/repository.mjs";
import {
  objectContext,
  facets,
  relationshipGraph,
} from "../server/workspaces.mjs";
import { transaction } from "../server/db.mjs";
import { BoundedCache } from "../server/shared/cache.mjs";
import {
  enqueue,
  workOnce,
  suggestion,
  sweepJobs,
  cancelJob,
} from "../server/jobs.mjs";
import { operation } from "../server/commands.mjs";

test("bounded cache evicts by bytes and idle time", () => {
  let clock = 0;
  const cache = new BoundedCache({
    maxBytes: 30,
    idleMs: 10,
    now: () => clock,
  });
  cache.set("a", "1234567890");
  cache.set("b", "1234567890");
  cache.get("a");
  cache.set("c", "1234567890");
  assert.equal(cache.get("b"), undefined);
  assert(cache.bytes <= 30);
  clock = 9;
  assert(cache.get("a"));
  clock = 11;
  cache.sweep();
  assert.equal(cache.get("c"), undefined);
  assert(cache.get("a"));
  clock = 22;
  cache.sweep();
  assert.equal(cache.bytes, 0);
});

test("object transactions, concurrency, adoption and exact dependency invalidation", async (t) => {
  const root = process.env.REVIEW_PROJECT_ROOT || process.cwd(),
    phase = await requiredPhase(root);
  assert(phase, "Run this integration test through the project task executor");
  const name = "review-refactor-test-" + Date.now(),
    labels = await phase.expect("container", name);
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      ...labels,
      "--tmpfs",
      "/var/lib/postgresql:rw,size=512m",
      "-e",
      "POSTGRES_USER=review",
      "-e",
      "POSTGRES_DB=review",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-p",
      "127.0.0.1::5432",
      "postgres:18.6",
    ],
    { stdio: "pipe" },
  );
  await phase.capture("container", name);
  const info = JSON.parse(
      execFileSync("docker", ["inspect", name], { encoding: "utf8" }),
    )[0],
    port = Number(info.NetworkSettings.Ports["5432/tcp"][0].HostPort);
  const pool = new pg.Pool({
    host: "127.0.0.1",
    port,
    user: "review",
    database: "review",
    max: 8,
  });
  t.after(() => pool.end());
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await pool.query(
    await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"),
  );
  await pool.query(
    "INSERT INTO project(instance_id,runtime_epoch,title) VALUES('fixture','d0fab4b5-0c84-4bc1-acb2-01a015fdfcdb','空白故事')",
  );
  let sequence = 0;
  const run = (commands) =>
    execute(pool, { operationId: "test-" + ++sequence, commands });
  const save = (id, kind, expectedVersion = 0, content = {}, extra = {}) => ({
    type: "save",
    id,
    kind,
    title: id,
    expectedVersion,
    content,
    ...extra,
  });
  const create = async (
    id,
    kind = "SCENE",
    content = { text: "原稿" },
    extra = {},
  ) => {
    const r = await run([save(id, kind, 0, content, extra)]);
    assert.equal(r.status, "SUCCEEDED", JSON.stringify(r));
    return r.results[0];
  };
  const adopt = async (id) => {
    const o = await readObject(pool, id);
    let r = await run([{ type: "submit", id, expectedVersion: o.version }]);
    assert.equal(r.status, "SUCCEEDED");
    r = await run([
      {
        type: "review",
        id,
        expectedVersion: o.version + 1,
        revisionId: o.revision.id,
        decision: "ADOPT",
        explicit: true,
        note: "已核对",
        findings: [],
      },
    ]);
    assert.equal(r.status, "SUCCEEDED", JSON.stringify(r));
    return r.results[0];
  };
  await t.test('blank authoring roots, exact sources, independent object versions and plan registration',async()=>{
    const state=()=>transaction(pool,tx=>workspaceRead(tx,['authoring'],new URLSearchParams()),{readOnly:true});
    const action=async input=>{const result=await run([{type:'workspace.change',workspace:'authoring',input}]);assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));return result.workspace;};
    const outline=await action({action:'save',expectedRevisionId:null,root:{kind:'STORY_OUTLINE',title:'结构',body:'调查失踪信件。',parentId:null,sceneIds:[],sourceBindings:[]}});
    const script=await action({action:'save',expectedRevisionId:null,root:{kind:'SCREENPLAY',title:'剧本',body:'发现信封并追查来处。',parentId:outline.root.id,sceneIds:[],sourceBindings:[]}});
    const scene=await action({action:'save',expectedRevisionId:null,root:{kind:'SCENE_SCRIPT',title:'发现钥匙',body:'桌上留着一枚铜钥匙。',parentId:script.root.id,sceneIds:[],sourceBindings:[]}});
    const stale=await run([{type:'workspace.change',workspace:'authoring',input:{action:'save',expectedRevisionId:null,root:{...scene.root,body:'旧版本写入'}}}]);assert.equal(stale.status,'FAILED');
    const planContent={planId:'fixture-story',episodes:[{episodeUid:'fixture-episode',displayId:'E01',title:'线索',sceneIds:[scene.root.id],reviewDossier:{purpose:{episodeTask:{class:'A',text:'发现线索'}},informationLayers:{},payoff:{}}}]};
    const plan=await action({action:'save',expectedRevisionId:null,root:{kind:'EPISODE_PLAN',title:'分集草稿',body:'首集发现信封。',parentId:script.root.id,sceneIds:[scene.root.id],sourceBindings:[],planContent}});
    const result=await action({action:'submit',rootId:plan.root.id,expectedRevisionId:plan.root.revisionId,expectedStoryRevisionId:null});assert.equal(result.formalAdoptionPerformed,false);
    assert.equal((await state()).roots.length,4);
    const projected=await transaction(pool,tx=>workspaceRead(tx,['views','episode-plan'],new URLSearchParams()),{readOnly:true});assert.equal(projected.plan.content.episodes[0].episodeUid,'fixture-episode');assert.equal(projected.plan.content.narrativeRevision.scenes[0].scriptBlocks[0].text,scene.root.body);assert.equal((await readObject(pool,'fixture-episode')).state,'DRAFT');
  });
  await t.test('episode organization updates both draft memberships atomically and preserves scene identity',async()=>{
    await create('organization-a','SCENE',{text:'第一条线索'});await create('organization-b','SCENE',{text:'第二条线索'});await create('organization-c','SCENE',{text:'另一集线索'});
    await create('organization-from','EPISODE',{}, {links:[{id:'organization-a',role:'SCENE'},{id:'organization-b',role:'SCENE'}]});await create('organization-to','EPISODE',{}, {links:[{id:'organization-c',role:'SCENE'}]});
    await adopt('organization-from');const from=await readObject(pool,'organization-from'),to=await readObject(pool,'organization-to'),scene=await readObject(pool,'organization-b');
    const input={action:'move',episodeId:from.id,expectedVersion:from.version,revisionId:from.revision.id,targetEpisodeId:to.id,targetExpectedVersion:to.version,targetRevisionId:to.revision.id,sceneId:scene.id,sceneExpectedVersion:scene.version};
    const stale=await run([{type:'workspace.change',workspace:'episode-organization',input:{...input,targetExpectedVersion:to.version+1}}]);assert.equal(stale.status,'FAILED');assert.equal((await readObject(pool,from.id)).version,from.version);
    const moved=await run([{type:'workspace.change',workspace:'episode-organization',input}]);assert.equal(moved.status,'SUCCEEDED',JSON.stringify(moved));assert.equal((await readObject(pool,from.id)).adoptedRevisionId,from.adoptedRevisionId);assert.deepEqual((await readObject(pool,to.id)).links.filter(r=>r.role==='SCENE').map(r=>r.id),['organization-c','organization-b']);assert.equal((await readObject(pool,scene.id)).revision.id,scene.revision.id);
    const current=await readObject(pool,from.id);const added=await run([{type:'workspace.change',workspace:'episode-organization',input:{action:'create',episodeId:from.id,expectedVersion:current.version,revisionId:current.revision.id,sceneId:'organization-new',blockId:'organization-new-block',title:'新场草稿',text:'新的一场正文'}}]);assert.equal(added.status,'SUCCEEDED',JSON.stringify(added));assert.equal((await readObject(pool,'organization-new')).state,'DRAFT');
  });
  await t.test(
    "editing a relation preserves its declared type and endpoints",
    async () => {
      await create("relation-left", "ENTITY", { description: "左主体" });
      await create("relation-right", "ENTITY", { description: "右主体" });
      await create(
        "relation-proof",
        "RELATION",
        { type: "PART_OF", description: "原关系" },
        {
          links: [
            { id: "relation-left", role: "ENTITY" },
            { id: "relation-right", role: "ENTITY" },
          ],
        },
      );
      const detail = await readObject(pool, "relation-proof");
      const updated = await run([
        save(detail.id, "RELATION", detail.version, {
          ...detail.revision.content,
          description: "补充说明",
        }),
      ]);
      assert.equal(updated.status, "SUCCEEDED");
      assert.deepEqual(
        (
          await pool.query(
            "SELECT from_id,to_id,relation_type FROM entity_relations WHERE object_id='relation-proof'",
          )
        ).rows[0],
        {
          from_id: "relation-left",
          to_id: "relation-right",
          relation_type: "PART_OF",
        },
      );
    },
  );
  await t.test(
    "domain contexts and anchored comments preserve exact source versions across edits",
    async () => {
      await create("context-scene", "SCENE", {
        blocks: [
          {
            id: "context-block",
            type: "action",
            text: "先看见信封，再看清名字。",
          },
        ],
        purpose: "交代线索",
      });
      await create(
        "context-episode",
        "EPISODE",
        {
          coreAdvance: "交代线索",
          reviewDossier: {
            purpose: { episodeTask: { text: "建立寻找目标", class: "A" } },
          },
        },
        { links: [{ id: "context-scene", role: "SCENE" }] },
      );
      const scene = await readObject(pool, "context-scene");
      const content = {
        text: "建议给看清名字的动作留下停顿",
        status: "OPEN",
        target: {
          objectId: scene.id,
          revisionId: scene.revision.id,
          expectedVersion: scene.version,
          sha256: scene.revision.sha256,
        },
        anchor: { blockId: "context-block", startOffset: 6, endOffset: 11, quote: "再看清名字" },
      };
      const request = {
        operationId: "anchored-comment-retry",
        commands: [
          save("anchored-comment", "COMMENT", 0, content, {
            links: [
              { id: scene.id, role: "SOURCE", expectedVersion: scene.version },
            ],
            dependencies: [
              { revisionId: scene.revision.id, purpose: "CONTENT" },
            ],
          }),
        ],
      };
      const receipt = await execute(pool, request);
      assert.equal(receipt.status, "SUCCEEDED", JSON.stringify(receipt));
      assert.deepEqual(await execute(pool, request), receipt);
      const context = await transaction(
        pool,
        (tx) => objectContext(tx, scene.id),
        { readOnly: true },
      );
      assert.equal(context.object.revision.id, scene.revision.id);
      assert.equal(context.revisionId, scene.revision.id);
      assert.equal(context.primary[0].id, "context-episode");
      assert.equal(context.comments[0].id, "anchored-comment");
      assert(
        context.basis.some(
          (b) => b.objectId === "anchored-comment" && b.objectVersion === 1,
        ),
      );
      assert(
        context.basis.some(
          (b) => b.objectId === "context-episode" && b.objectVersion === 1,
        ),
      );
      const ep = await readObject(pool, "context-episode");
      const nested = await run([
        save("nested-comment", "COMMENT", 0, {
          text: "明确本集任务",
          status: "OPEN",
          target: {
            objectId: ep.id,
            revisionId: ep.revision.id,
            expectedVersion: ep.version,
          },
          anchor: {
            path: ["reviewDossier", "purpose", "episodeTask", "text"],
            quote: "寻找目标",
          },
        }),
      ]);
      assert.equal(nested.status, "SUCCEEDED");
      assert.equal(
        (
          await catalog(pool, {
            chain: "story",
            workStage: "NARRATIVE",
            workState: "NOW",
          })
        ).items[0].workState,
        "READY",
      );
      const source = await create("immutable-source", "SOURCE", {
        text: "原始资料保留",
      });
      const altered = await run([
        save("immutable-source", "SOURCE", source.version, {
          text: "不能覆盖原始资料",
        }),
      ]);
      assert.equal(altered.error.code, "SOURCE_IMMUTABLE");
      const wrong = await run([
        save("wrong-anchor", "COMMENT", 0, {
          ...content,
          anchor: { quote: "不存在的文字", blockId: "context-block" },
        }),
      ]);
      assert.equal(wrong.error.code, "COMMENT_ANCHOR_CONFLICT");
      await run([
        save(scene.id, "SCENE", scene.version, {
          blocks: [
            { id: "context-block", type: "action", text: "信封已经寄出。" },
          ],
        }),
      ]);
      const stale = await run([save("stale-comment", "COMMENT", 0, content)]);
      assert.equal(stale.error.code, "VERSION_CONFLICT");
      const comment = await readObject(pool, "anchored-comment");
      const rebind = await run([
        save(comment.id, "COMMENT", comment.version, {
          ...content,
          target: {
            ...content.target,
            revisionId: (await readObject(pool, scene.id)).revision.id,
          },
        }),
      ]);
      assert.equal(rebind.error.code, "COMMENT_TARGET_IMMUTABLE");
      assert.equal(
        (
          await run([
            save(comment.id, "COMMENT", comment.version, {
              ...content,
              status: "RESOLVED",
            }),
          ])
        ).status,
        "SUCCEEDED",
      );
      const after = await transaction(
        pool,
        (tx) => objectContext(tx, scene.id),
        { readOnly: true },
      );
      assert.equal(
        after.comments[0].content.target.revisionId,
        scene.revision.id,
      );
      assert.notEqual(after.revisionId, scene.revision.id);
      const original = await transaction(
        pool,
        (tx) => objectContext(tx, scene.id, { revisionId: scene.revision.id }),
        { readOnly: true },
      );
      assert.equal(
        original.object.revision.content.blocks[0].text,
        "先看见信封，再看清名字。",
      );
      const search = await catalog(pool, { kind: "SCENE", query: "信封" });
      assert.equal(search.total, 1);
      await create("category-person", "ENTITY", {
        type: "CHARACTER",
        description: "人物",
      });
      await create("category-place", "ENTITY", {
        type: "LOCATION",
        description: "地点",
      });
      assert.equal(
        (await catalog(pool, { kind: "ENTITY", category: "CHARACTER" }))
          .items[0].id,
        "category-person",
      );
      assert.equal(
        (await facets(pool, "ENTITY")).items.find(
          (r) => r.category === "CHARACTER",
        ).count,
        1,
      );
      const graph = await relationshipGraph(pool, { owner: "relation-left" });
      assert.equal(graph.items[0].fromId, "relation-left");
      assert.equal(graph.items[0].toId, "relation-right");
    },
  );
  await t.test(
    "unrelated saves and retries do not depend on a global revision",
    async () => {
      await create("scene-a");
      await create("scene-b");
      const request = {
        operationId: "retry",
        commands: [save("scene-a", "SCENE", 1, { text: "新稿" })],
      };
      const [a, b] = await Promise.all([
        execute(pool, request),
        execute(pool, request),
      ]);
      assert.deepEqual(a, b);
      assert.equal(a.status, "SUCCEEDED");
      assert.equal(
        (await run([save("scene-b", "SCENE", 1, { text: "另一场" })])).status,
        "SUCCEEDED",
      );
      await assert.rejects(
        execute(pool, {
          ...request,
          commands: [save("scene-a", "SCENE", 1, { text: "不同请求" })],
        }),
        { code: "OPERATION_ID_CONFLICT" },
      );
      const races = await Promise.all([
        run([save("scene-a", "SCENE", 2, { text: "竞态1" })]),
        run([save("scene-a", "SCENE", 2, { text: "竞态2" })]),
      ]);
      assert.deepEqual(races.map((r) => r.status).sort(), [
        "FAILED",
        "SUCCEEDED",
      ]);
      const before = await readObject(pool, "scene-b"),
        failed = await run([
          save("scene-b", "SCENE", before.version, { text: "不会保存" }),
          save("scene-a", "SCENE", 1, { text: "过期" }),
        ]);
      assert.equal(failed.status, "FAILED");
      assert.equal((await readObject(pool, "scene-b")).version, before.version);
    },
  );
  await t.test(
    "adoption preserves immutable history and only invalidates exact dependencies",
    async () => {
      await create("requirement", "REQUIREMENT", { description: "人物身份" });
      const requirement = await adopt("requirement");
      await create(
        "design",
        "SHOT_DESIGN",
        { description: "只依赖需求定义" },
        {
          dependencies: [
            { revisionId: requirement.revisionId, purpose: "DEFINITION" },
          ],
        },
      );
      await adopt("design");
      await create("unrelated", "SHOT_DESIGN", { description: "无依赖" });
      await adopt("unrelated");
      const prior = await readObject(pool, "requirement");
      await run([
        save("requirement", "REQUIREMENT", prior.version, {
          description: "身份条件改变",
        }),
      ]);
      const result = await adopt("requirement");
      assert.equal(result.affected.length, 1);
      assert.equal((await readObject(pool, "design")).invalidations.length, 1);
      assert.equal(
        (await readObject(pool, "unrelated")).invalidations.length,
        0,
      );
      await assert.rejects(
        pool.query("UPDATE revisions SET content='{}' WHERE id=$1", [
          prior.revision.id,
        ]),
        /Immutable/,
      );
      const historical = await readObject(pool, "requirement", {
        revisionId: prior.revision.id,
      });
      assert.equal(historical.revision.content.description, "人物身份");
    },
  );
  await t.test(
    "AI cannot adopt; missing media and unknown rights fail closed",
    async () => {
      await create("family", "MATERIAL", { description: "人物素材" });
      await create(
        "asset",
        "ASSET",
        { description: "待核原图" },
        { links: [{ id: "family", role: "FAMILY" }] },
      );
      const asset = await readObject(pool, "asset");
      assert.equal(
        (
          await run([
            { type: "submit", id: "asset", expectedVersion: asset.version },
          ])
        ).status,
        "SUCCEEDED",
      );
      const command = {
        type: "review",
        id: "asset",
        expectedVersion: 2,
        revisionId: asset.revision.id,
        decision: "ADOPT",
        explicit: true,
        note: "测试",
      };
      assert.equal((await run([command])).error.code, "MEDIA_UNAVAILABLE");
      const ai = await execute(pool, {
        operationId: "ai-review",
        actor: { kind: "ASSISTANT", label: "AI" },
        commands: [command],
      });
      assert.equal(ai.error.code, "ASSISTANT_DRAFT_ONLY");
      await pool.query(
        "INSERT INTO media(id,version_id,sha256,byte_size,mime_type,availability) VALUES('image','v1',$1,4,'image/png','PRESENT')",
        ["a".repeat(64)],
      );
      await pool.query(
        "INSERT INTO asset_media(revision_id,media_id,media_version_id,sha256) VALUES($1,'image','v1',$2)",
        [asset.revision.id, "a".repeat(64)],
      );
      assert.equal((await run([command])).error.code, "RIGHTS_UNKNOWN");
      assert.equal(
        (await run([{ ...command, internalAttestation: true }])).status,
        "SUCCEEDED",
      );
      const after = await readObject(pool, "asset");
      assert.equal(after.rights.fact, "UNKNOWN");
      assert.equal(after.rights.internalAttestation, true);
    },
  );
  await t.test(
    "configuration ownership and round trips are explicit",
    async () => {
      const c = { title: "新故事", locale: "zh-CN" };
      assert.equal(
        (
          await run([
            {
              type: "configuration.save",
              scope: "project",
              expectedVersion: 0,
              content: c,
            },
          ])
        ).status,
        "SUCCEEDED",
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT content FROM configurations WHERE scope='project'",
          )
        ).rows[0].content,
        c,
      );
      assert.equal(
        (
          await run([
            {
              type: "configuration.save",
              scope: "system",
              expectedVersion: 0,
              content: c,
            },
          ])
        ).error.code,
        "CONFIGURATION_FIELD",
      );
      assert.equal(
        (
          await run([
            {
              type: "configuration.save",
              scope: "system",
              expectedVersion: 0,
              content: { assistant: { apiKey: "secret" } },
            },
          ])
        ).error.code,
        "PRIVATE_CONFIGURATION",
      );
    },
  );
  await t.test(
    "obsolete inputs remain invalid in a copied draft; rebasing only exact inputs clears them",
    async () => {
      const before = await readObject(pool, "design");
      await run([
        save("design", "SHOT_DESIGN", before.version, {
          description: "只改说明，仍使用旧依据",
        }),
      ]);
      const copied = await readObject(pool, "design");
      assert.equal(copied.invalidations.length, 1);
      const basis = await readObject(pool, "requirement");
      await run([
        save(
          "design",
          "SHOT_DESIGN",
          copied.version,
          { description: "已核对新的明确依据" },
          {
            dependencies: [
              { revisionId: basis.adoptedRevisionId, purpose: "DEFINITION" },
            ],
          },
        ),
      ]);
      assert.equal((await readObject(pool, "design")).invalidations.length, 0);
    },
  );
  await t.test(
    "mock assistant is invoked once, preview applies atomically and expired duplicate bodies disappear",
    async () => {
      await create("suggest-scene");
      const object = await readObject(pool, "suggest-scene");
      let calls = 0;
      const request = {
        operationId: "mock-suggest",
        kind: "AI_SUGGEST",
        objectId: object.id,
        expectedVersion: object.version,
        revisionId: object.revision.id,
        prompt: "受控模拟建议",
      };
      await Promise.all([enqueue(pool, request), enqueue(pool, request)]);
      const providers = {
        suggest: async ({ onRequestId }) => {
          calls++;
          await onRequestId("mock-provider-request");
          return { summary: "模拟返回", patch: { text: "模拟草稿" } };
        },
      };
      assert(
        await workOnce(pool, { root, workerId: "fixture-worker", providers }),
      );
      assert(
        !(await workOnce(pool, {
          root,
          workerId: "fixture-worker",
          providers,
        })),
      );
      assert.equal(calls, 1);
      assert.equal(
        (await suggestion(pool, request.operationId)).revisionId,
        object.revision.id,
      );
      const apply = {
        operationId: "apply-mock",
        commands: [
          {
            type: "suggestion.apply",
            id: object.id,
            expectedVersion: object.version,
            suggestionId: request.operationId,
          },
        ],
      };
      const [first, replay] = await Promise.all([
        execute(pool, apply),
        execute(pool, apply),
      ]);
      assert.deepEqual(first, replay);
      assert.equal(first.status, "SUCCEEDED");
      assert.equal(
        (await readObject(pool, object.id)).revision.content.text,
        "模拟草稿",
      );
      await pool.query(
        "UPDATE suggestions SET expires_at=now()-interval '1 second'",
      );
      await sweepJobs(pool);
      await assert.rejects(suggestion(pool, request.operationId), {
        code: "SUGGESTION_EXPIRED",
      });
      assert.equal(
        (await readObject(pool, object.id)).revision.content.text,
        "模拟草稿",
      );
    },
  );
  await t.test(
    "unknown provider results never requeue; queued cancellation does not invoke a provider",
    async () => {
      const object = await readObject(pool, "suggest-scene"),
        request = {
          operationId: "unknown-suggest",
          kind: "AI_SUGGEST",
          objectId: object.id,
          expectedVersion: object.version,
          revisionId: object.revision.id,
          prompt: "受控中断",
        };
      let calls = 0;
      await enqueue(pool, request);
      await workOnce(pool, {
        root,
        workerId: "fixture-worker",
        providers: {
          suggest: async ({ onRequestId }) => {
            calls++;
            await onRequestId("known-request-to-reconcile");
            throw Error("mock connection lost");
          },
        },
      });
      const receipt = await operation(pool, request.operationId);
      assert.equal(receipt.status, "RESULT_UNKNOWN");
      assert.equal(receipt.providerRequestId, "known-request-to-reconcile");
      assert.equal((await enqueue(pool, request)).status, "RESULT_UNKNOWN");
      assert(!(await workOnce(pool, { root, workerId: "fixture-worker" })));
      assert.equal(calls, 1);
      await enqueue(pool, { ...request, operationId: "cancel-suggest" });
      await cancelJob(pool, "cancel-suggest");
      assert(!(await workOnce(pool, { root, workerId: "fixture-worker" })));
    },
  );
  await t.test(
    "family identity and rights changes are explicit even when display names match",
    async () => {
      await create("other-family", "MATERIAL", { description: "同名素材族" });
      await create(
        "another-asset",
        "ASSET",
        { description: "同名候选" },
        { links: [{ id: "other-family", role: "FAMILY" }] },
      );
      assert.equal(
        (
          await pool.query(
            "SELECT family_id FROM asset_versions WHERE object_id='another-asset'",
          )
        ).rows[0].family_id,
        "other-family",
      );
      const asset = await readObject(pool, "asset"),
        result = await run([
          {
            type: "rights.record",
            id: asset.id,
            revisionId: asset.revision.id,
            expectedVersion: asset.version,
            explicit: true,
            fact: "BLOCKED",
            evidence: { note: "模拟权利阻断" },
          },
        ]);
      assert.equal(result.status, "SUCCEEDED");
      assert.equal((await readObject(pool, "asset")).rights.fact, "BLOCKED");
      await assert.rejects(
        pool.query("UPDATE rights_events SET fact='CLEAR'"),
        /Immutable/,
      );
    },
  );
  await t.test(
    "controlled production uses a locked input and registers ordinary candidate outputs exactly once",
    async () => {
      await create("production-family", "MATERIAL", {
        description: "隔离产物",
      });
      await create("production-prompt", "PROMPT", { text: "受控模拟内容" });
      await adopt("production-prompt");
      const prompt = await readObject(pool, "production-prompt");
      await create(
        "production-lock",
        "INPUT_LOCK",
        { description: "明确输入" },
        {
          links: [{ id: "production-family", role: "FAMILY" }],
          dependencies: [
            { revisionId: prompt.revision.id, purpose: "ACTUAL_INPUT" },
          ],
        },
      );
      await adopt("production-lock");
      const lock = await readObject(pool, "production-lock"),
        request = {
          operationId: "mock-production",
          kind: "GENERATE",
          objectId: lock.id,
          expectedVersion: lock.version,
          revisionId: lock.revision.id,
          authorized: true,
          authorization: { objectId: lock.id, revisionId: lock.revision.id },
        };
      await assert.rejects(enqueue(pool, { ...request, authorized: false }), {
        code: "GENERATION_AUTHORIZATION",
      });
      await enqueue(pool, request);
      const instance = path.join(
          (await phase.read()).resources[0].path,
          "producer-instance",
        ),
        outputDirectory = path.join(instance, "output");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        path.join(outputDirectory, "fixture.txt"),
        "controlled fixture bytes",
      );
      let calls = 0;
      await workOnce(pool, {
        root: instance,
        workerId: "fixture-worker",
        providers: {
          generate: async ({ inputs }) => {
            calls++;
            assert.equal(inputs[0].revision_id, prompt.revision.id);
            return {
              outputDirectory,
              outputs: [
                {
                  file: "fixture.txt",
                  mimeType: "text/plain",
                  title: "模拟产物",
                },
              ],
            };
          },
        },
      });
      const receipt = await operation(pool, request.operationId);
      assert.equal(receipt.status, "SUCCEEDED", JSON.stringify(receipt));
      const asset = await readObject(pool, receipt.result.outputs[0].id);
      assert.equal(asset.state, "DRAFT");
      assert.equal(
        asset.links.find((x) => x.role === "FAMILY").id,
        "production-family",
      );
      assert.equal(asset.rights.fact, "UNKNOWN");
      assert.equal((await enqueue(pool, request)).status, "SUCCEEDED");
      assert.equal(calls, 1);
      const second = { ...request, operationId: "stale-production" };
      await enqueue(pool, second);
      await run([
        save("production-prompt", "PROMPT", prompt.version, {
          text: "新的模拟内容",
        }),
      ]);
      await adopt("production-prompt");
      await workOnce(pool, {
        root: instance,
        workerId: "fixture-worker",
        providers: {
          generate: async () => {
            calls++;
            throw Error("must not be called");
          },
        },
      });
      assert.equal(
        (await operation(pool, second.operationId)).status,
        "FAILED",
      );
      assert.equal(calls, 1);
    },
  );
  await t.test('original execution handoff locks exact inputs and records one external candidate without generation',async()=>{
    const runtimeEpoch='d0fab4b5-0c84-4bc1-acb2-01a015fdfcdb';
    const read=(name,params)=>transaction(pool,tx=>workspaceRead(tx,name.split('/'),new URLSearchParams(params)),{readOnly:true});
    const action=(workspace,input,operationId='execution-test-'+ ++sequence)=>execute(pool,{operationId,runtimeEpoch,commands:[{type:'workspace.change',workspace,input}]});
    const good=async promise=>{const r=await promise;assert.equal(r.status,'SUCCEEDED',JSON.stringify(r));return r.workspace;};
    await create('external-family','MATERIAL',{description:'隔离外部执行候选'});
    await create('external-prompt','PROMPT',{text:'本轮受控模拟，禁止真实调用'});
    const prompt=await readObject(pool,'external-prompt');
    await create('external-call','CALL',{workItemRef:'external-work',definitionHash:'external-call-hash',model:'mock',prompt:'本轮受控模拟，禁止真实调用',inputBindings:[],output:{assetFamilyRef:'external-family',expectedOutputRef:'external-output'}},{links:[{id:'external-family',role:'FAMILY'}],dependencies:[{revisionId:prompt.revision.id,purpose:'CONTENT'}]});
    await create('external-output','EXPECTED_OUTPUT',{expectationState:'PLANNED',callId:'external-call'},{links:[{id:'external-family',role:'FAMILY'}]});
    const state=await read('input-locks',{callId:'external-call'}),snapshotId=state.snapshotId;
    const grantInput={action:'AUTHORIZE',snapshotId,workItemId:'external-work',familyId:'external-family',executionDefinitionId:'external-call',callPackageHash:'external-call-hash',executor:'USER_EXTERNAL',authorized:true,maxOutputs:1,inputBindings:[]};
    assert.equal((await action('execution-requests',grantInput)).error.code,'INPUT_LOCK_REQUIRED');
    const confirmation={action:'confirm',callId:'external-call',explicit:true,basisHash:state.basisHash,confirmedRevisionIds:state.reviewRequired.map(r=>r.revisionId),confirmedCriteria:[],note:'核对完整提示词、模型、参数及零附件；仅本轮隔离模拟。'};
    assert.equal((await action('input-locks',{...confirmation,confirmedRevisionIds:[]})).error.code,'INPUT_REVIEW_REQUIRED');
    const lock=await good(action('input-locks',confirmation));assert.equal(lock.state,'ADOPTED');assert.equal(lock.generationAuthorized,false);
    const grant=await good(action('execution-requests',grantInput,'external-authorize'));
    assert.deepEqual(await good(action('execution-requests',grantInput,'external-authorize')),grant);
    assert.equal((await action('execution-requests',grantInput)).error.code,'EXECUTION_ALREADY_AUTHORIZED');
    const common={snapshotId,executionRequestId:grant.executionRequestId,providerRunId:'mock-platform-1'};
    const submitted=await good(action('runs',{...common,state:'SUBMITTED'}));
    assert.equal((await action('runs',{...common,state:'SUBMITTED'})).error.code,'RUN_ALREADY_EXISTS');
    const unknown=await good(action('runs',{...common,runId:submitted.runId,state:'RESULT_UNKNOWN',expectedRunEventId:submitted.eventId,note:'模拟网络中断；未重试'}));
    assert.equal((await action('runs',{...common,runId:submitted.runId,state:'SUCCEEDED',expectedRunEventId:submitted.eventId})).error.code,'RUN_VERSION_CONFLICT');
    const success=await good(action('runs',{...common,runId:unknown.runId,state:'SUCCEEDED',expectedRunEventId:unknown.eventId}));
    const media=(await pool.query("SELECT * FROM media WHERE availability='PRESENT' LIMIT 1")).rows[0];assert(media);
    const candidate={...common,runId:success.runId,expectedRunEventId:success.eventId,expectedOutputId:'external-output',executionDefinitionId:'external-call',mediaId:media.id,mediaVersionId:media.version_id,sha256:media.sha256,actualPrompt:{main:'实际外部提示词'},inputBindings:[]};
    const imported=await good(action('imports',candidate,'external-import'));assert.equal(imported.state,'DRAFT');
    assert.equal((await readObject(pool,imported.versionId)).rights.fact,'UNKNOWN');
    assert.deepEqual(await good(action('imports',candidate,'external-import')),imported);
    assert.equal((await action('imports',candidate)).error.code,'OUTPUT_ALREADY_REGISTERED');
    assert.equal((await read('execution-requests',{executionRequestId:grant.executionRequestId})).latestRun.eventId,success.eventId);
    const recipe=(await read('recipes/external-call',{})).recipe;assert.equal(recipe.model.branch,'mock');assert.equal(recipe.prompt.main,'本轮受控模拟，禁止真实调用');assert.deepEqual(recipe.upload.items,[]);assert(recipe.currentRevisionId);
    assert.equal((await pool.query("SELECT count(*) AS count FROM operations WHERE kind='GENERATE' AND request->>'executionRequestId'=$1",[grant.executionRequestId])).rows[0].count,'0');
  });

  await t.test('presentation cache revalidates edits and new objects without a global write precondition',async()=>{
    const read=etag=>transaction(pool,tx=>cachedWorkspace(tx,['sources'],new URLSearchParams(),etag),{readOnly:true});
    const first=await read();assert(first.body&&first.etag);assert.equal((await read(first.etag)).unchanged,true);
    await create('cache-new-source','SOURCE',{text:'缓存新来源',role:'PRIMARY'});
    const next=await read(first.etag);assert(next.body&&!next.unchanged);assert.notEqual(next.etag,first.etag);
    const before=await transaction(pool,presentationToken,{readOnly:true}),scene=await readObject(pool,'organization-a');await run([save(scene.id,scene.kind,scene.version,{text:'修改后的正文'})]);assert.notEqual(await transaction(pool,presentationToken,{readOnly:true}),before);
  });
  await t.test('animatic UI queues one deterministic render and registers an unadopted candidate',async()=>{
    const root=path.join(process.env.REVIEW_TASK_DIR,'animatic-worker');await mkdir(path.join(root,'runtime','spool'),{recursive:true});
    const filename=path.join(root,'runtime','spool','fixture.png');await animaticProcess('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1920x1080','-frames:v','1','-threads','1','-n',filename]);
    const sha256=await fileSha(filename),bytes=(await readFile(filename)).length;
    await enqueue(pool,{operationId:'animatic-media',kind:'MEDIA_REGISTER',filename,sha256,bytes,mediaId:'animatic-media',versionId:sha256,mimeType:'image/png'});await workOnce(pool,{root,workerId:'animatic-test-worker',providers:{}});
    const registered=await operation(pool,'animatic-media');assert.equal(registered.status,'SUCCEEDED');
    await create('animatic-family','MATERIAL',{description:'测试分镜'});await create('animatic-image','ASSET',{description:'合成图'},{links:[{id:'animatic-family',role:'FAMILY'}],media:[{id:'animatic-media',versionId:sha256,sha256,role:'OUTPUT'}]});
    let asset=await readObject(pool,'animatic-image');assert.equal((await run([{type:'rights.record',id:asset.id,expectedVersion:asset.version,revisionId:asset.revision.id,explicit:true,fact:'CLEAR',evidence:{note:'验收合成素材'}}])).status,'SUCCEEDED');await adopt(asset.id);
    await create('animatic-scene','SCENE',{text:'测试'});await create('animatic-shot','SHOT',{visualIntent:'合成画面',design:canonicalShotDesign({shotSize:'WIDE',cameraAngle:'EYE_LEVEL',cameraMovement:'STATIC',composition:'合成画面',performance:'无人物',lighting:'均匀',estimatedDurationSeconds:0.25,subjectIds:[],continuity:{startState:'静止',endState:'静止',previousShotId:null,nextShotId:null,transitionIn:'CUT',transitionOut:'CUT'},keyframeStrategy:{mode:'START_ONLY',reason:'单镜验收',intermediateFrameCount:0}})},{links:[{id:'animatic-scene',role:'SCENE'}]});
    await create('animatic-design','SHOT_DESIGN',{}, {links:[{id:'animatic-scene',role:'SCENE'},{id:'animatic-shot',role:'SHOT'}]});await adopt('animatic-design');
    const state=await transaction(pool,tx=>workspaceRead(tx,['shot-production','animatics'],new URLSearchParams({sceneId:'animatic-scene'})),{readOnly:true});
    const timeline={schemaVersion:'1.0',sceneId:'animatic-scene',shotPlanRevisionId:state.basis.shotPlanRevisionId,fps:24,width:1920,height:1080,shots:[{shotId:'animatic-shot',durationFrames:6,panels:[{id:'panel',media:{versionId:asset.id,familyId:'animatic-family',sha256},startFrame:0,endFrame:6,motion:'STILL'}],beats:[]}],audio:[],cards:[]};
    const saved=await run([{type:'workspace.change',workspace:'shot-production/animatics',input:{action:'save',sceneId:'animatic-scene',expectedReleaseId:state.releaseId,expectedRevisionId:state.revisionId,content:timeline}}]);assert.equal(saved.status,'SUCCEEDED',JSON.stringify(saved));
    const request=await prepareAnimaticRender(pool,{action:'render',sceneId:'animatic-scene',expectedReleaseId:state.releaseId,expectedRevisionId:saved.workspace.revisionId,timelineRevisionId:saved.workspace.revisionId},{operationId:'animatic-render',runtimeEpoch:'d0fab4b5-0c84-4bc1-acb2-01a015fdfcdb'});
    await enqueue(pool,request);assert.equal((await enqueue(pool,request)).replayed,true);await assert.rejects(enqueue(pool,{...request,operationId:'animatic-duplicate'}),{code:'ANIMATIC_PENDING'});
    const outputDirectory=path.join(root,'output');await mkdir(outputDirectory);let calls=0;
    await workOnce(pool,{root,workerId:'animatic-test-worker',providers:{renderAnimatic:async args=>{calls++;return {...await renderAnimatic({...args,outputDirectory}),outputDirectory};}}});
    const result=await operation(pool,request.operationId);assert.equal(result.status,'SUCCEEDED',JSON.stringify(result.error));assert.equal(result.result.frameCount,6);assert.match(result.result.mediaUrl,/^\/api\/v1\/media\/[a-f0-9]{64}$/);assert.equal((await readObject(pool,result.result.outputs[0].id)).state,'DRAFT');assert.equal(calls,1);
  });

  await t.test('production manifest and keyframe observation proof survive export and cannot bypass the shared review service',async()=>{
    const read=(name,params)=>transaction(pool,tx=>workspaceRead(tx,name.split('/'),new URLSearchParams(params)),{readOnly:true});
    const action=async(workspace,input)=>{const result=await run([{type:'workspace.change',workspace,input}]);assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));return result.workspace;};
    const sceneId='animatic-scene',shotId='animatic-shot';
    const spec={version:'fixture-v1',locations:[{id:'LOC',name:'合成场地'}],states:[{id:'BASE',label:'基础态'}],locationPackages:[{id:'LOC',zones:[{id:'ZONE'}],cameras:[{id:'CAM',zoneIds:['ZONE']}]}]};
    const bytes=Buffer.from(JSON.stringify(spec)),source=await create('production-space','SOURCE',{text:bytes.toString()});
    await pool.query("INSERT INTO source_documents(revision_id,original_revision_id,original_sha256,mime_type,content_bytes,logical_path,role) VALUES($1,$1,$2,'application/json',$3,'data/production_map_spec.json','PRODUCTION_SPACE')",[source.revisionId,hash(bytes),bytes]);
    let settings=await read('shot-production',{sceneId});const content=settings.defaultContent;
    Object.assign(content.shots[0],{space:{loc:'LOC',state:'BASE',zone:'ZONE',camera:'CAM',freeze:hash(bytes)},videoBranch:'SILENT'});
    const saved=await action('shot-production',{action:'save',sceneId,content,expectedReleaseId:settings.releaseId,expectedDraftRevisionId:settings.draftHeadRevisionId});
    const preview=await action('shot-production',{action:'preview',sceneId,draftRevisionId:saved.revisionId});
    await action('shot-production',{action:'publish',sceneId,draftRevisionId:saved.revisionId,previewHash:preview.previewHash});
    settings=await read('shot-production',{sceneId});assert.equal(settings.manifestTargets.length,2);assert.equal(settings.readiness.ready,false);
    const manifestTarget=settings.manifestTargets.find(o=>o.deliverableKey==='SHOT_INPUT_LOCK');
    const manifest=await action('shot-production',{action:'manifest-preview',sceneId,workItemId:manifestTarget.workItemId});
    assert.equal(manifest.content.formalReviewCreated,false);
    const request=await prepareManifestRender(pool,{action:'manifest-render',sceneId,workItemId:manifest.workItemId,manifestHash:manifest.manifestHash,expectedReleaseId:manifest.expectedReleaseId},{operationId:'input-manifest',runtimeEpoch:'d0fab4b5-0c84-4bc1-acb2-01a015fdfcdb'});
    await enqueue(pool,request);assert.equal((await enqueue(pool,request)).replayed,true);await assert.rejects(enqueue(pool,{...request,operationId:'input-manifest-duplicate'}),{code:'MANIFEST_PENDING'});
    const root=path.join(process.env.REVIEW_TASK_DIR,'animatic-worker'),outputDirectory=path.join(root,'manifest-output');await mkdir(outputDirectory);let calls=0;
    await workOnce(pool,{root,workerId:'manifest-worker',providers:{renderManifest:async({request})=>{calls++;const result=JSON.parse(execFileSync(process.execPath,['scripts/render-manifest.mjs'],{input:JSON.stringify({request,outputDirectory}),encoding:'utf8'}));assert.equal(result.type,'answer');return {...result.value,outputDirectory};}}});
    const result=await operation(pool,request.operationId);assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(calls,1);
    const assetId=result.result.outputs[0].id;let asset=await readObject(pool,assetId);assert.equal(asset.state,'DRAFT');
    const output=await readObject(pool,manifest.expectedOutputId),reviewSpec=output.revision.content.reviewSpec;
    const findings=reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'隔离合成素材的逐项验收'}));
    await run([{type:'rights.record',id:asset.id,expectedVersion:asset.version,revisionId:asset.revision.id,explicit:true,fact:'CLEAR',evidence:{note:'验收生成的内部清单'}}]);asset=await readObject(pool,assetId);
    const base={subjectType:'WORK_PRODUCT',workItemId:manifest.workItemId,subjectId:manifest.workItemId,versionId:assetId,objectRevisionId:asset.revision.id,expectedVersion:asset.version,reviewSpecHash:reviewSpec.hash,criterionFindings:findings,action:'APPROVE_AND_RELEASE',note:'实际输入逐项核对完成'};
    const missing=await run([{type:'workspace.change',workspace:'reviews',input:base}]);assert.equal(missing.error.code,'PRODUCTION_EVIDENCE_CHANGED');
    const template=await read('views/shot-production-review-evidence',{workItemId:manifest.workItemId,versionId:assetId});assert.equal(template.evidence.kind,'INPUT_LOCK');
    const reviewed=await action('reviews',{...base,shotProductionEvidence:template.evidence});assert(reviewed.adopted);
    const proof=(await pool.query("SELECT content FROM provenance WHERE kind='review' AND original_id=$1",[reviewed.eventId])).rows[0].content;
    assert.deepEqual(proof.shotProductionEvidence,template.evidence);assert.equal(proof.workItemId,manifest.workItemId);
    const exported=[];for await(const line of exportRecords(pool)){const row=JSON.parse(line);if(row.table==='provenance'&&row.row.original_id===reviewed.eventId)exported.push(row.row.content);}
    assert.deepEqual(exported,[proof]);
    const outputs=(await read('views/production',{})).page.expectedOutputs.filter(o=>o.sceneId===sceneId&&o.workItemId);
    const approve=async(versionId,output,extra={})=>{let v=await readObject(pool,versionId);await run([{type:'rights.record',id:v.id,expectedVersion:v.version,revisionId:v.revision.id,explicit:true,fact:'CLEAR',evidence:{note:'隔离合成素材'}}]);v=await readObject(pool,versionId);const body={subjectType:'WORK_PRODUCT',subjectId:output.workItemId,workItemId:output.workItemId,versionId,objectRevisionId:v.revision.id,expectedVersion:v.version,reviewSpecHash:output.reviewSpec.hash,criterionFindings:output.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'仅隔离合成素材验证'})),action:'APPROVE_AND_RELEASE',note:'本次实际观察与输入核对',...extra};return {body,value:await run([{type:'workspace.change',workspace:'reviews',input:body}])};};
    let timeline=await read('shot-production/animatics',{sceneId});const newTimeline=await action('shot-production/animatics',{action:'save',sceneId,expectedReleaseId:timeline.releaseId,expectedRevisionId:timeline.revisionId,content:timeline.content});
    const animation=await prepareAnimaticRender(pool,{action:'render',sceneId,expectedReleaseId:timeline.releaseId,expectedRevisionId:newTimeline.revisionId,timelineRevisionId:newTimeline.revisionId},{operationId:'formal-animatic-render',runtimeEpoch:request.runtimeEpoch});
    await enqueue(pool,animation);const animationDirectory=path.join(root,'formal-animatic-output');await mkdir(animationDirectory);
    await workOnce(pool,{root,workerId:'proof-worker',providers:{renderAnimatic:async args=>({...await renderAnimatic({...args,outputDirectory:animationDirectory}),outputDirectory:animationDirectory})}});
    const rendered=await operation(pool,animation.operationId);assert.equal(rendered.status,'SUCCEEDED',JSON.stringify(rendered));
    const animationId=rendered.result.outputs[0].id,animationOutput=outputs.find(o=>o.deliverableKey==='ANIMATIC');assert.equal((await approve(animationId,animationOutput)).value.status,'SUCCEEDED');
    assert.equal((await read('shot-production/animatics',{sceneId})).lock.timelineRevisionId,newTimeline.revisionId);
    const frameOutput=outputs.find(o=>o.deliverableKey==='START_FRAME'),frameMedia=(await readObject(pool,'animatic-image')).media[0];
    await create('production-frame','ASSET',{basis:{expectedOutputId:frameOutput.id}},{links:[{id:frameOutput.familyId,role:'FAMILY'}],dependencies:[{revisionId:frameOutput.revisionId,purpose:'DEFINITION'}],media:[{id:frameMedia.id,versionId:frameMedia.version_id,sha256:frameMedia.sha256,role:'OUTPUT'}]});
    const frameTemplate=await read('views/shot-production-review-evidence',{workItemId:frameOutput.workItemId,versionId:'production-frame'});
    assert.deepEqual(frameTemplate.requiredObservedImageIds,['production-frame']);assert.equal(frameTemplate.requiresJointReview,true);assert.deepEqual(frameTemplate.evidence.observedImageIds,[]);
    const missingObservation=await approve('production-frame',frameOutput,{shotProductionEvidence:frameTemplate.evidence});assert.equal(missingObservation.value.error.code,'MEDIA_OBSERVATION_REQUIRED');
    const frameProof={...frameTemplate.evidence,observedImageIds:['production-frame'],jointFindings:{continuity:{outcome:'PASS',note:'合成单帧连续性验证'},composition:{outcome:'PASS',note:'合成图构图验证'}}};
    const frameApproval=await approve('production-frame',frameOutput,{shotProductionEvidence:frameProof});assert.equal(frameApproval.value.status,'SUCCEEDED',JSON.stringify(frameApproval));
    assert.equal((await read('shot-production',{sceneId})).readiness.ready,true);
    const videoOutput=outputs.find(o=>o.deliverableKey==='SHOT_VIDEO'),videoMedia=(await readObject(pool,animationId)).media[0];
    await create('production-video','ASSET',{basis:{expectedOutputId:videoOutput.id}},{links:[{id:videoOutput.familyId,role:'FAMILY'}],dependencies:[{revisionId:videoOutput.revisionId,purpose:'DEFINITION'}],media:[{id:videoMedia.id,versionId:videoMedia.version_id,sha256:videoMedia.sha256,role:'OUTPUT'}]});
    assert.equal((await approve('production-video',videoOutput)).value.status,'SUCCEEDED');
    const lockOutput=outputs.find(o=>o.deliverableKey==='LOCKED_SHOT'),lockManifest=await action('shot-production',{action:'manifest-preview',sceneId,workItemId:lockOutput.workItemId});
    assert.deepEqual(lockManifest.content.reviewBinding.members.map(m=>m.versionId),['production-video']);
    const lockTemplate=await read('views/shot-production-review-evidence',{workItemId:lockOutput.workItemId});assert.deepEqual(new Set(lockTemplate.requiredObservedVideoIds),new Set(['production-video',animationId]));assert.deepEqual(lockTemplate.evidence.observedVideoIds,[]);
    const lockInput={action:'manifest-render',sceneId,workItemId:lockOutput.workItemId,manifestHash:lockManifest.manifestHash,expectedReleaseId:lockManifest.expectedReleaseId},lockKey={operationId:'shot-lock-manifest',runtimeEpoch:request.runtimeEpoch};
    const lockRequest=await prepareManifestRender(pool,lockInput,lockKey);await enqueue(pool,lockRequest);
    const lockDirectory=path.join(root,'shot-lock-output');await mkdir(lockDirectory);
    await workOnce(pool,{root,workerId:'proof-worker',providers:{renderManifest:async({request})=>{const result=JSON.parse(execFileSync(process.execPath,['scripts/render-manifest.mjs'],{input:JSON.stringify({request,outputDirectory:lockDirectory}),encoding:'utf8'}));return {...result.value,outputDirectory:lockDirectory};}}});
    const lockResult=await operation(pool,lockRequest.operationId);assert.equal(lockResult.status,'SUCCEEDED',JSON.stringify(lockResult));const lockId=lockResult.result.outputs[0].id;
    assert.equal((await approve(lockId,lockOutput,{shotProductionEvidence:lockTemplate.evidence})).value.error.code,'MEDIA_OBSERVATION_REQUIRED');
    const lockEvidence={...lockTemplate.evidence,observedVideoIds:lockTemplate.requiredObservedVideoIds,videoFindings:Object.fromEntries(['action','camera','consistency','timing','adjacency'].map(k=>[k,{outcome:'PASS',note:'隔离合成视频与预演的实际对照'}]))};
    assert.equal((await approve(lockId,lockOutput,{shotProductionEvidence:lockEvidence})).value.status,'SUCCEEDED');
    const changed=structuredClone(timeline.content);changed.shots[0].beats.push({id:'timing-change',frame:1,label:'改变本镜动作点'});
    timeline=await read('shot-production/animatics',{sceneId});await action('shot-production/animatics',{action:'save',sceneId,expectedReleaseId:timeline.releaseId,expectedRevisionId:timeline.revisionId,content:changed});
    assert.equal((await read('shot-production',{sceneId})).readiness.ready,false);
    assert.deepEqual(await prepareManifestRender(pool,lockInput,lockKey),lockRequest,'Same operation recovers its original request after inputs change');
    await assert.rejects(prepareManifestRender(pool,{...lockInput,manifestHash:'f'.repeat(64)},lockKey),{code:'OPERATION_ID_CONFLICT'});
    const direct=await create('production-bypass','ASSET',{basis:{expectedOutputId:output.id}},{links:asset.links,media:asset.media.map(m=>({id:m.id,versionId:m.version_id,sha256:m.sha256,role:m.role}))});
    let candidate=await readObject(pool,'production-bypass');await run([{type:'rights.record',id:candidate.id,expectedVersion:candidate.version,revisionId:candidate.revision.id,explicit:true,fact:'CLEAR',evidence:{note:'隔离'}}]);candidate=await readObject(pool,candidate.id);await run([{type:'submit',id:candidate.id,expectedVersion:candidate.version}]);
    const denied=await run([{type:'review',id:candidate.id,expectedVersion:candidate.version+1,revisionId:candidate.revision.id,decision:'ADOPT',explicit:true,note:'缺少制作依据'}]);assert.equal(denied.error.code,'PRODUCTION_REVIEW_BASIS');
  });

});
