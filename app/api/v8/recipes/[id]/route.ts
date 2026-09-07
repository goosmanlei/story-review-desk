import { errorResponse, jsonResponse, recipeCatalog } from '../../_store';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const data = await recipeCatalog();
    const recipe = data.executionDefinitions.find((item) => item.id === id);
    if (!recipe) return jsonResponse({ error: 'execution recipe not found' }, { status: 404 });
    return jsonResponse({
      snapshotId: data.snapshotId,
      recipe,
      revisions: data.promptRevisions.filter((item) => item.executionDefinitionId === id),
    }, { headers: { ETag: `"${data.snapshotId}"` } });
  } catch (reason) {
    return errorResponse(reason, 'execution recipe is unavailable');
  }
}
