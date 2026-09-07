export const SCHEMA_VERSION = 1;
export const APPLICATION_ID = 0x52564931;

// Immutable published migrations. Business bytes and their original hashes are
// independent of SQLite row ordering and of the runtime lease epoch.
export const MIGRATIONS = [{ version: 1, sql: `
CREATE TABLE repository_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL,
 runtime_epoch TEXT NOT NULL, repository_revision INTEGER NOT NULL DEFAULT 0,
 current_release_id TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE record_revisions (
 revision_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, record_key TEXT NOT NULL,
 revision_number INTEGER NOT NULL CHECK(revision_number>0), previous_revision_id TEXT,
 content_bytes BLOB NOT NULL, content_sha256 TEXT NOT NULL, media_type TEXT NOT NULL,
 metadata_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 created_at TEXT NOT NULL, UNIQUE(namespace,record_key,revision_number)
) STRICT;
CREATE TABLE record_heads (
 namespace TEXT NOT NULL, record_key TEXT NOT NULL,
 revision_id TEXT NOT NULL REFERENCES record_revisions(revision_id),
 PRIMARY KEY(namespace,record_key)
) STRICT;
CREATE TABLE document_aliases (
 alias TEXT PRIMARY KEY, document_id TEXT NOT NULL
) STRICT;
CREATE TABLE releases (
 release_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL,
 snapshot_bytes BLOB NOT NULL, snapshot_sha256 TEXT NOT NULL,
 recipes_bytes BLOB NOT NULL, recipes_sha256 TEXT NOT NULL,
 source_revision_ids_json TEXT NOT NULL, profile_revision_id TEXT NOT NULL REFERENCES record_revisions(revision_id),
 created_at TEXT NOT NULL
) STRICT;
CREATE TABLE domain_events (
 storage_sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
 authority_domain TEXT NOT NULL, event_kind TEXT NOT NULL, original_sequence INTEGER,
 recorded_at TEXT NOT NULL, event_bytes BLOB NOT NULL, event_sha256 TEXT NOT NULL,
 idempotency_key_hash TEXT, request_hash TEXT, raw_request_hash TEXT, source_ref_json TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX domain_event_idempotency ON domain_events(authority_domain,event_kind,idempotency_key_hash)
 WHERE idempotency_key_hash IS NOT NULL;
CREATE INDEX domain_event_kind ON domain_events(authority_domain,event_kind,original_sequence,recorded_at,event_id);
CREATE TABLE media_versions (
 media_id TEXT NOT NULL, version_id TEXT NOT NULL, relative_path TEXT,
 sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>=0),
 availability TEXT NOT NULL CHECK(availability IN ('PRESENT','MISSING_HISTORY')),
 metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(media_id,version_id)
) STRICT;
CREATE TABLE media_aliases (
 alias TEXT NOT NULL, media_id TEXT NOT NULL, version_id TEXT NOT NULL,
 PRIMARY KEY(alias,media_id,version_id),
 FOREIGN KEY(media_id,version_id) REFERENCES media_versions(media_id,version_id)
) STRICT;
CREATE VIEW aux_current AS SELECT substr(r.namespace,5) AS namespace,r.record_key,r.revision_id,
 r.revision_number,r.previous_revision_id,r.content_bytes,r.content_sha256,r.media_type,r.metadata_json,r.deleted,r.created_at
 FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE r.namespace LIKE 'aux:%';
CREATE TRIGGER records_no_update BEFORE UPDATE ON record_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER records_no_delete BEFORE DELETE ON record_revisions BEGIN SELECT RAISE(ABORT,'immutable record'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON domain_events BEGIN SELECT RAISE(ABORT,'immutable domain event'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON domain_events BEGIN SELECT RAISE(ABORT,'immutable domain event'); END;
CREATE TRIGGER releases_no_update BEFORE UPDATE ON releases BEGIN SELECT RAISE(ABORT,'immutable release'); END;
CREATE TRIGGER releases_no_delete BEFORE DELETE ON releases BEGIN SELECT RAISE(ABORT,'immutable release'); END;
CREATE TRIGGER media_no_update BEFORE UPDATE ON media_versions BEGIN SELECT RAISE(ABORT,'immutable media'); END;
CREATE TRIGGER media_no_delete BEFORE DELETE ON media_versions BEGIN SELECT RAISE(ABORT,'immutable media'); END;
CREATE TRIGGER document_aliases_no_update BEFORE UPDATE ON document_aliases BEGIN SELECT RAISE(ABORT,'immutable alias'); END;
CREATE TRIGGER document_aliases_no_delete BEFORE DELETE ON document_aliases BEGIN SELECT RAISE(ABORT,'immutable alias'); END;
CREATE TRIGGER media_aliases_no_update BEFORE UPDATE ON media_aliases BEGIN SELECT RAISE(ABORT,'immutable alias'); END;
CREATE TRIGGER media_aliases_no_delete BEFORE DELETE ON media_aliases BEGIN SELECT RAISE(ABORT,'immutable alias'); END;
CREATE TRIGGER instance_identity_no_update BEFORE UPDATE OF instance_id ON repository_meta BEGIN SELECT RAISE(ABORT,'immutable instance'); END;
` }];
