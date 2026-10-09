BEGIN;
-- A receipt ledger, not new messaging/connection infrastructure. Without durable
-- capture, large acknowledged history payloads can be lost at after() timeout.
CREATE TABLE public.whatsapp_coexistence_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  connection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  onboarding_epoch text,
  records jsonb NOT NULL CHECK (jsonb_typeof(records)='array' AND jsonb_array_length(records)<=100),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  FOREIGN KEY (connection_id,account_id) REFERENCES public.whatsapp_config(id,account_id) ON DELETE CASCADE
);
ALTER TABLE public.whatsapp_coexistence_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_coexistence_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.whatsapp_coexistence_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.whatsapp_coexistence_events_id_seq TO service_role;
CREATE INDEX ON public.whatsapp_coexistence_events(retry_at,id) WHERE processed_at IS NULL;
CREATE INDEX ON public.whatsapp_coexistence_events(connection_id);
ALTER TABLE public.contacts ADD COLUMN smb_app_contacts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE public.messages ADD COLUMN coexistence_metadata jsonb;
COMMENT ON COLUMN public.messages.coexistence_metadata IS 'History provenance and media placeholders. Imports must not open a Cloud API customer service window.';

CREATE FUNCTION public.capture_whatsapp_coexistence_event(p_events jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE event jsonb; c public.whatsapp_config; matches integer; target uuid;
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid events'; END IF;
  FOR event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    IF nullif(event->>'key','') IS NULL OR jsonb_typeof(event->'records') IS DISTINCT FROM 'array'
      OR jsonb_array_length(event->'records')>100 THEN RAISE EXCEPTION 'Invalid event'; END IF;
    IF event->>'phone_id' IS NULL THEN
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(event->'records') r WHERE r->>'kind' IS DISTINCT FROM 'lifecycle') THEN RAISE EXCEPTION 'Missing phone identity'; END IF;
      -- A WABA is not a phone identity. Resolve a documented display number if
      -- supplied, otherwise accept only a WABA with exactly one connection.
      -- Count ALL mapped numbers, including standard connections.
      SELECT count(*), (array_agg(id))[1] INTO matches,target FROM public.whatsapp_config
        WHERE waba_id=event->>'waba' AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(event->'records') r
          WHERE nullif(r->>'phone','') IS NOT NULL AND
            regexp_replace(coalesce(onboarding_metadata->>'display_phone_number',''),'\D','','g') IS DISTINCT FROM r->>'phone');
      IF matches<>1 THEN CONTINUE; END IF;
    ELSE
      SELECT id INTO target FROM public.whatsapp_config WHERE waba_id=event->>'waba' AND phone_number_id=event->>'phone_id';
    END IF;
    SELECT * INTO c FROM public.whatsapp_config WHERE id=target AND onboarding_metadata->>'onboarding_mode'='coexistence';
    IF NOT FOUND THEN CONTINUE; END IF;
    -- No caller-provided workspace is accepted. All chunks commit before ACK.
    INSERT INTO public.whatsapp_coexistence_events(event_key,connection_id,account_id,onboarding_epoch,records)
      VALUES((event->>'key') || ':' || c.id::text,c.id,c.account_id,c.coexistence_state->>'onboarded_at',event->'records') ON CONFLICT(event_key) DO NOTHING;
  END LOOP;
END $$;

