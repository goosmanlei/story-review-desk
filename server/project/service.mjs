import { check, hash, objectValue } from "../shared/contracts.mjs";
import { validateLibrary } from '../library/contract.mjs';
import {validateReferenceContent,validateReferenceTargets} from '../materials/references.mjs';
import {retiredEntityType,currentSystemEntityTypes} from '../shared/entity-types.mjs';
export const kinds = ["GUIDANCE", "NOTE"];
export function validate(kind, content) {
  validateReferenceContent(kind,content);
  if (kind === "GUIDANCE")
    check(
      typeof content.text === "string",
      "GUIDANCE_TEXT_REQUIRED",
      "指引必须包含正文",
    );
}
export const validateTarget=validateReferenceTargets;
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
  "reviewLibrary",
]);
export function validateConfiguration(scope, content, {historicalImport=false}={}) {
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
  if(scope==='system'&&content.entityTypes!==undefined){
    objectValue(content.entityTypes,'entityTypes');
    if(content.entityTypes.entityTypes!==undefined){
      check(Array.isArray(content.entityTypes.entityTypes)&&content.entityTypes.entityTypes.every(type=>type&&typeof type.id==='string'),'CONFIGURATION_LIST','主体类型须为身份列表');
      if(!historicalImport)check(content.entityTypes.entityTypes.every(type=>!retiredEntityType(type.id)),'ENTITY_TYPE_RETIRED','系统配置不能重新启用已退役主体类型');
    }
  }
  if (scope === 'project' && content.reviewLibrary !== undefined) validateLibrary(content.reviewLibrary);
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

// Configuration is mutable; imported revisions are not. Preserve the exact
// legacy configuration as provenance before dropping retired choices.
export async function preserveRetiredEntityConfiguration(tx,row) {
  if(row.scope!=='system')return false;
  const content=currentSystemEntityTypes(row.content);
  if(hash(content)===hash(row.content))return false;
  const original=hash(row);
  await tx.query("INSERT INTO provenance(id,kind,original_id,original_sha256,content) VALUES($1,'retired-entity-configuration',$2,$3,$4) ON CONFLICT(kind,original_id) DO NOTHING",['retired_config_'+original,original,hash(row.content),row]);
  return true;
}

export async function retireImportedEntityConfiguration(tx,row) {
  if(!await preserveRetiredEntityConfiguration(tx,row))return false;
  await tx.query('UPDATE configurations SET content=$1,version=version+1 WHERE scope=$2',[currentSystemEntityTypes(row.content),row.scope]);
  return true;
}
export function presentConfiguration(row) {
  if(row.scope!=='system')return row;
  const content=currentSystemEntityTypes(row.content);
  return {...row,content,...(hash(content)!==hash(row.content)?{retiredEntityTypes:row.content.entityTypes.entityTypes.filter(type=>retiredEntityType(type.id)).map(type=>type.id),storedContentHash:hash(row.content)}:{})};
}
