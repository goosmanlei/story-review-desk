import { check } from "../shared/contracts.mjs";
export const kinds = ["ENTITY", "STATE", "REPRESENTATION", "RELATION", "SPACE"];
export function validate(kind, content) {
  if (kind === "ENTITY")
    check(
      typeof content.description === "string",
      "DESCRIPTION_REQUIRED",
      "请填写主体档案",
    );
  if (content.authority !== undefined)
    check(
      ["F", "A", "L", "U", "UNKNOWN"].includes(content.authority),
      "AUTHORITY_INVALID",
      "依据属性必须为 F、A、L 或 UNKNOWN",
    );
}
export async function projectLinks(tx, object, revisionId, links) {
  if (object.kind !== "RELATION") return;
  const endpoints = links.filter((x) => x.role === "ENTITY");
  check(
    endpoints.length === 2 && endpoints[0].id !== endpoints[1].id,
    "RELATION_ENDPOINTS",
    "关系必须连接两个不同的永久主体",
  );
  const actual = (
    await tx.query("SELECT id,kind FROM objects WHERE id=ANY($1::text[])", [
      endpoints.map((x) => x.id),
    ])
  ).rows;
  check(
    actual.length === 2 &&
      actual.every((x) => ["ENTITY", "SPACE"].includes(x.kind)),
    "RELATION_ENDPOINTS",
    "关系端点必须是主体或空间",
  );
  await tx.query(
    "INSERT INTO entity_relations(object_id,from_id,to_id,relation_type) VALUES($1,$2,$3,$4) ON CONFLICT(object_id) DO UPDATE SET from_id=EXCLUDED.from_id,to_id=EXCLUDED.to_id,relation_type=EXCLUDED.relation_type",
    [
      object.id,
      endpoints[0].id,
      endpoints[1].id,
      object.content.type || "RELATED",
    ],
  );
}