CREATE FUNCTION public.process_whatsapp_coexistence_event(p_limit integer DEFAULT 1)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.whatsapp_coexistence_events; c public.whatsapp_config; r jsonb; person uuid; conv uuid; msg uuid;
  peer text; at_time timestamptz; source jsonb; old_source jsonb; progress integer; row_count integer; processed boolean := false; batch integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'Invalid batch limit'; END IF;
  FOR batch IN 1..p_limit LOOP
    SELECT * INTO e FROM public.whatsapp_coexistence_events WHERE processed_at IS NULL AND retry_at<=clock_timestamp()
      AND attempts<10 ORDER BY retry_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN processed; END IF;
    -- All data writes AND receipt completion are one transaction. SKIP LOCKED
    -- allows overlapping wake-ups. Subtransaction rolls back a failed batch.
    BEGIN
      -- Do not wait on another worker holding a different connection: a bounded
      -- multi-receipt transaction must not build a cycle of connection locks.
      SELECT * INTO c FROM public.whatsapp_config WHERE id=e.connection_id AND account_id=e.account_id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN RETURN processed; END IF;
      IF c.onboarding_metadata->>'onboarding_mode' IS DISTINCT FROM 'coexistence' OR
        (e.onboarding_epoch IS NOT NULL AND e.onboarding_epoch IS DISTINCT FROM c.coexistence_state->>'onboarded_at') THEN
        UPDATE public.whatsapp_coexistence_events SET processed_at=clock_timestamp(),records='[]',last_error='stale_onboarding' WHERE id=e.id;
        processed := true; CONTINUE;
      END IF;
      FOR r IN SELECT value FROM jsonb_array_elements(e.records) LOOP
        IF r->>'kind'='lifecycle' THEN
          at_time := (r->>'at')::timestamptz;
          IF at_time < coalesce((c.coexistence_state->>'onboarded_at')::timestamptz,'-infinity') THEN CONTINUE; END IF;
          IF nullif(r->>'phone','') IS NOT NULL AND regexp_replace(coalesce(c.onboarding_metadata->>'display_phone_number',''),'\D','','g') IS DISTINCT FROM r->>'phone' THEN CONTINUE; END IF;
          IF at_time<=coalesce((c.coexistence_state->>'lifecycle_at')::timestamptz,'-infinity') THEN CONTINUE; END IF;
          UPDATE public.whatsapp_config SET status=CASE WHEN r->>'event'='ACCOUNT_RECONNECTED' THEN 'connected' ELSE 'disconnected' END,
            coexistence_state=coexistence_state || jsonb_build_object('lifecycle_at',at_time,'lifecycle_event',r->>'event','disconnection',r->'disconnection'),
            last_registration_error=CASE WHEN r->>'event'='ACCOUNT_RECONNECTED' THEN NULL ELSE 'WhatsApp Business app connection is offboarded. Check Business Platform settings in the app.' END
            WHERE id=c.id;
          SELECT * INTO c FROM public.whatsapp_config WHERE id=c.id;
          CONTINUE;
        END IF;
        IF r->>'kind'='progress' THEN
          progress := greatest(coalesce((c.coexistence_state->'history'->>'progress')::integer,0),coalesce((r->>'progress')::integer,0));
          source := coalesce(c.coexistence_state->'history','{}') || jsonb_build_object('progress',progress,
            'state',CASE WHEN (r->>'denied')::boolean THEN 'declined' WHEN (r->>'error')::boolean THEN 'partial' WHEN progress=100 THEN 'complete' ELSE 'syncing' END);
          -- Keep chunk identities without depending on delivery ordering.
          IF r ? 'phase' AND r ? 'chunk_order' THEN source := source || jsonb_build_object('chunks',coalesce(source->'chunks','{}') || jsonb_build_object((r->>'phase') || ':' || (r->>'chunk_order'),true)); END IF;
          UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,'{history}',source) WHERE id=c.id;
          SELECT * INTO c FROM public.whatsapp_config WHERE id=c.id;
          CONTINUE;
        END IF;
        peer := r->>'peer'; at_time := (r->>'at')::timestamptz;
        IF peer !~ '^[1-9]\d{6,14}$' OR at_time IS NULL THEN RAISE EXCEPTION 'Invalid identity'; END IF;
        IF (r->>'media_only')::boolean THEN
          -- Look up through the canonical connection and workspace. A media update
          -- may precede its placeholder; retry later rather than creating a wrong thread.
          SELECT m.id INTO msg FROM public.messages m JOIN public.conversations v ON v.id=m.conversation_id
            WHERE v.account_id=c.account_id AND v.whatsapp_config_id=c.id AND m.message_id=r->>'id';
          IF msg IS NULL THEN RAISE EXCEPTION 'History media awaiting message'; END IF;
          UPDATE public.messages SET content_type=r->>'type',content_text=r->>'text',media_url=CASE WHEN nullif(r->>'media_id','') IS NOT NULL THEN '/api/whatsapp/media/' || (r->>'media_id') || '?whatsapp_config_id=' || c.id::text ELSE media_url END,media_type=r->>'mime_type',
            coexistence_metadata=coalesce(coexistence_metadata,'{}') || jsonb_build_object('placeholder',false,'media_id',r->'media_id') WHERE id=msg;
          CONTINUE;
        END IF;
        INSERT INTO public.contacts(account_id,user_id,phone,name) VALUES(c.account_id,c.user_id,peer,coalesce(nullif(r->>'name',''),peer))
          ON CONFLICT (account_id,phone_normalized) WHERE phone_normalized<>'' DO NOTHING;
        SELECT id,smb_app_contacts->c.id::text INTO person,old_source FROM public.contacts WHERE account_id=c.account_id AND phone_normalized=peer FOR UPDATE;
        IF person IS NULL THEN RAISE EXCEPTION 'Contact unavailable'; END IF;
        IF r->>'kind'='contact' THEN
          IF at_time<=coalesce((old_source->>'at')::timestamptz,'-infinity') THEN CONTINUE; END IF;
          -- Preserve CRM contacts and their history when the phone address book removes
          -- a contact; only the app-origin relationship is removed.
          source := jsonb_build_object('at',at_time,'removed',r->'removed','name',r->'name');
          UPDATE public.contacts SET smb_app_contacts=jsonb_set(smb_app_contacts,ARRAY[c.id::text],source),
            name=CASE WHEN coalesce(name,'') IN ('',peer,coalesce(old_source->>'name','')) AND NOT (r->>'removed')::boolean THEN coalesce(nullif(r->>'name',''),name) ELSE name END
            WHERE id=person AND account_id=c.account_id;
          UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,'{smb_app_state_sync}',
            coalesce(coexistence_state->'smb_app_state_sync','{}') || '{"state":"syncing"}') WHERE id=c.id;
          CONTINUE;
        END IF;
        INSERT INTO public.conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES(c.account_id,c.user_id,person,c.id)
          ON CONFLICT (account_id,contact_id,whatsapp_config_id) WHERE whatsapp_config_id IS NOT NULL DO NOTHING;
        SELECT id INTO conv FROM public.conversations WHERE account_id=c.account_id AND contact_id=person AND whatsapp_config_id=c.id;
        INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_url,media_type,message_id,status,created_at,coexistence_metadata)
          VALUES(conv,CASE WHEN (r->>'outbound')::boolean THEN 'agent' ELSE 'customer' END,r->>'type',r->>'text',CASE WHEN nullif(r->>'media_id','') IS NOT NULL THEN '/api/whatsapp/media/' || (r->>'media_id') || '?whatsapp_config_id=' || c.id::text ELSE NULL END,r->>'mime_type',r->>'id',r->>'status',at_time,
            jsonb_build_object('history',r->'history','placeholder',r->'placeholder','media_id',r->'media_id'))
          ON CONFLICT (conversation_id,message_id) DO UPDATE SET content_type=excluded.content_type,content_text=excluded.content_text,media_type=excluded.media_type,media_url=excluded.media_url,coexistence_metadata=excluded.coexistence_metadata
            WHERE messages.coexistence_metadata->>'placeholder'='true' AND excluded.coexistence_metadata->>'placeholder'='false';
        GET DIAGNOSTICS row_count = ROW_COUNT;
        IF row_count>0 THEN
          -- Imported old chunks never replace a newer live inbox summary or bump unread.
          UPDATE public.conversations SET last_message_at=at_time,last_message_text=r->>'text'
            WHERE id=conv AND (last_message_at IS NULL OR last_message_at<at_time);
        END IF;
      END LOOP;
      UPDATE public.whatsapp_coexistence_events SET processed_at=clock_timestamp(),records='[]',last_error=NULL WHERE id=e.id;
    EXCEPTION WHEN OTHERS THEN
      -- Store only a bounded SQLSTATE, never contact/message contents or credentials.
      UPDATE public.whatsapp_coexistence_events SET attempts=attempts+1,last_error=SQLSTATE,
        retry_at=clock_timestamp()+least(interval '30 minutes',interval '30 seconds'*power(2,attempts)) WHERE id=e.id;
    END;
    processed := true;
  END LOOP;
  RETURN processed;
