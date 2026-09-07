import { audioVerificationTargets, errorResponse, jsonResponse, reviewData, sceneReviewDossierTargets, storyConfirmationTargets } from '../../_store';

export async function GET() {
  try {
    const data = await reviewData() as unknown as {
      schemaVersion: string;
      snapshotId: string;
      adaptationAudit?: unknown;
      creativeLineage?: { scenes?: Array<Record<string, unknown>> };
    };
    if (!data.adaptationAudit) throw new Error('adaptation audit is not present in the current base snapshot');
    return jsonResponse({
      schemaVersion: data.schemaVersion,
      snapshotId: data.snapshotId,
      adaptationAudit: data.adaptationAudit,
      scenes: data.creativeLineage?.scenes || [],
      sceneReviewDossiers: sceneReviewDossierTargets(data as never),
      storyConfirmations: storyConfirmationTargets(data as never),
      audioVerifications: audioVerificationTargets(data as never),
    });
  } catch (reason) {
    return errorResponse(reason, 'adaptation audit failed to load');
  }
}
