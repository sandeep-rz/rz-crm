BEGIN;
-- CLI-created migration renamed to 79 to follow this repository's legacy numbered order.
-- Internal mutations must not be available through the public Data API.
REVOKE ALL ON FUNCTION public._bcast_bump(uuid,text,integer), public.recompute_broadcast_counts(uuid), public.claim_ai_reply_slot(uuid,integer), public.record_webhook_failure(uuid,integer), public.merge_duplicate_contacts(), public.merge_duplicate_conversations() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid,text,integer), public.recompute_broadcast_counts(uuid), public.claim_ai_reply_slot(uuid,integer), public.record_webhook_failure(uuid,integer) TO service_role;
-- These installation-time maintenance functions predate multi-number inboxes.
-- No runtime caller needs them; retain their signatures without unsafe merging.
CREATE OR REPLACE FUNCTION public.merge_duplicate_contacts() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Use reviewed connection-aware maintenance' USING ERRCODE='42501'; END $$;
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Use reviewed connection-aware maintenance' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts(),public.merge_duplicate_conversations() FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.messages ADD COLUMN inbound_delivery_id bigint;
ALTER TABLE public.contacts ADD COLUMN creation_delivery_id bigint;
ALTER TABLE public.conversations ADD COLUMN creation_delivery_id bigint;
CREATE INDEX whatsapp_unresolved_reply ON public.messages(conversation_id,(coexistence_metadata->'context'->>'id'))
 WHERE reply_to_message_id IS NULL AND coexistence_metadata->'context'->>'id' IS NOT NULL;

-- Extend the single existing receipt ledger for signed ordinary deliveries.
ALTER TABLE public.whatsapp_coexistence_events ALTER COLUMN connection_id DROP NOT NULL, ALTER COLUMN account_id DROP NOT NULL,
 ADD COLUMN event_kind text NOT NULL DEFAULT 'coexistence' CHECK(event_kind IN ('coexistence','delivery')),
 ADD COLUMN priority smallint NOT NULL DEFAULT 1,
 ADD COLUMN payload jsonb, ADD COLUMN lease_id uuid, ADD COLUMN lease_until timestamptz,
 ADD COLUMN stages jsonb NOT NULL DEFAULT '{}';
