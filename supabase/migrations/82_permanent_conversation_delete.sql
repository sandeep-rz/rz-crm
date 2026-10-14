-- Permanent chat deletion. The small tombstone prevents delayed provider history
-- from recreating erased messages; it contains no message text or contact name.
BEGIN;
CREATE TABLE public.conversation_deletions (
  conversation_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  whatsapp_config_id uuid REFERENCES public.whatsapp_config(id) ON DELETE SET NULL,
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  media_urls text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX conversation_deletions_peer ON public.conversation_deletions
  (account_id, contact_id, whatsapp_config_id, deleted_at);
ALTER TABLE public.conversation_deletions ENABLE ROW LEVEL SECURITY;
-- Only server workers and the checked SECURITY DEFINER function access tombstones.
REVOKE ALL ON public.conversation_deletions FROM anon, authenticated;
GRANT ALL ON public.conversation_deletions TO service_role;

CREATE FUNCTION public.is_deleted_conversation_message(
  p_account uuid, p_contact uuid, p_connection uuid, p_sent_at timestamptz
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.conversation_deletions d
    WHERE d.account_id=p_account AND d.contact_id=p_contact
      AND d.whatsapp_config_id IS NOT DISTINCT FROM p_connection
      AND (p_sent_at IS NULL OR p_sent_at <= d.deleted_at));
$$;
REVOKE ALL ON FUNCTION public.is_deleted_conversation_message(uuid,uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_deleted_conversation_message(uuid,uuid,uuid,timestamptz) TO service_role;

CREATE FUNCTION public.delete_conversation_permanently(p_account uuid,p_conversation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.conversations; phone text; urls text[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_account_member(p_account,'admin') THEN
    RAISE EXCEPTION 'Insufficient role' USING ERRCODE='42501';
  END IF;
  SELECT * INTO c FROM public.conversations WHERE id=p_conversation AND account_id=p_account FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    SELECT media_urls INTO urls FROM public.conversation_deletions
      WHERE conversation_id=p_conversation AND account_id=p_account;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('media_urls',urls);
  END IF;
  -- Serialize with Coexistence imports, which lock the same connection.
  IF c.whatsapp_config_id IS NOT NULL THEN
    SELECT phone_number_id INTO phone FROM public.whatsapp_config WHERE id=c.whatsapp_config_id FOR UPDATE NOWAIT;
  END IF;
  IF EXISTS (SELECT 1 FROM public.whatsapp_coexistence_events e
    WHERE e.lease_until>clock_timestamp() AND e.processed_at IS NULL
      AND (e.stages->'context'->>'conversation'=c.id::text
        OR (phone IS NOT NULL AND e.payload::text LIKE '%' || phone || '%')))
    OR EXISTS (SELECT 1 FROM public.automation_pending_executions
      WHERE account_id=p_account AND context->>'conversation_id'=c.id::text AND status='running')
    OR EXISTS (SELECT 1 FROM public.flow_runs WHERE conversation_id=c.id
      AND status='active' AND last_advanced_at>clock_timestamp()-interval '3 minutes') THEN
    RAISE EXCEPTION 'conversation_busy';
  END IF;
  SELECT coalesce(array_agg(DISTINCT media_url) FILTER (WHERE media_url IS NOT NULL),'{}')
    INTO urls FROM public.messages WHERE conversation_id=c.id;
  INSERT INTO public.conversation_deletions(conversation_id,account_id,contact_id,whatsapp_config_id,media_urls)
    VALUES(c.id,c.account_id,c.contact_id,c.whatsapp_config_id,urls);
  UPDATE public.automation_pending_executions SET status='failed',last_error='Conversation permanently deleted'
    WHERE account_id=p_account AND context->>'conversation_id'=c.id::text AND status='pending';
  UPDATE public.flow_runs SET status='paused_by_agent',ended_at=clock_timestamp(),end_reason='conversation_deleted'
    WHERE conversation_id=c.id AND status='active';
  UPDATE public.deals SET conversation_id=NULL WHERE conversation_id=c.id;
  DELETE FROM public.conversations WHERE id=c.id;
  RETURN jsonb_build_object('media_urls',urls);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'conversation_busy';
END;
$$;
REVOKE ALL ON FUNCTION public.delete_conversation_permanently(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.delete_conversation_permanently(uuid,uuid) TO authenticated;
-- Clients must use the checked RPC so cleanup cannot be bypassed.
REVOKE DELETE ON public.conversations FROM authenticated,anon;

-- Check every durable consumer, including references nested in JSON configs.
-- A path fragment also protects public/signed URL aliases of the same object.
CREATE FUNCTION public.conversation_media_is_referenced(p_url text,p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM (
    SELECT to_jsonb(m)::text AS value FROM public.messages m
    UNION ALL SELECT to_jsonb(t)::text FROM public.message_templates t
    UNION ALL SELECT to_jsonb(q)::text FROM public.quick_replies q
    UNION ALL SELECT to_jsonb(n)::text FROM public.flow_nodes n
    UNION ALL SELECT to_jsonb(s)::text FROM public.automation_steps s
    UNION ALL SELECT to_jsonb(b)::text FROM public.broadcasts b
    UNION ALL SELECT to_jsonb(r)::text FROM public.flow_runs r
    UNION ALL SELECT to_jsonb(e)::text FROM public.automation_pending_executions e
  ) consumers WHERE strpos(value,p_url)>0 OR strpos(value,p_path)>0);
$$;
REVOKE ALL ON FUNCTION public.conversation_media_is_referenced(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_media_is_referenced(text,text) TO service_role;

-- Close the check/insert race for durable ordinary deliveries. The importer
-- already holds this connection lock and applies its own timestamp guard.
CREATE FUNCTION public.guard_deleted_conversation_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE payload jsonb; sent_at timestamptz;
BEGIN
  IF NEW.whatsapp_config_id IS NOT NULL THEN
    PERFORM 1 FROM public.whatsapp_config WHERE id=NEW.whatsapp_config_id FOR UPDATE;
  END IF;
  IF NEW.creation_delivery_id IS NOT NULL THEN
    SELECT e.payload INTO payload FROM public.whatsapp_coexistence_events e WHERE e.id=NEW.creation_delivery_id;
    SELECT min(to_timestamp((m->>'timestamp')::double precision)) INTO sent_at
      FROM jsonb_array_elements(payload->'entry') entry,
        jsonb_array_elements(entry->'changes') change,
        jsonb_array_elements(change->'value'->'messages') m;
    IF public.is_deleted_conversation_message(NEW.account_id,NEW.contact_id,NEW.whatsapp_config_id,sent_at) THEN
      RAISE EXCEPTION 'conversation_deleted';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_deleted_conversation_insert() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_deleted_conversation_insert BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_conversation_insert();

-- Keep the existing history importer; add the deletion cutoff before its insert.
DO $$
DECLARE definition text; anchor text := 'INSERT INTO public.conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES(c.account_id,c.user_id,person,c.id)';
BEGIN
  definition := pg_get_functiondef('public.process_whatsapp_coexistence_event(integer,integer)'::regprocedure);
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'History importer changed; review deletion guard'; END IF;
  EXECUTE replace(definition,anchor,
    'IF public.is_deleted_conversation_message(c.account_id,person,c.id,at_time) THEN CONTINUE; END IF; ' || anchor);
END $$;
COMMIT;
