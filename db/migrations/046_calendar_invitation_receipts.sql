ALTER TABLE cw_calendar_commands
  ADD COLUMN invitation_status jsonb
    CHECK (invitation_status IS NULL OR jsonb_typeof(invitation_status) = 'array'),
  ADD COLUMN meeting_actor_address text,
  ADD COLUMN meeting_result jsonb
    CHECK (meeting_result IS NULL OR jsonb_typeof(meeting_result) = 'object');
