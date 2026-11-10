ALTER TABLE cw_runs ADD COLUMN ocr_plan jsonb;
ALTER TABLE cw_ocr_revisions ADD COLUMN source_run_id uuid REFERENCES cw_runs ON DELETE SET NULL;
CREATE UNIQUE INDEX cw_ocr_revision_run ON cw_ocr_revisions(source_run_id) WHERE source_run_id IS NOT NULL;

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
 OR (workflow NOT IN ('read_file','revise_file_reading','manage_communication','manage_calendar','manage_approval','recognize_ocr') AND conversation_id IS NOT NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
);
ALTER TABLE cw_runs ADD CONSTRAINT cw_ocr_plan_scope CHECK ((workflow='recognize_ocr')=(ocr_plan IS NOT NULL));
