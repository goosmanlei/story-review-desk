import { HttpError, stableObjectHash, type EventRecord } from '../_store';


export const episodeCriterionSuffixes = [
  'opening-boundary',
  'episode-purpose',
  'escalation-turn',
  'information-causality',
  'episode-payoff',
  'ending-propulsion',
] as const;

const episodeCriterionLabels: Record<(typeof episodeCriterionSuffixes)[number], string> = {
  'opening-boundary': '起集点',
  'episode-purpose': '本集任务',
  'escalation-turn': '递进与转折',
  'information-causality': '信息与因果',
  'episode-payoff': '本集回报',
  'ending-propulsion': '断集与追看',
};

export type EpisodeReviewAction = 'APPROVE_AND_RELEASE' | 'REQUEST_REVISION' | 'DO_NOT_USE';
export type EpisodeFinding = { criterionId: string; verdict: 'PASS' | 'FAIL'; note: string };
export type EpisodeIdentity = { episodeUid: string; displayId: string };

const actionPriority: Record<EpisodeReviewAction, number> = {
  APPROVE_AND_RELEASE: 0,
  REQUEST_REVISION: 1,
  DO_NOT_USE: 2,
};

export function episodeIdentities(content: unknown): EpisodeIdentity[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new HttpError(422, 'EPISODE_PLAN creative revision content is unavailable');
  }
  const episodes = (content as Record<string, unknown>).episodes;
  if (!Array.isArray(episodes) || !episodes.length) {
    throw new HttpError(422, 'EPISODE_PLAN creative revision has no episodes');
  }
  const seen = new Set<string>();
  return episodes.map((episode, index) => {
    if (!episode || typeof episode !== 'object' || Array.isArray(episode)) {
      throw new HttpError(422, `EPISODE_PLAN content.episodes[${index}] is invalid`);
    }
    const record = episode as Record<string, unknown>;
    const episodeUid = typeof record.episodeUid === 'string' ? record.episodeUid.trim() : '';
    const displayId = typeof record.displayId === 'string' ? record.displayId.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/.test(episodeUid)) {
      throw new HttpError(422, `EPISODE_PLAN content.episodes[${index}].episodeUid is invalid`);
    }
    if (seen.has(episodeUid)) throw new HttpError(422, `EPISODE_PLAN contains duplicate episodeUid ${episodeUid}`);
    seen.add(episodeUid);
    return { episodeUid, displayId: displayId || `E${String(index + 1).padStart(2, '0')}` };
  });
}

export function expectedEpisodeCriterionIds(episodeUid: string) {
  return episodeCriterionSuffixes.map((suffix) => `episode:${episodeUid}:${suffix}`);
}

