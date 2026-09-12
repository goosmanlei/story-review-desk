import { check, hash } from "../shared/contracts.mjs";
import { PresentationRead } from '../presentation/read-unit.mjs';
import { episodePlan } from '../presentation/story.mjs';
import { commentTargets } from '../presentation/review.mjs';
export const kinds = ["COMMENT", "JUDGMENT"];
export function validate(kind, content) {
  if (kind === "COMMENT")
    check(
      typeof content.text === "string" && content.text.trim(),
      "COMMENT_REQUIRED",
      "评论正文不能为空",
    );
  if (content.status !== undefined)
    check(
      ["OPEN", "RESOLVED", "CLOSED"].includes(content.status),
      "COMMENT_STATUS",
      "评论状态无效",
    );
}

export async function validateTarget(tx, kind, content, oldContent) {
  if (kind !== "COMMENT") return;
  const target = content.target;
  // Keep imported comments attached to their frozen historical evidence. An edit
  // may resolve or amend them, but cannot silently move them to a current scene.
  if (oldContent?.target) {
    check(
      hash(target || null) === hash(oldContent.target) &&
        hash(content.anchor || null) === hash(oldContent.anchor || null),
      "COMMENT_TARGET_IMMUTABLE",
      "已有评论的来源版本与圈选不可改绑",
      409,
    );
    return;
  }
  check(
    target?.objectId &&
      target?.revisionId &&
      Number.isInteger(target.expectedVersion),
    "COMMENT_TARGET_REQUIRED",
    "评论须绑定对象、修订和所见版本",
  );
  const row = (
    await tx.query(
      `SELECT o.version,o.draft_revision_id,o.adopted_revision_id,r.content,r.sha256 FROM objects o JOIN revisions r ON r.object_id=o.id WHERE o.id=$1 AND r.id=$2`,
      [target.objectId, target.revisionId],
    )
  ).rows[0];
  check(
    row &&
      row.version === target.expectedVersion &&
      [row.draft_revision_id, row.adopted_revision_id].includes(
        target.revisionId,
      ),
    "VERSION_CONFLICT",
    "评论依据已改变，请核对新版本后再提交",
    409,
  );
  check(
    !target.sha256 || row.sha256 === target.sha256,
    "INPUT_REVISION_CONFLICT",
    "评论依据 SHA 不符",
    409,
  );
  let authorizedBlocks=row.content.blocks||row.content.scriptBlocks||[];
  if(['EPISODE_DESIGN','SCENE_SCRIPT'].includes(target.kind)) {
    const unit=new PresentationRead(tx),plan=await episodePlan(unit),current=(await commentTargets(unit,plan)).find(t=>t.kind===target.kind&&t.objectId===target.objectId);
    check(current&&current.contentHash===target.contentHash&&current.objectRevisionId===target.revisionId,'COMMENT_ANCHOR_CONFLICT','评论所读内容与对象修订不一致',409);
    check(hash(current.sourceVersions)===hash(target.sourceVersions),'COMMENT_SOURCE_CONFLICT','评论须携带精确来源版本',409);
    authorizedBlocks=current.blocks;
  }
  if (content.anchor?.quote) {
    const segments=content.anchor.segments?.length?content.anchor.segments:[content.anchor];
    check(Array.isArray(segments)&&segments.length<=100,'COMMENT_ANCHOR_CONFLICT','圈选段落无效',409);
    for(const segment of segments) {
      const block = authorizedBlocks.find(b=>b.id===segment.blockId);
      let text = segment.blockId ? block?.text : row.content.text;
      if (segment.path) {
      const path = segment.path;
      check(
        Array.isArray(path) &&
          path.length > 0 &&
          path.length <= 16 &&
          path.every((k) => typeof k === "string" && k.length <= 200),
        "COMMENT_ANCHOR_CONFLICT",
        "圈选字段路径无效",
        409,
      );
      text = path.reduce(
        (v, k) => (v && Object.hasOwn(v, k) ? v[k] : undefined),
        row.content,
      );
    }
      check(
      typeof text === "string" && typeof segment.quote==='string' && segment.quote.length>0 && (Number.isInteger(segment.startOffset)&&Number.isInteger(segment.endOffset)
        ? segment.startOffset>=0&&segment.endOffset>segment.startOffset&&text.slice(segment.startOffset,segment.endOffset)===segment.quote
        : !segment.blockId&&text.includes(segment.quote)),
      "COMMENT_ANCHOR_CONFLICT",
      "圈选文字不属于该版本正文",
      409,
    );
    }
  }
}
