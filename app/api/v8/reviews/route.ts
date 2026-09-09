import {resolveImageTechnicalSpec,readImageTechnicalFacts,assertImageTechnicalApproval} from '../../../../host/instance-runtime/image-technical-spec.mjs';
function imageTechnicalFailure(reason:unknown):never { throw new HttpError(409,reason instanceof Error?reason.message:'图像规格检查失败'); }
function imageTechnicalRead<T>(fn:()=>T):T { try{return fn();}catch(reason){return imageTechnicalFailure(reason);} }
import {withInstanceMediaRead} from '../_media-read';
import {resolveFormalReviewSpec,reviewFindingsIssues} from '../_review-spec';
import { projectIdFor, episodePlanIdFor } from '../../../instance-profile';
import {
  appendEvent,
  assertCreativeRevisionBasisCurrent,
  assetReviewContextHash,
  assetReviewOwnership,
  assetReviewTransitionProjection,
  assertStableFileIdentity,
  assertSha256,
  assertStableId,
  assertString,
  currentCreativeSubjectBaseHash,
  errorResponse,
  eventLimit,
  hashStableFile,
  HttpError,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  operationalSnapshot,
  optionalString,
  replayIdempotentEvent,
  recipeCatalog,
  safeGeneratedPath,
  storyConfirmationTargets,
  validateMutationRequest,
  workProductReviewBinding,
} from '../_store';

const formalActions = new Set(['APPROVE_AND_RELEASE', 'REQUEST_REVISION', 'DO_NOT_USE']);
const readableSubjectTypes = new Set(['STRUCTURE', 'CREATIVE_REVISION', 'SCRIPT_SCENE', 'ASSET', 'WORK_PRODUCT']);
const writableSubjectTypes = new Set(['CREATIVE_REVISION', 'SCRIPT_SCENE', 'ASSET', 'WORK_PRODUCT']);
const creativeReviewKinds = new Set(['EPISODE_PLAN', 'SCENE_COVERAGE', 'SHOT_PLAN_SET']);
const productionScopeTypes = new Set(['SHOT', 'SCENE', 'EPISODE', 'PROJECT']);
const legacyWriteFields = ['semanticStage', 'reviewScopeType', 'reviewScopeId', 'shotId', 'workflowStepId'];
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/;

type CriterionFinding = {
  criterionId: string;
  verdict: 'PASS' | 'FAIL' | 'NA';
  note: string;
};

type RevisionInstructions = {
  preserve: string[];
  change: string[];
  mustNotRegress: string[];
};

type ReviewableVersion = {
  id: string;
  familyId: string;
  path: string | null;
  sha256: string | null;
  outputState?: string | null;
  materializationState?: string | null;
  reviewDecision?: string | null;
  projectRightsGate?: string | null;
  lifecycleState?: string | null;
  canFlowDownstream?: boolean | null;
  rightsWarning?: boolean | null;
  promptSyncRequired?: boolean;
  actualPromptHash?: string | null;
  legacyState?: { materializationState?: string | null; rightsStatus?: string | null; [key: string]: unknown } | null;
  source: 'BASE_SNAPSHOT' | 'ASSET_VERSION_EVENT';
  verifiedPath?: string;
  verifiedFile?: { size: number; dev: number; ino: number; mtimeMs: number };
};

function instructionList(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, `${name} must be an array with at most 100 entries`);
  }
  const result = value.map((item, index) => assertString(item, `${name}[${index}]`, 4000));
  if (new Set(result).size !== result.length) throw new HttpError(400, `${name} contains duplicates`);
  return result;
}

function parseRevisionInstructions(value: unknown): RevisionInstructions | null {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'revisionInstructions must be an object or null');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['preserve', 'change', 'mustNotRegress']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'revisionInstructions contains unsupported fields');
  }
  return {
    preserve: instructionList(record.preserve, 'revisionInstructions.preserve'),
    change: instructionList(record.change, 'revisionInstructions.change'),
    mustNotRegress: instructionList(record.mustNotRegress, 'revisionInstructions.mustNotRegress'),
  };
}

function optionalSha256(value: unknown, name: string) {
  return value == null || value === '' ? '' : assertSha256(value, name);
}

function optionalStableId(value: unknown, name: string) {
  if (value == null || value === '') return '';
  const result = assertString(value, name, 300);
  if (!stableIdPattern.test(result)) throw new HttpError(400, `${name} must be a stable identifier`);
  return result;
}

