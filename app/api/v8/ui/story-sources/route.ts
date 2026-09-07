import { errorResponse, jsonResponse, reviewData } from '../../_store';

export async function GET() {
  try {
    const data = await reviewData();
    return jsonResponse({
      schemaVersion: '1.0',
      snapshotId: data.snapshotId,
      storySources: data.storySources || null,
    });
  } catch (reason) {
    return errorResponse(reason, 'story sources failed to load');
  }
}
