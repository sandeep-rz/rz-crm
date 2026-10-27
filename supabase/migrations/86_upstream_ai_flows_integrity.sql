BEGIN;
-- Selective WACRM ports; preserve RZ workspace, semantic-send and retry boundaries.


-- Upstream 046_ai_openai_compatible.sql
-- ============================================================
-- 046_ai_openai_compatible.sql — configurable OpenAI-compatible chat APIs
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS base_url text;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible'));

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_openai_compatible_base_url_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_openai_compatible_base_url_check
  CHECK (
    provider <> 'openai_compatible'
    OR (base_url IS NOT NULL AND btrim(base_url) <> '')
  );

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible'));


-- Upstream 053_ai_reply_integrity.sql
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND ai_reply_count < max_replies
      AND NOT ai_autoreply_disabled
      AND assigned_agent_id IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  WITH any_term AS (
    SELECT string_agg(
             '''' || replace(replace(lexeme, '\', '\\'), '''', '''''') || '''',
             ' | '
           )::tsquery AS query
    FROM unnest(tsvector_to_array(to_tsvector('simple', coalesce(p_query, '')))) AS lexeme
  )
  SELECT c.id,
         c.content,
         ts_rank(c.fts, any_term.query) AS rank
  FROM ai_knowledge_chunks c
  CROSS JOIN any_term
  WHERE any_term.query IS NOT NULL
    AND c.account_id = p_account_id
    AND c.fts @@ any_term.query
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;


-- Upstream 052_flow_run_integrity.sql
ALTER TABLE flow_runs
  DROP CONSTRAINT IF EXISTS flow_runs_status_check;

ALTER TABLE flow_runs
  ADD CONSTRAINT flow_runs_status_check
  CHECK (status IN (
    'active', 'completed', 'handed_off', 'timed_out',
    'paused_by_agent', 'cancelled', 'failed'
  ));

ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS transition_seq INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.replace_flow_nodes(
  p_flow_id UUID,
  p_nodes JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_cancelled INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'p_nodes must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM flows
  WHERE id = p_flow_id
  FOR UPDATE;

  IF v_account_id IS NULL OR NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = '42501';
  END IF;

  DELETE FROM flow_nodes WHERE flow_id = p_flow_id;

  INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
  SELECT
    p_flow_id,
    n->>'node_key',
    n->>'node_type',
    COALESCE(n->'config', '{}'::jsonb),
    COALESCE((n->>'position_x')::INTEGER, 0),
    COALESCE((n->>'position_y')::INTEGER, 0)
  FROM jsonb_array_elements(p_nodes) AS n;

  UPDATE flow_runs r
  SET status = 'cancelled',
      ended_at = NOW(),
      end_reason = 'current_node_removed'
  WHERE r.flow_id = p_flow_id
    AND r.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM flow_nodes fn
      WHERE fn.flow_id = p_flow_id
        AND fn.node_key = r.current_node_key
    );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_flow_nodes(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_flow_nodes(UUID, JSONB) TO authenticated, service_role;


-- Upstream 048_quick_reply_content_matches_kind.sql
ALTER TABLE quick_replies
  DROP CONSTRAINT IF EXISTS quick_replies_content_matches_kind;

ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_content_matches_kind CHECK (
    (kind = 'text' AND content_text IS NOT NULL AND btrim(content_text) <> '')
    OR (kind = 'interactive' AND interactive_payload IS NOT NULL)
  ) NOT VALID;


-- Upstream 049_broadcast_params_jsonb.sql
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  IF p_template_params IS NULL OR jsonb_typeof(p_template_params) <> 'array' THEN
    RAISE EXCEPTION 'p_template_params must be a JSON array with one params array per contact'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_template_params) <> COALESCE(cardinality(p_contact_ids), 0) THEN
    RAISE EXCEPTION 'p_template_params has % entries but p_contact_ids has %',
      jsonb_array_length(p_template_params), COALESCE(cardinality(p_contact_ids), 0)
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_template_params) AS params(value)
    WHERE jsonb_typeof(params.value) <> 'array'
  ) THEN
    RAISE EXCEPTION 'every p_template_params entry must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, contacts_in.cid, 'pending', params_in.prm
    FROM unnest(p_contact_ids) WITH ORDINALITY AS contacts_in(cid, ordinal)
    JOIN jsonb_array_elements(p_template_params) WITH ORDINALITY AS params_in(prm, ordinal)
      ON params_in.ordinal = contacts_in.ordinal
    ORDER BY contacts_in.ordinal
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) TO service_role;


-- RZ already leases continuations with processing_started_at. Only add the stable cursor.
ALTER TABLE public.automation_pending_executions ADD COLUMN IF NOT EXISTS parked_step_id uuid;

