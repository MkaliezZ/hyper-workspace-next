-- Actor-only calendar execution. It does not inherit an unrelated visible project.
ALTER TABLE cw_runs ADD COLUMN calendar_plan jsonb;
ALTER TABLE cw_runs ADD COLUMN calendar_binding text;
ALTER TABLE cw_calendar_commands ADD COLUMN source_run_id uuid REFERENCES cw_runs;
CREATE INDEX cw_calendar_commands_run ON cw_calendar_commands(source_run_id) WHERE source_run_id IS NOT NULL;
CREATE UNIQUE INDEX cw_calendar_runs_active_command ON cw_runs(workspace_id,actor_id,(calendar_plan->>'commandId'))
 WHERE workflow='manage_calendar' AND calendar_plan->>'operation'='apply' AND state IN ('queued','running');
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
 OR (workflow NOT IN ('read_file','revise_file_reading','manage_communication','manage_calendar') AND conversation_id IS NOT NULL
  AND source_file_asset_id IS NULL AND expected_file_version IS NULL AND source_file_reading_id IS NULL AND expected_reading_version IS NULL)
);
ALTER TABLE cw_runs ADD CONSTRAINT cw_calendar_plan_scope CHECK (
 (workflow='manage_calendar' AND calendar_plan IS NOT NULL AND calendar_binding IS NOT NULL)
 OR (workflow<>'manage_calendar' AND calendar_plan IS NULL AND calendar_binding IS NULL)
);