export function parseEpisodeFindings(value: unknown, episodeUid: string): EpisodeFinding[] {
  if (!Array.isArray(value) || value.length !== episodeCriterionSuffixes.length) {
    throw new HttpError(422, `episode review requires exactly ${episodeCriterionSuffixes.length} criterion findings`);
  }
  const expected = expectedEpisodeCriterionIds(episodeUid);
  const seen = new Set<string>();
  const findings = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, `criterionFindings[${index}] must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const criterionId = typeof record.criterionId === 'string' ? record.criterionId.trim() : '';
    const verdict = typeof record.verdict === 'string' ? record.verdict.trim() : '';
    const note = record.note == null ? '' : typeof record.note === 'string' ? record.note.trim() : '__INVALID__';
    if (!expected.includes(criterionId as (typeof expected)[number])) {
      throw new HttpError(422, `criterionFindings[${index}] does not belong to ${episodeUid}`);
    }
    if (seen.has(criterionId)) throw new HttpError(400, `criterionFindings contains duplicate criterionId ${criterionId}`);
    if (verdict !== 'PASS' && verdict !== 'FAIL') {
      throw new HttpError(422, `criterionFindings[${index}].verdict must be PASS or FAIL`);
    }
    if (note === '__INVALID__' || note.length > 3600) throw new HttpError(400, `criterionFindings[${index}].note is invalid`);
    if (verdict === 'FAIL' && !note) throw new HttpError(422, `criterionFindings[${index}] with FAIL requires a concrete note`);
    seen.add(criterionId);
    return { criterionId, verdict, note } as EpisodeFinding;
  });
  const byId = new Map(findings.map((finding) => [finding.criterionId, finding]));
  if (expected.some((criterionId) => !byId.has(criterionId))) {
    throw new HttpError(422, `episode review must cover all six criteria for ${episodeUid}`);
  }
  return expected.map((criterionId) => byId.get(criterionId) as EpisodeFinding);
}

export function validateEpisodeAction(action: string, findings: EpisodeFinding[], note: string): EpisodeReviewAction {
  if (action !== 'APPROVE_AND_RELEASE' && action !== 'REQUEST_REVISION' && action !== 'DO_NOT_USE') {
    throw new HttpError(400, 'reviewAction must be APPROVE_AND_RELEASE, REQUEST_REVISION or DO_NOT_USE');
  }
  const hasFailure = findings.some((finding) => finding.verdict === 'FAIL');
  if (action === 'APPROVE_AND_RELEASE' && hasFailure) {
    throw new HttpError(400, 'APPROVE_AND_RELEASE cannot contain a FAIL criterion finding');
  }
  if (action !== 'APPROVE_AND_RELEASE' && !hasFailure) {
    throw new HttpError(400, `${action} requires at least one FAIL criterion finding`);
  }
  if (action !== 'APPROVE_AND_RELEASE' && !note) {
    throw new HttpError(400, `${action} requires a concrete episode note`);
  }
  return action;
}

export function assertEpisodeSubmissionBindings(event: EventRecord, candidate: EventRecord, episodeUid: string) {
  const frozenSpec = event.reviewSpec as {hash?:string} | undefined;
  if (event.schemaVersion === '1.1' && frozenSpec) {
    if (frozenSpec.hash !== event.reviewSpecHash || stableObjectHash({...frozenSpec,hash:undefined}) !== frozenSpec.hash) throw new HttpError(409, '本次提交冻结的审阅标准校验失败');
    candidate = {...candidate,reviewSpec:frozenSpec};
  }
  const candidateRevisionId = candidate.creativeRevisionId || candidate.revisionId;
  const identities = episodeIdentities(candidate.content);
  const identity = identities.find((episode) => episode.episodeUid === episodeUid);
  if (
    !identity
    || event.subjectType !== 'EPISODE_PLAN_EPISODE'
    || event.subjectKind !== 'EPISODE_PLAN'
    || event.subjectId !== candidate.subjectId
    || event.subjectRevisionId !== candidateRevisionId
    || event.creativeRevisionId !== candidateRevisionId
    || event.subjectRevisionHash !== candidate.contentHash
    || event.contextHash !== candidate.contextHash
    || (candidate.reviewSpec && (candidate.reviewSpec as {hash:string}).hash !== event.reviewSpecHash)
    || (candidate.criteriaVersion === '2.0' ? event.criteriaVersion !== '2.0' : event.criteriaVersion != null && event.criteriaVersion !== '1.0')
    || event.baseRevisionHash !== candidate.baseRevisionHash
    || event.basisBindingsHash !== candidate.basisBindingsHash
    || stableObjectHash(event.basisBindings) !== candidate.basisBindingsHash
    || event.scopeType !== 'EPISODE'
    || event.scopeId !== episodeUid
    || event.episodeUid !== episodeUid
    || event.displayId !== identity.displayId
    || event.totalEpisodeCount !== identities.length
    || event.candidateCreationSnapshotId !== candidate.snapshotId
  ) {
    throw new HttpError(409, `${episodeUid} submission does not bind the exact episode plan candidate`);
  }
}

function eventSequence(event: EventRecord) {
  return Number.isSafeInteger(event.eventSequence) ? Number(event.eventSequence) : 0;
}

export function episodeSubmissionHeads(events: EventRecord[], subjectRevisionId: string) {
  const relevant = events.filter((event) => (
    event.eventKind === 'episode-plan-submission'
    && ['1.0', '1.1'].includes(String(event.schemaVersion))
    && event.applicationStatus === 'RECORDED'
    && event.effect === 'REVIEW_INPUT_ONLY'
    && event.subjectType === 'EPISODE_PLAN_EPISODE'
    && event.subjectKind === 'EPISODE_PLAN'
    && event.subjectRevisionId === subjectRevisionId
  ));
  const grouped = new Map<string, EventRecord[]>();
  for (const event of relevant) {
    const episodeUid = String(event.episodeUid || event.scopeId || '');
    if (!episodeUid) throw new HttpError(503, 'episode review event is missing episodeUid');
    grouped.set(episodeUid, [...(grouped.get(episodeUid) || []), event]);
  }
  const heads = new Map<string, EventRecord>();
  for (const [episodeUid, rows] of grouped) {
    const ordered = [...rows].sort((left, right) => eventSequence(left) - eventSequence(right) || String(left.recordedAt).localeCompare(String(right.recordedAt)));
    let head: EventRecord | null = null;
    for (const row of ordered) {
      const supersedes = String(row.supersedesEpisodeSubmissionEventId || '');
      if (!head && supersedes) throw new HttpError(503, `episode review ${episodeUid} starts with an invalid supersession`);
      if (head && supersedes !== head.eventId) throw new HttpError(503, `episode review ${episodeUid} has a non-linear supersession chain`);
      head = row;
    }
    if (head) heads.set(episodeUid, head);
  }
  return heads;
}

export function aggregateEpisodeSubmissions(identities: EpisodeIdentity[], heads: Map<string, EventRecord>) {
  const missingEpisodeUids = identities.map((episode) => episode.episodeUid).filter((episodeUid) => !heads.has(episodeUid));
  const extraEpisodeUids = [...heads.keys()].filter((episodeUid) => !identities.some((episode) => episode.episodeUid === episodeUid));
  if (extraEpisodeUids.length) throw new HttpError(409, 'episode submissions contain identities outside the reviewed candidate', { extraEpisodeUids });
  if (missingEpisodeUids.length) return { complete: false as const, missingEpisodeUids };
  const submissions = identities.map((episode) => {
    const event = heads.get(episode.episodeUid) as EventRecord;
    const findings = parseEpisodeFindings(event.criterionFindings, episode.episodeUid);
    const action = validateEpisodeAction(String(event.recommendation || ''), findings, String(event.note || '').trim());
    return { episode, event, findings, action };
  });
  const action = submissions.reduce<EpisodeReviewAction>((current, submission) => (
    actionPriority[submission.action] > actionPriority[current] ? submission.action : current
  ), 'APPROVE_AND_RELEASE');
  const criterionFindings = submissions.flatMap((submission) => submission.findings.map((finding) => ({
    criterionId: finding.criterionId,
    verdict: finding.verdict,
    ...(finding.note ? { note: finding.note } : {}),
  })));
  const episodeSubmissionRefs = submissions.map((submission) => ({
    episodeUid: submission.episode.episodeUid,
    displayIdAtSubmission: submission.episode.displayId,
    eventId: String(submission.event.eventId || ''),
  }));
  const note = submissions.map((submission) => {
    const label = submission.action === 'APPROVE_AND_RELEASE' ? '通过并放行' : submission.action === 'REQUEST_REVISION' ? '要求修改' : '禁止使用';
    return `${submission.episode.displayId} · ${label}：${String(submission.event.note || '').trim() || '六项判断均通过。'}`;
  }).join('\n');
  const revisionChanges = submissions.flatMap((submission) => submission.findings
    .filter((finding) => finding.verdict === 'FAIL')
    .map((finding) => {
      const suffix = finding.criterionId.split(':').at(-1) as (typeof episodeCriterionSuffixes)[number];
      return `${submission.episode.displayId} · ${episodeCriterionLabels[suffix] || suffix}：${finding.note}`;
    }));
  if (note.length > 20_000) throw new HttpError(422, 'aggregated episode review note exceeds the ReviewEvent limit');
  return { complete: true as const, action, criterionFindings, episodeSubmissionRefs, note, revisionChanges, submissions };
}
