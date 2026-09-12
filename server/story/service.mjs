import { check, hash } from "../shared/contracts.mjs";
export const kinds = ["SOURCE", "STORY", "EPISODE", "SCENE"];
export function validate(kind, content) {
  if (kind === "SCENE") {
    check(
      typeof content.text === "string" || Array.isArray(content.blocks),
      "SCENE_TEXT_REQUIRED",
      "场景必须包含正文",
    );
    if (content.blocks) {
      const ids = content.blocks.map((x) => x.id);
      check(
        ids.every((x) => typeof x === "string") &&
          new Set(ids).size === ids.length,
        "BLOCK_ID_CONFLICT",
        "正文段落必须使用唯一且稳定的身份",
      );
    }
  }
  if (content.authority !== undefined)
    check(
      ["F", "A", "L", "U", "UNKNOWN"].includes(content.authority),
      "AUTHORITY_INVALID",
      "依据属性必须为 F、A、L 或 UNKNOWN",
    );
}
export async function validateTarget(tx, kind, content, oldContent) {
  if(kind==='SCENE'&&oldContent) {
    const authored=value=>{const result={...value};delete result.contentHash;return result;};
    if(hash(authored(content))!==hash(authored(oldContent)))content.contentHash=hash(authored(content));
  }
  if (kind === "SOURCE" && oldContent)
    check(
      hash(content) === hash(oldContent),
      "SOURCE_IMMUTABLE",
      "原始资料不可原位改写；请登记新资料并保留原修订",
      409,
    );
}
export async function projectLinks(tx, object, revisionId, links) {
  if (object.kind === "EPISODE") {
    const scenes = links.filter((x) => x.role === "SCENE");
    for (const scene of scenes) {
      const row = (
        await tx.query("SELECT kind FROM objects WHERE id=$1", [scene.id])
      ).rows[0];
      check(row?.kind === "SCENE", "SCENE_REQUIRED", "分集成员必须是永久场景");
    }
    await tx.query("DELETE FROM episode_scenes WHERE episode_id=$1", [
      object.id,
    ]);
    for (const [position, scene] of scenes.entries())
      await tx.query(
        "INSERT INTO episode_scenes(episode_id,scene_id,position) VALUES($1,$2,$3)",
        [object.id, scene.id, position],
      );
  }
}
