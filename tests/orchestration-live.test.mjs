/** Opt-in real Codex + PostgreSQL smoke. This never runs in the ordinary unit suite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, readFile, writeFile, cp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createInstanceRepository } from '../host/instance-runtime/index.mjs';
import { blankProfile, blankSnapshot } from '../host/instance-runtime/blank.mjs';
import { readOrchestration, writeOrchestration } from '../host/instance-runtime/orchestration-service.mjs';
import { OrchestrationCodex } from '../host/orchestration-codex.mjs';
import { OrchestrationLedgerClient, OrchestrationRunner, privateDirectory, gitArtifactSha256 } from '../host/orchestration-runner.mjs';
import { sharedStoryPostgres } from './fixtures/shared-story-postgres.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const coreRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('real Codex develops, independently reviews and locally delivers an exact fixture commit', {
  skip: process.env.REVIEW_TEST_ORCHESTRATION_LIVE !== '1', timeout: 600000,
}, async t => {
  const parent = path.join(coreRoot, 'tests', '.test-tmp'); await mkdir(parent, { recursive: true });
  const projectRoot = await realpath(await mkdtemp(path.join(parent, 'orchestration-live-')));
  const repository = path.join(projectRoot, 'repository'), instanceRoot = path.join(projectRoot, 'instance');
  const receiptPath = path.join(projectRoot, 'local-delivery-receipt.json');
  const expected = 'Hello from Story Review Orchestrator.\n';
  const fixtureGuidance = '# Isolated orchestration verification fixture\n\n'
    + 'This project is a disposable software protocol test with its own Git repository and PostgreSQL database. The task and its exact input/authorization are supplied by the orchestration ledger. There is no story, media, production service, deployed application, or business source to inspect or modify.\n\n'
    + 'Read this repository README.md, AGENTS.md and STATE.md. The task is authorized to write greeting.txt, commit a candidate, independently QA it, and only during FINALIZE fast-forward the explicit fixture repository and create the explicit local JSON receipt. Do not push, deploy, generate media, create more agents, or access any other repository/instance. Do not read private runtime capabilities or credentials. Ordinary tests and task-scoped Git writes are authorized.\n\n'
    + 'The host has already validated and supplied the active fixture task and role context; all ledger operations go through dynamic orchestration tools. There is no installed production review-software CLI in this fixture, and no additional story guidance applies. No production Docker/Sites/release checks are relevant to this greeting-file test.\n';
  const skillSource = process.env.REVIEW_ORCHESTRATION_SKILL_ROOT || path.join(coreRoot, '.agents', 'skills', 'story-review-orchestrator');
  await cp(skillSource, path.join(projectRoot, '.agents', 'skills', 'story-review-orchestrator'), { recursive: true, dereference: false });
  await mkdir(repository); await mkdir(instanceRoot, { mode: 0o700 });
  for (const name of ['README.md', 'AGENTS.md', 'STATE.md']) {
    await writeFile(path.join(projectRoot, name), fixtureGuidance);
    await writeFile(path.join(repository, name), fixtureGuidance);
  }
  await execute('git', ['init', '--initial-branch=main', repository]);
  await execute('git', ['-C', repository, 'config', 'user.name', 'Orchestration Fixture']);
  await execute('git', ['-C', repository, 'config', 'user.email', 'orchestration-fixture@example.invalid']);
  await execute('git', ['-C', repository, 'add', 'README.md', 'AGENTS.md', 'STATE.md']);
  await execute('git', ['-C', repository, 'commit', '-m', 'test: initialize isolated orchestration fixture']);
  const baseCommit = (await execute('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const keys = ['REVIEW_POSTGRES_HOST', 'REVIEW_POSTGRES_PORT', 'REVIEW_POSTGRES_PASSWORD_FILE', 'REVIEW_POSTGRES_PASSWORD', 'REVIEW_POSTGRES_USER'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let pg, repo, runner, privateRoot, schedulerClosed = false;
  t.after(async () => {
    runner?.shutdown();
    if (runner) {
      await Promise.allSettled([...runner.active.values()].map(async record => { record.adapter?.interruptActive('LIVE_TEST_FINISHED'); await record.adapter?.close(); }));
      await Promise.allSettled([...runner.active.values()].map(record => record.promise));
      schedulerClosed = !runner.scheduleAdapter || await runner.scheduleAdapter.close();
      await runner.schedulePromise;
      await runner.lock?.release();
    }
    await repo?.close(); await pg?.cleanup();
    // Remove only disposable credentials; preserve source commits and verification receipts for inspection.
    if (privateRoot) for (const name of await readdir(privateRoot)) {
      if (name === 'requests' || name === 'scheduler.json' || name.startsWith('main-') || /^run-[a-f0-9]+\.json$/.test(name)) await rm(path.join(privateRoot, name), { recursive: name === 'requests', force: true });
    }
    await rm(path.join(instanceRoot, 'runtime', 'private', 'postgres-password'), { force: true });
    for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  });
  pg = await sharedStoryPostgres(instanceRoot);
  const profile = blankProfile({ title: 'Disposable real orchestration fixture' });
  repo = await createInstanceRepository({ root: instanceRoot, instanceId: profile.instanceId, backend: 'postgres', database: pg.database, profile });
  await repo.writeTransaction(tx => tx.publishRelease({ ...blankSnapshot(profile), expectedReleaseId: null, sourceRevisionIds: [] }));
  const { runtimeEpoch, instanceId } = await repo.getMetadata();
  privateRoot = await privateDirectory(instanceRoot);
  const ledger = new OrchestrationLedgerClient({ instanceRoot, runtimeEpoch, privateRoot,
    transport: async (selected, args, { input }) => {
      assert.equal(selected, instanceRoot);
      if (args[0] === 'orchestration-read') return repo.readTransaction(tx => readOrchestration(tx, input));
      assert.equal(args[0], 'orchestration-write'); return repo.writeTransaction(tx => writeOrchestration(tx, input));
    } });
  const attached = await ledger.write('attach', { entryId: 'live-fixture-main' }), main = { kind: 'MAIN', ...attached.main };
  await ledger.write('activate', { projectRoot,
    ...(process.env.REVIEW_ORCHESTRATION_MODEL ? { model: process.env.REVIEW_ORCHESTRATION_MODEL } : {}),
    ...(process.env.REVIEW_ORCHESTRATION_EFFORT ? { effort: process.env.REVIEW_ORCHESTRATION_EFFORT } : {}),
    authorization: { source: 'Explicit real local development smoke test request', scope: 'Only the exact fixture repository and local delivery receipt; no push/deployment/media generation', automaticCompletion: true },
  }, main);
  // All adapters and turns are real; only storage routing is injected to the real disposable PostgreSQL transaction.
  runner = new OrchestrationRunner({ projectRoot, instanceRoot, instanceId, runtimeEpoch, privateRoot, main, ledger,
    codexFactory: options => new OrchestrationCodex(options),
    instructions: async (project, kind) => {
      const refs = path.join(project, '.agents', 'skills', 'story-review-orchestrator', 'references');
      const role = kind === 'SCHEDULER' ? 'schedule.md' : 'development.md';
      return (await readFile(path.join(refs, 'protocol.md'), 'utf8')) + '\n' + (await readFile(path.join(refs, role), 'utf8'))
        + '\n' + fixtureGuidance + '\n当前角色：' + kind + '。This is the explicitly authorized local fixture smoke task; use only the explicit paths in its payload.';
    },
  });
  await runner.initialize();
  const { task } = await ledger.write('submit', {
    kind: 'DEVELOP', title: 'Real greeting file smoke test',
    goal: 'WORK: add only greeting.txt at the assigned isolated worktree root. Its exact UTF-8 bytes have hexadecimal value ' + Buffer.from(expected).toString('hex') + ' and SHA256 ' + hash(Buffer.from(expected))
      + '. It ends with one LF byte, not literal backslash-n. Read fixture README/AGENTS/STATE; verify exact bytes with a local executable assertion and use orchestration_commit_candidate with paths [greeting.txt] to commit it. Return the exact git:<commit> artifact and SHA256 given by the controlled tool. '
      + 'QA: independently read the exact submitted commit and greeting.txt, execute an exact-content assertion, verify only greeting.txt was changed relative to the base commit; report all acceptance criteria and echo artifactHash. Do not modify tracked files. '
      + 'FINALIZE: only after QA PASS, use orchestration_fast_forward to integrate the exact approved candidate into the explicitly bound fixture repository. '
      + 'Verify repository greeting.txt bytes, then write ' + JSON.stringify(receiptPath) + ' as JSON containing status DELIVERED, commit equal to the approved commit, greetingSha256 equal to the greeting bytes SHA256. '
      + 'Return unchanged approved artifacts/artifactHash and deliveryEvidence containing this exact receipt path and actual receipt SHA256. No remote exists; do not push, deploy, generate media, or spawn additional agents.',
    scope: 'Only fixture repo ' + repository + ', host-created isolated worktrees and local receipt ' + receiptPath,
    acceptance: [{ id: 'exact-greeting', text: 'greeting.txt has exact SHA256 ' + hash(Buffer.from(expected)) + ' and ends with one LF byte, observed by an executable assertion' },
      { id: 'isolated-change', text: 'The exact candidate commit changes only greeting.txt relative to the pinned base commit' },
      { id: 'commit-proof', text: 'Candidate commit identity and reported git show bytes SHA256 are exact and independently observed' }],
    inputs: [{ ref: 'git:' + baseCommit, sha256: await gitArtifactSha256(repository, baseCommit) }],
    resources: ['fixture:greeting'], execution: { cwd: repository, repository, baseCommit },
  }, main);
  const deadline = Date.now() + 540000;
  let finalTask, lastProgress = '', lastProgressAt = 0;
  while (Date.now() < deadline) {
    await runner.pump();
    const state = await ledger.read();
    finalTask = (await ledger.read('task', { taskId: task.id })).task;
    const progress = JSON.stringify({ phase: 'LIVE_PROGRESS', taskStatus: finalTask.status, active: state.runs.map(run => ({ phase: run.phase, status: run.status, threadId: run.threadId, turnId: run.turnId })), decisionTypes: state.decisions.map(item => item.type) });
    if (progress !== lastProgress || Date.now() - lastProgressAt >= 30000) { console.log(progress); lastProgress = progress; lastProgressAt = Date.now(); }
    if (state.decisions.length || state.scheduler?.blocked) {
      await writeFile(path.join(projectRoot, 'blocked-verification.json'), JSON.stringify({ status: 'BLOCKED', projectRoot, task: finalTask, runs: state.runs, decisions: state.decisions }, null, 2) + '\n');
      throw Object.assign(new Error('Real execution requires a user decision; no retry attempted'), { code: state.decisions[0]?.type || 'SCHEDULER_BLOCKED' });
    }
    if (finalTask.status === 'DONE') break;
    await pause(2000);
  }
  assert.equal(finalTask.status, 'DONE', 'Real smoke must finish all three phases within its deadline');
  await Promise.allSettled([...runner.active.values()].map(record => record.promise)); await runner.schedulePromise;
  const allTasks = (await ledger.read('list')).tasks.filter(item => item.rootId === task.id);
  const allRuns = (await Promise.all(allTasks.map(item => ledger.read('task', { taskId: item.id })))).flatMap(item => item.runs);
  assert.equal(allRuns.length, 3); assert.deepEqual(new Set(allRuns.map(run => run.phase)), new Set(['WORK', 'QA', 'FINALIZE']));
  assert.equal(new Set(allRuns.map(run => run.threadId)).size, 3); assert.ok(allRuns.every(run => run.status === 'COMPLETED'));
  const approvedCommit = finalTask.artifacts.find(item => item.ref.startsWith('git:')).ref.slice(4);
  assert.equal((await execute('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim(), approvedCommit);
  assert.equal(await readFile(path.join(repository, 'greeting.txt'), 'utf8'), expected);
  const receiptBytes = await readFile(receiptPath), receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.status, 'DELIVERED'); assert.equal(receipt.commit, approvedCommit); assert.equal(receipt.greetingSha256, hash(Buffer.from(expected)));
  assert.ok(finalTask.result.deliveryEvidence.some(item => item.ref === receiptPath && item.sha256 === hash(receiptBytes)));
  const processReceipts = await Promise.all((await readdir(privateRoot)).filter(name => name.startsWith('process-receipt-')).map(async name => JSON.parse(await readFile(path.join(privateRoot, name), 'utf8'))));
  assert.equal(processReceipts.length, 3); assert.ok(processReceipts.every(item => item.processGroupClosed === true));
  await ledger.write('stop', {}, main); runner.shutdown();
  schedulerClosed = !runner.scheduleAdapter || await runner.scheduleAdapter.close(); assert.equal(schedulerClosed, true);
  const proof = { status: 'LIVE_DEVELOP_CLOSED_LOOP_VERIFIED', projectRoot, databaseBackend: 'postgres', inference: 'REAL_CODEX',
    taskId: task.id, finalStatus: finalTask.status, baseCommit, approvedCommit, greetingSha256: hash(Buffer.from(expected)),
    receiptPath, receiptSha256: hash(receiptBytes), phases: allRuns.map(run => ({ phase: run.phase, threadId: run.threadId, turnId: run.turnId, model: run.model, effort: run.effort })),
    workerProcessGroupsClosed: true, schedulerProcessGroupClosed: schedulerClosed, remotePushes: 0, deployments: 0, mediaGeneration: 0 };
  await writeFile(path.join(projectRoot, 'verification.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
});
