-- Published definitions and approval actions are authoritative product records.
CREATE TABLE cw_approval_flows (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 current_version integer NOT NULL CHECK(current_version>0),
 UNIQUE (id,workspace_id)
);
CREATE TABLE cw_approval_flow_versions (
 flow_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL,
 published_by uuid NOT NULL REFERENCES cw_users,
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (flow_id,workspace_id,version),
 FOREIGN KEY (flow_id,workspace_id) REFERENCES cw_approval_flows(id,workspace_id) ON DELETE CASCADE
);
CREATE TABLE cw_approval_requests (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 flow_id uuid NOT NULL,
 flow_version integer NOT NULL,
 applicant_id uuid NOT NULL REFERENCES cw_users,
 state text NOT NULL CHECK(state IN ('draft','active','returned','approved','rejected','withdrawn')),
 revision integer NOT NULL CHECK(revision>0),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 stage integer NOT NULL DEFAULT 0 CHECK(stage>=0),
 form jsonb NOT NULL DEFAULT '{}',
 stages jsonb NOT NULL DEFAULT '[]',
 visible_reviewers uuid[] NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (id,workspace_id),
 FOREIGN KEY (flow_id,workspace_id,flow_version)
   REFERENCES cw_approval_flow_versions(flow_id,workspace_id,version)
);
CREATE INDEX cw_approval_requests_applicant ON cw_approval_requests(workspace_id,applicant_id,updated_at DESC);
CREATE INDEX cw_approval_requests_reviewers ON cw_approval_requests USING gin(visible_reviewers);
CREATE TABLE cw_approval_operations (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES cw_workspaces ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES cw_users,
 request_id uuid,
 flow_id uuid,
 action text NOT NULL,
 idempotency_key uuid NOT NULL,
 params_hash text NOT NULL,
 audit jsonb NOT NULL,
 receipt jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (workspace_id,actor_id,idempotency_key),
 FOREIGN KEY (request_id,workspace_id) REFERENCES cw_approval_requests(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY (flow_id,workspace_id) REFERENCES cw_approval_flows(id,workspace_id) ON DELETE CASCADE,
 CHECK ((request_id IS NULL) <> (flow_id IS NULL))
);
CREATE INDEX cw_approval_operations_request ON cw_approval_operations(workspace_id,request_id,recorded_at,id);
CREATE INDEX cw_approval_operations_recipient ON cw_approval_operations(workspace_id,(audit->>'recipientId'),recorded_at DESC)
 WHERE action='remind';
