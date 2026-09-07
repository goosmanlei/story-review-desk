import { jsonResponse, reviewData } from '../_store';

export async function GET() {
  const data = await reviewData();
  const model = data.productionModel as typeof data.productionModel & { counts?: Record<string, unknown>; executionRecipeSummary?: Record<string, unknown>; snapshotManifest?: Record<string, unknown> };
  return jsonResponse({
    instance: data.instance,
    schemaVersion: data.schemaVersion,
    snapshotId: data.snapshotId,
    counts: model.counts,
    executionRecipes: model.executionRecipeSummary,
    integrity: model.snapshotManifest,
  }, { headers: { ETag: `"${data.snapshotId}"` } });
}
