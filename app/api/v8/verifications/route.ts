import { createHash } from 'node:crypto';
import {
  appendEvent,
  assertSha256,
  assertStableId,
  audioVerificationTargets,
  errorResponse,
  eventLimit,
  HttpError,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  optionalString,
  replayIdempotentEvent,
  validateMutationRequest,
} from '../_store';

const outcomes = new Set(['CONFIRMED_CURRENT', 'CORRECTED', 'UNRESOLVED_AFTER_LISTENING']);

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = eventLimit(url.searchParams.get('limit'));
    const issueId = url.searchParams.get('issueId');
    const outcome = url.searchParams.get('outcome');
    if (issueId) assertStableId(issueId, 'issueId');
    if (outcome && !outcomes.has(outcome)) throw new HttpError(400, 'outcome is invalid');
    const events = (await listAllEvents('verification'))
      .filter((event) => !issueId || event.issueId === issueId)
      .filter((event) => !outcome || event.outcome === outcome)
      .slice(0, limit);
    return jsonResponse({ events, count: events.length });
  } catch (reason) {
    return errorResponse(reason, 'verification events are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('verification', body);
    const replay = await replayIdempotentEvent('verification', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        verificationId: replay.event.verificationId,
        replayed: true,
        event: replay.event,
        operationRevision: replay.operations.operationRevision,
        etag: replay.operations.etag,
        mutationEtag: replay.operations.mutationEtag,
      }, { headers: { ETag: replay.operations.etag } });
    }

    const schemaVersion = optionalString(body.schemaVersion, 16) || '1.0';
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const issueId = assertStableId(body.issueId || body.subjectId, 'issueId');
    const outcome = assertStableId(body.outcome, 'outcome', 64);
    const correctedText = optionalString(body.correctedText, 20_000);
    const note = optionalString(body.note, 20_000);
    if (schemaVersion !== '1.0') throw new HttpError(409, 'verification requires schemaVersion 1.0');
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    if (!outcomes.has(outcome)) throw new HttpError(400, 'outcome is invalid');
    if (outcome === 'CORRECTED' && !correctedText) throw new HttpError(422, 'CORRECTED requires correctedText');
    if (outcome !== 'CORRECTED' && correctedText) throw new HttpError(422, 'correctedText is only valid for CORRECTED');
    if (outcome === 'UNRESOLVED_AFTER_LISTENING' && !note) {
      throw new HttpError(422, 'UNRESOLVED_AFTER_LISTENING requires a concrete listening note');
    }

    const target = audioVerificationTargets(data).find((item) => String(item.issueId || item.subjectId || '') === issueId);
    if (!target) throw new HttpError(422, 'issueId is not a current audio verification target');
    const audioSha256 = assertSha256(body.audioSha256, 'audioSha256');
    const currentTextHash = assertSha256(body.currentTextHash, 'currentTextHash');
    const businessContextHash = assertSha256(body.businessContextHash || body.contextHash, 'businessContextHash');
    const timecodeStart = optionalString(body.timecodeStart, 32);
    const timecodeEnd = optionalString(body.timecodeEnd, 32);
    if (
      audioSha256 !== String(target.audioSha256 || '').toLowerCase()
      || currentTextHash !== String(target.currentTextHash || '').toLowerCase()
      || businessContextHash !== String(target.businessContextHash || target.contextHash || '').toLowerCase()
      || timecodeStart !== String(target.timecodeStart || '')
      || timecodeEnd !== String(target.timecodeEnd || '')
    ) {
      throw new HttpError(409, 'audio verification binding is stale; reload the current issue before recording a conclusion');
    }

    const verificationId = `verify_${createHash('sha256').update(`${issueId}:${businessContextHash}:${outcome}:${correctedText}:${note}`).digest('hex').slice(0, 32)}`;
    const semanticRequest = {
      schemaVersion: '1.0',
      snapshotId,
      creationSnapshotId: snapshotId,
      verificationId,
      issueId,
      subjectType: 'AUDIO_SOURCE',
      subjectId: issueId,
      audioSha256,
      timecodeStart,
      timecodeEnd,
      currentTextHash,
      businessContextHash,
      contextHash: businessContextHash,
      bindingVersion: '1.0',
      outcome,
      correctedText,
      note,
    };
    const { event, replayed, operations } = await appendEvent(
      'verification',
      idempotencyKey,
      mutationRequestHash('verification', semanticRequest),
      ifMatch,
      {
        ...semanticRequest,
        rawRequestHash,
        applicationStatus: 'APPLIED',
        applicabilityState: 'CURRENT',
        staleReasons: [],
        sourceSyncRequired: outcome === 'CORRECTED',
        sourceSyncState: outcome === 'CORRECTED' ? 'PENDING_AUTHORIZATION' : 'NOT_REQUIRED',
      },
      '1.0',
      (locked) => {
        const existing = locked.verifications.latestByIssue
          .find((item: { aggregateId?: unknown }) => item.aggregateId === issueId)?.event;
        if (!existing) return;
        throw new HttpError(
          409,
          'this audio source binding already has an applied verification; change the authoritative audio, text, time range or business context before recording another conclusion',
          {
            immutableTarget: `${issueId}@${audioSha256}:${timecodeStart}-${timecodeEnd}:${currentTextHash}:${businessContextHash}`,
            existingEventId: existing.eventId,
            existingOutcome: existing.outcome,
          },
        );
      },
    );
    const current = operations.verifications.latestByIssue
      .find((item: { aggregateId?: unknown; event?: { eventId?: unknown } }) => item.aggregateId === issueId && item.event?.eventId === event.eventId);
    if (!current) throw new HttpError(409, 'verification event was recorded but is not applicable to the current issue');
    return jsonResponse({
      eventId: event.eventId,
      verificationId: event.verificationId,
      replayed,
      event,
      operationRevision: operations.operationRevision,
      operationalRevision: operations.operationalRevision,
      etag: operations.etag,
      mutationEtag: operations.mutationEtag,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'invalid verification event');
  }
}
