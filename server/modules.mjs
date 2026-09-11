import * as story from "./story/service.mjs";
import * as settings from "./settings/service.mjs";
import * as materials from "./materials/service.mjs";
import * as production from "./production/service.mjs";
import * as collaboration from "./collaboration/service.mjs";
import * as project from "./project/service.mjs";
import { check } from "./shared/contracts.mjs";
export const modules = {
  story,
  settings,
  materials,
  production,
  collaboration,
  project,
};
export function moduleFor(kind) {
  const found = Object.entries(modules).find(([, m]) => m.kinds.includes(kind));
  check(found, "OBJECT_KIND", "不支持的业务对象类型");
  return { name: found[0], ...found[1] };
}
