import { check, objectValue } from "../shared/contracts.mjs";
export const kinds = ["GUIDANCE", "NOTE"];
export function validate(kind, content) {
  if (kind === "GUIDANCE")
    check(
      typeof content.text === "string",
      "GUIDANCE_TEXT_REQUIRED",
      "指引必须包含正文",
    );
}
export const SYSTEM_FIELDS = new Set([
  "reviewStandards",
  "entityTypes",
  "materialTypes",
  "productionStages",
  "sourceRules",
  "assistant",
  "limits",
  "technicalStandards",
  "template",
]);
export const PROJECT_FIELDS = new Set([
  "title",
  "locale",
  "branding",
  "storyRules",
  "pictureBaseline",
  "defaultWorkspace",
  "sourcePriority",
  "candidateOptions",
  "preferredCollaborator",
]);
export function validateConfiguration(scope, content) {
  objectValue(content);
  const allowed =
    scope === "system"
      ? SYSTEM_FIELDS
      : scope === "project"
        ? PROJECT_FIELDS
        : null;
  check(allowed, "CONFIGURATION_SCOPE", "配置范围必须是 system 或 project");
  for (const key of Object.keys(content))
    check(
      allowed.has(key),
      "CONFIGURATION_FIELD",
      `${key} 不属于 ${scope} 配置`,
    );
  const forbidden =
    /^(apiKey|token|password|secret|credential|machinePath|sessionId|runtimeEpoch|databaseUrl)$/i;
  function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      check(
        !forbidden.test(key),
        "PRIVATE_CONFIGURATION",
        "密钥、机器路径和会话只能存于本机配置",
      );
      visit(item);
    }
  }
  visit(content);
  if (scope === "system" && content.limits) {
    for (const [key, maximum] of Object.entries({
      cacheBytes: 24 * 1024 * 1024,
      idleSeconds: 300,
      queueSize: 100,
    }))
      if (content.limits[key] !== undefined)
        check(
          content.limits[key] === maximum,
          "FIXED_RESOURCE_LIMIT",
          "资源上限由系统固定，不能通过项目包覆盖",
        );
  }
  return content;
}