END $$;
REVOKE ALL ON FUNCTION public.capture_whatsapp_coexistence_event(jsonb),public.process_whatsapp_coexistence_event(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.capture_whatsapp_coexistence_event(jsonb),public.process_whatsapp_coexistence_event(integer) TO service_role;
CREATE FUNCTION public.whatsapp_coexistence_import_summary(p_account uuid)
RETURNS TABLE(connection_id uuid,pending bigint,failed bigint) LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT c.id,count(e.id) FILTER (WHERE e.processed_at IS NULL),
    count(e.id) FILTER (WHERE e.processed_at IS NULL AND e.attempts>=10)
  FROM public.whatsapp_config c LEFT JOIN public.whatsapp_coexistence_events e ON e.connection_id=c.id AND e.account_id=c.account_id AND e.processed_at IS NULL
  WHERE c.account_id=p_account AND c.onboarding_metadata->>'onboarding_mode'='coexistence' GROUP BY c.id
$$;
REVOKE ALL ON FUNCTION public.whatsapp_coexistence_import_summary(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_coexistence_import_summary(uuid) TO service_role;
-- Reuse the existing pg_cron background infrastructure. SQL-only imports need
-- no second webhook endpoint, application worker, Vault token, or HTTP wake-up.
SELECT cron.schedule('whatsapp-coexistence-import','* * * * *',
  'SELECT public.process_whatsapp_coexistence_event(25)');
COMMIT;
