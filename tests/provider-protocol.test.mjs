import {createHash} from 'node:crypto';
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { createProject } from "../tools/project.mjs";
import {
  requiredPhase,
  phaseRecords,
  ProcessPhase,
  readProcessConfig,
} from "../tools/process-resources.mjs";
import { processProvider } from "../server/process-provider.mjs";

test("host Codex protocol uses only versioned business reads and rejects other tools", async (t) => {
  const outer = await requiredPhase(process.cwd());
  assert(outer);
  const project = path.join(
    (await outer.read()).resources[0].path,
    "provider-project",
  );
  await createProject(project, { initializeGit: false, host: "fixture" });
  const object = {
    id: "fixture",
    version: 1,
    revision: {
      id: "fixture-revision",
      sha256: "a".repeat(64),
      content: { text: "原稿" },
    },
  };
  const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=','base64');
  const imageSha=createHash('sha256').update(imageBytes).digest('hex');
  const server = http.createServer((req, res) => {
    if(req.url.includes('/media/')){res.setHeader('Content-Type','image/png');res.end(imageBytes);return;}
    if(req.url.includes('/objects/image-fixture')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...object,id:'image-fixture',kind:'ASSET',media:[{role:'OUTPUT',availability:'PRESENT',sha256:imageSha,mime_type:'image/png'}]}));return;}
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url.includes("/source/")
          ? { original_sha256: "b".repeat(64), offset: 0, text: "原始依据" }
          : req.url.includes("/contexts/")
            ? {
                object,
                primary: [
                  {
                    ...object,
                    id: "parent",
                    contextBinding: "EXACT_INPUT",
                    revision: { ...object.revision, id: "parent-revision" },
                  },
                ],
                basis: [
                  {
                    objectId: "fixture",
                    revisionId: "fixture-revision",
                    sha256: object.revision.sha256,
                    objectVersion: 1,
                  },
                  {
                    objectId: "parent",
                    revisionId: "parent-revision",
                    sha256: object.revision.sha256,
                  },
                ],
              }
            : req.url.includes("/objects?")
              ? {
                  items: [
                    {
                      ...object,
                      draftRevisionId: object.revision.id,
                      revisionSha256: object.revision.sha256,
                    },
                  ],
                  nextOffset: null,
                }
              : object,
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const payload = {
    cwd: project,
    codexBin: path.resolve("tests/mock-codex.py"),
    apiUrl: "http://127.0.0.1:" + server.address().port,
    object,
    request: { operationId: "mock-protocol", prompt: "模拟请求" },
  };
  let requestId;
  const result = await processProvider({
    root: path.join(project, "instance"),
    command: ["python3", path.resolve("server/collaboration/codex_suggest.py")],
    payload,
    onRequestId: async (id) => (requestId = id),
  });
  assert.equal(requestId, "mock-thread/mock-turn");
  assert.equal(result.value.patch.text, "模拟修订");
  assert.equal(result.value.sourceVersions.length, 5);
  assert.equal(result.value.sourceVersions[0].objectVersion, 1);
  assert.equal(result.value.sourceVersions[1].length, 4);
  assert.equal(result.value.sourceVersions[3].revisionId, "parent-revision");
  assert.equal(result.value.sourceVersions[3].objectVersion, undefined);
  assert.equal(result.value.sourceVersions[4].objectVersion, 1);
  assert.equal((await result.phase.finish()).status, "CLEANED");
  process.env.MOCK_IMAGE_SHA=imageSha;
  try{
    const observed=await processProvider({root:path.join(project,'instance'),command:['python3',path.resolve('server/collaboration/codex_suggest.py')],payload:{...payload,request:{...payload.request,operationId:'mock-image'}},onRequestId:async()=>{}});
    assert.deepEqual(observed.value.observedImageIds,['image-fixture']);assert.equal(observed.value.sourceVersions.at(-1).mediaSha256,imageSha);assert.equal((await observed.phase.finish()).status,'CLEANED');
  }finally{delete process.env.MOCK_IMAGE_SHA;}
  process.env.MOCK_ILLEGAL_TOOL = "1";
  try {
    await assert.rejects(
      processProvider({
        root: path.join(project, "instance"),
        command: [
          "python3",
          path.resolve("server/collaboration/codex_suggest.py"),
        ],
        payload: {
          ...payload,
          request: { ...payload.request, operationId: "mock-rejected" },
        },
        onRequestId: async () => {},
      }),
    );
  } finally {
    delete process.env.MOCK_ILLEGAL_TOOL;
  }
  // This controlled fixture never invoked a model. Resolve its retained diagnostic
  // workspace using that exact evidence, then verify the owning phase is empty.
  const policy = await readProcessConfig(project);
  for (const { file, record } of await phaseRecords(project)) {
    if (record.outcome !== "RESULT_UNKNOWN") continue;
    const phase = new ProcessPhase(policy, file, record.token);
    await phase.update((r) => {
      for (const resource of r.resources)
        if (resource.kind === "path") resource.state = "TEMPORARY";
      r.status = "CLEANUP_REQUIRED";
    });
    assert.equal(
      (
        await phase.finish({
          recover: true,
          outcome: "MOCK_REJECTION_VERIFIED",
        })
      ).status,
      "CLEANED",
    );
  }
});