-- Protect identity columns without replacing RZ multi-workspace membership semantics.
CREATE OR REPLACE FUNCTION public.enforce_account_identity_columns()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 IF current_user = 'authenticated' AND
    (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
   RAISE EXCEPTION 'Use transfer_account_ownership to change account ownership' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_account_identity_columns() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER enforce_account_identity_columns BEFORE UPDATE ON public.accounts
 FOR EACH ROW EXECUTE FUNCTION public.enforce_account_identity_columns();


-- Adapted account membership locking: set_member_role
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role public.account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role public.account_role_enum;
  v_target_role public.account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Serialize caller/target profile changes before reading the active workspace.
  PERFORM 1 FROM public.profiles
  WHERE user_id IN (auth.uid(), p_user_id) ORDER BY user_id FOR UPDATE;
  SELECT account_id INTO v_account_id
  FROM public.profiles WHERE user_id = auth.uid();
  PERFORM 1 FROM public.accounts WHERE id = v_account_id FOR UPDATE;
  PERFORM 1 FROM public.account_members
  WHERE account_id = v_account_id AND user_id IN (auth.uid(), p_user_id)
  ORDER BY user_id FOR UPDATE;

  SELECT role INTO v_caller_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' OR p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership for owner changes' USING ERRCODE = '22023';
  END IF;

  UPDATE public.account_members
  SET role = p_new_role, updated_at = now()
  WHERE account_id = v_account_id AND user_id = p_user_id;

  UPDATE public.profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_account_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, public.account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, public.account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, public.account_role_enum) TO authenticated;


-- Adapted account membership locking: remove_account_member
CREATE OR REPLACE FUNCTION public.remove_account_member(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role public.account_role_enum;
  v_target_role public.account_role_enum;
  v_fallback_account UUID;
  v_fallback_role public.account_role_enum;
  v_name TEXT;
  v_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Serialize caller/target profile changes before reading the active workspace.
  PERFORM 1 FROM public.profiles
  WHERE user_id IN (auth.uid(), p_user_id) ORDER BY user_id FOR UPDATE;
  SELECT account_id INTO v_account_id
  FROM public.profiles WHERE user_id = auth.uid();
  PERFORM 1 FROM public.accounts WHERE id = v_account_id FOR UPDATE;
  PERFORM 1 FROM public.account_members
  WHERE account_id = v_account_id AND user_id IN (auth.uid(), p_user_id)
  ORDER BY user_id FOR UPDATE;

  SELECT role INTO v_caller_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; switch/leave the account or transfer ownership first' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_user_id;

  -- Only change the target's active workspace if the removed workspace was active.
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = p_user_id AND account_id = v_account_id
  ) THEN
    SELECT am.account_id, am.role
    INTO v_fallback_account, v_fallback_role
    FROM public.account_members am
    WHERE am.user_id = p_user_id
    ORDER BY (am.role = 'owner') DESC, am.joined_at ASC
    LIMIT 1;

    -- Legacy users may not have a second/personal workspace because pre-043
    -- invitation redemption deleted it. Create one only when necessary.
    IF v_fallback_account IS NULL THEN
      SELECT full_name, email INTO v_name, v_email
      FROM public.profiles WHERE user_id = p_user_id;

      INSERT INTO public.accounts (name, owner_user_id)
      VALUES (COALESCE(NULLIF(v_name, ''), v_email, 'My account'), p_user_id)
      RETURNING id INTO v_fallback_account;

      v_fallback_role := 'owner';
      INSERT INTO public.account_members (account_id, user_id, role)
      VALUES (v_fallback_account, p_user_id, 'owner');
    END IF;

    UPDATE public.profiles
    SET account_id = v_fallback_account,
        account_role = v_fallback_role
    WHERE user_id = p_user_id;
  END IF;

  RETURN v_fallback_account;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;


-- Adapted account membership locking: transfer_account_ownership
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(p_new_owner_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role public.account_role_enum;
  v_target_role public.account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Serialize caller/target profile changes before reading the active workspace.
  PERFORM 1 FROM public.profiles
  WHERE user_id IN (auth.uid(), p_new_owner_user_id) ORDER BY user_id FOR UPDATE;
  SELECT account_id INTO v_account_id
  FROM public.profiles WHERE user_id = auth.uid();
  PERFORM 1 FROM public.accounts WHERE id = v_account_id FOR UPDATE;
  PERFORM 1 FROM public.account_members
  WHERE account_id = v_account_id AND user_id IN (auth.uid(), p_new_owner_user_id)
  ORDER BY user_id FOR UPDATE;

  SELECT role INTO v_caller_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = auth.uid();

  IF v_caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM public.account_members
  WHERE account_id = v_account_id AND user_id = p_new_owner_user_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  -- Avoid violating the partial unique owner index: demote then promote in the
  -- same transaction/function call.
  UPDATE public.account_members
  SET role = 'admin', updated_at = now()
  WHERE account_id = v_account_id AND user_id = auth.uid();

  UPDATE public.account_members
  SET role = 'owner', updated_at = now()
  WHERE account_id = v_account_id AND user_id = p_new_owner_user_id;

  UPDATE public.accounts
  SET owner_user_id = p_new_owner_user_id
  WHERE id = v_account_id;

  UPDATE public.profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_account_id;
  UPDATE public.profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

COMMIT;
