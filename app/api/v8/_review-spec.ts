import type { ReviewData } from "./_store";
import type { ReviewSpec } from "../../../host/instance-runtime/configuration-model.mjs";
import {
  defaultConfiguration,
  reviewSpec,
} from "../../../host/instance-runtime/configuration-model.mjs";

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
export function candidateReviewSpec(
  data: ReviewData,
  candidate: Row,
): ReviewSpec {
  const model = data.productionModel as unknown as Row;
  const projected = rows(model.configurationCandidates).find(
    (r) => r.id === candidate.creativeRevisionId,
  );
  return (
    ((projected?.reviewSpec || candidate.reviewSpec) as ReviewSpec) ||
    resolveFormalReviewSpec(
      data,
      "EPISODE_PLAN",
      String(candidate.creativeRevisionId),
    )!
  );
}
export function resolveFormalReviewSpec(
  data: ReviewData,
  subjectType: string,
  subjectId: string,
): ReviewSpec | null {
  const model = data.productionModel;
  const config =
    model.systemConfiguration?.config || defaultConfiguration(data.instance);
  if (subjectType === "ASSET") {
    const owners = rows(model.materialWorkItems).filter(
      (w) => w.outputAssetRef === subjectId,
    );
    const ownerRefs = [
      ...new Set(owners.map((w) => w.requirementRef).filter(Boolean)),
    ];
    const candidates = rows(model.materialRequirements).filter((r) =>
      ownerRefs.length
        ? r.id === ownerRefs[0]
        : Array.isArray(r.assetFamilyRefs) &&
          r.assetFamilyRefs.includes(subjectId),
    );
    if (ownerRefs.length > 1 || candidates.length !== 1) return null;
    const requirement = candidates[0];
    return (
      (requirement.reviewSpec as ReviewSpec) ||
      reviewSpec(config, "ASSET", requirement, { legacy: true })
    );
  }
  if (subjectType === "SCRIPT_SCENE") {
    const target = rows(
      (data as unknown as Row).actionQueueInputs &&
        ((data as unknown as Row).actionQueueInputs as Row).sceneReviewDossiers,
    ).find((r) => r.sceneId === subjectId || r.id === subjectId);
    return (
      (target?.reviewSpec as ReviewSpec) ||
      reviewSpec(config, "SCRIPT_SCENE", target || {}, { legacy: true })
    );
  }
  if (subjectType === "EPISODE_PLAN") {
    const candidate = rows(model.episodePlanRevisions).find(
      (r) => r.id === subjectId || r.creativeRevisionId === subjectId,
    );
    return (
      (candidate?.reviewSpec as ReviewSpec) ||
      reviewSpec(config, "EPISODE_PLAN", candidate || {}, { legacy: true })
    );
  }
  const work = rows(model.workItems).find((w) => w.id === subjectId);
  if (!work) return null;
  if (work.reviewSpec) return work.reviewSpec as ReviewSpec;
  const contexts = rows(model.reviewContexts);
  const context =
    contexts.find((c) => c.id === work.reviewContextRef) ||
    contexts.find(
      (c) => c.scopeId === work.scopeId && c.scopeType === work.scopeType,
    );
  const shot = rows(model.shots).find((s) => s.id === work.scopeId);
  return reviewSpec(config, "WORK_PRODUCT", work, {
    legacy: true,
    shotContext: shot?.reviewContext,
    scopeContext: context,
  });
}
export function reviewFindingsIssues(
  spec: ReviewSpec,
  findings: Array<{ criterionId: string; verdict: string; note?: string }>,
  hash: unknown,
  requireHash = true,
): string[] {
  const issues: string[] = [];
  if (requireHash && hash !== spec.hash)
    issues.push("审阅标准版本已变化，请重新读取");
  const wanted = new Set(spec.criteria.map((c) => c.id));
  if (
    findings.length !== wanted.size ||
    new Set(findings.map((c) => c.criterionId)).size !== wanted.size ||
    findings.some((f) => !wanted.has(f.criterionId))
  )
    issues.push("判断项必须与本对象的完整审阅标准一致");
  for (const criterion of spec.criteria) {
    const finding = findings.find((f) => f.criterionId === criterion.id);
    if (!finding) continue;
    if (finding.verdict === "NA" && !criterion.allowNA)
      issues.push(`${criterion.label}不允许选择不适用`);
    if (
      finding.verdict === "FAIL" &&
      criterion.noteRequiredOnFail &&
      !finding.note?.trim()
    )
      issues.push(`${criterion.label}未通过时须说明原因`);
  }
  return issues;
}
