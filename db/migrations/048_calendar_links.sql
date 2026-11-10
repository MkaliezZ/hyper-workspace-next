-- Private associations are product records. No event content or project publication.
CREATE TABLE cw_calendar_link_operations (
 revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 id uuid NOT NULL UNIQUE,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES cw_users ON DELETE CASCADE,
 source_binding text NOT NULL,
 calendar_id text NOT NULL,
 object_id text NOT NULL,
 source_uid text NOT NULL,
 source_etag text NOT NULL,
 project_id uuid NOT NULL,
 task_id uuid,
 task_version integer,
 linked boolean NOT NULL,
 idempotency_key uuid NOT NULL,
 params_hash text NOT NULL,
 source_run_id uuid REFERENCES cw_runs ON DELETE SET NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (project_id,workspace_id) REFERENCES cw_projects(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY (task_id,workspace_id) REFERENCES cw_tasks(id,workspace_id) ON DELETE CASCADE,
 UNIQUE (workspace_id,actor_id,idempotency_key),
 CHECK ((task_id IS NULL AND task_version IS NULL) OR
        (task_id IS NOT NULL AND task_version IS NOT NULL AND task_version>0))
);
CREATE INDEX cw_calendar_links_event ON cw_calendar_link_operations
 (workspace_id,actor_id,source_binding,calendar_id,object_id,source_uid,project_id,task_id,revision DESC);
CREATE INDEX cw_calendar_links_run ON cw_calendar_link_operations(source_run_id)
 WHERE source_run_id IS NOT NULL;
