-- P04/P05/P07 C02/C04/C05 A04/A08/A10: source-bound, employee-owned editable Office proposals.
CREATE TABLE cw_office_proposals (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES cw_users ON DELETE CASCADE,
 provider_key text NOT NULL,
 source_uid text NOT NULL,
 source_file_id text NOT NULL,
 source_etag text NOT NULL,
 source_path text[] NOT NULL,
 source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
 source_size integer NOT NULL CHECK (source_size BETWEEN 1 AND 8388608),
 source_mime text NOT NULL,
 source_title text NOT NULL,
 source_binding text NOT NULL,
 format text NOT NULL CHECK (format IN ('docx','xlsx','pptx')),
 destination text[] NOT NULL,
 target_path text[] NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','processing','applying','succeeded','failed','cancelled','recovery_required')),
 engine text NOT NULL,
 operations jsonb,
 preview jsonb,
 invalidated_at timestamptz,
 cancel_requested boolean NOT NULL DEFAULT false,
 retryable boolean NOT NULL DEFAULT false,
 error text,
 attempt_token uuid,
 output_sha256 text CHECK (output_sha256 ~ '^[a-f0-9]{64}$'),
 output_size integer CHECK (output_size BETWEEN 1 AND 8388608),
 source_file jsonb,
 source_run_id uuid REFERENCES cw_runs ON DELETE SET NULL,
 apply_run_id uuid REFERENCES cw_runs ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (state NOT IN ('applying','succeeded','recovery_required') OR (output_sha256 IS NOT NULL AND output_size IS NOT NULL)),
 CHECK (invalidated_at IS NULL OR (operations IS NULL AND preview IS NULL))
);
CREATE INDEX cw_office_proposal_owner ON cw_office_proposals(workspace_id,actor_id,created_at DESC);
CREATE UNIQUE INDEX cw_office_proposal_run ON cw_office_proposals(source_run_id) WHERE source_run_id IS NOT NULL;
CREATE TABLE cw_office_requests (
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES cw_users ON DELETE CASCADE,
 request_key uuid NOT NULL,
 request_hash text NOT NULL,
 proposal_id uuid NOT NULL REFERENCES cw_office_proposals ON DELETE CASCADE,
 revision integer NOT NULL,
 kind text NOT NULL CHECK (kind IN ('create','edit','apply','cancel')),
 run_id uuid REFERENCES cw_runs ON DELETE SET NULL,
 response jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,actor_id,request_key)
);
CREATE UNIQUE INDEX cw_office_request_run ON cw_office_requests(run_id) WHERE run_id IS NOT NULL;
ALTER TABLE cw_runs ADD COLUMN office_plan jsonb;
ALTER TABLE cw_runs ADD CONSTRAINT cw_office_plan_scope CHECK ((workflow IN ('draft_office','apply_office'))=(office_plan IS NOT NULL));
ALTER TABLE cw_runs DROP CONSTRAINT cw_run_source_scope;
ALTER TABLE cw_runs ADD CONSTRAINT cw_run_source_scope CHECK (
 (workflow='read_file' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NOT NULL AND expected_file_version IS NOT NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
 OR (workflow='revise_file_reading' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NOT NULL AND expected_file_version IS NOT NULL AND source_file_reading_id IS NOT NULL AND expected_reading_version IS NOT NULL AND expected_reading_version>0)
 OR (workflow='manage_communication' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL
  AND room_management_plan IS NOT NULL AND room_management_provider_key IS NOT NULL AND NOT demo)
 OR (workflow='manage_calendar' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL
  AND calendar_plan IS NOT NULL AND calendar_binding IS NOT NULL AND NOT demo)
 OR (workflow='manage_approval' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL
  AND approval_plan IS NOT NULL AND NOT demo)
 OR (workflow='recognize_ocr' AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL
  AND ocr_plan IS NOT NULL AND NOT demo)
 OR (workflow IN ('draft_office','apply_office') AND conversation_id IS NULL AND artifact_id IS NULL AND expected_artifact_version IS NULL AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL AND office_plan IS NOT NULL AND NOT demo)
 OR (workflow NOT IN ('draft_office','apply_office','read_file','revise_file_reading','manage_communication','manage_calendar','manage_approval','recognize_ocr') AND conversation_id IS NOT NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
);