function parseCriterionFindings(value: unknown, allowEmptyFailNote = false): CriterionFinding[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new HttpError(400, 'criterionFindings must be a non-empty array with at most 200 entries');
  }
  const seen = new Set<string>();
  const findings = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, `criterionFindings[${index}] must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const criterionId = optionalStableId(record.criterionId, `criterionFindings[${index}].criterionId`);
    if (!criterionId) throw new HttpError(400, `criterionFindings[${index}].criterionId is required`);
    if (seen.has(criterionId)) throw new HttpError(400, `criterionFindings contains duplicate criterionId ${criterionId}`);
    seen.add(criterionId);
    const verdict = assertString(record.verdict, `criterionFindings[${index}].verdict`, 16);
    if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'NA') {
      throw new HttpError(400, `criterionFindings[${index}].verdict must be PASS, FAIL or NA`);
    }
    const note = optionalString(record.note, 4000);
    if (verdict === 'FAIL' && !note && !allowEmptyFailNote) {
      throw new HttpError(400, `criterionFindings[${index}] with FAIL requires a concrete note`);
    }
    return { criterionId, verdict, note } as CriterionFinding;
  });
  return findings.sort((left, right) => left.criterionId.localeCompare(right.criterionId));
}

const episodePlanCriterionSuffixes = [
  'opening-boundary',
  'episode-purpose',
  'escalation-turn',
  'information-causality',
  'episode-payoff',
  'ending-propulsion',
] as const;

function assertEpisodePlanCriterionFindings(content: unknown, findings: CriterionFinding[], action: string) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new HttpError(422, 'EPISODE_PLAN creative revision content is unavailable');
  }
  const episodes = (content as Record<string, unknown>).episodes;
  if (!Array.isArray(episodes) || episodes.length < 1) {
    throw new HttpError(422, 'EPISODE_PLAN creative revision has no episodes');
  }
  const expected = episodes.flatMap((episode, index) => {
    if (!episode || typeof episode !== 'object' || Array.isArray(episode)) {
      throw new HttpError(422, `EPISODE_PLAN content.episodes[${index}] is invalid`);
    }
    const episodeUid = optionalStableId((episode as Record<string, unknown>).episodeUid, `content.episodes[${index}].episodeUid`);
    if (!episodeUid) throw new HttpError(422, `EPISODE_PLAN content.episodes[${index}].episodeUid is required`);
    return episodePlanCriterionSuffixes.map((suffix) => `episode:${episodeUid}:${suffix}`);
  }).sort();
  const actual = findings.map((finding) => finding.criterionId).sort();
  if (actual.length !== expected.length || actual.some((criterionId, index) => criterionId !== expected[index])) {
    throw new HttpError(422, 'EPISODE_PLAN reviews require all six stable episodeUid findings for every episode', {
      expectedCount: expected.length,
      actualCount: actual.length,
    });
  }
  if (findings.some((finding) => finding.verdict === 'NA')) {
    throw new HttpError(422, 'EPISODE_PLAN structural findings must be PASS or FAIL; timing UNKNOWN is tracked separately');
  }
  if (action === 'DO_NOT_USE' && !findings.some((finding) => finding.verdict === 'FAIL')) {
    throw new HttpError(400, 'EPISODE_PLAN DO_NOT_USE requires at least one FAIL finding');
  }
}

function parseRightsUnknownConfirmation(value: unknown) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'rightsUnknownConfirmation must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.confirmed !== true || record.scope !== 'PROJECT_INTERNAL_ONLY') {
    throw new HttpError(422, 'rightsUnknownConfirmation must explicitly confirm PROJECT_INTERNAL_ONLY');
  }
  const basis = assertString(record.basis, 'rightsUnknownConfirmation.basis', 4000);
  return {
    confirmed: true,
    scope: 'PROJECT_INTERNAL_ONLY',
    basis,
    commercialLegalReview: 'NOT_CONFIRMED',
  } as const;
}

function eventSubjectType(event: Record<string, unknown>) {
  return typeof event.subjectType === 'string' && event.subjectType
    ? event.subjectType
    : event.workItemId
      ? 'WORK_PRODUCT'
      : '';
}

function eventSubjectId(event: Record<string, unknown>) {
  return typeof event.subjectId === 'string' && event.subjectId
    ? event.subjectId
    : typeof event.workItemId === 'string'
      ? event.workItemId
      : '';
}

function creativeReviewScope(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  subjectKind: string,
  subjectId: string,
) {
  if (subjectKind === 'EPISODE_PLAN') {
    const row = data.productionModel.episodePlanRevisions?.find((item) => item.planId === subjectId);
    if (!row || subjectId !== episodePlanIdFor(data)) throw new HttpError(422, 'EPISODE_PLAN subject does not resolve in the current business graph');
    return { scopeType: 'PROJECT', scopeId: projectIdFor(data) };
  }
  const rows = subjectKind === 'SCENE_COVERAGE'
    ? data.productionModel.sceneCoveragePlanRevisions
    : data.productionModel.shotPlanSetRevisions;
  const row = rows?.find((item) => item.planId === subjectId || item.id === subjectId);
  if (!row) throw new HttpError(422, `${subjectKind} subject does not resolve in the current business graph`);
  const scopeType = String(row.scopeType || '');
  const scopeId = String(row.scopeId || '');
  if (scopeType !== 'SCENE' || !stableIdPattern.test(scopeId)) {
    throw new HttpError(503, `${subjectKind} current scope binding is unavailable`);
  }
  return { scopeType, scopeId };
}

function versionIsPresent(version: ReviewableVersion) {
  if (version.outputState) return version.outputState === 'PRESENT';
  return version.materializationState === 'GENERATED' || version.legacyState?.materializationState === 'GENERATED';
}

async function verifiedVersion(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  familyId: string,
  versionId: string,
  versionSha256: string,
) {
  if (!data.productionModel.assetFamilies.some((item) => item.id === familyId)) {
    throw new HttpError(422, 'subject asset family does not resolve in the current business graph');
  }
  const candidate = (await listAllEvents('asset-version')).find((event) => event.versionId === versionId);
  const staticVersion = data.productionModel.assetVersions.find((item) => item.id === versionId);
  const version: ReviewableVersion | null = candidate
    ? {
        id: String(candidate.versionId || ''),
        familyId: String(candidate.familyId || ''),
        path: typeof candidate.path === 'string' ? candidate.path : null,
        sha256: typeof candidate.sha256 === 'string' ? candidate.sha256 : null,
        outputState: typeof candidate.outputState === 'string' ? candidate.outputState : 'PRESENT',
        reviewDecision: typeof candidate.reviewDecision === 'string' ? candidate.reviewDecision : 'PENDING',
        projectRightsGate: typeof candidate.projectRightsGate === 'string' ? candidate.projectRightsGate : 'UNKNOWN',
        lifecycleState: typeof candidate.lifecycleState === 'string' ? candidate.lifecycleState : 'REVIEW_PENDING',
        canFlowDownstream: candidate.canFlowDownstream === true,
        rightsWarning: candidate.rightsWarning === true,
        promptSyncRequired: candidate.promptSyncRequired === true,
        actualPromptHash: typeof candidate.actualPromptHash === 'string' ? candidate.actualPromptHash : null,
        legacyState: candidate.legacyState && typeof candidate.legacyState === 'object' && !Array.isArray(candidate.legacyState)
          ? candidate.legacyState as ReviewableVersion['legacyState']
          : null,
        source: 'ASSET_VERSION_EVENT',
      }
    : staticVersion
      ? { ...staticVersion, source: 'BASE_SNAPSHOT' }
      : null;
  if (!version || version.familyId !== familyId) {
    throw new HttpError(422, 'versionId is not a version of the review subject asset family');
  }
  if (!versionIsPresent(version)) {
    throw new HttpError(422, 'only a version with outputState PRESENT can receive a result review');
  }
  if (!version.path || !version.sha256 || version.sha256.toLowerCase() !== versionSha256) {
    throw new HttpError(422, 'versionId and SHA-256 do not resolve to one reviewable version');
  }
  const {filePath,currentFile}=await withInstanceMediaRead(async()=>{const filePath=await safeGeneratedPath(version.path!,{versionId,sha256:versionSha256});return{filePath,currentFile:await hashStableFile(filePath)};});
  if (currentFile.sha256 !== versionSha256) {
    throw new HttpError(409, 'the registered version bytes no longer match versionSha256');
  }
  return { ...version, verifiedPath: filePath, verifiedFile: currentFile };
}

function originalRightsFacts(version: ReviewableVersion) {
  const declared = typeof version.projectRightsGate === 'string' ? version.projectRightsGate : '';
  const legacy = typeof version.legacyState?.rightsStatus === 'string' ? version.legacyState.rightsStatus : '';
  const blocked = declared === 'BLOCKED' || legacy === 'BLOCKED' || legacy === 'DO_NOT_USE';
  let normalizedProjectRightsGate = 'UNKNOWN';
  if (blocked) normalizedProjectRightsGate = 'BLOCKED';
  else if (['CLEAR', 'CLEAR_BY_USER_ATTESTATION', 'UNKNOWN', 'NOT_APPLICABLE'].includes(declared)) {
    normalizedProjectRightsGate = declared;
  } else if (legacy === 'APPROVED' || legacy === 'CLEAR') normalizedProjectRightsGate = 'CLEAR';
  else if (legacy === 'NOT_APPLICABLE') normalizedProjectRightsGate = 'NOT_APPLICABLE';
  return {
    normalizedProjectRightsGate,
    declaredProjectRightsGate: declared || null,
    legacyRightsStatus: legacy || null,
    rightsWarning: version.rightsWarning === true,
    source: version.source,
  };
}

function appliedProjection(
  action: string,
  originalGate: string,
  confirmation: ReturnType<typeof parseRightsUnknownConfirmation>,
) {
  if (action === 'APPROVE_AND_RELEASE') {
    if (originalGate === 'BLOCKED') {
      throw new HttpError(422, 'a BLOCKED project rights gate cannot be waived or released');
    }
    if (originalGate === 'UNKNOWN' && !confirmation) {
      throw new HttpError(422, 'UNKNOWN project rights require an explicit rightsUnknownConfirmation in the same review');
    }
    return {
      projectRightsGate: originalGate === 'UNKNOWN' ? 'CLEAR_BY_USER_ATTESTATION' : originalGate,
      reviewDecision: 'RELEASED',
      lifecycleState: 'RELEASED',
      canFlowDownstream: true,
    } as const;
  }
  if (action === 'REQUEST_REVISION') {
    return {
      projectRightsGate: originalGate,
      reviewDecision: 'REVISION_REQUIRED',
      lifecycleState: 'REVISION_REQUIRED',
      canFlowDownstream: false,
    } as const;
  }
  return {
    projectRightsGate: originalGate,
    reviewDecision: 'DO_NOT_USE',
    lifecycleState: 'DO_NOT_USE',
    canFlowDownstream: false,
  } as const;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = eventLimit(url.searchParams.get('limit'));
    const workItemId = url.searchParams.get('workItemId');
    const versionId = url.searchParams.get('versionId');
    const subjectType = url.searchParams.get('subjectType');
    const subjectKind = url.searchParams.get('subjectKind');
    const subjectId = url.searchParams.get('subjectId');
    const contextHash = url.searchParams.get('contextHash');
    const productionPhaseId = url.searchParams.get('productionPhaseId');
    const productionGateId = url.searchParams.get('productionGateId');
    const scopeType = url.searchParams.get('scopeType');
    const scopeId = url.searchParams.get('scopeId');
    if (subjectType && !readableSubjectTypes.has(subjectType)) throw new HttpError(400, 'subjectType is invalid');
    if (subjectKind && !stableIdPattern.test(subjectKind)) throw new HttpError(400, 'subjectKind must be a stable identifier');
    if (subjectId && !stableIdPattern.test(subjectId)) throw new HttpError(400, 'subjectId must be a stable identifier');
    if (contextHash) assertSha256(contextHash, 'contextHash');
    if (scopeType && !productionScopeTypes.has(scopeType)) throw new HttpError(400, 'scopeType is invalid');
    if (Boolean(scopeType) !== Boolean(scopeId)) throw new HttpError(400, 'scopeType and scopeId must be supplied together');
    const events = (await listAllEvents('review'))
      .filter((event) => !workItemId || event.workItemId === workItemId)
      .filter((event) => !versionId || event.versionId === versionId)
      .filter((event) => !subjectType || eventSubjectType(event) === subjectType)
      .filter((event) => !subjectKind || event.subjectKind === subjectKind)
      .filter((event) => !subjectId || eventSubjectId(event) === subjectId)
      .filter((event) => !contextHash || event.contextHash === contextHash)
      .filter((event) => !productionPhaseId || event.productionPhaseId === productionPhaseId)
      .filter((event) => !productionGateId || event.productionGateId === productionGateId)
      .filter((event) => !scopeType || event.scopeType === scopeType)
      .filter((event) => !scopeId || event.scopeId === scopeId)
      .slice(0, limit);
    return jsonResponse({ events, count: events.length });
  } catch (reason) {
    return errorResponse(reason, 'review events are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    if (['reviewPurpose', 'usageBindingId', 'usageId'].some((key) => Object.hasOwn(body, key))) {
      throw new HttpError(422, '新用途审阅须使用支持 MATERIAL_USAGE_V1 的专用接口，不能作为原资产采用提交。');
    }
    const rawRequestHash = mutationRequestHash('review', body);
    const replay = await replayIdempotentEvent('review', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        replayed: true,
        event: replay.event,
        operationRevision: replay.operations.operationRevision,
        operationalRevision: replay.operations.operationalRevision,
        etag: replay.operations.etag,
        mutationEtag: replay.operations.mutationEtag,
        appliedProjection: replay.operations.stateProjection,
      }, { headers: { ETag: replay.operations.etag } });
    }
    const snapshotId = assertString(body.snapshotId, 'snapshotId', 200);
    const note = optionalString(body.note, 20_000);
    const requestSchemaVersion = assertString(body.schemaVersion, 'schemaVersion', 16);
    const rawAction = typeof body.action === 'string' ? body.action.trim() : '';
    if (body.decision != null || rawAction === 'HOLD') {
      throw new HttpError(422, 'legacy PASS, REVISE and HOLD events are read-only audit evidence; submit a ReviewEvent 2.2 action');
    }
    const action = assertString(body.action, 'action', 32);
    const subjectType = optionalStableId(body.subjectType, 'subjectType');
    const requestedSubjectId = optionalStableId(body.subjectId, 'subjectId');
    const contextHash = optionalSha256(body.contextHash, 'contextHash');
    const criterionFindings = parseCriterionFindings(
      body.criterionFindings,
      Boolean(data.productionModel.systemConfiguration)||subjectType === 'ASSET' || subjectType === 'SCRIPT_SCENE',
    );
    const revisionInstructions = parseRevisionInstructions(body.revisionInstructions);
    const rightsUnknownConfirmation = parseRightsUnknownConfirmation(body.rightsUnknownConfirmation);
    const supersedesReviewEventId = optionalStableId(body.supersedesReviewEventId, 'supersedesReviewEventId');
    const suppliedLegacyFields = legacyWriteFields.filter((field) => Object.prototype.hasOwnProperty.call(body, field));

    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    const contract = data.productionModel.systemModel?.stateModel?.reviewContract;
    if (!contract || requestSchemaVersion !== '2.2' || !['2.0', '2.1', '2.2'].includes(String(contract.schemaVersion || ''))) {
      throw new HttpError(409, 'new formal review writes require ReviewEvent 2.2');
    }
    if (!writableSubjectTypes.has(subjectType)) {
      throw new HttpError(422, 'ReviewEvent 2.2 must bind CREATIVE_REVISION, SCRIPT_SCENE, ASSET or WORK_PRODUCT; legacy STRUCTURE is read-only');
    }
    if (!formalActions.has(action) || !contract.actions?.includes(action)) {
      throw new HttpError(400, 'action must be APPROVE_AND_RELEASE, REQUEST_REVISION or DO_NOT_USE');
    }
    if (suppliedLegacyFields.length) {
      throw new HttpError(422, 'legacy review binding fields are read-only; submit canonical phase, gate, scope and work bindings', {
        legacyFields: suppliedLegacyFields,
      });
    }
    if (!contextHash) throw new HttpError(400, 'formal reviews require contextHash');
    if (!criterionFindings.length) throw new HttpError(400, 'formal reviews require criterionFindings');
    if (!['ASSET', 'SCRIPT_SCENE'].includes(subjectType) && action !== 'APPROVE_AND_RELEASE' && !note) {
      throw new HttpError(400, `${action} requires a concrete overall note`);
    }
    if (action === 'APPROVE_AND_RELEASE' && criterionFindings.some((item) => item.verdict === 'FAIL')) {
      throw new HttpError(400, 'APPROVE_AND_RELEASE cannot contain a FAIL criterion finding');
    }
    if (subjectType !== 'ASSET' && action === 'REQUEST_REVISION' && !criterionFindings.some((item) => item.verdict === 'FAIL')) {
      throw new HttpError(400, 'REQUEST_REVISION criterionFindings must contain at least one FAIL verdict');
    }
    if (action !== 'REQUEST_REVISION' && revisionInstructions) {
      throw new HttpError(422, 'revisionInstructions is only valid for REQUEST_REVISION');
    }
    if (subjectType !== 'ASSET' && supersedesReviewEventId) {
      throw new HttpError(422, 'supersedesReviewEventId is currently supported only for ASSET review correction');
    }

    let semanticRequest: Record<string, unknown>;
    let reviewedVersion: ReviewableVersion | null = null;
    let reviewedCreativeRevisionId = '';
    if (subjectType === 'CREATIVE_REVISION') {
      if (!requestedSubjectId) throw new HttpError(400, 'CREATIVE_REVISION reviews require subjectId');
      if (rightsUnknownConfirmation || body.versionId != null || body.versionSha256 != null || body.familyId != null) {
        throw new HttpError(422, 'CREATIVE_REVISION reviews cannot carry media version or rights fields');
      }
      const subjectKind = optionalStableId(body.subjectKind, 'subjectKind');
      if (!creativeReviewKinds.has(subjectKind)) {
        throw new HttpError(422, 'CREATIVE_REVISION reviews require subjectKind EPISODE_PLAN, SCENE_COVERAGE or SHOT_PLAN_SET');
      }
      if (subjectKind === 'EPISODE_PLAN') {
        throw new HttpError(
          422,
          'EPISODE_PLAN reviews must record all seven per-episode submissions and use the episode-plan finalization endpoint',
        );
      }
      const subjectRevisionId = optionalStableId(body.subjectRevisionId, 'subjectRevisionId');
      if (!subjectRevisionId) throw new HttpError(400, 'CREATIVE_REVISION reviews require subjectRevisionId');
      const subjectRevisionHash = assertSha256(body.subjectRevisionHash, 'subjectRevisionHash');
      const creativeRevision = (await listAllEvents('creative-revision'))
        .find((event) => event.creativeRevisionId === subjectRevisionId || event.revisionId === subjectRevisionId);
      if (!creativeRevision) throw new HttpError(422, 'subjectRevisionId does not resolve to a CreativeRevisionEvent');
      if (creativeRevision.subjectId !== requestedSubjectId || creativeRevision.subjectKind !== subjectKind) {
        throw new HttpError(422, 'creative revision belongs to another subject or subjectKind');
      }
      if (creativeRevision.contentHash !== subjectRevisionHash) throw new HttpError(409, 'subjectRevisionHash does not match the creative revision content');
      if (creativeRevision.contextHash !== contextHash) throw new HttpError(409, 'creative revision review context is stale');
      assertScopedPlanningFindings(creativeRevision,criterionFindings,body.reviewSpecHash);
      if (creativeRevision.baseRevisionHash !== currentCreativeSubjectBaseHash(data, subjectKind, requestedSubjectId)) {
        throw new HttpError(409, 'creative revision no longer binds the current subject predecessor');
      }
      if (subjectKind === 'EPISODE_PLAN') {
        assertEpisodePlanCriterionFindings(creativeRevision.content, criterionFindings, action);
      }
      const expectedScope = creativeReviewScope(data, subjectKind, requestedSubjectId);
      const scopeType = optionalStableId(body.scopeType, 'scopeType');
      const scopeId = optionalStableId(body.scopeId, 'scopeId');
      if (scopeType !== expectedScope.scopeType || scopeId !== expectedScope.scopeId) {
        throw new HttpError(422, 'canonical creative revision scope does not match the current business graph', { expectedScope });
      }
      if ([body.productionPhaseId, body.productionGateId, body.workPackageId, body.workItemId].some((value) => value != null && value !== '')) {
        throw new HttpError(422, 'creative revision review does not bind a production phase, gate, package or work item');
      }
      reviewedCreativeRevisionId = subjectRevisionId;
      semanticRequest = {
        schemaVersion: '2.2',
        snapshotId,
        creationSnapshotId: snapshotId,
        businessContextHash: contextHash,
        bindingVersion: '2.2',
        subjectType,
        subjectKind,
        subjectId: requestedSubjectId,
        subjectRevisionId,
        creativeRevisionId: subjectRevisionId,
        subjectRevisionHash,
        baseRevisionHash: creativeRevision.baseRevisionHash,
        ...(creativeRevision.scopedReviewSpec?{reviewSpecHash:body.reviewSpecHash}:{}),
        basisBindings: Array.isArray(creativeRevision.basisBindings) ? creativeRevision.basisBindings : [],
        basisBindingsHash: creativeRevision.basisBindingsHash || null,
        contextHash,
        criterionFindings,
        revisionInstructions,
        productionPhaseId: null,
        productionGateId: null,
        scopeType,
        scopeId,
        workPackageId: null,
        workItemId: null,
        action,
        note,
      };
    } else if (subjectType === 'SCRIPT_SCENE') {
      if (!requestedSubjectId) throw new HttpError(400, 'SCRIPT_SCENE reviews require subjectId');
      if (rightsUnknownConfirmation || body.versionId != null || body.versionSha256 != null || body.familyId != null) {
        throw new HttpError(422, 'SCRIPT_SCENE reviews cannot carry media version or rights fields');
      }
      const currentOperations = await operationalSnapshot();
      if (currentOperations.snapshotId !== data.snapshotId) throw new HttpError(409, 'story handoff projection changed during review validation');
      const storyHandoff = currentOperations.stateProjection.storyHandoff as Record<string, unknown> | undefined;
      if (
        !storyHandoff?.currentEpisodePlanRevisionId
        || !['SOURCE_CURRENT', 'SUCCEEDED'].includes(String(storyHandoff.episodePlanSourceSyncState || ''))
      ) {
        throw new HttpError(409, 'SCRIPT_SCENE review requires a current adopted and source-synced EpisodePlanRevision', {
          reasonCode: 'CURRENT_SYNCED_EPISODE_PLAN_REQUIRED',
          storyHandoff: storyHandoff || null,
        });
      }
      const target = storyConfirmationTargets(data).find((item) => String(item.sceneId || item.subjectId || '') === requestedSubjectId);
      if (!target) throw new HttpError(422, 'scene is not in the current rewritten-scene confirmation set');
      const subjectRevisionHash = assertSha256(body.subjectRevisionHash, 'subjectRevisionHash');
      const currentRevisionHash = String(target.sceneContentHash || target.subjectRevisionHash || '').toLowerCase();
      const currentContextHash = String(target.businessContextHash || target.contextHash || '').toLowerCase();
      if (subjectRevisionHash !== currentRevisionHash) throw new HttpError(409, 'scene content changed; reload before deciding');
      if (contextHash !== currentContextHash) throw new HttpError(409, 'scene review context changed; reload before deciding');
      semanticRequest = {
        schemaVersion: '2.2',
        snapshotId,
        creationSnapshotId: snapshotId,
        subjectType,
        subjectId: requestedSubjectId,
        subjectRevisionId: requestedSubjectId,
        subjectRevisionHash,
        scriptPath: target.scriptPath || null,
        scriptSha256: target.scriptSha256 || null,
        contextHash,
        businessContextHash: contextHash,
        bindingVersion: '2.2',
        affectedDownstreamRefs: target.affectedDownstreamRefs || [],
        criterionFindings,
        revisionInstructions,
        productionPhaseId: null,
        productionGateId: null,
        scopeType: 'SCENE',
        scopeId: requestedSubjectId,
        workPackageId: null,
        workItemId: null,
        action,
        note,
      };
    } else if (subjectType === 'ASSET') {
      if (!requestedSubjectId) throw new HttpError(400, 'ASSET reviews require subjectId');
      const familyId = requestedSubjectId;
      const ownership = assetReviewOwnership(data, familyId);
      if (!ownership.reviewable) {
        throw new HttpError(422, 'ASSET review is reserved for an asset with exactly one material-work-item owner and no production-work-item owner', {
          reasonCode: 'ASSET_REVIEW_OWNER_MISMATCH',
          familyId,
          materialOwnerWorkItemIds: ownership.materialOwnerWorkItemIds,
          productionOwnerWorkItemIds: ownership.productionOwnerWorkItemIds,
        });
      }
      const companionOwners = [
        ...data.productionModel.workItems,
        ...(data.productionModel.materialWorkItems || []),
      ].filter((item) => item.outputAssetRef === familyId && Array.isArray(item.additionalOutputAssetRefs) && item.additionalOutputAssetRefs.length > 0);
      if (companionOwners.length) {
        throw new HttpError(409, 'asset is the main output of a multi-output work item whose companion lifecycles are not independently reviewable', {
          reasonCode: 'COMPANION_OUTPUTS_REQUIRE_INDEPENDENT_LIFECYCLE',
          ownerWorkItemIds: companionOwners.map((item) => item.id),
          companionOutputAssetRefs: [...new Set(companionOwners.flatMap((item) => item.additionalOutputAssetRefs || []))],
        });
      }
      const versionId = assertString(body.versionId, 'versionId', 300);
      const versionSha256 = assertSha256(body.versionSha256, 'versionSha256');
      reviewedVersion = await verifiedVersion(data, familyId, versionId, versionSha256);
      const currentAssetContextHash = assetReviewContextHash(data, familyId, versionId, versionSha256);
      if (contextHash !== currentAssetContextHash) {
        throw new HttpError(409, 'asset review context is stale; reload the current version context before deciding', {
          currentContextHash: currentAssetContextHash,
        });
      }
      semanticRequest = {
        schemaVersion: '2.2',
        snapshotId,
        creationSnapshotId: snapshotId,
        businessContextHash: contextHash,
        bindingVersion: '2.2',
        subjectType,
        subjectId: familyId,
        subjectRevisionHash: versionSha256,
        familyId,
        versionId,
        versionSha256,
        contextHash,
        criterionFindings,
        revisionInstructions,
        productionPhaseId: null,
        productionGateId: null,
        scopeType: null,
        scopeId: null,
        workPackageId: null,
        workItemId: null,
        action,
        rightsUnknownConfirmation,
        supersedesReviewEventId,
        note,
      };
    } else {
      const workPackageId = assertStableId(body.workPackageId, 'workPackageId');
      const workItemId = assertStableId(body.workItemId, 'workItemId');
      const productionPhaseId = assertStableId(body.productionPhaseId, 'productionPhaseId');
      const productionGateId = assertStableId(body.productionGateId, 'productionGateId');
      const scopeType = assertStableId(body.scopeType, 'scopeType', 20);
      const scopeId = assertStableId(body.scopeId, 'scopeId');
      if (!productionScopeTypes.has(scopeType)) throw new HttpError(400, 'scopeType must be SHOT, SCENE, EPISODE or PROJECT');
      const versionId = assertString(body.versionId, 'versionId', 300);
      const versionSha256 = assertSha256(body.versionSha256, 'versionSha256');
      const workItem = data.productionModel.workItems.find((item) => item.id === workItemId);
      if (!workItem) throw new HttpError(422, 'workItemId does not resolve in the current business graph');
      if (!requestedSubjectId || requestedSubjectId !== workItemId) {
        throw new HttpError(422, 'WORK_PRODUCT subjectId must equal workItemId');
      }
      const companionOutputs = Array.isArray(workItem.additionalOutputAssetRefs)
        ? workItem.additionalOutputAssetRefs.map(String).filter(Boolean)
        : [];
      if (companionOutputs.length) {
        throw new HttpError(409, 'work product has companion outputs without independent version and review lifecycles; formal review is fail-closed', {
          reasonCode: 'COMPANION_OUTPUTS_REQUIRE_INDEPENDENT_LIFECYCLE',
          companionOutputAssetRefs: companionOutputs,
        });
      }
      const workPackage = data.productionModel.workPackages.find((item) => item.id === workPackageId);
      if (!workPackage || !(workPackage.workItemRefs || []).includes(workItemId)) {
        throw new HttpError(422, 'workPackageId does not contain workItemId in the current business graph');
      }
      const productionGate = (data.productionModel.productionGates || []).find((gate) => gate.id === productionGateId);
      if (!productionGate || productionGate.phaseId !== productionPhaseId) {
        throw new HttpError(422, 'productionGateId does not belong to productionPhaseId');
      }
      if (
        workItem.phaseId !== productionPhaseId
        || workItem.gateId !== productionGateId
        || workPackage.phaseId !== productionPhaseId
        || workPackage.gateId !== productionGateId
      ) {
        throw new HttpError(422, 'canonical production phase/gate binding does not match the work item and package');
      }
      if (
        workItem.scopeType !== scopeType
        || workItem.scopeId !== scopeId
        || workPackage.scopeType !== scopeType
        || workPackage.scopeId !== scopeId
      ) {
        throw new HttpError(422, 'canonical scope binding does not match the work item and package');
      }
      if (workItem.activeInCurrentProduction !== true || workPackage.activeInCurrentProduction !== true) {
        throw new HttpError(409, 'historical or proposal work bindings are read-only evidence and cannot receive a new formal review');
      }
      const binding = workProductReviewBinding(data, workItemId, workPackageId);
      if (!binding) {
        throw new HttpError(422, 'work product has no exact SHOT, SCENE, EPISODE or PROJECT review context; arbitrary first-shot fallback is forbidden');
      }
      if (!binding.reviewable || binding.semanticStatus === 'UNKNOWN_STALE_BINDING') {
        throw new HttpError(409, 'work product review context is stale or not reviewable', {
          reviewContextRef: binding.reviewContextRef || null,
          semanticStatus: binding.semanticStatus,
        });
      }
      if (contextHash !== binding.contextHash) {
        throw new HttpError(409, 'review context is stale; reload the current scoped context before deciding', {
          currentContextHash: binding.contextHash,
          scopeType: binding.reviewScopeType,
          scopeId: binding.reviewScopeId,
        });
      }
      const requestedReviewContextRef = optionalStableId(body.reviewContextRef, 'reviewContextRef');
      if (!requestedReviewContextRef || requestedReviewContextRef !== binding.reviewContextRef) {
        throw new HttpError(409, 'reviewContextRef does not match the current work product context');
      }
      if (scopeType !== binding.reviewScopeType || scopeId !== binding.reviewScopeId) {
        throw new HttpError(422, 'canonical scope does not match the exact review context');
      }
      const familyId = workItem.outputAssetRef;
      if (!familyId) throw new HttpError(422, 'workItemId has no reviewable output asset family');
      reviewedVersion = await verifiedVersion(data, familyId, versionId, versionSha256);
      semanticRequest = {
        schemaVersion: '2.2',
        snapshotId,
        creationSnapshotId: snapshotId,
        businessContextHash: contextHash,
        bindingVersion: '2.2',
        subjectType,
        subjectId: workItemId,
        subjectRevisionHash: versionSha256,
        reviewContextRef: binding.reviewContextRef || null,
        reviewContextSemanticStatus: binding.semanticStatus,
        productionPhaseId,
        productionGateId,
        scopeType,
        scopeId,
        workPackageId,
        workItemId,
        familyId,
        versionId,
        versionSha256,
        contextHash,
        criterionFindings,
        revisionInstructions,
        action,
        rightsUnknownConfirmation,
        note,
      };
    }

    if (
      subjectType === 'WORK_PRODUCT'
      && action === 'REQUEST_REVISION'
      && (!revisionInstructions || revisionInstructions.change.length < 1)
    ) {
      throw new HttpError(422, 'media REQUEST_REVISION requires revisionInstructions.change with at least one concrete instruction');
    }

    if (subjectType !== 'CREATIVE_REVISION') {
      const spec = resolveFormalReviewSpec(data, subjectType, String(semanticRequest.subjectId));
      if (!spec && data.productionModel.systemConfiguration) throw new HttpError(422, '该对象没有唯一的审阅标准绑定');
      if (spec) {
        const issues = data.productionModel.systemConfiguration ? reviewFindingsIssues(spec, criterionFindings, body.reviewSpecHash, true) : [];
        if (issues.length) throw new HttpError(422, issues.join('；'));
        semanticRequest.reviewSpecHash = spec.hash;
      }
    }
    let eventPayload: Record<string, unknown>;
    if (subjectType === 'CREATIVE_REVISION') {
      const reviewDecision = action === 'APPROVE_AND_RELEASE'
        ? 'RELEASED'
        : action === 'REQUEST_REVISION'
          ? 'REVISION_REQUIRED'
          : 'DO_NOT_USE';
      eventPayload = {
        ...semanticRequest,
        reviewedRevisionState: 'CANDIDATE',
        originalProjection: {
          reviewDecision: 'PENDING',
          lifecycleState: 'REVIEW_PENDING',
          canFlowDownstream: false,
        },
        reviewDecision,
        lifecycleState: reviewDecision,
        canFlowDownstream: false,
        adoptionIntent: action === 'APPROVE_AND_RELEASE' ? 'ADOPT_THIS_REVISION' : 'DO_NOT_ADOPT',
        internalDownstreamEligibility: action === 'APPROVE_AND_RELEASE' ? 'INELIGIBLE_PENDING_SOURCE_SYNC' : 'INELIGIBLE',
        sourceSyncRequired: action === 'APPROVE_AND_RELEASE',
        sourceSyncState: action === 'APPROVE_AND_RELEASE' ? 'PENDING' : 'NOT_REQUIRED',
        applicationStatus: 'APPLIED',
        effect: 'APPLIED',
      };
    } else if (subjectType === 'SCRIPT_SCENE') {
      const reviewDecision = action === 'APPROVE_AND_RELEASE'
        ? 'RELEASED'
        : action === 'REQUEST_REVISION'
          ? 'REVISION_REQUIRED'
          : 'DO_NOT_USE';
      eventPayload = {
        ...semanticRequest,
        originalProjection: {
          reviewDecision: 'PENDING',
          lifecycleState: 'REVIEW_PENDING',
          canFlowDownstream: false,
        },
        reviewDecision,
        lifecycleState: reviewDecision,
        canFlowDownstream: action === 'APPROVE_AND_RELEASE',
        adoptionIntent: action === 'APPROVE_AND_RELEASE' ? 'ADOPT_THIS_SCENE' : 'DO_NOT_ADOPT',
        internalDownstreamEligibility: action === 'APPROVE_AND_RELEASE' ? 'ELIGIBLE' : 'INELIGIBLE',
        sourceSyncRequired: false,
        sourceSyncState: 'NOT_REQUIRED',
        applicationStatus: 'APPLIED',
        applicabilityState: 'CURRENT',
        staleReasons: [],
        effect: 'APPLIED',
      };
    } else {
      if (!reviewedVersion) throw new HttpError(500, 'reviewable media version was not resolved');
      const rightsFacts = originalRightsFacts(reviewedVersion);
      if (rightsUnknownConfirmation && (action !== 'APPROVE_AND_RELEASE' || rightsFacts.normalizedProjectRightsGate !== 'UNKNOWN')) {
        throw new HttpError(422, 'rightsUnknownConfirmation is only valid when releasing a version whose rights fact is UNKNOWN');
      }
      const projection = appliedProjection(action, rightsFacts.normalizedProjectRightsGate, rightsUnknownConfirmation);
      const sourceSyncRequired = action === 'APPROVE_AND_RELEASE' && reviewedVersion.promptSyncRequired === true;
      if (sourceSyncRequired && !/^[a-f0-9]{64}$/.test(reviewedVersion.actualPromptHash || '')) {
        throw new HttpError(422, 'prompt-adjusted candidate is missing its actualPromptHash source-sync binding');
      }
      eventPayload = {
        ...semanticRequest,
        reviewedOutputState: 'PRESENT',
        originalProjection: {
          reviewDecision: reviewedVersion.reviewDecision || 'PENDING',
          projectRightsGate: rightsFacts.normalizedProjectRightsGate,
          lifecycleState: reviewedVersion.lifecycleState || 'REVIEW_PENDING',
          canFlowDownstream: reviewedVersion.canFlowDownstream === true,
        },
        originalRightsFacts: rightsFacts,
        projectRightsGateAtReview: rightsFacts.normalizedProjectRightsGate,
        appliedProjectRightsGate: projection.projectRightsGate,
        reviewDecision: projection.reviewDecision,
        lifecycleState: projection.lifecycleState,
        canFlowDownstream: sourceSyncRequired ? false : projection.canFlowDownstream,
        adoptionIntent: action === 'APPROVE_AND_RELEASE' ? 'ADOPT_THIS_VERSION' : 'DO_NOT_ADOPT',
        internalDownstreamEligibility: sourceSyncRequired
          ? 'INELIGIBLE_PENDING_PROMPT_SYNC'
          : action === 'APPROVE_AND_RELEASE' ? 'ELIGIBLE' : 'INELIGIBLE',
        sourceSyncRequired,
        sourceSyncState: sourceSyncRequired ? 'PENDING' : 'NOT_REQUIRED',
        sourceSyncBinding: sourceSyncRequired ? {
          versionId: reviewedVersion.id,
          actualPromptHash: reviewedVersion.actualPromptHash,
        } : null,
        commercialReleaseEligibility: 'BLOCKED_PENDING_LEGAL_REVIEW',
        applicationStatus: 'APPLIED',
        effect: 'APPLIED',
      };
    }

    if(subjectType==='WORK_PRODUCT'&&body.shotProductionEvidence!=null){
      const {validateShotProductionEvidence}=await import('../../../../host/instance-runtime/shot-production-locks.mjs');
      try{const evidence=validateShotProductionEvidence(body.shotProductionEvidence);semanticRequest.shotProductionEvidence=evidence;eventPayload.shotProductionEvidence=evidence;}
      catch(reason){throw new HttpError(422,reason instanceof Error?reason.message:'制作审阅证据无效');}
    }
    const appendPayload: Record<string, unknown> = { ...eventPayload, rawRequestHash };
    const { event, replayed, operations } = await appendEvent(
      'review',
      idempotencyKey,
      mutationRequestHash('review', semanticRequest),
      ifMatch,
      appendPayload,
      '2.2',
      async (locked) => {
        if(subjectType==='WORK_PRODUCT'&&action==='APPROVE_AND_RELEASE'){const entry=locked.stateProjection.configuredGatesByWorkItem?.[String(semanticRequest.workItemId)]?.entryReasons||[];if(entry.length)throw new HttpError(409,'当前配置的前置门禁未通过',{reasons:entry});}
        if (reviewedVersion?.verifiedPath && reviewedVersion.verifiedFile) {
          await assertStableFileIdentity(reviewedVersion.verifiedPath, reviewedVersion.verifiedFile);
        }
        if(action==='APPROVE_AND_RELEASE'&&['ASSET','WORK_PRODUCT'].includes(subjectType)&&reviewedVersion?.verifiedPath){
          const familyId=String(semanticRequest.familyId||''),versionId=String(semanticRequest.versionId||'');
          const candidate=locked.candidates.events.find(e=>e.familyId===familyId&&e.versionId===versionId);
          const base=data.productionModel.assetVersions.find(v=>v.id===versionId&&v.familyId===familyId);
          const definitionId=String(candidate?.executionDefinitionId||base?.executionDefinitionRef||'');
          const definition=(await recipeCatalog()).executionDefinitions.find(d=>d.id===definitionId);
          const binding=imageTechnicalRead(()=>resolveImageTechnicalSpec(data.productionModel,{familyId,expectedOutputId:String(candidate?.expectedOutputId||base?.expectedOutputId||''),definition}));
          if(binding){
            const facts=await readImageTechnicalFacts(reviewedVersion.verifiedPath,{sha256:String(semanticRequest.versionSha256),byteSize:reviewedVersion.verifiedFile?.size}).catch(imageTechnicalFailure);
            imageTechnicalRead(()=>assertImageTechnicalApproval(binding,facts));
          }
        }
        if (reviewedCreativeRevisionId) {
          const revision = locked.creativeRevisions.events.find((item) => (
            item.creativeRevisionId === reviewedCreativeRevisionId || item.revisionId === reviewedCreativeRevisionId
          ));
          if (!revision || revision.contentHash !== semanticRequest.subjectRevisionHash || revision.contextHash !== contextHash) {
            throw new HttpError(409, 'creative revision binding changed while review was in flight');
          }
          if (action === 'APPROVE_AND_RELEASE') {
            assertCreativeRevisionBasisCurrent(data, locked.stateProjection, revision, {
              requireCurrentPredecessor: true,
            });
          }
        }
        const immutableAppliedReviews = locked.reviews.events.filter((item) => (
          ['2.0', '2.1', '2.2'].includes(String(item.schemaVersion || ''))
          && item.effect === 'APPLIED'
          && item.applicationStatus === 'APPLIED'
        ));
        if (subjectType === 'ASSET') {
          const transition = assetReviewTransitionProjection(data, {
            familyId: String(semanticRequest.familyId || ''),
            versionId: String(semanticRequest.versionId || ''),
            sha256: String(semanticRequest.versionSha256 || ''),
          }, {
            reviews: locked.reviews.events,
            candidates: locked.candidates.events,
            executionRequests: locked.executionRequests.events,
            runs: locked.runs.events,
            sourceOperations: locked.sourceOperations.events,
          }, {executionDefinitions: (await recipeCatalog()).executionDefinitions});
          const correctionState = transition.state;
          const correctionHeadEventId = transition.headEventId;
          const projectedAssetReview = locked.reviews.projectedByAssetVersion.find((entry) => (
            entry.aggregateId === semanticRequest.versionId
          ))?.event || null;
          const projectedHeadEventId = String(projectedAssetReview?.eventId || '');
          const currentAssetDecision = correctionHeadEventId
            ? immutableAppliedReviews.find((item) => (
                item.eventId === correctionHeadEventId
                && item.subjectType === 'ASSET'
                && item.subjectId === semanticRequest.subjectId
                && item.familyId === semanticRequest.familyId
                && item.versionId === semanticRequest.versionId
                && String(item.versionSha256 || '').toLowerCase() === String(semanticRequest.versionSha256 || '').toLowerCase()
              )) || null
            : null;
          if (
            (correctionHeadEventId && (!currentAssetDecision || projectedHeadEventId !== correctionHeadEventId))
            || (!correctionHeadEventId && projectedHeadEventId)
          ) {
            throw new HttpError(409, 'the effective asset review head cannot be verified; reload before submitting another decision', {
              reasonCode: 'REVIEW_CORRECTION_STATE_UNKNOWN',
              reviewCorrectionState: 'UNKNOWN',
              currentHeadEventId: correctionHeadEventId || null,
              projectedHeadEventId: projectedHeadEventId || null,
              lockReasons: transition.lockReasons,
            });
          }
          if (!currentAssetDecision && supersedesReviewEventId) {
            throw new HttpError(409, 'the asset review head changed; reload before submitting the correction', {
              reasonCode: 'REVIEW_CORRECTION_HEAD_CHANGED',
              suppliedSupersedesReviewEventId: supersedesReviewEventId,
              currentHeadEventId: correctionHeadEventId || null,
            });
          }
          if (currentAssetDecision) {
            if (correctionState !== 'OPEN' || correctionHeadEventId !== currentAssetDecision.eventId) {
              throw new HttpError(409, 'this review decision is locked because the asset has entered a downstream state', {
                reasonCode: correctionState === 'LOCKED' ? 'REVIEW_CORRECTION_LOCKED' : 'REVIEW_CORRECTION_STATE_UNKNOWN',
                reviewCorrectionState: correctionState,
                existingEventId: currentAssetDecision.eventId,
                lockReasons: transition.lockReasons,
              });
            }
            if (!supersedesReviewEventId) {
              throw new HttpError(409, 'this asset already has an effective decision; reload it and submit an explicit superseding correction', {
                reasonCode: 'REVIEW_CORRECTION_REQUIRES_HEAD',
                existingEventId: currentAssetDecision.eventId,
                existingAction: currentAssetDecision.action,
                reviewCorrectionState: correctionState,
              });
            }
            if (supersedesReviewEventId !== currentAssetDecision.eventId) {
              throw new HttpError(409, 'the asset review head changed; reload before submitting the correction', {
                reasonCode: 'REVIEW_CORRECTION_HEAD_CHANGED',
                suppliedSupersedesReviewEventId: supersedesReviewEventId,
                currentHeadEventId: currentAssetDecision.eventId,
              });
            }
            Object.assign(appendPayload, {
              reviewEventRole: 'SUPERSEDING_CORRECTION',
              supersessionPolicy: 'BEFORE_DOWNSTREAM_LOCK',
              supersedesReviewEventId: currentAssetDecision.eventId,
              originalProjection: {
                reviewDecision: currentAssetDecision.reviewDecision || 'PENDING',
                projectRightsGate: currentAssetDecision.appliedProjectRightsGate || currentAssetDecision.projectRightsGateAtReview || 'UNKNOWN',
                lifecycleState: currentAssetDecision.lifecycleState || 'REVIEW_PENDING',
                canFlowDownstream: currentAssetDecision.canFlowDownstream === true,
              },
            });
          } else {
            if (correctionState !== 'OPEN') {
              throw new HttpError(409, 'the asset version has already advanced or its downstream binding cannot be verified; an initial decision is not allowed', {
                reasonCode: 'REVIEW_INITIAL_DECISION_LOCKED',
                reviewCorrectionState: correctionState,
                currentHeadEventId: null,
                lockReasons: transition.lockReasons,
              });
            }
            appendPayload.reviewEventRole = 'INITIAL_DECISION';
          }
        }
        const existingImmutableDecision = subjectType === 'SCRIPT_SCENE'
          ? immutableAppliedReviews.find((item) => (
              item.subjectType === 'SCRIPT_SCENE'
              && item.subjectId === semanticRequest.subjectId
              && String(item.subjectRevisionHash || '').toLowerCase() === String(semanticRequest.subjectRevisionHash || '').toLowerCase()
            ))
          : subjectType === 'CREATIVE_REVISION'
            ? immutableAppliedReviews.find((item) => (
                ['CREATIVE_REVISION', 'STRUCTURE'].includes(String(item.subjectType || ''))
                && item.subjectKind === semanticRequest.subjectKind
                && item.subjectId === semanticRequest.subjectId
                && (item.subjectRevisionId || item.creativeRevisionId) === semanticRequest.subjectRevisionId
                && String(item.subjectRevisionHash || '').toLowerCase() === String(semanticRequest.subjectRevisionHash || '').toLowerCase()
              ))
            : subjectType === 'WORK_PRODUCT'
            ? immutableAppliedReviews.find((item) => (
                item.subjectType === 'WORK_PRODUCT'
                && item.workItemId === semanticRequest.workItemId
                && item.versionId === semanticRequest.versionId
                && String(item.versionSha256 || '').toLowerCase() === String(semanticRequest.versionSha256 || '').toLowerCase()
              ))
            : null;
        if (existingImmutableDecision) {
          const isScene = subjectType === 'SCRIPT_SCENE';
          throw new HttpError(
            409,
            isScene
              ? 'this scene content hash already has an applied formal decision; change the authoritative scene source to create a new sceneContentHash before reviewing again'
              : 'this asset version and SHA-256 already have an applied formal decision; register a new AssetVersion before reviewing again',
            {
              immutableTarget: isScene
                ? `${String(semanticRequest.subjectId)}@${String(semanticRequest.subjectRevisionHash)}`
                : `${String(semanticRequest.versionId)}@${String(semanticRequest.versionSha256)}`,
              existingEventId: existingImmutableDecision.eventId,
              existingAction: existingImmutableDecision.action,
              existingReviewDecision: existingImmutableDecision.reviewDecision,
            },
          );
        }
        if (subjectType === 'WORK_PRODUCT') {
          const projected = locked.stateProjection.workItemsById[String(semanticRequest.workItemId || '')];
          const baseWorkItem = data.productionModel.workItems.find((item) => item.id === String(semanticRequest.workItemId || ''));
          if (baseWorkItem?.pipelineStageCode === 'P07' && projected?.reviewActionability !== 'ACTIONABLE') {
            throw new HttpError(409, 'review dependency gate is not open for this work product', {
              reviewActionability: projected?.reviewActionability || 'UNKNOWN',
              reviewBlockers: projected?.reviewBlockers || [],
            });
          }
        }
      },
    );
    const applied = subjectType === 'SCRIPT_SCENE'
      ? operations.reviews.projectedBySubject?.some((item: { event?: { eventId?: unknown } }) => item.event?.eventId === event.eventId)
      : subjectType === 'CREATIVE_REVISION'
        ? operations.reviews.projectedStructureByRevision.some((item: { event?: { eventId?: unknown } }) => item.event?.eventId === event.eventId)
        : subjectType === 'ASSET'
          ? operations.reviews.projectedByAssetVersion.some((item: { event?: { eventId?: unknown } }) => item.event?.eventId === event.eventId)
          : operations.reviews.projectedByVersion.some((item: { event?: { eventId?: unknown } }) => item.event?.eventId === event.eventId);
    if (!applied) throw new HttpError(409, 'review event was recorded but does not bind the current business projection; reload before retrying');
    return jsonResponse(
      {
        eventId: event.eventId,
        replayed,
        event,
        operationRevision: operations.operationRevision,
        operationalRevision: operations.operationalRevision,
        etag: operations.etag,
        mutationEtag: operations.mutationEtag,
        appliedProjection: operations.stateProjection,
      },
      { status: replayed ? 200 : 201, headers: { ETag: operations.etag } },
    );
  } catch (reason) {
    return errorResponse(reason, 'invalid review event');
  }
}
import {assertScopedPlanningFindings} from '../episode-plan-reviews/_planning';
