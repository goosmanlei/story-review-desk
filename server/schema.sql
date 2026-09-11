CREATE TABLE schema_version (version integer PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_version(version) VALUES (1);
CREATE TABLE project (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id text NOT NULL UNIQUE,
  runtime_epoch uuid NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE objects (
  id text PRIMARY KEY,
  module text NOT NULL CHECK (module IN ('story','settings','materials','production','collaboration','project')),
  kind text NOT NULL,
  display_id text NOT NULL DEFAULT '',
  title text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('DRAFT','SUBMITTED','ADOPTED','CHANGES_REQUESTED','DISABLED','ARCHIVED')),
  draft_revision_id text,
  adopted_revision_id text,
  position integer NOT NULL DEFAULT 0,
  historical boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (draft_revision_id IS NOT NULL OR adopted_revision_id IS NOT NULL)
);
CREATE TABLE revisions (
  id text PRIMARY KEY,
  object_id text NOT NULL REFERENCES objects(id) DEFERRABLE INITIALLY DEFERRED,
  number integer NOT NULL CHECK (number > 0),
  previous_id text,
  content jsonb NOT NULL CHECK (jsonb_typeof(content)='object'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id, number),
  UNIQUE (object_id, id),
  FOREIGN KEY (object_id, previous_id) REFERENCES revisions(object_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE objects ADD FOREIGN KEY (id,draft_revision_id) REFERENCES revisions(object_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE objects ADD FOREIGN KEY (id,adopted_revision_id) REFERENCES revisions(object_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX object_catalog ON objects(module,kind,historical,position,id);
CREATE INDEX object_attention ON objects(state,module) WHERE NOT historical;
CREATE TABLE episode_scenes (
  episode_id text NOT NULL REFERENCES objects(id),
  scene_id text NOT NULL UNIQUE REFERENCES objects(id),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (episode_id,scene_id), UNIQUE(episode_id,position) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE entity_relations (
  object_id text PRIMARY KEY REFERENCES objects(id),
  from_id text NOT NULL REFERENCES objects(id),
  to_id text NOT NULL REFERENCES objects(id),
  relation_type text NOT NULL,
  CHECK (from_id <> to_id)
);
CREATE INDEX relation_from ON entity_relations(from_id);
CREATE INDEX relation_to ON entity_relations(to_id);
CREATE TABLE memberships (
  owner_id text NOT NULL REFERENCES objects(id),
  member_id text NOT NULL REFERENCES objects(id),
  role text NOT NULL CHECK(role IN ('ENTITY','STATE','REPRESENTATION','REQUIREMENT','FAMILY','SCENE','SHOT','EPISODE','OUTPUT','SOURCE','COMMENT')),
  PRIMARY KEY (owner_id,member_id,role)
);
CREATE INDEX membership_member ON memberships(member_id,role);
CREATE TABLE revision_memberships (
  revision_id text NOT NULL REFERENCES revisions(id) DEFERRABLE INITIALLY DEFERRED,
  member_id text NOT NULL REFERENCES objects(id) DEFERRABLE INITIALLY DEFERRED,
  role text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY(revision_id,member_id,role)
);
CREATE TABLE material_families (
  object_id text PRIMARY KEY REFERENCES objects(id),
  adopted_asset_id text REFERENCES objects(id)
);
CREATE TABLE asset_versions (
  object_id text PRIMARY KEY REFERENCES objects(id),
  family_id text NOT NULL REFERENCES material_families(object_id) DEFERRABLE INITIALLY DEFERRED,
  parent_asset_id text REFERENCES asset_versions(object_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(family_id,object_id)
);
ALTER TABLE material_families ADD FOREIGN KEY(object_id,adopted_asset_id) REFERENCES asset_versions(family_id,object_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE dependencies (
  consumer_revision_id text NOT NULL REFERENCES revisions(id) DEFERRABLE INITIALLY DEFERRED,
  dependency_revision_id text NOT NULL REFERENCES revisions(id) DEFERRABLE INITIALLY DEFERRED,
  purpose text NOT NULL CHECK(purpose IN ('SOURCE','CONTENT','DEFINITION','DESIGN','ACTUAL_INPUT')),
  PRIMARY KEY(consumer_revision_id,dependency_revision_id,purpose),
  CHECK(consumer_revision_id <> dependency_revision_id)
);
CREATE INDEX dependency_input ON dependencies(dependency_revision_id);
CREATE TABLE invalidations (
  consumer_revision_id text NOT NULL REFERENCES revisions(id),
  changed_revision_id text NOT NULL REFERENCES revisions(id),
  replacement_revision_id text NOT NULL REFERENCES revisions(id),
  operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(consumer_revision_id,changed_revision_id,replacement_revision_id)
);
CREATE TABLE media (
  id text NOT NULL,
  version_id text NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK(byte_size>=0),
  mime_type text NOT NULL,
  availability text NOT NULL CHECK(availability IN ('PRESENT','MISSING','RETIRED')),
  original_path text,
  evidence jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(id,version_id),
  UNIQUE(id,version_id,sha256)
);
CREATE INDEX media_sha ON media(sha256);
CREATE TABLE asset_media (
  revision_id text NOT NULL REFERENCES revisions(id),
  media_id text NOT NULL,
  media_version_id text NOT NULL,
  sha256 text NOT NULL,
  role text NOT NULL DEFAULT 'OUTPUT' CHECK(role IN ('OUTPUT','PREVIEW','SOURCE','ATTACHMENT')),
  PRIMARY KEY(revision_id,media_id,media_version_id,role),
  FOREIGN KEY(media_id,media_version_id,sha256) REFERENCES media(id,version_id,sha256)
);
CREATE TABLE rights (
  revision_id text PRIMARY KEY REFERENCES revisions(id),
  fact text NOT NULL CHECK(fact IN ('UNKNOWN','CLEAR','BLOCKED')),
  internal_attestation boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '{}',
  CHECK (fact <> 'BLOCKED' OR NOT internal_attestation)
);
CREATE TABLE rights_events (
  id text PRIMARY KEY,
  revision_id text NOT NULL REFERENCES revisions(id),
  fact text NOT NULL CHECK(fact IN ('UNKNOWN','CLEAR','BLOCKED')),
  internal_attestation boolean NOT NULL,
  evidence jsonb NOT NULL,
  author text NOT NULL,
  operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(fact <> 'BLOCKED' OR NOT internal_attestation)
);
CREATE TABLE reviews (
  id text PRIMARY KEY,
  object_id text NOT NULL,
  revision_id text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('ADOPT','REQUEST_CHANGES','DISABLE')),
  findings jsonb NOT NULL,
  note text NOT NULL,
  author text NOT NULL,
  operation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(object_id,revision_id) REFERENCES revisions(object_id,id)
);
CREATE INDEX review_object ON reviews(object_id,created_at DESC,id);
CREATE TABLE source_documents (
  revision_id text PRIMARY KEY REFERENCES revisions(id),
  original_revision_id text NOT NULL UNIQUE,
  original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL,
  content_bytes bytea NOT NULL,
  logical_path text NOT NULL,
  role text NOT NULL
);
CREATE INDEX source_path ON source_documents(logical_path);
CREATE TABLE provenance (
  id text PRIMARY KEY,
  object_id text REFERENCES objects(id),
  revision_id text REFERENCES revisions(id),
  kind text NOT NULL,
  original_id text NOT NULL,
  original_sha256 text NOT NULL,
  content jsonb NOT NULL,
  UNIQUE(kind,original_id)
);
CREATE TABLE configurations (
  scope text PRIMARY KEY CHECK(scope IN ('system','project')),
  version integer NOT NULL CHECK(version>0),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object')
);
CREATE TABLE operations (
  id text PRIMARY KEY,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL,
  status text NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','RESULT_UNKNOWN')),
  request jsonb NOT NULL,
  result jsonb,
  error jsonb,
  worker_id text,
  lease_until timestamptz,
  provider_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operation_queue ON operations(created_at,id) WHERE status='QUEUED';
CREATE TABLE suggestions (
  operation_id text PRIMARY KEY REFERENCES operations(id),
  object_id text NOT NULL REFERENCES objects(id),
  based_on_revision_id text NOT NULL REFERENCES revisions(id),
  content jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  applied_revision_id text REFERENCES revisions(id)
);
CREATE TABLE runtime_status (
  name text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_history_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable record: append a revision instead' USING ERRCODE='23000'; END; $$;
CREATE TRIGGER immutable_revision BEFORE UPDATE OR DELETE ON revisions FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER immutable_review BEFORE UPDATE OR DELETE ON reviews FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER immutable_source BEFORE UPDATE OR DELETE ON source_documents FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER immutable_provenance BEFORE UPDATE OR DELETE ON provenance FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER immutable_dependency BEFORE UPDATE OR DELETE ON dependencies FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER immutable_revision_membership BEFORE UPDATE OR DELETE ON revision_memberships FOR EACH ROW EXECUTE FUNCTION reject_history_update();
CREATE TRIGGER immutable_rights_event BEFORE UPDATE OR DELETE ON rights_events FOR EACH ROW EXECUTE FUNCTION reject_history_update();
