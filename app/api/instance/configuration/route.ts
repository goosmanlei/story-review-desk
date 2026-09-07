import { reviewCatalog } from "../../../../host/instance-runtime/review-standard-catalog.mjs";
import { committedGet } from '../_committed-get';
import {
  getConfiguration,
  getConfigurationRevision,
  exportConfigurationTemplate,
  type ConfigurationState,
} from "../../../../host/instance-runtime/configuration-service.mjs";
import { validateConfiguration, configurationObjects, profileFor, configHash, defaultConfiguration } from "../../../../host/instance-runtime/configuration-model.mjs";
import {
  errorResponse,
  hostedReadOnlyMode,
  instanceReadOnlyMode,
  HttpError,
  instanceRepository,
  jsonResponse,
  reviewData,
  validateMutationRequest,
  stableObjectHash,
  operationalSnapshot,
} from "../../v8/_store";

export async function GET(request: Request) {
  try {
    if (hostedReadOnlyMode()) {
      const data = await reviewData();
      const value = data.productionModel.systemConfiguration;
      if (!value) throw new HttpError(503, "此镜像尚无系统配置");
      return jsonResponse({
        configuration: value.config,
        defaults: defaultConfiguration(),
        revisionId: value.reference.revisionId,
        sha256: value.reference.sha256,
        releaseId: "HOSTED_READ_ONLY",
        reviewCatalog: reviewCatalog(value.config),
        boundStandards: [...new Map(configurationObjects(data).flatMap(({object})=>object.configurationBinding ? [[object.configurationBinding.reviewSpec.hash,object.configurationBinding.reviewSpec]] : [])).values()],
        bindings: configurationObjects(data).flatMap(({key,kind,object})=>object.configurationBinding ? [{key,kind,title:object.title || object.sceneTitle || object.sceneId || key,profileId:object.configurationBinding.reviewSpec.profileId,defaultProfileId:profileFor(value.config,kind,object),reviewSpecHash:object.configurationBinding.reviewSpec.hash,configurationHash:object.configurationBinding.configurationHash}] : []),
        history: [],
        initialized: true,
        readOnly: true,
      });
    }
    const repo = await instanceRepository();
    if (!repo) throw new HttpError(503, "需要独立实例");
    const url = new URL(request.url);
    const queryKey = JSON.stringify(['configuration-read-2', instanceReadOnlyMode(), url.searchParams.get('history') || null, url.searchParams.get('export') === '1']);
    return await committedGet(repo, queryKey, async (tx) => {
      const state = (await getConfiguration(tx));
      const draft = (await tx.getAux("configuration-drafts", "current"));
      if (url.searchParams.get("history")) {
        const found = state.history.find(
          (r) => r.revisionId === url.searchParams.get("history"),
        );
        if (!found) throw new HttpError(404, "配置版本不存在");
        const historical = (await getConfigurationRevision(tx, found.revisionId));
        const frozen = (historical as typeof historical & {bindings?:Record<string,import("../../../../host/instance-runtime/configuration-model.mjs").ConfigurationBinding>}).bindings || {};
        return {
          ...state,
          ...historical,
          reviewCatalog: reviewCatalog(historical.configuration),
          boundStandards: [...new Map(Object.values(frozen).map(b=>[b.reviewSpec.hash,b.reviewSpec])).values()],
          bindings: Object.entries(frozen).map(([key,b])=>({key,kind:b.kind,title:state.bindings.find(x=>x.key===key)?.title || "历史对象",profileId:b.reviewSpec.profileId,defaultProfileId:b.reviewSpec.profileId,reviewSpecHash:b.reviewSpec.hash,configurationHash:b.configurationHash})),
          historical: true,
        };
      }
      if (url.searchParams.get("export") === "1")
        return exportConfigurationTemplate(state.configuration);
      const trial = (await tx.getAux("local-trial-index", "scopes"));
      const scopes = trial ? JSON.parse(trial.bytes.toString()) : [];
      const saved = draft ? JSON.parse(draft.bytes.toString()) : null;
      return {
        ...state,
        readOnly: instanceReadOnlyMode(),
        trialAvailable:
          Array.isArray(scopes) &&
          scopes.length > 0 &&
          (await Promise.all(scopes.map(async (id: unknown) =>
            typeof id === "string" && Boolean(await tx.getAux(`local-trial:${id}`, "meta/config"))
          ))).every(Boolean),
        draft: draft
          ? {
              revisionId: draft.revisionId,
              ...saved,
              published: saved.expectedReleaseId!==state.releaseId && configHash(saved.configuration)===configHash(state.configuration),
            }
          : null,
      };
    });
  } catch (e) {
    return configurationError(e);
  }
}
export async function PUT(request: Request) {
  try {
    const { ifMatch } = await validateMutationRequest(request);
    const body = (await request.json()) as {
      configuration: unknown;
      expectedDraftRevision: string | null;
      expectedReleaseId: string;
      expectedConfigurationRevisionId: string | null;
      upgradeKeys?: string[];
    };
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpError(422, "配置请求必须为对象");
    if (
      Object.keys(body).some(
        (k) =>
          ![
            "configuration",
            "expectedDraftRevision",
            "expectedReleaseId",
            "expectedConfigurationRevisionId",
            "upgradeKeys",
          ].includes(k),
      )
    )
      throw new HttpError(422, "草稿含未支持字段");
    if (
      (body.expectedDraftRevision !== null &&
        typeof body.expectedDraftRevision !== "string") ||
      (body.expectedConfigurationRevisionId !== null &&
        typeof body.expectedConfigurationRevisionId !== "string") ||
      typeof body.expectedReleaseId !== "string" ||
      (body.upgradeKeys !== undefined &&
        (!Array.isArray(body.upgradeKeys) ||
          body.upgradeKeys.some((k) => typeof k !== "string") ||
          new Set(body.upgradeKeys).size !== body.upgradeKeys.length))
    )
      throw new HttpError(422, "草稿版本或升级范围无效");
    if (!Object.hasOwn(body, "expectedDraftRevision"))
      throw new HttpError(422, "缺少草稿版本");
    const repo = await instanceRepository();
    if (!repo) throw new HttpError(503, "需要独立实例");
    return await repo.writeTransaction(async (tx) => {
      const state = (await getConfiguration(tx));
      if (
        state.releaseId !== body.expectedReleaseId ||
        state.revisionId !== body.expectedConfigurationRevisionId ||
        (await operationalSnapshot()).mutationEtag.replace(/^"|"$/g, "") !==
          ifMatch
      )
        throw new HttpError(409, "实例已变化，请刷新后保存");
      const configuration = validateConfiguration(
        body.configuration,
        state.configuration,
      );
      const value = {
        configuration,
        expectedReleaseId: state.releaseId,
        expectedConfigurationRevisionId: state.revisionId,
        upgradeKeys: body.upgradeKeys || [],
        requestHash: stableObjectHash(body),
      };
      const record = (await tx.putAux({
        namespace: "configuration-drafts",
        key: "current",
        bytes: Buffer.from(JSON.stringify(value)),
        expectedRevisionId: body.expectedDraftRevision,
        mediaType: "application/json",
      }));
      return jsonResponse({ revisionId: record.revisionId });
    });
  } catch (e) {
    return configurationError(e);
  }
}
export function configurationError(error: unknown) {
  if (
    error instanceof Error &&
    "code" in error &&
    ["HEAD_CONFLICT", "RELEASE_CONFLICT"].includes(String(error.code))
  )
    return jsonResponse(
      { error: "配置版本已变化，请刷新后重试" },
      { status: 409 },
    );
  if (
    error instanceof Error &&
    "code" in error &&
    String(error.code).startsWith("CONFIGURATION_")
  )
    return jsonResponse(
      { error: error.message },
      { status: error.code === "CONFIGURATION_INVALID" ? 422 : 409 },
    );
  return errorResponse(error, "系统配置操作失败");
}
export type { ConfigurationState };
