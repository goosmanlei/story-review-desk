import {productionRecipeInputs} from './review-evidence.mjs';
import {PresentationRead} from '../presentation/read-unit.mjs';
import {hash} from '../shared/contracts.mjs';
import { check } from "../shared/contracts.mjs";
import {validateAnimaticTimeline} from './animatic-model.mjs';
import {canonicalShotDesign} from '../../web/presentation/shot-design-contract.mjs';
export const kinds = [
  "PREPARATION",
  "COVERAGE",
  "SHOT_DESIGN",
  "SHOT",
  "INPUT_LOCK",
  "ASSEMBLY",
  "DELIVERABLE",
];
export function validate(kind, content) {
  if(kind==='ASSEMBLY'&&content.role==='ANIMATIC')validateAnimaticTimeline(content.timeline);
  if(kind==='SHOT'&&content.design)canonicalShotDesign(content.design);
  if (kind === "SHOT")
    check(
      typeof content.description === "string" ||
        typeof content.visualIntent === "string",
      "SHOT_INTENT_REQUIRED",
      "请填写镜头设计",
    );
  if (content.authorized !== undefined)
    check(
      content.authorized === false,
      "AUTHORIZATION_SEPARATE",
      "生成授权须使用明确授权操作，不能在设计内容中写入",
    );
}
export async function verifyAdoption(tx, object, revisionId) {
  if (object.kind !== "INPUT_LOCK") return;
  const inputs = (
    await tx.query(
      "SELECT o.id,o.kind,o.state,o.adopted_revision_id,d.dependency_revision_id,r.fact,r.internal_attestation FROM dependencies d JOIN revisions v ON v.id=d.dependency_revision_id JOIN objects o ON o.id=v.object_id LEFT JOIN rights r ON r.revision_id=v.id WHERE d.consumer_revision_id=$1 AND d.purpose='ACTUAL_INPUT'",
      [revisionId],
    )
  ).rows;
  check(
    inputs.length > 0,
    "ACTUAL_INPUT_REQUIRED",
    "实际输入锁定必须列出精确采用版本",
    409,
  );
  for (const input of inputs) {
    if(input.kind==='CALL'){const c=(await tx.query('SELECT content FROM revisions WHERE id=$1',[input.dependency_revision_id])).rows[0]?.content;if(c?.basis?.productionBasis){const needed=await productionRecipeInputs(new PresentationRead(tx),c.workItemRef);check(hash(needed.basis)===hash(c.basis.productionBasis),'PRODUCTION_CALL_STALE','调用包的本镜锁时、关键帧或声音输入已改变',409);}}
    check(
      ["ASSET", "CALL", "PROMPT"].includes(input.kind),
      "INPUT_KIND",
      "实际输入须为素材版本、调用定义或提示词；来源资料不能直接作为制作素材",
      409,
      { id: input.id },
    );
    check(
      input.adopted_revision_id === input.dependency_revision_id &&
        input.state !== "DISABLED",
      "INPUT_NOT_ADOPTED",
      "实际输入版本尚未采用或已禁用",
      409,
      { id: input.id },
    );
    if (input.kind === "ASSET") {
      check(
        input.fact !== "BLOCKED" &&
          (input.fact === "CLEAR" || input.internal_attestation),
        "INPUT_RIGHTS_BLOCKED",
        "实际输入缺少项目下传权利依据",
        409,
        { id: input.id },
      );
      const media = (
        await tx.query(
          "SELECT m.availability FROM asset_media a JOIN media m ON (m.id,m.version_id)=(a.media_id,a.media_version_id) WHERE a.revision_id=$1 AND a.role='OUTPUT'",
          [input.dependency_revision_id],
        )
      ).rows;
      check(
        media.length && media.every((m) => m.availability === "PRESENT"),
        "INPUT_MEDIA_UNAVAILABLE",
        "实际输入媒体缺失或已退役",
        409,
        { id: input.id },
      );
    }
  }
}
