import {executionRuntimeReason,type ExecutionRuntime} from '../host/instance-runtime/execution-epoch.mjs';
import {domainReferenceEligibility} from '../host/instance-runtime/domain-reference.mjs';
import {shotProductionEntryGates} from '../host/instance-runtime/shot-production-model.mjs';
import type { Configuration } from "../host/instance-runtime/configuration-model.mjs";
type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const record = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
export type ConfiguredGate = {
  workItemId: string;
  gateId: string | null;
  configurationHash: string | null;
  entryReasons: string[];
  exitReasons: string[];
  missingOutputTypes: string[];
};
export function configuredGates(
  model: Row,
  projection: EligibilitySnapshot["stateProjection"],
): Record<string, ConfiguredGate> {
  const work = rows(model.workItems).filter(
      (w) => w.activeInCurrentProduction === true,
    ),
    materials = rows(model.materialWorkItems),
    requirements = rows(model.materialRequirements);
  const bindings = (w: Row) =>
    record(
      w.configurationBinding ||
        requirements.find((r) => r.id === w.requirementRef)
          ?.configurationBinding,
    );
  const scope = (w: Row, type: string) =>
    String(
      type === "SCENE"
        ? w.sceneId || (w.scopeType === "SCENE" ? w.scopeId : "")
        : type === "SHOT"
          ? w.shotId || (w.scopeType === "SHOT" ? w.scopeId : "")
          : type === "EPISODE"
            ? w.episodeUid ||
              w.canonicalScopeId ||
              (w.scopeType === "EPISODE" ? w.scopeId : "")
            : w.scopeType === "PROJECT"
              ? w.scopeId
              : record(model.instance).projectId || "",
    );
  const result: Record<string, ConfiguredGate> = {};
  const productionEntries=shotProductionEntryGates(model,projection);
  for (const w of [...work, ...materials]) {
    const b = bindings(w),
      flow = b.workflow as Configuration["workflow"] | undefined,
      g = flow?.gates.find((g) => g.id === w.gateId),
      entryReasons: string[] = [...(productionEntries[String(w.id)]||[])],
      exitReasons: string[] = [],
      missingOutputTypes: string[] = [];
    result[String(w.id)] = {
      workItemId: String(w.id),
      gateId: g?.id || null,
      configurationHash:
        typeof b.configurationHash === "string" ? b.configurationHash : null,
      entryReasons,
      exitReasons,
      missingOutputTypes,
    };
    const requirement = requirements.find((r) => r.id === w.requirementRef);
    if (requirement && flow) {
      const requiredScenes = (flow.materialPrerequisites || [])
        .filter((rule) => rule.requirementIds.includes(String(requirement.id)))
        .flatMap((rule) => rule.requiredSceneIds);
      if (
        requiredScenes.some(
          (id) =>
            projection.scriptScenesById?.[id]?.reviewDecision !== "RELEASED"
            && projection.storyHandoff?.sceneReleaseById?.[id]?.canCreateSceneCoverage !== true,
        )
      )
        entryReasons.push("SCRIPT_SCENE_CONFIRMATION_REQUIRED");
      if (
        flow.earlyAmbience === false &&
        (requirement.businessCategorySecondaryId === "ambience-bed" ||
          requirement.businessCategorySecondary === "环境底声")
      ) {
        const scenes = ids(requirement.sceneIds);
        if (
          !scenes.length ||
          scenes.some(
            (id) =>
              !work.some(
                (p) =>
                  p.gateId === "PICTURE_LOCK" &&
                  scope(p, "SCENE") === id &&
                  projection.workItemsById[String(p.id)]?.canFlowDownstream ===
                    true,
              ),
          )
        )
          entryReasons.push("AMBIENCE_REQUIRES_PICTURE_LOCK");
      }
    }
    if (!g) continue;
    const scopeId = scope(w, g.scopeType);
    if (!scopeId) {
      entryReasons.push("CONFIGURED_SCOPE_UNKNOWN");
      continue;
    }
    const members = work.filter(
      (other) => other.gateId === g.id && scope(other, g.scopeType) === scopeId,
    );
    for (const type of g.additionalOutputTypes) {
      const outputs = members.filter((other) => other.deliverableKey === type);
      if (outputs.length !== 1) {
        missingOutputTypes.push(type);
        exitReasons.push(
          outputs.length
            ? "CONFIGURED_OUTPUT_BINDING_AMBIGUOUS"
            : "CONFIGURED_OUTPUT_DEFINITION_MISSING",
        );
        continue;
      }
      const output = outputs[0],
        family = projection.assetFamiliesById[String(output.outputAssetRef)],
        version =
          projection.assetVersionsById[String(family?.currentVersionId)];
      if (!family?.currentVersionId || !version?.sha256)
        exitReasons.push("CONFIGURED_OUTPUT_NOT_PRODUCED");
      else if (
        family.canFlowDownstream !== true ||
        version.canFlowDownstream !== true ||
        projection.workItemsById[String(output.id)]?.canFlowDownstream !== true
      )
        exitReasons.push("CONFIGURED_OUTPUT_NOT_RELEASED");
    }
    const state =
      projection.workItemsById[String(w.id)] ||
      projection.materialWorkItemsById?.[String(w.id)];
    if (state?.canFlowDownstream !== true)
      exitReasons.push("GATE_OUTPUT_NOT_RELEASED");
  }
  const gateOf = (w: Row) =>
    (bindings(w).workflow as Configuration["workflow"] | undefined)?.gates.find(
      (g) => g.id === w.gateId,
    );
  const siblings = (a: Row, b: Row) => {
    const gate = gateOf(a);
    return Boolean(
      gate &&
        a.gateId === b.gateId &&
        scope(a, gate.scopeType) &&
        scope(a, gate.scopeType) === scope(b, gate.scopeType),
    );
  };
  const parentsOf = (w: Row) => {
    const g = gateOf(w);
    const relationIds = rows(w.upstreamWorkRelations).flatMap((r) =>
      ids(r.workItemRefs),
    );
    return work.filter(
      (p) =>
        (g?.extraPrerequisites.includes(String(p.gateId)) &&
          scope(p, g.scopeType) === scope(w, g.scopeType)) ||
        (!siblings(w, p) &&
          (ids(w.inputAssetRefs).includes(String(p.outputAssetRef)) ||
            relationIds.includes(String(p.id)))),
    );
  };
  const add = (list: string[], reason: string) => {
    if (list.includes(reason)) return false;
    list.push(reason);
    return true;
  };
  // Resolve the complete dependency closure without blocking sibling outputs that
  // must be produced inside this same gate and business scope.
  for (let i = 0; i <= work.length + materials.length; i++) {
    let changed = false;
    for (const w of work) {
      const r = result[String(w.id)],
        g = gateOf(w);
      if (!g) continue;
      for (const prerequisite of g.extraPrerequisites) {
        const targets = work.filter(
          (p) =>
            p.gateId === prerequisite &&
            scope(p, g.scopeType) === scope(w, g.scopeType),
        );
        if (!targets.length)
          changed =
            add(r.entryReasons, "CONFIGURED_PREREQUISITE_UNKNOWN") || changed;
      }
      if (
        parentsOf(w).some(
          (p) =>
            result[String(p.id)]?.exitReasons.length ||
            result[String(p.id)]?.entryReasons.length,
        )
      )
        changed =
          add(r.entryReasons, "UPSTREAM_GATE_OUTPUTS_INCOMPLETE") || changed;
      const reports = work.filter(
        (p) =>
          siblings(w, p) &&
          g.additionalOutputTypes.includes(String(p.deliverableKey)),
      );
      if (
        reports.some(
          (p) =>
            result[String(p.id)]?.entryReasons.length ||
            projection.workItemsById[String(p.id)]?.canFlowDownstream !== true,
        )
      )
        changed =
          add(r.exitReasons, "CONFIGURED_OUTPUT_NOT_RELEASED") || changed;
    }
    for (const w of materials) {
      const flow = bindings(w).workflow as
        | Configuration["workflow"]
        | undefined;
      const requirement = requirements.find((r) => r.id === w.requirementRef);
      if (
        flow?.earlyAmbience !== false ||
        !requirement ||
        !(
          requirement.businessCategorySecondaryId === "ambience-bed" ||
          requirement.businessCategorySecondary === "环境底声"
        )
      )
        continue;
      const sceneIds = ids(requirement.sceneIds);
      if (
        !sceneIds.length ||
        sceneIds.some((id) => {
          const locks = work.filter(
            (p) => p.gateId === "PICTURE_LOCK" && scope(p, "SCENE") === id,
          );
          return (
            !locks.length ||
            locks.some(
              (p) =>
                projection.workItemsById[String(p.id)]?.canFlowDownstream !==
                  true ||
                result[String(p.id)]?.entryReasons.length ||
                result[String(p.id)]?.exitReasons.length,
            )
          );
        })
      )
        changed =
          add(
            result[String(w.id)].entryReasons,
            "AMBIENCE_REQUIRES_PICTURE_LOCK",
          ) || changed;
    }
    if (!changed) break;
  }
  return result;
}
export function configuredProductionProgress(
  model: Row,
  projection: EligibilitySnapshot["stateProjection"],
) {
  const states = projection.configuredGatesByWorkItem || {};
  const work = rows(model.workItems).filter(
    (w) =>
      w.activeInCurrentProduction === true &&
      projection.workItemsById[String(w.id)]?.activeInCurrentProduction !==
        false,
  );
  const progress = (gateId: string, definition: Row) => {
    const groups = new Map<string, Row[]>();
    for (const w of work.filter((w) => w.gateId === gateId)) {
      const unit = String(
        definition.denominatorUnit || definition.scopeType || w.scopeType,
      );
      const id = String(
        unit === "SHOT"
          ? w.shotId || (w.scopeType === unit ? w.scopeId : "")
          : unit === "SCENE"
            ? w.sceneId || (w.scopeType === unit ? w.scopeId : "")
            : unit === "EPISODE"
              ? w.episodeUid ||
                w.canonicalScopeId ||
                (w.scopeType === unit ? w.scopeId : "")
              : w.scopeType === "PROJECT"
                ? w.scopeId
                : "",
      );
      if (id) groups.set(id, [...(groups.get(id) || []), w]);
    }
    const releasedObjectCount = [...groups.values()].filter((members) =>
      members.every(
        (w) =>
          projection.workItemsById[String(w.id)]?.canFlowDownstream === true &&
          !states[String(w.id)]?.entryReasons.length &&
          !states[String(w.id)]?.exitReasons.length,
      ),
    ).length;
    const known =
      definition.denominatorState === "KNOWN" &&
      typeof definition.denominator === "number";
    return {
      ...definition,
      releasedObjectCount,
      currentObjectCount: groups.size,
      completionState: !known
        ? "UNKNOWN"
        : Number(definition.denominator) > 0 &&
            releasedObjectCount === definition.denominator
          ? "COMPLETE"
          : groups.size
            ? "IN_PROGRESS"
            : "NOT_STARTED",
    };
  };
  const productionGates = rows(model.productionGates).map((g) =>
    progress(String(g.id), g),
  );
  const productionPhases = rows(model.productionPhases).map((p) =>
    progress(String(p.exitGateId || ""), p),
  );
  return { productionGates, productionPhases };
}

