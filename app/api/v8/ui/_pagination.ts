import { assertStableId, HttpError, stableObjectHash } from '../_store';

export const UI_PAGE_MAX_BYTES = 2 * 1024 * 1024;

export type UiPageFilters = {
  phaseId: string | null;
  gateId: string | null;
  scopeType: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT' | null;
  scopeId: string | null;
};

type CursorPayload = {
  v: 1;
  resource: string;
  snapshotId: string;
  filterHash: string;
  offset: number;
};

function parseLimit(value: string | null) {
  if (value == null || value === '') return 50;
  if (!/^\d+$/.test(value)) throw new HttpError(400, 'limit must be an integer between 1 and 100');
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'limit must be an integer between 1 and 100');
  }
  return limit;
}

function encodeBase64Url(value: string) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - normalized.length % 4) % 4);
  return atob(`${normalized}${padding}`);
}

export function encodeUiCursor(
  resource: string,
  snapshotId: string,
  filterHash: string,
  offset: number,
) {
  return encodeBase64Url(JSON.stringify({ v: 1, resource, snapshotId, filterHash, offset } satisfies CursorPayload));
}

function decodeUiCursor(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(value));
  } catch {
    throw new HttpError(400, 'cursor is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'cursor is invalid');
  const cursor = parsed as Partial<CursorPayload>;
  if (
    cursor.v !== 1
    || typeof cursor.resource !== 'string'
    || typeof cursor.snapshotId !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(cursor.filterHash || ''))
    || !Number.isInteger(cursor.offset)
    || Number(cursor.offset) < 0
  ) {
    throw new HttpError(400, 'cursor is invalid');
  }
  return cursor as CursorPayload;
}

export function parseUiPageRequest(
  request: Request,
  resource: string,
  snapshotId: string,
  normalizeFilters: (filters: UiPageFilters) => UiPageFilters = (filters) => filters,
) {
  const url = new URL(request.url);
  const phaseId = url.searchParams.get('phaseId');
  const gateId = url.searchParams.get('gateId');
  const scopeType = url.searchParams.get('scopeType');
  const scopeId = url.searchParams.get('scopeId');
  if (phaseId) assertStableId(phaseId, 'phaseId');
  if (gateId) assertStableId(gateId, 'gateId');
  if (gateId && !phaseId) throw new HttpError(400, 'gateId requires phaseId');
  if (Boolean(scopeType) !== Boolean(scopeId)) throw new HttpError(400, 'scopeType and scopeId must be supplied together');
  if (scopeType && !['SHOT', 'SCENE', 'EPISODE', 'PROJECT'].includes(scopeType)) {
    throw new HttpError(400, 'scopeType must be SHOT, SCENE, EPISODE or PROJECT');
  }
  if (scopeId) assertStableId(scopeId, 'scopeId');
  const filters = normalizeFilters({
    phaseId: phaseId || null,
    gateId: gateId || null,
    scopeType: scopeType as UiPageFilters['scopeType'] || null,
    scopeId: scopeId || null,
  });
  const filterHash = stableObjectHash(filters);
  const cursorValue = url.searchParams.get('cursor');
  const cursor = cursorValue ? decodeUiCursor(cursorValue) : null;
  if (cursor && cursor.resource !== resource) throw new HttpError(409, 'cursor belongs to another resource');
  if (cursor && cursor.snapshotId !== snapshotId) throw new HttpError(409, 'cursor snapshot is stale; restart pagination');
  if (cursor && cursor.filterHash !== filterHash) throw new HttpError(409, 'cursor does not match the requested filters');
  return {
    filters,
    filterHash,
    limit: parseLimit(url.searchParams.get('limit')),
    offset: cursor?.offset || 0,
  };
}

export function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertCursorOffset(offset: number, total: number) {
  if (offset > total) throw new HttpError(409, 'cursor offset is no longer valid for this snapshot and filter set');
}
