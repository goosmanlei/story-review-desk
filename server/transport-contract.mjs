import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
// Data contract, not arbitrary SQL. Importers may only write these business columns.
export const TABLES={
  objects:['id','module','kind','display_id','title','version','state','draft_revision_id','adopted_revision_id','position','historical','updated_at','created_at'],
  revisions:['id','object_id','number','previous_id','content','sha256','author','created_at'],
  source_documents:['revision_id','original_revision_id','original_sha256','mime_type','content_bytes','logical_path','role'],
  media:['id','version_id','sha256','byte_size','mime_type','availability','original_path','evidence'],
  material_families:['object_id','adopted_asset_id'],
  asset_versions:['object_id','family_id','parent_asset_id'],
  episode_scenes:['episode_id','scene_id','position'],
  entity_relations:['object_id','from_id','to_id','relation_type'],
  memberships:['owner_id','member_id','role'],
  revision_memberships:['revision_id','member_id','role','position'],
  dependencies:['consumer_revision_id','dependency_revision_id','purpose'],
  invalidations:['consumer_revision_id','changed_revision_id','replacement_revision_id','operation_id','created_at'],
  asset_media:['revision_id','media_id','media_version_id','sha256','role'],
  rights:['revision_id','fact','internal_attestation','evidence'],
  rights_events:['id','revision_id','fact','internal_attestation','evidence','author','operation_id','created_at'],
  reviews:['id','object_id','revision_id','decision','findings','note','author','operation_id','created_at'],
  provenance:['id','object_id','revision_id','kind','original_id','original_sha256','content'],
  configurations:['scope','version','content'],
};
export async function fileSha(filename){const digest=createHash('sha256');for await(const chunk of createReadStream(filename))digest.update(chunk);return digest.digest('hex');}

export const ORDER_KEYS={memberships:['owner_id','member_id','role'],revision_memberships:['revision_id','member_id','role'],dependencies:['consumer_revision_id','dependency_revision_id','purpose'],asset_media:['revision_id','media_id','media_version_id','role'],invalidations:['consumer_revision_id','changed_revision_id','operation_id']};
