import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readOrchestration, writeOrchestration, ORCHESTRATION_NAMESPACE} from '../host/instance-runtime/orchestration-service.mjs';
import {canonicalJson, sha256} from '../host/instance-runtime/bytes.mjs';

const capability = () => randomUUID() + randomUUID();
const artifact = {ref: 'artifact:revision-one', sha256: 'a'.repeat(64)};
function fixture(instanceId = 'instance-fixture') {
  let rows = new Map(), counter = 0;
  const metadata = {instanceId, runtimeEpoch: 'epoch-first', releaseId: 'release-first'};
  const tx = {
    getMetadata: async () => metadata,
    getAux: async (namespace, key) => rows.get(namespace + ':' + key) || null,
    listAux: async (namespace, {prefix = ''}) => [...rows.values()].filter(row => row.namespace === namespace && row.key.startsWith(prefix)),
    putAux: async ({namespace, key, bytes, expectedRevisionId, metadata: recordMetadata}) => {
      assert.equal(expectedRevisionId, rows.get(namespace + ':' + key)?.revisionId || null, 'every state write uses CAS');
      const row = {namespace, key, bytes: Buffer.from(bytes), revisionId: 'revision-' + ++counter, sha256: sha256(bytes), metadata: recordMetadata}; rows.set(namespace + ':' + key, row); return row;
    },
  };
  const call = async (command, args = {}, actor, requestId = randomUUID()) => {
    const before = new Map(rows);
    try {return await writeOrchestration(tx, {schemaVersion: '1.0', command, args, actor, requestId, runtimeEpoch: metadata.runtimeEpoch});}
    catch (error) {rows = before; throw error;}
  };
  const f = {metadata, tx, call, read: input => readOrchestration(tx, input), rows: () => [...rows.values()]};
  f.start = async () => {
    const attached = await call('attach', {entryId: 'entry-first', capabilityToken: capability()}); f.main = {kind: 'MAIN', ...attached.main};
    await call('activate', {projectRoot: '/fixture', authorization: {source: 'user requested these task types', scope: 'fixture scope', automaticCompletion: true}}, f.main);
    const opened = await call('scheduler-open', {schedulerId: 'scheduler-first', capabilityToken: capability()}, f.main); f.scheduler = {kind: 'SCHEDULER', ...opened.scheduler}; return f;
  };
  f.submit = async (overrides = {}) => (await call('submit', {kind: 'CREATIVE', title: 'Create a scene', goal: 'Write a scene', scope: 'fixture scope', acceptance: [{id: 'content', text: 'Meets requested scene requirements'}], inputs: [], ...overrides}, f.main)).task;
  f.claim = async (kind, taskId) => {
    const claimed = await call('claim', {kind, taskId, workerId: randomUUID(), capabilityToken: capability()}, f.scheduler);
    if (!claimed) return null;
    return {...claimed, actor: {kind: 'WORKER', id: claimed.run.workerId, token: claimed.run.token}};
  };
  f.report = (claimed, result, requestId) => call('report', {runId: claimed.run.id, result}, claimed.actor, requestId);
  f.submitWork = claimed => f.report(claimed, {status: 'SUBMITTED', summary: 'Work produced', artifacts: [artifact]});
  f.qa = (claimed, status = 'PASS') => f.report(claimed, {status, summary: 'Reviewed the actual artifact', artifactHash: claimed.task.artifactHash, artifacts: [], checks: claimed.task.acceptance.map(item => ({criterionId: item.id, status, comment: 'Observed content and exact requirements', evidenceRefs: [artifact.ref]}))});
  f.finalize = claimed => f.report(claimed, {status: 'DELIVERED', summary: 'Exact reviewed version delivered', artifactHash: claimed.task.artifactHash, artifacts: [artifact], deliveryEvidence: [{ref: 'receipt:published-version', sha256: 'b'.repeat(64)}]});
  return f;
}