UPDATE public.whatsapp_coexistence_events SET priority=CASE WHEN records @> '[{"kind":"lifecycle"}]' THEN 0 WHEN (records @> '[{"history":true}]' OR records @> '[{"kind":"progress"}]') THEN 3 ELSE 1 END;
CREATE INDEX whatsapp_pending_lifecycle ON public.whatsapp_coexistence_events(connection_id,id) WHERE event_kind='coexistence' AND priority=0 AND processed_at IS NULL;
CREATE INDEX whatsapp_coexistence_priority_claim ON public.whatsapp_coexistence_events(priority,retry_at,id) WHERE event_kind='coexistence' AND processed_at IS NULL AND attempts<10;
CREATE INDEX whatsapp_first_inbound_intent ON public.whatsapp_coexistence_events((stages->'context'->>'conversation')) WHERE stages->'context'->>'firstInbound'='true';
CREATE INDEX whatsapp_delivery_claim ON public.whatsapp_coexistence_events(priority,retry_at,id) WHERE event_kind='delivery' AND processed_at IS NULL AND attempts<10;
CREATE FUNCTION public.capture_whatsapp_delivery(p_key text,p_payload jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF length(p_key)>200 OR p_key IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>4000000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
 INSERT INTO public.whatsapp_coexistence_events(event_key,event_kind,records,payload,priority) VALUES('delivery:'||p_key,'delivery','[]',p_payload,CASE p_payload->'entry'->0->'changes'->0->>'field' WHEN 'account_update' THEN 0 WHEN 'history' THEN 3 WHEN 'smb_app_state_sync' THEN 2 ELSE 1 END) ON CONFLICT(event_key) DO NOTHING;
END $$;
CREATE FUNCTION public.capture_whatsapp_deliveries(p_deliveries jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(p_deliveries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_deliveries)>1000 OR octet_length(p_deliveries::text)>8000000 THEN RAISE EXCEPTION 'Invalid delivery batch'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_deliveries) LOOP
  PERFORM public.capture_whatsapp_delivery(item->>'key',item->'payload');
 END LOOP;
END $$;

CREATE FUNCTION public.claim_whatsapp_deliveries(p_limit integer,p_lease uuid) RETURNS SETOF public.whatsapp_coexistence_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_limit NOT BETWEEN 1 AND 20 OR p_lease IS NULL THEN RAISE EXCEPTION 'Invalid claim'; END IF;
 RETURN QUERY UPDATE public.whatsapp_coexistence_events e SET lease_id=p_lease,lease_until=clock_timestamp()+interval '3 minutes',attempts=attempts+1
 WHERE e.id IN (SELECT id FROM public.whatsapp_coexistence_events WHERE event_kind='delivery' AND processed_at IS NULL AND attempts<10 AND retry_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY priority,retry_at,id FOR UPDATE SKIP LOCKED LIMIT p_limit) RETURNING e.*;
END $$;
CREATE FUNCTION public.finish_whatsapp_delivery(p_id bigint,p_lease uuid,p_error text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.whatsapp_coexistence_events SET processed_at=CASE WHEN p_error IS NULL THEN clock_timestamp() ELSE NULL END,
 payload=CASE WHEN p_error IS NULL THEN NULL ELSE payload END, lease_id=NULL,lease_until=NULL,last_error=left(p_error,80),
 retry_at=clock_timestamp()+least(interval '30 minutes',interval '30 seconds'*power(2,attempts))
 WHERE id=p_id AND lease_id=p_lease AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'Delivery lease changed' USING ERRCODE='42501'; END IF;
END $$;
-- Claim side effects before invoking them. Unknown external outcomes remain visible,
-- never repeated after a worker restart. Done-stage results support flow replay.
CREATE FUNCTION public.whatsapp_delivery_stage(p_id bigint,p_lease uuid,p_stage text,p_result jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.whatsapp_coexistence_events; previous jsonb;
BEGIN
 SELECT * INTO STRICT e FROM public.whatsapp_coexistence_events WHERE id=p_id FOR UPDATE;
 IF e.lease_id IS DISTINCT FROM p_lease OR e.lease_until<=clock_timestamp() OR length(p_stage)>100 THEN RAISE EXCEPTION 'Invalid stage lease' USING ERRCODE='42501'; END IF;
 previous:=e.stages->p_stage;
 IF p_result IS NOT NULL THEN
  IF previous->>'lease' IS DISTINCT FROM p_lease::text OR previous->>'state'<>'started' THEN RAISE EXCEPTION 'Stage changed'; END IF;
  UPDATE public.whatsapp_coexistence_events SET stages=jsonb_set(stages,ARRAY[p_stage],jsonb_build_object('state','done','result',p_result)) WHERE id=p_id;
  RETURN jsonb_build_object('state','done','result',p_result);
 END IF;
 IF previous IS NOT NULL THEN RETURN previous; END IF;
 previous:=jsonb_build_object('state','started','lease',p_lease);
 UPDATE public.whatsapp_coexistence_events SET stages=jsonb_set(stages,ARRAY[p_stage],previous) WHERE id=p_id;
 RETURN jsonb_build_object('state','claimed');
END $$;
-- Inbox bookkeeping is transactionally fenced with its durable stage marker.
CREATE FUNCTION public.apply_whatsapp_inbound(p_id bigint,p_lease uuid,p_conversation uuid,p_text text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.whatsapp_coexistence_events; v public.conversations; recipient uuid;
BEGIN
 SELECT * INTO STRICT e FROM public.whatsapp_coexistence_events WHERE id=p_id FOR UPDATE;
 IF e.lease_id IS DISTINCT FROM p_lease OR e.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid inbox lease' USING ERRCODE='42501'; END IF;
 IF e.stages ? 'inbox' THEN RETURN; END IF;
 SELECT * INTO STRICT v FROM public.conversations WHERE id=p_conversation FOR UPDATE;
 -- Attribute one reply per provider message, in the same transaction as inbox
 -- bookkeeping. Include already-replied recipients in the latest selection:
 -- neither receipt retries nor distinct follow-up messages consume older broadcasts.
 SELECT r.id INTO recipient FROM public.broadcast_recipients r JOIN public.broadcasts b ON b.id=r.broadcast_id
 WHERE r.contact_id=v.contact_id AND b.account_id=v.account_id AND b.whatsapp_config_id=v.whatsapp_config_id
  AND r.status IN ('sent','delivered','read','replied') AND r.sent_at IS NOT NULL
  AND r.sent_at<=to_timestamp((e.payload->'entry'->0->'changes'->0->'value'->'messages'->0->>'timestamp')::double precision)
 ORDER BY r.sent_at DESC,r.id DESC LIMIT 1 FOR UPDATE OF r;
 IF recipient IS NOT NULL THEN
  UPDATE public.broadcast_recipients SET status='replied',replied_at=clock_timestamp()
   WHERE id=recipient AND status IN ('sent','delivered','read');
 END IF;
 PERFORM public.bump_conversation_on_inbound(p_conversation,p_text);
 UPDATE public.messages child SET reply_to_message_id=parent.id FROM public.messages parent
 WHERE child.conversation_id=p_conversation AND parent.conversation_id=p_conversation
  AND parent.message_id=e.payload->'entry'->0->'changes'->0->'value'->'messages'->0->>'id'
  AND parent.message_id=child.coexistence_metadata->'context'->>'id' AND child.reply_to_message_id IS NULL AND child.coexistence_metadata->'context'->>'id' IS NOT NULL;
 UPDATE public.whatsapp_coexistence_events SET stages=stages||'{"inbox":{"state":"done"}}' WHERE id=p_id;
END $$;

CREATE FUNCTION public.whatsapp_delivery_context(p_id bigint,p_lease uuid,p_context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.whatsapp_coexistence_events; conversation uuid; first_inbound boolean;
BEGIN
 SELECT * INTO STRICT e FROM public.whatsapp_coexistence_events WHERE id=p_id FOR UPDATE;
 IF e.lease_id IS DISTINCT FROM p_lease OR e.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid context lease' USING ERRCODE='42501'; END IF;
 IF e.stages ? 'context' THEN RETURN e.stages->'context'; END IF;
 conversation:=(p_context->>'conversation')::uuid;
 IF conversation IS NOT NULL THEN
  -- Serialize first-inbound intent before message insertion. Distinct concurrent
  -- deliveries must not both send a first-contact welcome while media is loading.
  PERFORM 1 FROM public.conversations WHERE id=conversation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation unavailable'; END IF;
  first_inbound:=coalesce((p_context->>'firstInbound')::boolean,false)
    AND NOT EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=conversation AND sender_type='customer')
    AND NOT EXISTS(SELECT 1 FROM public.whatsapp_coexistence_events WHERE stages->'context'->>'conversation'=conversation::text AND stages->'context'->>'firstInbound'='true');
  p_context:=p_context||jsonb_build_object('firstInbound',first_inbound);
 END IF;
 UPDATE public.whatsapp_coexistence_events SET stages=stages||jsonb_build_object('context',p_context) WHERE id=p_id;
 RETURN p_context;
END $$;

CREATE FUNCTION public.apply_whatsapp_status(p_phone text,p_waba text,p_status jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.whatsapp_config; result jsonb; state text:=p_status->>'status'; err jsonb:=p_status->'errors'->0; at_time timestamptz;
BEGIN
 SELECT * INTO STRICT c FROM public.whatsapp_config WHERE phone_number_id=p_phone AND waba_id=p_waba;
 IF state NOT IN ('sent','delivered','read','failed') THEN RETURN NULL; END IF;
 at_time:=to_timestamp((p_status->>'timestamp')::double precision);
 UPDATE public.messages m SET status=state,
  error_code=CASE WHEN state='failed' THEN (err->>'code')::integer ELSE m.error_code END,
  error_title=CASE WHEN state='failed' THEN err->>'title' ELSE m.error_title END,
  error_details=CASE WHEN state='failed' THEN err->'error_data'->>'details' ELSE m.error_details END
 FROM public.conversations v WHERE m.conversation_id=v.id AND v.account_id=c.account_id AND v.whatsapp_config_id=c.id AND m.message_id=p_status->>'id'
 AND CASE state WHEN 'read' THEN m.status IN ('sending','sent','delivered') WHEN 'delivered' THEN m.status IN ('sending','sent') WHEN 'sent' THEN m.status='sending' WHEN 'failed' THEN m.status IN ('sending','sent') ELSE false END;
 UPDATE public.broadcast_recipients r SET status=state,
  sent_at=CASE WHEN state='sent' THEN at_time ELSE r.sent_at END,
  delivered_at=CASE WHEN state='delivered' THEN at_time ELSE r.delivered_at END,
  read_at=CASE WHEN state='read' THEN at_time ELSE r.read_at END,
  error_message=CASE WHEN state='failed' THEN '['||coalesce(err->>'code','')||'] '||coalesce(err->>'title','Failed') ELSE r.error_message END
 FROM public.broadcasts b WHERE r.broadcast_id=b.id AND b.account_id=c.account_id AND b.whatsapp_config_id=c.id AND r.whatsapp_message_id=p_status->>'id'
 AND CASE state WHEN 'read' THEN r.status IN ('pending','sent','delivered') WHEN 'delivered' THEN r.status IN ('pending','sent') WHEN 'sent' THEN r.status='pending' WHEN 'failed' THEN r.status IN ('pending','sent') ELSE false END;
 SELECT jsonb_build_object('matched',true,'account_id',c.account_id,'conversation_id',m.conversation_id,'status',m.status) INTO result FROM public.messages m JOIN public.conversations v ON v.id=m.conversation_id
 WHERE v.account_id=c.account_id AND v.whatsapp_config_id=c.id AND m.message_id=p_status->>'id' LIMIT 1;
 IF result IS NULL THEN
  -- Some broadcasts have no Inbox row. Match the recipient independently,
  -- including duplicate or regressive statuses that correctly changed no rows.
  SELECT jsonb_build_object('matched',true,'account_id',c.account_id,'conversation_id',NULL,'status',r.status)
   INTO result FROM public.broadcast_recipients r JOIN public.broadcasts b ON b.id=r.broadcast_id
   WHERE b.account_id=c.account_id AND b.whatsapp_config_id=c.id AND r.whatsapp_message_id=p_status->>'id' LIMIT 1;
 END IF;
 RETURN coalesce(result,jsonb_build_object('matched',false));
END $$;

-- One shared send budget, independent of the connection/import row lock.
CREATE TABLE public.whatsapp_send_budgets(phone_number_id text PRIMARY KEY, next_send_at timestamptz NOT NULL);
ALTER TABLE public.whatsapp_send_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_send_budgets FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.whatsapp_send_budgets TO service_role;
CREATE FUNCTION public.acquire_whatsapp_send(p_phone text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.whatsapp_config; slot timestamptz; spacing interval; pending_lifecycle text;
BEGIN
 SELECT * INTO c FROM public.whatsapp_config WHERE phone_number_id=p_phone;
 IF NOT FOUND OR (c.onboarding_metadata->>'onboarding_mode'='coexistence' AND c.status<>'connected') THEN RETURN -1; END IF;
 -- A captured offboarding event also pauses sending while import-row locks
 -- postpone its application. This reads the same durable receipt ledger.
 IF c.onboarding_metadata->>'onboarding_mode'='coexistence' THEN
  SELECT r->>'event' INTO pending_lifecycle FROM public.whatsapp_coexistence_events e CROSS JOIN LATERAL jsonb_array_elements(e.records) r
    WHERE e.connection_id=c.id AND e.event_kind='coexistence' AND e.priority=0 AND e.processed_at IS NULL AND r->>'kind'='lifecycle'
      AND (r->>'at')::timestamptz>coalesce((c.coexistence_state->>'lifecycle_at')::timestamptz,'-infinity')
      AND (r->>'at')::timestamptz>=coalesce((c.coexistence_state->>'onboarded_at')::timestamptz,'-infinity')
    ORDER BY (r->>'at')::timestamptz DESC LIMIT 1;
  IF pending_lifecycle IN ('ACCOUNT_OFFBOARDED','PARTNER_REMOVED') THEN RETURN -1; END IF;
 END IF;
 -- Conservative 20mps ceiling for all modes until standard capability is verified.
 spacing:=interval '50 milliseconds';
 INSERT INTO public.whatsapp_send_budgets VALUES(p_phone,clock_timestamp()) ON CONFLICT DO NOTHING;
 SELECT next_send_at INTO slot FROM public.whatsapp_send_budgets WHERE phone_number_id=p_phone FOR UPDATE;
 IF slot>clock_timestamp() THEN RETURN greatest(1,ceil(extract(epoch FROM slot-clock_timestamp())*1000)::integer); END IF;
 UPDATE public.whatsapp_send_budgets SET next_send_at=clock_timestamp()+spacing WHERE phone_number_id=p_phone;
 RETURN 0;
END $$;

CREATE FUNCTION public.fail_whatsapp_coexistence_sync(p_connection uuid,p_type text,p_code integer DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,ARRAY[p_type],coexistence_state->p_type||jsonb_build_object('state','rejected','error_code',p_code))
 WHERE id=p_connection AND p_type IN ('history','smb_app_state_sync') AND coexistence_state->p_type->>'state'='unconfirmed';
END $$;

-- A missing request is durable work immediately after connection finalization.
-- No separate queue: the existing connection state is the source of truth.
CREATE FUNCTION public.pending_whatsapp_coexistence_sync() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT id FROM public.whatsapp_config WHERE status='connected' AND onboarding_metadata->>'onboarding_mode'='coexistence'
 AND (NOT coexistence_state ? 'history' OR NOT coexistence_state ? 'smb_app_state_sync') ORDER BY connected_at LIMIT 10
$$;

-- Staged token authorization allows code exchange before session asset selection.
ALTER TABLE public.whatsapp_signup_attempts ADD COLUMN authorization_token text, ADD COLUMN authorization_lease uuid, ADD COLUMN authorization_started_at timestamptz;
CREATE FUNCTION public.begin_whatsapp_authorization(p_attempt uuid,p_user uuid,p_account uuid,p_hash text,p_lease uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts;
BEGIN
 SELECT * INTO STRICT a FROM public.whatsapp_signup_attempts WHERE id=p_attempt AND user_id=p_user AND account_id=p_account FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_user AND account_id=p_account AND account_role IN ('admin','owner')) OR a.expires_at<=clock_timestamp() OR a.discarded_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid authorization' USING ERRCODE='42501'; END IF;
 IF a.authorization_token IS NOT NULL AND a.code_hash=p_hash THEN RETURN a.authorization_token; END IF;
 IF a.authorization_started_at IS NOT NULL OR a.state<>'pending' THEN RAISE EXCEPTION 'Fresh authorization required'; END IF;
 UPDATE public.whatsapp_signup_attempts SET code_hash=p_hash,authorization_lease=p_lease,authorization_started_at=clock_timestamp() WHERE id=p_attempt;
 RETURN NULL;
END $$;
CREATE FUNCTION public.save_whatsapp_authorization(p_attempt uuid,p_lease uuid,p_token text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.whatsapp_signup_attempts SET authorization_token=p_token WHERE id=p_attempt AND authorization_lease=p_lease AND authorization_started_at>clock_timestamp()-interval '2 minutes' AND discarded_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authorization changed' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION public.clear_whatsapp_authorization() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.state='complete' OR NEW.discarded_at IS NOT NULL THEN NEW.authorization_token:=NULL; NEW.authorization_lease:=NULL; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clear_whatsapp_authorization() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER clear_whatsapp_authorization BEFORE UPDATE ON public.whatsapp_signup_attempts FOR EACH ROW EXECUTE FUNCTION public.clear_whatsapp_authorization();

CREATE OR REPLACE FUNCTION public.claim_whatsapp_signup(p_attempt uuid,p_user uuid,p_account uuid,p_lease uuid,p_hash text DEFAULT NULL,p_context jsonb DEFAULT NULL,p_mode text DEFAULT NULL)
RETURNS SETOF public.whatsapp_signup_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.whatsapp_signup_attempts; normalized jsonb := p_context;
BEGIN
  SELECT * INTO a FROM public.whatsapp_signup_attempts WHERE id=p_attempt AND user_id=p_user AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid session' USING ERRCODE='42501'; END IF;
  IF a.authorization_token IS NOT NULL AND p_hash IS NOT NULL AND a.code_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'Authorization code mismatch' USING ERRCODE='42501'; END IF;
  IF p_mode IS NOT NULL AND p_mode NOT IN ('cloud_api','coexistence') THEN RAISE EXCEPTION 'Invalid mode' USING ERRCODE='22023'; END IF;
  -- The persisted choice is server-bound; generic FINISH cannot downgrade it.
  IF a.onboarding_mode='coexistence' THEN p_mode := 'coexistence'; END IF;
  -- The session event is a hint. A verified phone-number-first promotion must
  -- survive replay of the original FINISH event without downgrading its mode.
  IF a.completion_mode IS NOT NULL AND p_mode IS NOT NULL AND a.completion_mode<>p_mode
    AND NOT (a.completion_mode='coexistence' AND a.pending_metadata->>'onboarding_mode' IS NOT DISTINCT FROM 'coexistence') THEN
    RAISE EXCEPTION 'Completion mode mismatch' USING ERRCODE='42501';
  END IF;
  -- On recovery/replay, the resolved phone must not change, even if the session
  -- event originally contained only a WABA. Preserve strict WABA/code matching.
  IF p_mode='coexistence' AND p_context->>'phone_number_id' IS NULL AND a.context->>'phone_number_id' IS NOT NULL THEN
    normalized := p_context || jsonb_build_object('phone_number_id',a.context->>'phone_number_id');
  END IF;
  PERFORM public.claim_whatsapp_signup_lease(p_attempt,p_user,p_account,p_lease,p_hash,normalized);
  UPDATE public.whatsapp_signup_attempts SET completion_mode=coalesce(completion_mode,p_mode,'cloud_api'),
    onboarding_mode=coalesce(completion_mode,p_mode,'cloud_api'),
    signup_completed_at=coalesce(signup_completed_at,clock_timestamp()) WHERE id=p_attempt;
  RETURN QUERY SELECT * FROM public.whatsapp_signup_attempts WHERE id=p_attempt;
END $$;

-- Expiry cannot make an uncertain registration safe to repeat.
CREATE OR REPLACE FUNCTION public.mark_whatsapp_registration(p_attempt uuid,p_lease uuid,p_encrypted_pin text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.assert_whatsapp_signup_lease(p_attempt,p_lease);
  IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts WHERE id=p_attempt AND completion_mode='coexistence') THEN
    RAISE EXCEPTION 'Coexistence numbers cannot be registered' USING ERRCODE='42501';
  END IF;
  IF p_encrypted_pin IS NULL OR length(p_encrypted_pin)=0 THEN RAISE EXCEPTION 'Missing encrypted PIN' USING ERRCODE='22023'; END IF;
  -- Abandonment cannot erase an uncertain external registration. The backend
  -- can still finish a new signup when Meta verifies the number is CONNECTED,
  -- but must never blindly submit another registration for this number.
  IF EXISTS (SELECT 1 FROM public.whatsapp_signup_attempts old
    JOIN public.whatsapp_signup_attempts current ON current.id=p_attempt
    WHERE old.id<>current.id AND (old.discarded_at IS NOT NULL OR old.state<>'complete') AND old.registration_requested_at IS NOT NULL
      AND old.context->>'phone_number_id'=current.context->>'phone_number_id'
      AND old.context->>'waba_id'=current.context->>'waba_id') THEN
    RAISE EXCEPTION 'Previous registration outcome must be verified in Meta' USING ERRCODE='42501';
  END IF;
  UPDATE public.whatsapp_signup_attempts SET pending_registration_pin=p_encrypted_pin,registration_requested_at=clock_timestamp()
    WHERE id=p_attempt AND lease_id=p_lease AND state='processing' AND lease_until>clock_timestamp()
      AND expires_at>clock_timestamp() AND registration_requested_at IS NULL AND pending_access_token IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Registration outcome must be reconciled' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.capture_whatsapp_coexistence_event(p_events jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE event jsonb; c public.whatsapp_config; matches integer; target uuid; unresolved integer := 0;
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
      IF matches<>1 THEN unresolved := unresolved+1; CONTINUE; END IF;
    ELSE
      SELECT id INTO target FROM public.whatsapp_config WHERE waba_id=event->>'waba' AND phone_number_id=event->>'phone_id';
    END IF;
    SELECT * INTO c FROM public.whatsapp_config WHERE id=target AND onboarding_metadata->>'onboarding_mode'='coexistence';
    IF NOT FOUND THEN unresolved := unresolved+1; CONTINUE; END IF;
    -- No caller-provided workspace is accepted. All chunks commit before ACK.
    INSERT INTO public.whatsapp_coexistence_events(event_key,connection_id,account_id,onboarding_epoch,records,priority)
      VALUES((event->>'key') || ':' || c.id::text,c.id,c.account_id,c.coexistence_state->>'onboarded_at',event->'records',CASE WHEN event->'records' @> '[{"kind":"lifecycle"}]' THEN 0 WHEN (event->'records' @> '[{"history":true}]' OR event->'records' @> '[{"kind":"progress"}]') THEN 3 ELSE 1 END) ON CONFLICT(event_key) DO NOTHING;
    IF FOUND AND (event->'records' @> '[{"history":true}]' OR event->'records' @> '[{"kind":"progress"}]') AND c.coexistence_state->'history'->>'state'='complete' THEN
      UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,'{history,state}','"syncing"') WHERE id=c.id;
    END IF;
  END LOOP;
  RETURN unresolved;
END $$;

DROP FUNCTION public.process_whatsapp_coexistence_event(integer);
CREATE FUNCTION public.process_whatsapp_coexistence_event(p_limit integer DEFAULT 1,p_max_priority integer DEFAULT 3)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.whatsapp_coexistence_events; c public.whatsapp_config; r jsonb; person uuid; conv uuid; msg uuid;
  peer text; at_time timestamptz; source jsonb; old_source jsonb; progress integer; row_count integer; processed boolean := false; batch integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_max_priority IS NULL OR p_max_priority NOT BETWEEN 0 AND 3 THEN RAISE EXCEPTION 'Invalid batch limit'; END IF;
  FOR batch IN 1..p_limit LOOP
    SELECT * INTO e FROM public.whatsapp_coexistence_events WHERE event_kind='coexistence' AND processed_at IS NULL AND retry_at<=clock_timestamp()
      AND attempts<10 AND priority<=p_max_priority ORDER BY priority,retry_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN processed; END IF;
    -- All data writes AND receipt completion are one transaction. SKIP LOCKED
    -- allows overlapping wake-ups. Subtransaction rolls back a failed batch.
    BEGIN
      -- Do not wait on another worker holding a different connection: a bounded
      -- multi-receipt transaction must not build a cycle of connection locks.
      SELECT * INTO c FROM public.whatsapp_config WHERE id=e.connection_id AND account_id=e.account_id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        UPDATE public.whatsapp_coexistence_events SET retry_at=clock_timestamp()+interval '1 second' WHERE id=e.id;
        CONTINUE;
      END IF;
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
            'state',CASE WHEN c.coexistence_state->'history'->>'state' IN ('declined','failed') THEN c.coexistence_state->'history'->>'state'
              WHEN (r->>'denied')::boolean THEN 'declined' WHEN (r->>'error')::boolean THEN 'partial' ELSE 'syncing' END);
          -- Keep chunk identities without depending on delivery ordering.
          IF r ? 'phase' AND r ? 'chunk_order' THEN source := source || jsonb_build_object('chunks',coalesce(source->'chunks','{}') || jsonb_build_object((r->>'phase') || ':' || (r->>'chunk_order'),true)); END IF;
          UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,'{history}',source) WHERE id=c.id;
          SELECT * INTO c FROM public.whatsapp_config WHERE id=c.id;
          CONTINUE;
        END IF;
        peer := r->>'peer'; at_time := (r->>'at')::timestamptz;
        IF peer !~ '^[1-9]\d{6,14}$' OR at_time IS NULL THEN RAISE EXCEPTION 'Invalid identity'; END IF;
        IF r->>'kind'='message_update' THEN
          SELECT m.id,m.coexistence_metadata INTO msg,old_source FROM public.messages m JOIN public.conversations v ON v.id=m.conversation_id
            JOIN public.contacts p ON p.id=v.contact_id
            WHERE v.account_id=c.account_id AND v.whatsapp_config_id=c.id AND p.phone_normalized=peer AND m.message_id=r->>'original_id';
          IF msg IS NULL THEN RAISE EXCEPTION 'App update awaiting original'; END IF;
          IF at_time<=coalesce((old_source->>'app_updated_at')::timestamptz,'-infinity') OR old_source->>'revoked'='true' THEN CONTINUE; END IF;
          UPDATE public.messages SET content_type=CASE WHEN (r->>'revoked')::boolean THEN 'text' ELSE content_type END,
            content_text=CASE WHEN (r->>'revoked')::boolean THEN '[Message deleted in WhatsApp]' ELSE coalesce(r->>'text',content_text) END,
            media_url=CASE WHEN (r->>'revoked')::boolean THEN NULL ELSE media_url END,
            coexistence_metadata=coalesce(coexistence_metadata,'{}')||jsonb_build_object('app_updated_at',at_time,'revoked',r->'revoked','edited',NOT (r->>'revoked')::boolean,'placeholder',false) WHERE id=msg;
          UPDATE public.conversations v SET last_message_text=m.content_text FROM public.messages m
            WHERE m.id=msg AND v.id=m.conversation_id AND v.last_message_at=m.created_at;
          CONTINUE;
        END IF;
        IF (r->>'media_only')::boolean THEN
          -- Look up through the canonical connection and workspace. A media update
          -- may precede its placeholder; retry later rather than creating a wrong thread.
          SELECT m.id INTO msg FROM public.messages m JOIN public.conversations v ON v.id=m.conversation_id
            WHERE v.account_id=c.account_id AND v.whatsapp_config_id=c.id AND m.message_id=r->>'id';
          IF msg IS NULL THEN RAISE EXCEPTION 'History media awaiting message'; END IF;
          UPDATE public.messages SET content_type=r->>'type',content_text=r->>'text',media_url=CASE WHEN nullif(r->>'media_id','') IS NOT NULL THEN '/api/whatsapp/media/' || (r->>'media_id') || '?whatsapp_config_id=' || c.id::text ELSE media_url END,media_type=r->>'mime_type',
            coexistence_metadata=coalesce(coexistence_metadata,'{}') || jsonb_build_object('placeholder',false,'media_id',r->'media_id','filename',coalesce(nullif(r->'filename','null'),coexistence_metadata->'filename')) WHERE id=msg AND coexistence_metadata->>'revoked' IS DISTINCT FROM 'true';
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
            coalesce(coexistence_state->'smb_app_state_sync','{}') || jsonb_build_object('data_received',true,
              'state',CASE WHEN coexistence_state->'smb_app_state_sync'->>'state' IN ('complete','declined','failed') THEN coexistence_state->'smb_app_state_sync'->>'state' ELSE 'received' END)) WHERE id=c.id;
          CONTINUE;
        END IF;
        INSERT INTO public.conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES(c.account_id,c.user_id,person,c.id)
          ON CONFLICT (account_id,contact_id,whatsapp_config_id) WHERE whatsapp_config_id IS NOT NULL DO NOTHING;
        SELECT id INTO conv FROM public.conversations WHERE account_id=c.account_id AND contact_id=person AND whatsapp_config_id=c.id;
        INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_url,media_type,message_id,status,created_at,coexistence_metadata,interactive_reply_id,reply_to_message_id)
          VALUES(conv,CASE WHEN (r->>'outbound')::boolean THEN 'agent' ELSE 'customer' END,r->>'type',r->>'text',CASE WHEN nullif(r->>'media_id','') IS NOT NULL THEN '/api/whatsapp/media/' || (r->>'media_id') || '?whatsapp_config_id=' || c.id::text ELSE NULL END,r->>'mime_type',r->>'id',r->>'status',at_time,
            jsonb_build_object('history',r->'history','placeholder',r->'placeholder','media_id',r->'media_id','context',r->'context','location',r->'location','interactive',r->'interactive','filename',r->'filename'),r->>'interactive_reply_id',(SELECT id FROM public.messages WHERE conversation_id=conv AND message_id=r->'context'->>'id'))
          ON CONFLICT (conversation_id,message_id) DO UPDATE SET content_type=excluded.content_type,content_text=excluded.content_text,media_type=excluded.media_type,media_url=excluded.media_url,coexistence_metadata=excluded.coexistence_metadata
            WHERE messages.coexistence_metadata->>'revoked' IS DISTINCT FROM 'true' AND messages.coexistence_metadata->>'placeholder'='true' AND excluded.coexistence_metadata->>'placeholder'='false';
        GET DIAGNOSTICS row_count = ROW_COUNT;
        UPDATE public.messages child SET reply_to_message_id=parent.id FROM public.messages parent
          WHERE child.conversation_id=conv AND parent.conversation_id=conv AND parent.message_id=child.coexistence_metadata->'context'->>'id'
          AND child.reply_to_message_id IS NULL AND child.coexistence_metadata->'context'->>'id' IS NOT NULL AND parent.message_id=r->>'id';
        IF row_count>0 THEN
          -- Imported old chunks never replace a newer live inbox summary or bump unread.
          UPDATE public.conversations SET last_message_at=at_time,last_message_text=r->>'text'
            WHERE id=conv AND (last_message_at IS NULL OR last_message_at<at_time);
        END IF;
      END LOOP;
      UPDATE public.whatsapp_coexistence_events SET processed_at=clock_timestamp(),records='[]',last_error=NULL WHERE id=e.id;
      IF c.coexistence_state->'history'->>'progress'='100' AND c.coexistence_state->'history'->>'state' NOT IN ('declined','failed')
        AND NOT EXISTS(SELECT 1 FROM public.whatsapp_coexistence_events WHERE connection_id=c.id AND event_kind='coexistence'
          AND priority=3 AND processed_at IS NULL AND onboarding_epoch IS NOT DISTINCT FROM c.coexistence_state->>'onboarded_at') THEN
        UPDATE public.whatsapp_config SET coexistence_state=jsonb_set(coexistence_state,'{history,state}','"complete"') WHERE id=c.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Store only a bounded SQLSTATE, never contact/message contents or credentials.
      UPDATE public.whatsapp_coexistence_events SET attempts=attempts+1,last_error=SQLSTATE,
        retry_at=clock_timestamp()+least(interval '30 minutes',interval '30 seconds'*power(2,attempts)) WHERE id=e.id;
    END;
    processed := true;
  END LOOP;
  RETURN processed;
END $$;

CREATE FUNCTION public.maintain_whatsapp_runtime() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.whatsapp_signup_attempts SET authorization_token=NULL,pending_access_token=NULL,pending_registration_pin=NULL WHERE expires_at<clock_timestamp() AND (authorization_token IS NOT NULL OR pending_access_token IS NOT NULL OR pending_registration_pin IS NOT NULL);
 DELETE FROM public.whatsapp_signup_attempts WHERE expires_at<clock_timestamp()-interval '30 days' AND registration_requested_at IS NULL AND state<>'processing';
 UPDATE public.whatsapp_coexistence_events SET payload=NULL,records='[]',attempts=10,last_error='payload_retention_expired' WHERE event_kind='delivery' AND processed_at IS NULL AND created_at<clock_timestamp()-interval '30 days';
 DELETE FROM public.whatsapp_coexistence_events WHERE processed_at<clock_timestamp()-interval '30 days';
 DELETE FROM public.whatsapp_send_budgets WHERE next_send_at<clock_timestamp()-interval '1 day';
END $$;
CREATE FUNCTION public.wake_whatsapp_worker() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target text; secret text;
BEGIN
 PERFORM public.process_whatsapp_coexistence_event(5,1);
 PERFORM public.maintain_whatsapp_runtime();
 SELECT decrypted_secret INTO target FROM vault.decrypted_secrets WHERE name='whatsapp_worker_url';
 SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name='whatsapp_worker_token';
 IF target IS NOT NULL AND secret IS NOT NULL AND target LIKE 'https://%' THEN
  PERFORM net.http_post(url:=target,headers:=jsonb_build_object('Content-Type','application/json','x-whatsapp-worker-token',secret),body:='{}',timeout_milliseconds:=120000);
 ELSE
  PERFORM public.process_whatsapp_coexistence_event(5);
 END IF;
END $$;
SELECT cron.schedule('whatsapp-coexistence-import','* * * * *','SELECT public.wake_whatsapp_worker()');

-- Identity is immutable for an existing Business App connection, including
-- direct writes and races after an API preflight. Standard connections retain
-- their existing update behavior. New numbers require a new signup connection.
CREATE FUNCTION public.protect_whatsapp_coexistence_identity() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF OLD.onboarding_metadata->>'onboarding_mode'='coexistence' AND
   (NEW.onboarding_metadata->>'onboarding_mode' IS DISTINCT FROM 'coexistence' OR NEW.phone_number_id IS DISTINCT FROM OLD.phone_number_id OR NEW.waba_id IS DISTINCT FROM OLD.waba_id OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
  RAISE EXCEPTION 'Coexistence connection identity cannot change' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_whatsapp_coexistence_identity BEFORE UPDATE ON public.whatsapp_config
 FOR EACH ROW EXECUTE FUNCTION public.protect_whatsapp_coexistence_identity();
REVOKE ALL ON FUNCTION public.protect_whatsapp_coexistence_identity() FROM PUBLIC,anon,authenticated;

-- Service-only operational recovery: no message contents or credentials returned.
CREATE FUNCTION public.inspect_whatsapp_coexistence_failures(p_account uuid)
RETURNS TABLE(id bigint,connection_id uuid,attempts integer,last_error text,created_at timestamptz,record_count integer)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT e.id,e.connection_id,e.attempts,e.last_error,e.created_at,jsonb_array_length(e.records)
 FROM public.whatsapp_coexistence_events e WHERE e.account_id=p_account AND e.event_kind='coexistence'
  AND e.processed_at IS NULL AND e.attempts>=10 ORDER BY e.id LIMIT 100
$$;
CREATE FUNCTION public.retry_whatsapp_coexistence_event(p_account uuid,p_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.whatsapp_coexistence_events e SET attempts=0,retry_at=clock_timestamp(),last_error=NULL
 FROM public.whatsapp_config c WHERE e.id=p_id AND e.account_id=p_account AND c.id=e.connection_id AND c.account_id=p_account
  AND c.onboarding_metadata->>'onboarding_mode'='coexistence' AND e.onboarding_epoch IS NOT DISTINCT FROM c.coexistence_state->>'onboarded_at'
  AND e.event_kind='coexistence' AND e.processed_at IS NULL AND e.attempts>=10 AND jsonb_array_length(e.records)>0
  AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp());
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.whatsapp_coexistence_import_summary(p_account uuid)
RETURNS TABLE(connection_id uuid,pending bigint,failed bigint) LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT c.id,count(e.id),count(e.id) FILTER (WHERE e.attempts>=10)
 FROM public.whatsapp_config c LEFT JOIN public.whatsapp_coexistence_events e ON e.processed_at IS NULL AND
  ((e.event_kind='coexistence' AND e.account_id=c.account_id AND e.connection_id=c.id
     AND e.onboarding_epoch IS NOT DISTINCT FROM c.coexistence_state->>'onboarded_at') OR
   (e.event_kind='delivery' AND e.priority=3 AND e.payload->'entry'->0->>'id'=c.waba_id
     AND e.payload->'entry'->0->'changes'->0->'value'->'metadata'->>'phone_number_id'=c.phone_number_id))
 WHERE c.account_id=p_account AND c.onboarding_metadata->>'onboarding_mode'='coexistence' GROUP BY c.id
$$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('inspect_whatsapp_coexistence_failures','retry_whatsapp_coexistence_event','process_whatsapp_coexistence_event','capture_whatsapp_delivery','capture_whatsapp_deliveries','claim_whatsapp_deliveries','finish_whatsapp_delivery','whatsapp_delivery_stage','whatsapp_delivery_context','apply_whatsapp_inbound','apply_whatsapp_status','acquire_whatsapp_send','fail_whatsapp_coexistence_sync','pending_whatsapp_coexistence_sync','begin_whatsapp_authorization','save_whatsapp_authorization','maintain_whatsapp_runtime','wake_whatsapp_worker') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
COMMIT;