export type EligibilitySnapshot = {
  executionRuntime?:ExecutionRuntime|null;
  stateProjection: {
    domainReferenceRules?: Array<Record<string,unknown>>;
    scriptScenesById?: Record<string, Row | undefined>;
    storyHandoff?: {sceneReleaseById?:Record<string,Row|undefined>};
    configuredGatesByWorkItem?: Record<string, ConfiguredGate>;
    executionGatesByWorkItem?: Record<string, string[]>;
    workItemsById: Record<string, Record<string, unknown> | undefined>;
    materialWorkItemsById?: Record<string, Record<string, unknown> | undefined>;
    assetFamiliesById: Record<string, Record<string, unknown> | undefined>;
    assetVersionsById: Record<string, Record<string, unknown> | undefined>;
  };
  p07Released?: { allReleased?: boolean };
};

export function executionEligibilityReasons(
  snapshot: EligibilitySnapshot,
  definition: Record<string, unknown>,
  request: Record<string, unknown>,
) {
  const reasons: string[] = [];
  const runtimeReason=executionRuntimeReason(snapshot.executionRuntime,request);if(runtimeReason)reasons.push(runtimeReason);
  if (
    definition.definitionStatus !== "DEFINED" ||
    !/^[a-f0-9]{64}$/i.test(String(definition.definitionHash || ""))
  )
    reasons.push("EXECUTION_DEFINITION_NOT_READY");
  const workItemId = String(request.workItemId || "");
  const familyId = String(request.familyId || "");
  const projected =
    snapshot.stateProjection.workItemsById[workItemId] ||
    snapshot.stateProjection.materialWorkItemsById?.[workItemId];
  reasons.push(
    ...(snapshot.stateProjection.configuredGatesByWorkItem?.[workItemId]
      ?.entryReasons || []),
  );
  const lifecycleState = String(projected?.lifecycleState || "UNKNOWN");
  if (!["READY_TO_START", "REVISION_REQUIRED"].includes(lifecycleState)) {
    reasons.push(`WORK_ITEM_${lifecycleState}`);
  }
  const companionOutputs = Array.isArray(projected?.additionalOutputAssetRefs)
    ? projected.additionalOutputAssetRefs.map(String).filter(Boolean)
    : [];
  if (companionOutputs.length)
    reasons.push("COMPANION_OUTPUTS_REQUIRE_INDEPENDENT_LIFECYCLE");
  const output =
    definition.output &&
    typeof definition.output === "object" &&
    !Array.isArray(definition.output)
      ? (definition.output as Record<string, unknown>)
      : {};
  if (String(output.assetFamilyRef || "") !== familyId)
    reasons.push("OUTPUT_FAMILY_BINDING_STALE");

  const gate = String(definition.declaredGate || "UNKNOWN");
  if (
    ![
      "READY_TO_START",
      "DOCUMENT_DECLARED_GATE",
      "HOLD_P07_CALIBRATION",
      "BLOCKED_DO_NOT_CALL",
      "WAIT_P12",
      "WAITING_P07_APPROVAL",
      "WAITING_P14_AND_RELEASE_CONFIG",
    ].includes(gate)
  )
    reasons.push("DECLARED_GATE_UNKNOWN");
  if (
    gate === "BLOCKED_DO_NOT_CALL" ||
    gate === "WAIT_P12" ||
    gate === "WAITING_P14_AND_RELEASE_CONFIG"
  )
    reasons.push(`DECLARED_GATE_${gate}`);
  if (
    gate === "HOLD_P07_CALIBRATION" &&
    snapshot.p07Released?.allReleased !== true
  ) {
    reasons.push("DECLARED_GATE_HOLD_P07_CALIBRATION");
  }

  const bindings = Array.isArray(request.inputBindings)
    ? request.inputBindings
    : [];
  for (const [index, raw] of bindings.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      reasons.push(`INPUT_${index + 1}_INVALID`);
      continue;
    }
    const binding = raw as Record<string, unknown>;
    const inputFamilyId = String(binding.assetFamilyRef || "");
    const inputVersionId = String(binding.assetVersionRef || "");
    const inputSha256 = String(binding.sha256 || "").toLowerCase();
    const family = snapshot.stateProjection.assetFamiliesById[inputFamilyId];
    const version = snapshot.stateProjection.assetVersionsById[inputVersionId];
    if (!family || !version) {
      reasons.push(`INPUT_${index + 1}_MISSING_FROM_GRAPH`);
      continue;
    }
    if (family.currentVersionId !== inputVersionId)
      reasons.push(`INPUT_${index + 1}_NOT_CURRENT`);
    if (
      family.canFlowDownstream !== true ||
      version.canFlowDownstream !== true
    ) {
      reasons.push(`INPUT_${index + 1}_NOT_RELEASED`);
    }
    if (
      !/^[a-f0-9]{64}$/.test(inputSha256) ||
      String(version.sha256 || "").toLowerCase() !== inputSha256
    ) {
      reasons.push(`INPUT_${index + 1}_SHA_STALE`);
    }
  }
  reasons.push(...domainReferenceEligibility(snapshot.stateProjection,familyId,bindings));
  const domainHash=snapshot.stateProjection.assetFamiliesById[familyId]?.domainContextHash;
  if(request.domainReferenceHash&&domainHash!==request.domainReferenceHash)reasons.push('DOMAIN_REFERENCE_CONTEXT_STALE');
  return [...new Set(reasons)];
}
