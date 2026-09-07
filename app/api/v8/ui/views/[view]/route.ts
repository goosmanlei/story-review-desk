import { errorResponse, HttpError, jsonResponse, reviewData } from '../../../_store';
import { compactProductionModel } from '../../_projection';

const productionViews = new Set(['pipeline', 'assets', 'materials', 'targets', 'work', 'system', 'production']);

export async function GET(_request: Request, { params }: { params: Promise<{ view: string }> }) {
  try {
    const { view } = await params;
    if (!productionViews.has(view)) throw new HttpError(404, 'view data is not available');
    const data = await reviewData() as unknown as { schemaVersion: string; snapshotId: string; productionModel: Record<string, unknown> };
    return jsonResponse({ schemaVersion: data.schemaVersion, snapshotId: data.snapshotId, view, data: compactProductionModel(data.productionModel) });
  } catch (reason) {
    return errorResponse(reason, 'review UI view data failed');
  }
}