test('mode starts inactive; singleton Main requires explicit takeover and stale capability is rejected', async () => {
  const f = fixture();
  assert.equal((await f.read()).config, null);
  const requestId = randomUUID(), args = {entryId: 'first', capabilityToken: capability()};
  const attached = await f.call('attach', args, undefined, requestId);
  assert.deepEqual(await f.call('attach', args, undefined, requestId), attached);
  assert.equal(attached.config.enabled, false);
  await assert.rejects(f.call('attach', {entryId: 'second', capabilityToken: capability()}), {code: 'ORCHESTRATION_MAIN_EXISTS'});
  await f.call('attach', {entryId: 'second', takeover: true, capabilityToken: capability()});
  await assert.rejects(f.call('pause', {}, {kind: 'MAIN', ...attached.main}), {code: 'ORCHESTRATION_MAIN_LOST'});
  for (const row of f.rows()) assert.equal(row.bytes.includes(Buffer.from(args.capabilityToken)), false, 'capability secret is never persisted');
});

test('independent QA and delivery are required; dependency unblocks only after delivered', async () => {
  const f = await fixture().start(), root = await f.submit(), dependent = await f.submit({dependencies: [root.id]});
  const author = await f.claim('CREATIVE', root.id);
  await assert.rejects(f.finalize(author));
  await f.submitWork(author);
  assert.equal(await f.claim('CREATIVE', dependent.id), null);
  const qa = await f.claim('CREATIVE_QA'); assert.notEqual(qa.run.workerId, author.run.workerId); assert.equal(qa.task.rootId, root.id);
  await f.qa(qa);
  assert.equal((await f.read({query: 'task', taskId: root.id})).task.status, 'FINALIZING');
  const delivery = await f.claim('CREATIVE', root.id); assert.equal(delivery.run.phase, 'FINALIZE'); await f.finalize(delivery);
  await f.call('tick', {}, f.scheduler);
  assert.equal((await f.read({query: 'task', taskId: root.id})).task.status, 'DONE');
  assert.equal((await f.claim('CREATIVE', dependent.id)).task.id, dependent.id);
});

test('three failed QA rounds are counted on original root and cannot be reset by rework tasks', async () => {
  const f = await fixture().start(), root = await f.submit({kind: 'DEVELOP'});
  for (let round = 1; round <= 3; round++) {
    const author = await f.claim('DEVELOP'); assert.equal(author.task.rootId, root.id); await f.submitWork(author);
    const qa = await f.claim('DEVELOP_QA'); await f.qa(qa, 'FAIL');
    assert.equal((await f.read({query: 'task', taskId: root.id})).task.qaFailures, round);
  }
  assert.equal(await f.claim('DEVELOP'), null);
  const status = await f.read(); assert.equal(status.decisions.length, 1); assert.equal(status.decisions[0].type, 'QA_LIMIT');
  await assert.rejects(f.call('decision', {decisionId: status.decisions[0].id, action: 'retry', comment: 'Retry'}, f.main));
  await f.call('decision', {decisionId: status.decisions[0].id, action: 'retry', comment: 'One more round authorized', additionalRounds: 1}, f.main);
  const task = (await f.read({query: 'task', taskId: root.id})).task;
  assert.equal(task.qaFailures, 3); assert.equal(task.qaLimit, 4); assert.ok(await f.claim('DEVELOP'));
});

test('quality pass must cover all criteria and exact artifact hash, with observed evidence', async () => {
  const f = await fixture().start(); await f.submit(); await f.submitWork(await f.claim('CREATIVE')); const qa = await f.claim('CREATIVE_QA');
  const result = {status: 'PASS', summary: 'Checked', artifacts: [], artifactHash: 'c'.repeat(64), checks: []};
  await assert.rejects(f.report(qa, result), {code: 'ORCHESTRATION_ARTIFACT_CHANGED'});
  result.artifactHash = qa.task.artifactHash;
  await assert.rejects(f.report(qa, result));
  result.checks = [{criterionId: 'content', status: 'PASS', comment: 'Only metadata available', evidenceRefs: []}];
  await assert.rejects(f.report(qa, result));
  await f.qa(qa);
  const finalization = await f.claim('CREATIVE');
  await assert.rejects(f.report(finalization, {status: 'DELIVERED', summary: 'Claimed delivery', artifactHash: finalization.task.artifactHash, artifacts: [artifact], deliveryEvidence: []}));
});

