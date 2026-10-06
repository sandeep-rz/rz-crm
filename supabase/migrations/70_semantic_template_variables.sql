-- New authoring stores authoritative semantic content. Meta imports require
-- explicit mapping when parameterized. No legacy inference or data backfill.
BEGIN;
ALTER TABLE public.message_templates
  ADD COLUMN template_origin TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN semantic_content JSONB,
  ADD COLUMN semantic_variable_mapping JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN variable_configuration_status TEXT NOT NULL DEFAULT 'needs_mapping',
  ADD CONSTRAINT message_templates_template_origin_check CHECK (template_origin IN ('rgcrm','meta')),
  ADD CONSTRAINT message_templates_rgcrm_semantic_required CHECK (template_origin <> 'rgcrm' OR (semantic_content IS NOT NULL AND variable_configuration_status='configured')),
  ADD CONSTRAINT message_templates_semantic_content_object CHECK (semantic_content IS NULL OR jsonb_typeof(semantic_content)='object'),
  ADD CONSTRAINT message_templates_semantic_mapping_array CHECK (jsonb_typeof(semantic_variable_mapping)='array'),
  ADD CONSTRAINT message_templates_variable_configuration_status_check CHECK (variable_configuration_status IN ('configured','needs_mapping'));
COMMENT ON COLUMN public.message_templates.semantic_content IS 'Canonical RGCRM token content. Labels are dynamically read from message_variable_catalog, never durable identity.';
COMMENT ON COLUMN public.message_templates.semantic_variable_mapping IS 'Component-scoped position/occurrence to canonical variable_key and approval sample. Independent of Meta approval status.';
COMMIT;
