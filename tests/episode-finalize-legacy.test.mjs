import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fixture, runtime} from './modern-event-validator.test.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const api = runtime.api;
const routeSource = readFileSync(new URL('../app/api/v8/episode-plan-reviews/finalize/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(routeSource, {compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
}}).outputText;

// Real route, evidence, bindings and input validators; only repository I/O is
// replaced with an in-memory transaction. No instance or formal event is written.
async function finalize({schemaVersion = '1.0', hashMode = 'missing', legacy = true} = {}) {
  const f = fixture();
  const data = f.snapshot;
  data.productionModel.systemModel = {stateModel: {reviewContract: {
    schemaVersion: '2.2', actions: ['APPROVE_AND_RELEASE', 'REQUEST_REVISION', 'DO_NOT_USE'],
  }}};
  const candidate = f.candidate;
  let standard = api.candidateReviewSpec(data, candidate);
  assert.equal(standard.legacy, true);
  if (!legacy) {
    const {hash: _oldHash, ...value} = standard;
    const updated = {...value, legacy: false};
    candidate.reviewSpec = {...updated, hash: api.stableObjectHash(updated)};
    standard = candidate.reviewSpec;
  }
  const submissions = candidate.content.episodes.map((episode, index) => {
    const event = {...structuredClone(f.submission), schemaVersion,
      eventId: `legacy-test:submission:${index}`, eventSequence: 10 + index,
      episodeUid: episode.episodeUid, scopeId: episode.episodeUid, displayId: episode.displayId,
      criterionFindings: api.expectedEpisodeCriterionIds(episode.episodeUid).map(criterionId => ({criterionId, verdict: 'PASS', note: ''})),
    };
    if (hashMode !== 'missing') event.reviewSpecHash = hashMode === 'current' ? standard.hash : api.stableObjectHash('different standard');
    if (schemaVersion === '1.1') Object.assign(event, {
      reviewSpec: standard, reviewInputVersion: '1.0',
      reviewInputHash: api.episodeReviewInputHash(candidate, episode.episodeUid, standard.hash),
    });
    return event;
  });
  const before = api.stableObjectHash(submissions);
  const candidates = [candidate];
  const writes = [];
  let lockedChecks = 0;
  const store = {...api,
    validateMutationRequest: async () => ({data, idempotencyKey: 'legacy-test:finalize', ifMatch: 'legacy-test:etag'}),
    replayIdempotentEvent: async () => null,
    listAllEvents: async kind => kind === 'creative-revision' ? candidates : kind === 'episode-plan-submission' ? submissions : [],
    appendEvent: async (_kind, _key, _hash, _etag, payload, _schema, validateLocked) => {
      lockedChecks += 1;
      await validateLocked({creativeRevisions: {events: candidates}, episodePlanSubmissions: {events: submissions}, reviews: {events: []}, stateProjection: {}});
      const event = {...payload, eventId: 'legacy-test:review'};
      writes.push(event);
      return {event, replayed: false, operations: {etag: 'legacy-test:etag', mutationEtag: 'legacy-test:etag',
        operationRevision: 1, stateProjection: {}, reviews: {projectedStructureByRevision: [{event}]}}};
    },
  };
  const module = {exports: {}};
  new Function('require', 'module', 'exports', compiled)(specifier => specifier.endsWith('/_store') ? store : api, module, module.exports);
  const response = await module.exports.POST(new Request('http://legacy.test/api/v8/episode-plan-reviews/finalize', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
      schemaVersion: '1.0', operation: 'FINALIZE_PLAN', snapshotId: data.snapshotId,
      subjectRevisionId: candidate.creativeRevisionId, subjectRevisionHash: candidate.contentHash,
      contextHash: candidate.contextHash, criteriaVersion: candidate.criteriaVersion,
      reviewSpecHash: standard.hash,
      episodeSubmissionRefs: submissions.map(({episodeUid, eventId}) => ({episodeUid, eventId})),
    }),
  }));
  const body = await response.json();
  assert.equal(api.stableObjectHash(submissions), before, 'immutable historical submissions were modified');
  return {status: response.status, body, writes, lockedChecks, standard};
}

test('legacy schema 1.0 without a standard hash passes both finalization checks', async () => {
  const result = await finalize();
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.lockedChecks, 1);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].reviewSpecHash, result.standard.hash);
});

test('schema 1.1 without its hash cannot downgrade to legacy compatibility', async () => {
  const result = await finalize({schemaVersion: '1.1'});
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.writes.length, 0);
});

test('legacy compatibility does not accept an explicitly mismatched hash', async () => {
  const result = await finalize({hashMode: 'wrong'});
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.writes.length, 0);
});

test('nonlegacy standards do not accept an unhashed schema 1.0 submission', async () => {
  const result = await finalize({legacy: false});
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.writes.length, 0);
});

test('schema 1.1 remains valid with its exact frozen standard and input hash', async () => {
  const result = await finalize({schemaVersion: '1.1', hashMode: 'current'});
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.lockedChecks, 1);
  assert.equal(result.writes.length, 1);
});