test('four pools enforce separate limits; resource conflicts serialize and scale-down drains in-flight runs', async () => {
  const f = await fixture().start();
  const same = await f.submit({resources: ['object:one']}); await f.submit({resources: ['object:one']});
  for (let i = 0; i < 5; i++) await f.submit();
  assert.ok(await f.claim('CREATIVE', same.id)); assert.ok(await f.claim('CREATIVE')); assert.ok(await f.claim('CREATIVE')); assert.equal(await f.claim('CREATIVE'), null);
  await f.call('scale', {concurrency: {CREATIVE: 0}}, f.main);
  const status = await f.read(); assert.equal(status.counts.CREATIVE.running, 3); assert.equal(status.concurrency.DEVELOP, 3);
  await f.call('tick', {}, f.scheduler); await f.call('tick', {}, f.scheduler);
  assert.equal((await f.read()).decisions.filter(item => item.type === 'CONCURRENCY').length, 1);
});

test('duplicate report is idempotent, changed retry fails, wrong role cannot report', async () => {
  const f = await fixture().start(); await f.submit(); const author = await f.claim('CREATIVE');
  const result = {status: 'SUBMITTED', summary: 'Produced', artifacts: [artifact]}, requestId = randomUUID();
  const first = await f.report(author, result, requestId); assert.deepEqual(await f.report(author, result, requestId), first);
  await assert.rejects(f.report(author, {...result, summary: 'Changed'}, requestId), {code: 'ORCHESTRATION_CONFLICT'});
  await assert.rejects(f.call('report', {runId: author.run.id, result}, f.main), {code: 'ORCHESTRATION_ROLE'});
  assert.equal((await f.read()).tasks.filter(item => item.kind === 'CREATIVE_QA').length, 1);
});

test('quota/model errors block only the affected work and do not increment QA failures', async () => {
  const f = await fixture().start(), task = await f.submit(); await f.submit({kind: 'DEVELOP'}); const author = await f.claim('CREATIVE');
  await f.report(author, {status: 'BLOCKED', summary: 'Provider returned insufficient credit', code: 'INSUFFICIENT_CREDIT', artifacts: []});
  const status = await f.read(); assert.equal(status.tasks.find(item => item.id === task.id).qaFailures, 0); assert.equal(status.decisions[0].type, 'INSUFFICIENT_CREDIT'); assert.ok(await f.claim('DEVELOP'));
});

test('runner generation restart fences old worker and requires reconciliation before retry', async () => {
  const f = await fixture().start(); await f.submit(); const author = await f.claim('CREATIVE');
  await f.call('run-context', {runId: author.run.id, threadId: 'thread-one', turnId: 'turn-one', worktree: '/fixture/work', model: 'model-one', effort: 'high'}, author.actor);
  const opened = await f.call('scheduler-open', {schedulerId: 'scheduler-next', capabilityToken: capability()}, f.main); f.scheduler = {kind: 'SCHEDULER', ...opened.scheduler};
  await assert.rejects(f.submitWork(author), {code: 'ORCHESTRATION_LEASE_LOST'});
  const decision = (await f.read()).decisions[0]; assert.equal(decision.type, 'RESULT_UNKNOWN');
  await assert.rejects(f.call('decision', {decisionId: decision.id, action: 'scale', comment: 'Must not consume this decision', concurrency: {CREATIVE: 4}}, f.main));
  await assert.rejects(f.call('decision', {decisionId: decision.id, action: 'retry', comment: 'Blind retry'}, f.main), {code: 'ORCHESTRATION_RECONCILIATION_REQUIRED'});
  await f.call('decision', {decisionId: decision.id, action: 'retry', comment: 'Exact turn confirmed stopped with no output', reconciliation: {status: 'CONFIRMED_NOT_RUNNING', runId: author.run.id, threadId: 'thread-one', turnId: 'turn-one', evidenceRef: 'readback:turn-one'}}, f.main);
  assert.ok(await f.claim('CREATIVE'));
});

