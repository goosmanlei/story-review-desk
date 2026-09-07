import { reviewCatalog, standardLabel } from "./review-standard-catalog.mjs";
import {
  CONFIG_ID,
  clone,
  configHash,
  profileFor,
  defaultConfiguration,
  validateConfiguration,
  semanticConfiguration,
  configurationObjects,
  bindConfiguration,
  projectConfiguration,
  exportConfigurationTemplate,
} from "./configuration-model.mjs";
import { sha256 } from "./bytes.mjs";
async function configurationView(tx) {
  const view = (await tx.readView());
  const m = view.snapshot.productionModel;
  const existing = m.configurationCandidates || [];
  m.configurationCandidates = [...existing];
  for (const event of view.eventsByKind["creative-revision"] || []) {
    if (
      event.subjectKind !== "EPISODE_PLAN" ||
      m.configurationCandidates.some((r) => r.id === event.creativeRevisionId)
    )
      continue;
    m.configurationCandidates.push({
      id: event.creativeRevisionId,
      creativeRevisionId: event.creativeRevisionId,
      planId: event.subjectId,
      criteriaVersion: event.criteriaVersion || "1.0",
      reviewSpec: event.reviewSpec,
      configurationBinding: event.configurationBinding,
    });
  }
  return view;
}
const assert = (condition, message) => {
  if (!condition)
    throw Object.assign(new Error(message), { code: "CONFIGURATION_CONFLICT" });
};
export async function configurationRecord(tx, view) {
  view ||= await configurationView(tx);
  const ref = view.profile.configurationRef;
  if (!ref) return null;
  const record = (await tx.getRecord("settings", CONFIG_ID, ref.revisionId));
  assert(
    record &&
      !record.deleted &&
      record.sha256 === ref.sha256 &&
      sha256(record.bytes) === ref.sha256,
    "已发布配置版本或哈希不一致",
  );
  const value = JSON.parse(record.bytes);
  for (const { key, object } of configurationObjects(view.snapshot))
    if (object.configurationBinding)
      value.bindings[key] = object.configurationBinding;
  return { ...record, value };
}
export function migrateConfiguration(snapshot, profile, overrides = {}) {
  const config = defaultConfiguration(profile);
  const model = snapshot.productionModel || {};
  for (const [definitions,rows] of [[config.workflow.phases,model.productionPhases || []],[config.workflow.gates,model.productionGates || []]]) {
    for (const definition of definitions) { const previous=rows.find(row=>row.id===definition.id);if(previous) { if(previous.label)definition.label=previous.label;if(previous.purpose)definition.purpose=previous.purpose; } }
  }
  const requirements = (model.materialRequirements || []).filter(
    (r) => r.requirementClass === "REQUIRED",
  );
  for (const req of requirements) {
    assert(
      ["IMAGE", "AUDIO", "VIDEO", "TEXT"].includes(req.mediaType),
      "旧素材媒介不明，须先补齐权威分类",
    );
    const primary = req.businessCategoryPrimary || "待分类";
    const secondary = req.businessCategorySecondary || req.category || "待分类";
    let cat = config.taxonomy.categories.find((c) => c.label === primary);
    if (!cat) {
      cat = {
        id: `category-${configHash(primary).slice(0, 12)}`,
        label: primary,
        aliases: [primary],
        icon: "◇",
        tone: "neutral",
        types: [],
      };
      config.taxonomy.categories.push(cat);
    }
    let type = cat.types.find((t) => t.label === secondary);
    if (!type) {
      type = {
        id: `type-${configHash([primary, secondary]).slice(0, 12)}`,
        label: secondary,
        aliases: [secondary],
        mediaType: ["IMAGE", "AUDIO", "VIDEO", "TEXT"].includes(req.mediaType)
          ? req.mediaType
          : "TEXT",
        reviewProfileId: `material-${["IMAGE", "AUDIO", "VIDEO", "TEXT"].includes(req.mediaType) ? req.mediaType.toLowerCase() : "text"}`,
        productionLane: "MANUAL_OR_ASSISTED",
      };
      cat.types.push(type);
    }
    if (req.acceptanceCriteria?.length) {
      const id = `material-legacy-${configHash(req.acceptanceCriteria).slice(0, 12)}`;
      if (!config.reviewProfiles.some((p) => p.id === id))
        config.reviewProfiles.push({
          id,
          label: req.acceptanceProfile || `${cat.label} · ${type.label}`,
          subjectKind: "ASSET",
          criteria: req.acceptanceCriteria.map((label, i) => ({
            id: `material-${String(i + 1).padStart(2, "0")}`,
            label,
            question: label,
            required: true,
            allowNA: true,
            noteRequiredOnFail: false,
          })),
        });
    }
  }
  for (const rule of profile.capabilities?.materialDefinitionPrerequisites ||
    []) {
    const requirementIds = (model.materialWorkItems || [])
      .filter(
        (w) =>
          rule.sourceRefContains &&
          String(w.sourceRef || "").includes(rule.sourceRefContains),
      )
      .map((w) => w.requirementRef)
      .filter((id) => requirements.some((r) => r.id === id));
    if (requirementIds.length)
      config.workflow.materialPrerequisites.push({
        id: `prerequisite-${configHash(rule).slice(0, 12)}`,
        label: "素材制作前先确认关联场正文",
        requirementIds: [...new Set(requirementIds)],
        requiredSceneIds: rule.requiredSceneIds,
      });
  }
  if (snapshot.storySources?.evidenceOrder?.length)
    config.sources.order = snapshot.storySources.evidenceOrder.map(
      (label, i) => ({
        id: ["primary", "derived", "auxiliary"][i] || `source-${i + 1}`,
        label,
        role: ["PRIMARY", "DERIVED", "AUXILIARY"][i] || "AUXILIARY",
      }),
    );
  for (const key of Object.keys(overrides)) {
    assert(
      ["reviewProfiles", "technical", "sources", "presentation"].includes(key),
      "迁移只接受明确配置覆盖",
    );
    config[key] = clone(overrides[key]);
  }
  validateConfiguration(config);
  return config;
}
export async function getConfiguration(tx) {
  const view = (await configurationView(tx)),
    record = (await configurationRecord(tx, view));
  const configuration =
    record?.value.configuration ||
    migrateConfiguration(view.snapshot, view.profile);
  const bindings =
    record?.value.bindings ||
    bindConfiguration(view.snapshot, configuration, {}, [], true);
  const history = (await tx.listRecordRevisions('settings', CONFIG_ID)).map(r => ({
    revisionId: r.revisionId, sha256: r.sha256, createdAt: r.createdAt, number: r.revision,
  }));
  return {
    releaseId: view.releaseId,
    revisionId: record?.revisionId || null,
    sha256: record?.sha256 || null,
    configuration,
    defaults: defaultConfiguration(),
    reviewCatalog: reviewCatalog(configuration),
    boundStandards: [...new Map(Object.values(bindings).map(b=>[b.reviewSpec.hash,b.reviewSpec])).values()],
    bindings: Object.entries(bindings).map(([key, b]) => ({
      key,
      title:(()=>{const object=configurationObjects(view.snapshot).find(o=>o.key===key)?.object;return object?.title || object?.label || object?.sceneTitle || object?.sceneId || key.split(":").slice(1).join(":");})(),
      profileLabel:standardLabel(configuration.reviewProfiles.find(p=>p.id===b.reviewSpec.profileId)),
      defaultProfileId: (()=>{const entry=configurationObjects(view.snapshot).find(o=>o.key===key);return entry ? profileFor(configuration,entry.kind,entry.object) : null;})(),
      kind: b.kind,
      profileId: b.reviewSpec.profileId,
      reviewSpecHash: b.reviewSpec.hash,
      configurationHash: b.configurationHash,
    })),
    history,
    initialized: Boolean(record),
  };
}
function assertUpgrades(view, keys, bindings) {
  const objects = configurationObjects(view.snapshot);
  for (const key of keys) {
    assert(
      objects.some((o) => o.key === key) && bindings[key],
      "升级对象不在当前范围",
    );
    const target = key.slice(key.indexOf(":") + 1);
    const work = (view.snapshot.productionModel.workItems || []).find(
      (w) => w.id === target,
    );
    const req = (view.snapshot.productionModel.materialRequirements || []).find(
      (r) => r.id === target,
    );
    const candidate = [
      ...(view.snapshot.productionModel.episodePlanRevisions || []),
      ...(view.snapshot.productionModel.configurationCandidates || []),
    ].find((r) => r.id === target || r.creativeRevisionId === target);
    const related = new Set(
      [
        target,
        ...(candidate ? [candidate.planId, candidate.creativeRevisionId] : []),
        ...(req?.assetFamilyRefs || []),
        ...(work ? [work.outputAssetRef] : []),
      ].filter((id) => typeof id === "string" && id),
    );
    for (const events of Object.values(view.eventsByKind || {}))
      for (const e of events) {
        if (
          ![
            e.subjectId,
            e.workItemId,
            e.familyId,
            e.scopeId,
            e.subjectRevisionId,
            e.creativeRevisionId,
          ].some((id) => related.has(id))
        )
          continue;
        if (
          (key.startsWith("candidate:") && e.eventKind === "review") ||
          e.eventKind === "run" ||
          e.eventKind === "source-operation" ||
          e.action === "APPROVE_AND_RELEASE" ||
          (e.eventKind === "execution-request" &&
            ["AUTHORIZED", "CLAIMED"].includes(e.requestState || e.state))
        )
          assert(
            false,
            "该对象已有放行、执行或源同步记录，须通过新的业务修订变更标准",
          );
      }
  }
}
export async function previewConfiguration(
  tx,
  {
    configuration,
    expectedReleaseId,
    expectedConfigurationRevisionId,
    upgradeKeys = [],
  },
) {
  const view = (await configurationView(tx));
  assert(view.releaseId === expectedReleaseId, "当前发布已变化，请重新预览");
  const record = (await configurationRecord(tx, view));
  assert(
    (record?.revisionId || null) === expectedConfigurationRevisionId,
    "配置已变化，请重新读取",
  );
  const previous =
    record?.value.configuration ||
    migrateConfiguration(view.snapshot, view.profile);
  const config = validateConfiguration(configuration, previous);
  assert(
    Array.isArray(upgradeKeys) &&
      new Set(upgradeKeys).size === upgradeKeys.length &&
      upgradeKeys.every((k) => typeof k === "string"),
    "升级范围无效",
  );
  for (const requirement of view.snapshot.productionModel
    .materialRequirements || []) {
    if (requirement.requirementClass !== "REQUIRED") continue;
    const old = previous.taxonomy.categories.find(
      (c) =>
        c.id === requirement.businessCategoryPrimaryId ||
        c.label === requirement.businessCategoryPrimary,
    );
    const next = config.taxonomy.categories.find((c) => c.id === old?.id);
    assert(next, "使用中的一级分类不能删除");
    const priorType = old.types.find(
      (t) =>
        t.id === requirement.businessCategorySecondaryId ||
        t.label === requirement.businessCategorySecondary,
    );
    assert(
      !priorType || next.types.some((t) => t.id === priorType.id),
      "使用中的素材类型不能删除或跨分类移动",
    );
    const nextType = next.types.find((t) => t.id === priorType?.id);
    assert(
      !priorType || !nextType || priorType.mediaType === nextType.mediaType,
      "已使用素材类型不能改变媒介；请建立新类型",
    );
  }
  const baseBindings =
    record?.value.bindings ||
    bindConfiguration(view.snapshot, config, {}, [], true);
  assertUpgrades(view, upgradeKeys, baseBindings);
  for (const rule of config.workflow.materialPrerequisites || []) {
    assert(
      rule.requirementIds.every((id) =>
        (view.snapshot.productionModel.materialRequirements || []).some(
          (r) => r.id === id && r.requirementClass === "REQUIRED",
        ),
      ) &&
        rule.requiredSceneIds.every((id) =>
          (view.snapshot.productionModel.scenes || []).some((s) => s.id === id),
        ),
      "素材前置规则必须引用当前需求与场次",
    );
  }
  if (config.sources.continuity.specAlias) {
    const document = (await tx.readDocument(config.sources.continuity.specAlias));
    assert(
      document && view.sourceRevisionIds.includes(document.revisionId),
      "连续性规范必须来自当前已发布实例资料",
    );
  }
  const semanticChange =
    configHash(semanticConfiguration(config)) !==
    configHash(semanticConfiguration(previous));
  const changedGroups = Object.keys(config).filter(
    (k) => !Object.hasOwn(previous, k) || configHash(config[k]) !== configHash(previous[k]),
  );
  const bindings = bindConfiguration(
    view.snapshot,
    config,
    baseBindings,
    upgradeKeys,
  );
  const body = {
    baseReleaseId: view.releaseId,
    baseRevisionId: record?.revisionId || null,
    baseEventsHash: configHash(view.eventsByKind),
    configuration: config,
    bindings,
    upgradeKeys,
    semanticChange,
    changedGroups,
  };
  return {
    ...body,
    previewHash: configHash(body),
    affectedObjects: upgradeKeys,
    retainedObjects: Object.keys(bindings).filter(
      (k) => !upgradeKeys.includes(k),
    ),
    newObjectDefaults: semanticChange,
    checks: [
      "配置结构有效",
      "稳定身份与历史别名完整",
      "流程骨架与依赖有效",
      "历史对象绑定保留",
      "来源引用可解析",
    ],
  };
}
export async function publishConfiguration(tx, input) {
  const prior = (await tx.getAux("configuration-requests", input.requestId));
  const requestHash = configHash(input);
  if (prior) {
    const saved = JSON.parse(prior.bytes);
    assert(saved.requestHash === requestHash, "请求编号已用于另一项配置");
    return saved.result;
  }
  const staged = await stageConfiguration(tx, input);
  const { snapshot, recipes, sourceRevisionIds, result: stagedResult, baseReleaseId } = staged;
  const release = await tx.publishRelease({snapshot, recipes, expectedReleaseId:baseReleaseId,sourceRevisionIds});
  const result = {...stagedResult,releaseId:release.releaseId};
  await tx.putAux({namespace:'configuration-requests',key:input.requestId,bytes:Buffer.from(JSON.stringify({requestHash,result})),expectedRevisionId:null,mediaType:'application/json'});
  return result;
}

