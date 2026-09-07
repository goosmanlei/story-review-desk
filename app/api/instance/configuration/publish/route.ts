import { publishConfiguration } from "../../../../../host/instance-runtime/configuration-service.mjs";
import {
  instanceRepository,
  jsonResponse,
  HttpError,
  validateMutationRequest,
  operationalSnapshot,
} from "../../../v8/_store";
import { configurationError } from "../route";
export async function POST(request: Request) {
  try {
    const { idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = (await request.json()) as {
      draftRevisionId: string;
      previewHash: string;
    };
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.draftRevisionId !== "string" ||
      typeof body.previewHash !== "string"
    )
      throw new HttpError(422, "发布请求无效");
    if (
      Object.keys(body).some(
        (k) => !["draftRevisionId", "previewHash"].includes(k),
      )
    )
      throw new HttpError(422, "发布含未支持字段");
    const repo = await instanceRepository();
    if (!repo) throw new HttpError(503, "需要独立实例");
    return await repo.writeTransaction(async (tx) => {
      const replay = (await tx.getAux("configuration-requests", idempotencyKey));
      const draft = (await tx.getAux(
        "configuration-drafts",
        "current",
        replay ? { revisionId: body.draftRevisionId } : {},
      ));
      if (!draft || body.draftRevisionId !== draft.revisionId)
        throw new HttpError(409, "草稿已变化");
      const input = JSON.parse(draft.bytes.toString());
      if (
        !(await tx.getAux("configuration-requests", idempotencyKey)) &&
        (await operationalSnapshot()).mutationEtag.replace(/^"|"$/g, "") !==
          ifMatch
      )
        throw new HttpError(409, "数据已变化，请刷新并重新预览");
      return jsonResponse(
        (await publishConfiguration(tx, {
          configuration: input.configuration,
          expectedReleaseId: input.expectedReleaseId,
          expectedConfigurationRevisionId:
            input.expectedConfigurationRevisionId,
          upgradeKeys: input.upgradeKeys,
          previewHash: body.previewHash,
          requestId: idempotencyKey,
        })),
      );
    });
  } catch (e) {
    return configurationError(e);
  }
}
