-- CLI-generated migration, numbered after RZ 92. Local implementation only.
-- Selective upstream guards adapted to RZ multi-workspace and connection semantics.
BEGIN;
DROP POLICY IF EXISTS profiles_insert ON public.profiles;
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF current_user <> 'authenticated' THEN RETURN NEW; END IF;
 IF TG_OP = 'INSERT' THEN
   RAISE EXCEPTION 'Profiles are created by signup, not direct inserts' USING ERRCODE='42501';
 END IF;
 IF NEW.account_role IS DISTINCT FROM OLD.account_role OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
   RAISE EXCEPTION 'Use workspace membership RPCs to change account privileges' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;
DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns BEFORE INSERT OR UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'flow-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1] OR ((SELECT auth.uid())::text = (storage.foldername(name))[1] AND am.account_id = (SELECT p.account_id FROM public.profiles p WHERE p.user_id = (SELECT auth.uid()))))))
;

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'flow-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1] OR ((SELECT auth.uid())::text = (storage.foldername(name))[1] AND am.account_id = (SELECT p.account_id FROM public.profiles p WHERE p.user_id = (SELECT auth.uid()))))))
WITH CHECK (bucket_id = 'flow-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1] OR ((SELECT auth.uid())::text = (storage.foldername(name))[1] AND am.account_id = (SELECT p.account_id FROM public.profiles p WHERE p.user_id = (SELECT auth.uid()))))))
;

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'flow-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1] OR ((SELECT auth.uid())::text = (storage.foldername(name))[1] AND am.account_id = (SELECT p.account_id FROM public.profiles p WHERE p.user_id = (SELECT auth.uid()))))))
;

DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'chat-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1])))
;

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'chat-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1])))
WITH CHECK (bucket_id = 'chat-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1])))
;

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'chat-media' AND EXISTS (
 SELECT 1 FROM public.account_members am
 WHERE am.user_id = (SELECT auth.uid()) AND am.role IN ('owner','admin','agent')
 AND (('account-' || am.account_id::text) = (storage.foldername(name))[1])))
;

CREATE OR REPLACE FUNCTION public.enforce_conversation_assignee_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF NEW.assigned_agent_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id
   AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.account_members WHERE user_id=NEW.assigned_agent_id AND account_id=NEW.account_id FOR KEY SHARE;
 IF FOUND THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
   AND EXISTS (SELECT 1 FROM public.account_members WHERE user_id=OLD.assigned_agent_id AND account_id=OLD.account_id)
 THEN NEW.assigned_agent_id := OLD.assigned_agent_id;
 ELSE NEW.assigned_agent_id := NULL; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.enforce_conversation_assignee_membership() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_conversation_assignee_membership() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS enforce_conversation_assignee_membership ON public.conversations;
CREATE TRIGGER enforce_conversation_assignee_membership BEFORE INSERT OR UPDATE OF assigned_agent_id,account_id
 ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.enforce_conversation_assignee_membership();
CREATE OR REPLACE FUNCTION public.clear_removed_member_assignments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 UPDATE public.conversations SET assigned_agent_id=NULL
 WHERE account_id=OLD.account_id AND assigned_agent_id=OLD.user_id;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.clear_removed_member_assignments() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER clear_removed_member_assignments AFTER DELETE ON public.account_members
 FOR EACH ROW EXECUTE FUNCTION public.clear_removed_member_assignments();
UPDATE public.conversations c SET assigned_agent_id=NULL
WHERE assigned_agent_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM public.account_members am WHERE am.account_id=c.account_id AND am.user_id=c.assigned_agent_id
);
CREATE OR REPLACE FUNCTION public.notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.account_members
    WHERE user_id = NEW.assigned_agent_id
      AND account_id = NEW.account_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_conversation_assigned() OWNER TO postgres;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS delivery_lease_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.replace_flow_graph(
  p_flow_id UUID,
  p_nodes JSONB,
  p_flow JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cancelled INTEGER;
BEGIN
  IF p_flow IS NULL OR jsonb_typeof(p_flow) <> 'object' THEN
    RAISE EXCEPTION 'p_flow must be a JSON object' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM flows WHERE id=p_flow_id AND is_account_member(account_id,'agent') FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL THEN RAISE EXCEPTION 'Flow not found' USING ERRCODE='42501'; END IF;
  IF p_flow ? 'whatsapp_config_id' AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config w JOIN flows f ON f.account_id=w.account_id
    WHERE f.id=p_flow_id AND w.id=(p_flow->>'whatsapp_config_id')::uuid
  ) THEN RAISE EXCEPTION 'Invalid flow connection' USING ERRCODE='22023'; END IF;
  IF p_nodes IS NOT NULL THEN v_cancelled := replace_flow_nodes(p_flow_id, p_nodes);
  ELSE v_cancelled := 0; END IF;

  UPDATE flows
  SET whatsapp_config_id = CASE WHEN p_flow ? 'whatsapp_config_id' THEN (p_flow->>'whatsapp_config_id')::uuid ELSE whatsapp_config_id END,
      name = CASE WHEN p_flow ? 'name' THEN p_flow->>'name' ELSE name END,
      description = CASE WHEN p_flow ? 'description' THEN p_flow->>'description' ELSE description END,
      trigger_type = CASE WHEN p_flow ? 'trigger_type' THEN p_flow->>'trigger_type' ELSE trigger_type END,
      trigger_config = CASE WHEN p_flow ? 'trigger_config' THEN p_flow->'trigger_config' ELSE trigger_config END,
      entry_node_id = CASE WHEN p_flow ? 'entry_node_id' THEN p_flow->>'entry_node_id' ELSE entry_node_id END,
      fallback_policy = CASE WHEN p_flow ? 'fallback_policy' THEN p_flow->'fallback_policy' ELSE fallback_policy END,
      updated_at = NOW()
  WHERE id = p_flow_id;

  RETURN v_cancelled;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_flow_graph(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_flow_graph(UUID, JSONB, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_timed_out_flow_runs(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
) RETURNS TABLE (
  id UUID,
  last_advanced_at TIMESTAMPTZ,
  fallback_policy JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.last_advanced_at, f.fallback_policy
  FROM flow_runs r
  LEFT JOIN flows f ON f.id = r.flow_id
  WHERE r.status = 'active'
    AND r.last_advanced_at <= p_now - make_interval(secs => 3600 * (
      CASE
        WHEN jsonb_typeof(f.fallback_policy->'on_timeout_hours') = 'number'
          AND (f.fallback_policy->>'on_timeout_hours')::NUMERIC > 0
        THEN LEAST((f.fallback_policy->>'on_timeout_hours')::NUMERIC, 87600)
        ELSE 24
      END
    )::DOUBLE PRECISION)
  ORDER BY r.last_advanced_at, r.id
  LIMIT GREATEST(p_limit, 0);
$$;

REVOKE ALL ON FUNCTION public.list_timed_out_flow_runs(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_timed_out_flow_runs(TIMESTAMPTZ, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_broadcast_delivery_lease(
  p_broadcast_id UUID
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lease TIMESTAMPTZ;
BEGIN
  UPDATE broadcasts b
  SET delivery_lease_until = now() + INTERVAL '5 minutes'
  WHERE b.id = p_broadcast_id
    AND is_account_member(b.account_id, 'agent')
    AND (b.delivery_lease_until IS NULL OR b.delivery_lease_until < now())
    AND (b.delivery_locked_at IS NULL OR b.delivery_locked_at < now() - INTERVAL '30 minutes')
  RETURNING b.delivery_lease_until INTO v_lease;
  RETURN v_lease;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_broadcast_delivery_lease(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acquire_broadcast_delivery_lease(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.renew_broadcast_delivery_lease(
  p_broadcast_id UUID,
  p_held TIMESTAMPTZ
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lease TIMESTAMPTZ;
BEGIN
  UPDATE broadcasts b
  SET delivery_lease_until = now() + INTERVAL '5 minutes'
  WHERE b.id = p_broadcast_id
    AND is_account_member(b.account_id, 'agent')
    AND b.delivery_lease_until = p_held
    AND b.delivery_lease_until > now()
  RETURNING b.delivery_lease_until INTO v_lease;
  RETURN v_lease;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_broadcast_delivery_lease(UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_broadcast_delivery_lease(UUID, TIMESTAMPTZ) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.broadcast_delivery_in_flight(
  p_broadcast_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT b.delivery_locked_at > now() - INTERVAL '30 minutes'
      OR b.delivery_lease_until > now()
    FROM broadcasts b
    WHERE b.id = p_broadcast_id
  ), FALSE)
$$;

REVOKE ALL ON FUNCTION public.broadcast_delivery_in_flight(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_delivery_in_flight(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.release_broadcast_delivery_lease(p_broadcast_id uuid,p_held timestamptz)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
 UPDATE broadcasts SET delivery_lease_until=NULL WHERE id=p_broadcast_id
 AND delivery_lease_until=p_held AND is_account_member(account_id,'agent');
$$;
REVOKE ALL ON FUNCTION public.release_broadcast_delivery_lease(uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.release_broadcast_delivery_lease(uuid,timestamptz) TO authenticated;
-- Service-only ingestion after admin route authorization. Table row type supplies
-- the installed vector cast; all inserts/deletes share the document lock.
CREATE OR REPLACE FUNCTION public.replace_ai_knowledge_chunks(
 p_account_id uuid,p_document_id uuid,p_content text,p_chunks jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_content text;
BEGIN
 IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
   RAISE EXCEPTION 'Chunks must be an array' USING ERRCODE='22023'; END IF;
 SELECT content INTO v_content FROM ai_knowledge_documents
 WHERE id=p_document_id AND account_id=p_account_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Document not found' USING ERRCODE='42501'; END IF;
 IF v_content IS DISTINCT FROM p_content THEN
   RAISE EXCEPTION 'Document changed during indexing; retry with current content' USING ERRCODE='40001'; END IF;
 DELETE FROM ai_knowledge_chunks WHERE document_id=p_document_id AND account_id=p_account_id;
 INSERT INTO ai_knowledge_chunks(document_id,account_id,chunk_index,content,embedding)
 SELECT p_document_id,p_account_id,c.chunk_index,c.content,c.embedding
 FROM jsonb_array_elements(p_chunks) AS item(value)
 CROSS JOIN LATERAL jsonb_populate_record(NULL::ai_knowledge_chunks,item.value) c;
END $$;
REVOKE ALL ON FUNCTION public.replace_ai_knowledge_chunks(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_ai_knowledge_chunks(uuid,uuid,text,jsonb) TO service_role;
COMMIT;
