import { transaction } from '../db.mjs';
import { check, hash } from '../shared/contracts.mjs';
import { PresentationRead } from '../presentation/read-unit.mjs';
import { episodePlan } from '../presentation/story.mjs';
import { presentationToken } from '../presentation/cache.mjs';
import { validateLibrary, LIBRARY_FORMAT } from './contract.mjs';
import { mediaName, mediaExtension, renderScreenplay } from './names.mjs';

export async function libraryHead(tx) {
  const project = (await tx.query('SELECT instance_id AS "instanceId",runtime_epoch AS "runtimeEpoch" FROM project')).rows[0];
  const config = (await tx.query("SELECT content FROM configurations WHERE scope='project'")).rows[0]?.content.reviewLibrary || { enabled: true, texts: [] };
  validateLibrary(config);
  return { ...project, enabled: config.enabled !== false, config, token: await presentationToken(tx) };
}
export async function librarySnapshot(pool) {
  return transaction(pool, async tx => {
    const head = await libraryHead(tx);
    if (!head.enabled) return { ...head, entries: [], blobs: [] };
    const rows = (await tx.query('SELECT * FROM media ORDER BY id,version_id LIMIT 50001')).rows;
    check(rows.length <= 50000, 'LIBRARY_LIMIT', '登记媒体超过单次目录上限', 413);
    const references = (await tx.query(`SELECT am.media_id,am.media_version_id,am.role,
      r.id AS "revisionId",r.object_id AS "objectId",r.number,r.sha256 AS "revisionSha256",
      o.title,o.kind,o.state,o.historical,r.id=o.adopted_revision_id AS adopted,
      jsonb_build_object('subtype',r.content->'subtype','type',r.content->'type','businessCategoryPrimaryId',r.content->'businessCategoryPrimaryId') AS content,
      f.id AS "familyId",f.title AS "familyTitle",fr.id AS "classificationRevisionId",
      jsonb_build_object('subtype',fr.content->'subtype','businessCategoryPrimaryId',fr.content->'businessCategoryPrimaryId') AS "familyContent"
      FROM asset_media am JOIN revisions r ON r.id=am.revision_id JOIN objects o ON o.id=r.object_id
      LEFT JOIN asset_versions av ON av.object_id=o.id LEFT JOIN objects f ON f.id=av.family_id
      LEFT JOIN revisions fr ON fr.id=COALESCE(f.draft_revision_id,f.adopted_revision_id)
      ORDER BY am.media_id,am.media_version_id,r.number,r.id LIMIT 100001`)).rows;
    check(references.length <= 100000, 'LIBRARY_LIMIT', '媒体引用超过单次目录上限', 413);
    const refs = new Map();
    for (const ref of references) {
      const key = JSON.stringify([ref.media_id, ref.media_version_id]);
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key).push(ref);
    }
    const entries = rows.map(row => {
      const bindings = refs.get(JSON.stringify([row.id, row.version_id])) || [];
      const name = mediaName(row, bindings);
      const excluded = ['txt','md','json','yaml','yml','srt','vtt'].includes(mediaExtension(row)) || row.mime_type.startsWith('text/');
      return { ...name, path: row.availability === 'PRESENT' && !excluded ? name.path : null,
        kind: 'media', mediaId: row.id, mediaVersionId: row.version_id, sha256: row.sha256,
        bytes: Number(row.byte_size), mimeType: row.mime_type, availability: row.availability,
        ...(excluded ? { excluded: 'TEXT_SELECTION_ONLY' } : {}),
        originalName: row.evidence?.legacyVersion?.path || row.original_path || null,
        sourceRole: row.evidence?.sourceRole || row.evidence?.authorityDomain || null,
        evidenceOnly: row.evidence?.evidenceOnly === true,
        usageNote: row.evidence?.reviewUse || null,
        bindings: bindings.map(({content, familyContent, media_id, media_version_id, ...binding}) => binding),
        observation: 'NOT_OBSERVED_BY_LIBRARY',
      };
    });
    const blobs = [];
    for (const selection of head.config.texts) {
      const unit = new PresentationRead(tx);
      const object = await unit.detail(selection.objectId, selection.revisionId);
      let bytes, basis, originalSha256 = null, sourceMediaSha256 = null;
      if (selection.kind === 'source') {
        check(object.kind === 'SOURCE', 'LIBRARY_SOURCE', '所选文本须为来源对象');
        const original = (await tx.query('SELECT content_bytes,original_sha256 FROM source_documents WHERE revision_id=$1', [object.revision.id])).rows[0];
        if (original) { bytes = original.content_bytes; originalSha256 = original.original_sha256; }
        else if (object.revision.content.originalMediaSha256) {
          sourceMediaSha256 = object.revision.content.originalMediaSha256;
          const row = rows.find(r => r.sha256 === sourceMediaSha256 && r.availability === 'PRESENT');
          check(row, 'LIBRARY_SOURCE_MISSING', '所选来源原件不可用', 409);
          originalSha256 = sourceMediaSha256;
        } else {
          check(typeof object.revision.content.text === 'string', 'LIBRARY_SOURCE', '来源没有可导出的原始文本', 409);
          bytes = Buffer.from(object.revision.content.text);
          originalSha256 = object.revision.content.sha256;
        }
        if (bytes) check(originalSha256 && hash(bytes) === originalSha256, 'LIBRARY_SOURCE_HASH', '来源原始字节 SHA 不符', 409);
        basis = [...unit.basis.values()];
      } else {
        check(object.kind === 'STORY', 'LIBRARY_SCREENPLAY', '完整剧本须选择故事对象');
        const plan = await episodePlan(unit, selection.revisionId);
        check(plan?.content.planId === object.id, 'LIBRARY_SCREENPLAY', '完整剧本不属于所选故事', 409);
        bytes = renderScreenplay(plan);
        basis = [...unit.basis.values()];
      }
      const sha256 = bytes ? hash(bytes) : sourceMediaSha256;
      const entry = { key: hash(['text', selection.objectId, selection.path]), path: selection.path,
        kind: selection.kind, objectId: object.id, revisionId: object.revision.id,
        title: object.title, state: object.state, dynamic: !selection.revisionId,
        sha256, originalSha256, ...(selection.kind === 'screenplay' ? { rendererVersion: LIBRARY_FORMAT } : {}),
        bytes: bytes?.length ?? Number(rows.find(r => r.sha256 === sha256).byte_size),
        mimeType: 'text/markdown', availability: 'PRESENT', basis,
        observation: 'NOT_OBSERVED_BY_LIBRARY',
      };
      entries.push(entry);
      blobs.push({ sha256, bytes, sourceMediaSha256 });
    }
    check(Buffer.byteLength(JSON.stringify(entries)) <= 24 * 1024 ** 2 && blobs.reduce((n,b) => n + (b.bytes?.length || 0), 0) <= 24 * 1024 ** 2,
      'LIBRARY_LIMIT', '审阅索引或文本超过 24 MiB 上限', 413);
    return { ...head, entries, blobs };
  }, { readOnly: true, timeoutMs: 30000 });
}