test('project isolation and read pagination do not reveal capabilities or fabricate cross-instance dependencies', async () => {
  const a = await fixture('instance-a').start(), b = await fixture('instance-b').start(); const task = await a.submit();
  await assert.rejects(b.submit({dependencies: [task.id]}), {code: 'ORCHESTRATION_NOT_FOUND'});
  await assert.rejects(b.call('pause', {}, a.main), {code: 'ORCHESTRATION_MAIN_LOST'});
  const page = await a.read({query: 'events', limit: 2}); assert.equal(page.events.length, 2); assert.equal(page.hasMore, true);
  const next = await a.read({query: 'events', after: page.after, limit: 2}); assert.equal(next.events[0].sequence, page.after + 1);
  assert.doesNotMatch(JSON.stringify(await a.read()), /tokenHash|capabilityToken|"token"/);
  assert.ok(a.rows().every(row => row.namespace === ORCHESTRATION_NAMESPACE));
});

test('paused work can finish; new claims stop; cancellation fences descendants and old workers', async () => {
  const f = await fixture().start(), root = await f.submit(); const author = await f.claim('CREATIVE');
  await f.call('pause', {}, f.main); assert.equal(await f.claim('CREATIVE'), null); await f.submitWork(author);
  await f.call('resume', {}, f.main); const qa = await f.claim('CREATIVE_QA');
  await f.report(qa, {status: 'BLOCKED', summary: 'Cannot observe artifact', code: 'OBSERVATION_UNAVAILABLE', artifacts: []});
  const decision = (await f.read()).decisions[0]; await f.call('decision', {decisionId: decision.id, action: 'cancel', comment: 'Stop this task family'}, f.main);
  assert.equal((await f.read({query: 'task', taskId: root.id})).task.status, 'CANCELLED'); assert.equal(await f.claim('CREATIVE_QA'), null);
});

test('unknown execution continues holding resources and pool slots until exact reconciliation', async () => {
  const f = await fixture().start(); const first = await f.submit({resources: ['object:shared']}); const next = await f.submit({resources: ['object:shared']});
  const author = await f.claim('CREATIVE', first.id);
  const opened = await f.call('scheduler-open', {schedulerId: 'replacement', capabilityToken: capability()}, f.main); f.scheduler = {kind: 'SCHEDULER', ...opened.scheduler};
  assert.equal(await f.claim('CREATIVE', next.id), null);
  const status = await f.read(); assert.equal(status.counts.CREATIVE.running, 1); assert.equal(status.runs[0].status, 'RESULT_UNKNOWN');
  const decision = status.decisions[0];
  await assert.rejects(f.call('decision', {decisionId: decision.id, action: 'retry', comment: 'Insufficient evidence', reconciliation: {status: 'CONFIRMED_NOT_RUNNING'}}, f.main), {code: 'ORCHESTRATION_RECONCILIATION_REQUIRED'});
  await f.call('decision', {decisionId: decision.id, action: 'cancel', comment: 'Exact execution confirmed stopped', reconciliation: {status: 'CONFIRMED_NOT_RUNNING', runId: author.run.id, evidenceRef: 'process:observed-exited'}}, f.main);
  assert.ok(await f.claim('CREATIVE', next.id));
});

test('scheduler cannot create new roots disguised as repair children or QA the author thread', async () => {
  const f = await fixture().start(), root = await f.submit(), author = await f.claim('CREATIVE');
  await f.call('run-context', {runId: author.run.id, threadId: 'author-thread'}, author.actor); await f.submitWork(author);
  await assert.rejects(f.call('submit', {...root, parentId: root.id}, f.scheduler), {code: 'ORCHESTRATION_ROLE'});
  assert.equal(await f.call('claim', {kind: 'CREATIVE_QA', workerId: author.run.workerId, capabilityToken: capability()}, f.scheduler), null);
  const qa = await f.claim('CREATIVE_QA');
  await assert.rejects(f.call('run-context', {runId: qa.run.id, threadId: 'author-thread'}, qa.actor), {code: 'ORCHESTRATION_QA_IDENTITY'});
});

test('worker-reported RESULT_UNKNOWN holds its resource until observed reconciliation', async () => {
  const f = await fixture().start(), first = await f.submit({resources: ['object:shared']}), next = await f.submit({resources: ['object:shared']});
  await f.report(await f.claim('CREATIVE', first.id), {status: 'BLOCKED', code: 'RESULT_UNKNOWN', summary: 'Provider response was lost'});
  assert.equal((await f.read()).runs[0].status, 'RESULT_UNKNOWN'); assert.equal(await f.claim('CREATIVE', next.id), null);
});

