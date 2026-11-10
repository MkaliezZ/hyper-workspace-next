CREATE TABLE cw_ocr_documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES cw_users ON DELETE CASCADE,
  provider_key text NOT NULL,
  source_uid text NOT NULL,
  source_file_id text NOT NULL,
  source_etag text NOT NULL,
  source_path text[] NOT NULL,
  source_size integer NOT NULL CHECK (source_size BETWEEN 1 AND 8388608),
  source_mime text NOT NULL,
  source_title text NOT NULL,
  page integer NOT NULL CHECK (page BETWEEN 1 AND 50),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  confirmed_revision integer CHECK (confirmed_revision BETWEEN 1 AND revision),
  invalidated_at timestamptz
);
CREATE UNIQUE INDEX cw_ocr_documents_active ON cw_ocr_documents
  (workspace_id,actor_id,provider_key,source_uid,source_file_id,page)
  WHERE invalidated_at IS NULL;
CREATE TABLE cw_ocr_revisions (
  document_id uuid NOT NULL REFERENCES cw_ocr_documents ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','confirmed')),
  engine text NOT NULL,
  content jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (document_id,revision),
  UNIQUE (document_id,request_key)
);
