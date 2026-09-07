import { buildJourney, type JourneyScopeType } from '../_journeys';
import { errorResponse, HttpError, jsonResponse } from '../_store';

const scopeTypes = new Set<JourneyScopeType>(['SCENE', 'EPISODE', 'PROJECT']);

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scopeType = url.searchParams.get('scopeType') as JourneyScopeType | null;
    const scopeId = url.searchParams.get('scopeId') || '';
    if (!scopeType || !scopeTypes.has(scopeType)) throw new HttpError(400, 'scopeType must be SCENE, EPISODE, or PROJECT');
    if (scopeType !== 'PROJECT' && !scopeId) throw new HttpError(400, 'scopeId is required');
    try {
      const journey = await buildJourney(scopeType, scopeId);
      return jsonResponse(journey, { headers: { ETag: journey.etag } });
    } catch (reason) {
      if (reason instanceof Error && reason.message.startsWith('unknown ')) throw new HttpError(404, reason.message);
      throw reason;
    }
  } catch (reason) {
    return errorResponse(reason, 'journey is unavailable');
  }
}
