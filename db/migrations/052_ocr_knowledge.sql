ALTER TABLE cw_ocr_documents ADD COLUMN asset_id uuid UNIQUE REFERENCES cw_assets ON DELETE SET NULL;

CREATE VIEW cw_source_bound_assets AS
  SELECT asset_id FROM cw_source_files
  UNION ALL
  SELECT id AS asset_id FROM cw_assets WHERE type='ocr';

CREATE FUNCTION cw_invalidate_ocr_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL AND NEW.asset_id IS NOT NULL THEN
    UPDATE cw_assets SET content='',validity='source_unavailable'
    WHERE id=NEW.asset_id AND workspace_id=NEW.workspace_id AND owner_id=NEW.actor_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cw_invalidate_ocr_knowledge
  AFTER UPDATE OF invalidated_at ON cw_ocr_documents
  FOR EACH ROW EXECUTE FUNCTION cw_invalidate_ocr_knowledge();

-- Existing confirmed pages become eligible for keyword search on upgrade.
-- The application still revalidates source access before returning any result.
WITH candidates AS MATERIALIZED (
  SELECT d.id AS document_id,gen_random_uuid() AS asset_id,d.workspace_id,d.actor_id,
    d.source_title||' · 第 '||d.page||' 页（OCR）' AS title,
    'ocr:'||d.id||'#page='||d.page AS source_ref,
    'ocr:'||d.confirmed_revision AS version,
    string_agg('[第 '||d.page||' 页 · 块 '||b.ordinality||']'||chr(10)||(b.block->>'text'),
      chr(10)||chr(10) ORDER BY b.ordinality) AS content
  FROM cw_ocr_documents d
  JOIN cw_ocr_revisions v ON v.document_id=d.id AND v.revision=d.confirmed_revision AND v.state='confirmed'
  CROSS JOIN LATERAL jsonb_array_elements(v.content->'blocks') WITH ORDINALITY AS b(block,ordinality)
  WHERE d.invalidated_at IS NULL AND d.asset_id IS NULL AND btrim(b.block->>'text')<>''
  GROUP BY d.id
), inserted AS (
  INSERT INTO cw_assets(id,workspace_id,owner_id,visibility,title,content,type,source_ref,source_version)
  SELECT asset_id,workspace_id,actor_id,'private',title,content,'ocr',source_ref,version FROM candidates
  RETURNING id
)
UPDATE cw_ocr_documents d SET asset_id=c.asset_id
FROM candidates c JOIN inserted i ON i.id=c.asset_id WHERE d.id=c.document_id;