/** Stage configuration and profile within the caller's atomic publication transaction. */
export async function stageConfiguration(tx, input) {
  const preview = (await previewConfiguration(tx, input));
  assert(
    preview.previewHash === input.previewHash,
    "影响预览已变化，请重新预览",
  );
  const view = (await configurationView(tx));
  const currentProfile = (await tx.getConfig("instance-profile"));
  assert(
    currentProfile?.revisionId === (await tx.readRelease()).profileRevisionId,
    "存在未发布的实例设置",
  );
  const current = (await tx.getConfig(CONFIG_ID));
  assert(
    (current?.revisionId || null) === input.expectedConfigurationRevisionId,
    "存在未发布配置",
  );
  const value = {
    schemaVersion: "1.0",
    configuration: preview.configuration,
    bindings: preview.bindings,
  };
  const record = (await tx.putConfig({
    configId: CONFIG_ID,
    value,
    expectedRevisionId: current?.revisionId || null,
  }));
  const reference = { revisionId: record.revisionId, sha256: record.sha256 };
  const snapshot = projectConfiguration(
    view.snapshot,
    preview.configuration,
    preview.bindings,
    reference,
  );
  const profile = {
    ...view.profile,
    ...snapshot.instance,
    configurationRef: reference,
  };
  (await tx.putConfig({
    configId: "instance-profile",
    value: profile,
    expectedRevisionId: currentProfile.revisionId,
  }));
  return {
    snapshot, recipes:{...view.recipes,configurationRef:reference},sourceRevisionIds:view.sourceRevisionIds,
    reference, profile, baseReleaseId:view.releaseId,
    result:{revisionId:record.revisionId,sha256:record.sha256,upgradedObjects:preview.upgradeKeys,changedGroups:preview.changedGroups},
  };
}
export async function initializeConfiguration(tx, overrides = {}) {
  const view = (await configurationView(tx));
  if (view.profile.configurationRef) return (await getConfiguration(tx));
  const configuration = migrateConfiguration(
    view.snapshot,
    view.profile,
    overrides,
  );
  const input = {
    configuration,
    expectedReleaseId: view.releaseId,
    expectedConfigurationRevisionId: null,
    upgradeKeys: [],
  };
  const preview = (await previewConfiguration(tx, input));
  return (await publishConfiguration(tx, {
    ...input,
    previewHash: preview.previewHash,
    requestId: `initialize:${view.releaseId}`,
  }));
}
export function preserveConfigurationProjection({
  snapshot,
  recipes,
  baseSnapshot,
  profile,
  events = [],
}) {
  const current = baseSnapshot.productionModel?.systemConfiguration;
  if (!profile.configurationRef) return { snapshot, recipes };
  assert(
    current?.reference?.revisionId === profile.configurationRef.revisionId,
    "编译缺少精确配置投影",
  );
  const bindings = {};
  for (const { key, object } of configurationObjects(baseSnapshot))
    if (object.configurationBinding)
      bindings[key] = object.configurationBinding;
    else if (object.reviewSpec)
      bindings[key] = {
        key,
        kind: key.startsWith("scene:") ? "SCRIPT_SCENE" : "EPISODE_PLAN",
        reviewSpec: object.reviewSpec,
        technical: current.config.technical,
        workflow: current.config.workflow,
        sources: current.config.sources,
        configurationHash: configHash(current.config),
      };
  snapshot = clone(snapshot);
  snapshot.productionModel.configurationCandidates = clone(
    baseSnapshot.productionModel.configurationCandidates || [],
  );
  for (const candidate of events.filter(
    (e) =>
      e.eventKind === "creative-revision" && e.subjectKind === "EPISODE_PLAN",
  )) {
    const id = candidate.creativeRevisionId;
    let existing = snapshot.productionModel.configurationCandidates.find(
      (r) => r.id === id,
    );
    if (!existing) {
      existing = {
        id,
        creativeRevisionId: id,
        planId: candidate.subjectId,
        criteriaVersion: candidate.criteriaVersion || "1.0",
        reviewSpec: candidate.reviewSpec,
        configurationBinding: candidate.configurationBinding,
      };
      snapshot.productionModel.configurationCandidates.push(existing);
    }
    const adopted = (
      snapshot.productionModel.episodePlanRevisions || []
    ).filter((r) => r.creativeRevisionId === id && r.scopeRole === "CURRENT");
    if (!adopted.length) continue;
    assert(adopted.length === 1, "采用候选匹配到多份当前分集修订");
    const binding =
      bindings[`candidate:${id}`] ||
      existing.configurationBinding ||
      candidate.configurationBinding;
    const standard = binding?.reviewSpec || candidate.reviewSpec;
    const approval = events.find(
      (e) =>
        e.eventKind === "review" &&
        e.action === "APPROVE_AND_RELEASE" &&
        (e.subjectRevisionId === id || e.creativeRevisionId === id),
    );
    assert(
      standard &&
        approval &&
        (approval.reviewSpecHash === standard.hash ||
          (!approval.reviewSpecHash && standard.legacy)),
      "采用候选与批准的审阅标准不一致",
    );
    const key = `candidate:${adopted[0].id}`;
    bindings[key] = binding
      ? { ...clone(binding), key }
      : {
          key,
          kind: "EPISODE_PLAN",
          reviewSpec: clone(standard),
          configurationHash: standard.configurationHash,
          technical: clone(current.config.technical),
          workflow: clone(current.config.workflow),
          sources: clone(current.config.sources),
        };
  }
  const next = bindConfiguration(snapshot, current.config, bindings);
  return {
    snapshot: projectConfiguration(
      snapshot,
      current.config,
      next,
      current.reference,
    ),
    recipes: { ...recipes, configurationRef: current.reference },
  };
}
export { exportConfigurationTemplate };

export async function getConfigurationRevision(tx, revisionId) {
  const record = (await tx.getRecord("settings", CONFIG_ID, revisionId));
  assert(
    record && !record.deleted && sha256(record.bytes) === record.sha256,
    "配置历史不可用",
  );
  return {
    revisionId: record.revisionId,
    sha256: record.sha256,
    ...JSON.parse(record.bytes),
  };
}