test('stop drains running work and idle tick does not append heartbeat history', async () => {
  const f = await fixture().start(); await f.submit(); const author = await f.claim('CREATIVE');
  assert.equal((await f.call('stop', {}, f.main)).config.status, 'STOPPING');
  assert.equal(await f.claim('CREATIVE'), null); await f.submitWork(author);
  assert.equal((await f.call('tick', {}, f.scheduler)).config.status, 'STOPPED');
  await f.call('resume', {}, f.main);
  const before = f.rows().length; await f.call('tick', {}, f.scheduler); await f.call('tick', {}, f.scheduler); assert.equal(f.rows().length, before);
});

test('restored queued tasks require explicit authority and input revalidation before resume', async () => {
  const f = await fixture().start(), root = await f.submit(); f.metadata.runtimeEpoch = 'restored-epoch';
  const attached = await f.call('attach', {entryId: 'entry-first', capabilityToken: capability()}); f.main = {kind: 'MAIN', ...attached.main};
  await f.call('activate', {projectRoot: '/fixture', authorization: {source: 'User reauthorizes restored scope', scope: 'fixture scope', automaticCompletion: true}}, f.main);
  const opened = await f.call('scheduler-open', {schedulerId: 'restored', capabilityToken: capability()}, f.main); f.scheduler = {kind: 'SCHEDULER', ...opened.scheduler};
  assert.equal(await f.claim('CREATIVE'), null);
  const decision = (await f.read()).decisions.find(item => item.type === 'EPOCH_REAUTHORIZE'); assert.equal(decision.taskId, root.id);
  await assert.rejects(f.call('decision', {decisionId: decision.id, action: 'resume', comment: 'Missing revalidation'}, f.main));
  await f.call('decision', {decisionId: decision.id, action: 'resume', comment: 'Current input closure checked', reconciliation: {status: 'INPUTS_REVALIDATED', evidenceRef: 'revision:validated-current'}}, f.main);
  assert.ok(await f.claim('CREATIVE', root.id));
});

test('dependency recovery automatically resolves obsolete blockage decisions', async () => {
  const f = await fixture().start(), dep = await f.submit(), child = await f.submit({dependencies: [dep.id]});
  await f.report(await f.claim('CREATIVE', dep.id), {status: 'BLOCKED', summary: 'Temporarily unavailable', code: 'UNAVAILABLE'});
  await f.call('tick', {}, f.scheduler);
  const status = await f.read(); assert.ok(status.decisions.some(item => item.type === 'DEPENDENCY_BLOCKED'));
  await f.call('decision', {decisionId: status.decisions.find(item => item.type === 'UNAVAILABLE').id, action: 'retry', comment: 'Service recovered'}, f.main);
  await f.submitWork(await f.claim('CREATIVE', dep.id)); await f.qa(await f.claim('CREATIVE_QA')); await f.finalize(await f.claim('CREATIVE', dep.id)); await f.claim('CREATIVE', child.id); await f.call('tick', {}, f.scheduler);
  assert.equal((await f.read()).decisions.filter(item => item.type === 'DEPENDENCY_BLOCKED').length, 0);
  assert.equal((await f.read({query: 'task', taskId: child.id})).task.status, 'RUNNING');
});

test('scheduler credit failure stays blocked across restart until its own explicit decision', async () => {
  const f = await fixture().start(); await f.submit();
  const {decision} = await f.call('scheduler-blocked', {code: 'INSUFFICIENT_CREDIT', summary: 'Actual provider credit error', threadId: 'scheduler-thread'}, f.scheduler);
  await f.call('scale', {concurrency: {CREATIVE: 4}}, f.main); assert.equal(await f.claim('CREATIVE'), null);
  const opened = await f.call('scheduler-open', {schedulerId: 'restart', capabilityToken: capability()}, f.main); f.scheduler = {kind: 'SCHEDULER', ...opened.scheduler};
  assert.equal(await f.claim('CREATIVE'), null);
  await assert.rejects(f.call('decision', {decisionId: decision.id, action: 'cancel', comment: 'Not an explicit retry'}, f.main));
  await f.call('decision', {decisionId: decision.id, action: 'resume', comment: 'User confirmed credit recovery'}, f.main);
  assert.ok(await f.claim('CREATIVE'));
});
