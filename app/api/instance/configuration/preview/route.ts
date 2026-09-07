import { previewConfiguration } from "../../../../../host/instance-runtime/configuration-service.mjs";
import {
  instanceRepository,
  jsonResponse,
  HttpError,
  validateMutationRequest,
} from "../../../v8/_store";
import { configurationError } from "../route";
export async function POST(request: Request) {
  try {
    await validateMutationRequest(request);
    const body = (await request.json()) as {
      draftRevisionId: string;
      previewHash: string;
    };
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.draftRevisionId !== "string" ||
      Object.keys(body).some((k) => k !== "draftRevisionId")
    )
      throw new HttpError(422, "预览请求无效");
    const repo = await instanceRepository();
    if (!repo) throw new HttpError(503, "需要独立实例");
    return await repo.readTransaction(async (tx) => {
      const draft = (await tx.getAux("configuration-drafts", "current"));
      if (!draft || body.draftRevisionId !== draft.revisionId)
        throw new HttpError(409, "草稿已变化，请重新保存");
      const input = JSON.parse(draft.bytes.toString());
      const preview = (await previewConfiguration(tx, input));
      return jsonResponse({
        previewHash: preview.previewHash,
        semanticChange: preview.semanticChange,
        changedGroups: preview.changedGroups,
        affectedObjects: preview.affectedObjects,
        retainedObjectCount: preview.retainedObjects.length,
        checks: preview.checks,
      });
    });
  } catch (e) {
    return configurationError(e);
  }
}
