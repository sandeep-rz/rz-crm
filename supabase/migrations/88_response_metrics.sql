BEGIN;
-- Preserve migration 87's atomic persistence contract. Derive the CRM actor
-- from the authenticated JWT, never request JSON or an API-key owner's identity.
-- One atomic round trip after Meta accepts a message. No external HTTP in this
-- transaction, and no additional queue/worker/table. Preserve agent handoff.
CREATE OR REPLACE FUNCTION public.record_whatsapp_outbound(p_account uuid,p_conversation uuid,p_message jsonb,p_preview text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE contact uuid; result uuid;
BEGIN
 IF coalesce(auth.jwt()->>'role','')<>'service_role' AND NOT EXISTS(
   SELECT 1 FROM public.profiles WHERE user_id=auth.uid() AND account_id=p_account
    AND account_role IN ('agent','admin','owner') AND public.is_account_member(p_account,'agent')) THEN
  RAISE EXCEPTION 'Agent permission required' USING ERRCODE='42501';
 END IF;
 IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' OR nullif(p_message->>'message_id','') IS NULL
   OR p_message->>'content_type' IS NULL OR p_message->>'content_type' NOT IN ('text','template','interactive','image','audio','video','document') THEN
  RAISE EXCEPTION 'Invalid outbound message' USING ERRCODE='22023';
 END IF;
 SELECT contact_id INTO contact FROM public.conversations WHERE id=p_conversation AND account_id=p_account FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found' USING ERRCODE='42501'; END IF;
 IF nullif(p_message->>'reply_to_message_id','') IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.messages WHERE id=(p_message->>'reply_to_message_id')::uuid AND conversation_id=p_conversation) THEN
  RAISE EXCEPTION 'Reply does not belong to conversation' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.messages(conversation_id,sender_type,sender_id,content_type,content_text,media_url,template_name,template_snapshot,interactive_payload,message_id,status,reply_to_message_id)
 VALUES(p_conversation,'agent',CASE WHEN auth.jwt()->>'role'='authenticated' THEN auth.uid() ELSE NULL END,p_message->>'content_type',p_message->>'content_text',p_message->>'media_url',p_message->>'template_name',CASE WHEN p_message->>'content_type'='template' THEN nullif(p_message->'template_snapshot','null') ELSE NULL END,nullif(p_message->'interactive_payload','null'),p_message->>'message_id','sent',nullif(p_message->>'reply_to_message_id','')::uuid)
 ON CONFLICT(conversation_id,message_id) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN
  SELECT id INTO result FROM public.messages WHERE conversation_id=p_conversation AND message_id=p_message->>'message_id';
  RETURN result; -- Replay must not regress status, preview or pause a newly started flow.
 END IF;
 UPDATE public.conversations SET last_message_text=p_preview,last_message_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_conversation;
 BEGIN
  UPDATE public.flow_runs SET status='paused_by_agent',ended_at=clock_timestamp(),end_reason='agent_replied'
   WHERE account_id=p_account AND contact_id=contact AND status='active';
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'WhatsApp agent handoff failed (SQLSTATE %)',SQLSTATE;
 END;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.record_whatsapp_outbound(uuid,uuid,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_outbound(uuid,uuid,jsonb,text) TO authenticated,service_role;

-- Read-only aggregation under the caller's RLS. No new table/queue, status
-- rewriting, history backfill, service-window timestamp or outbound side effect.
CREATE INDEX IF NOT EXISTS idx_messages_response_order
  ON public.messages(conversation_id, created_at, id);

CREATE FUNCTION public.dashboard_response_metrics(p_account uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
  zone text;
  current_week timestamptz;
  previous_week timestamptz;
  result jsonb;
BEGIN
  IF NOT public.is_account_member(p_account) OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE user_id=auth.uid() AND account_id=p_account
  ) THEN
    RAISE EXCEPTION 'Current workspace membership required' USING ERRCODE='42501';
  END IF;
  SELECT default_timezone INTO zone FROM public.accounts WHERE id=p_account;
  IF zone IS NULL THEN
    RAISE EXCEPTION 'Workspace timezone unavailable' USING ERRCODE='22023';
  END IF;
  current_week := date_trunc('week', now() AT TIME ZONE zone) AT TIME ZONE zone;
  previous_week := (date_trunc('week', now() AT TIME ZONE zone) - interval '7 days') AT TIME ZONE zone;

  WITH eligible AS NOT MATERIALIZED (
    SELECT m.id, m.conversation_id, m.created_at,
      m.sender_type='customer' AS is_customer,
      CASE WHEN m.ai_generated IS TRUE THEN 'ai' ELSE 'human' END AS reply_kind
    FROM public.messages m
    JOIN public.conversations c ON c.id=m.conversation_id
    WHERE c.account_id=p_account AND m.created_at<=now()
      AND m.coexistence_metadata->>'history' IS DISTINCT FROM 'true'
      AND m.coexistence_metadata->>'placeholder' IS DISTINCT FROM 'true'
      AND m.coexistence_metadata->>'revoked' IS DISTINCT FROM 'true'
      AND (m.sender_type='customer' OR (
        m.status IN ('sent','delivered','read') AND (
          m.ai_generated IS TRUE OR (m.sender_type='agent' AND m.sender_id IS NOT NULL)
        )
      ))
  ), recent AS MATERIALIZED (
    SELECT * FROM eligible WHERE created_at>=previous_week
  ), context AS (
    SELECT * FROM recent
    UNION ALL
    -- One preceding event per active conversation preserves whether its first
    -- in-range inbound continues an older customer burst. Use the ordered index
    -- rather than sorting every message in the account's entire history.
    SELECT prior.* FROM (SELECT DISTINCT conversation_id FROM recent) c
    CROSS JOIN LATERAL (
      SELECT * FROM eligible e WHERE e.conversation_id=c.conversation_id
        AND e.created_at<previous_week ORDER BY e.created_at DESC,e.id DESC LIMIT 1
    ) prior
  ), ordered AS (
    SELECT e.*, lag(is_customer) OVER (
      PARTITION BY conversation_id ORDER BY created_at,id
    ) AS prev_customer FROM context e
  ), grouped AS (
    -- A customer burst begins after a real human/AI reply. Deterministic
    -- acknowledgements and failed sends never split it. One reply can count
    -- once per series; a later customer's turn cannot inherit an old AI wait.
    SELECT o.*, sum(CASE WHEN is_customer AND prev_customer IS DISTINCT FROM true THEN 1 ELSE 0 END)
      OVER (PARTITION BY conversation_id ORDER BY created_at,id ROWS UNBOUNDED PRECEDING) AS turn
    FROM ordered o
  ), turns AS (
    SELECT conversation_id,turn,
      min(created_at) FILTER (WHERE is_customer) AS asked_at,
      min(created_at) FILTER (WHERE NOT is_customer AND reply_kind='human') AS human_at,
      min(created_at) FILTER (WHERE NOT is_customer AND reply_kind='ai') AS ai_at
    FROM grouped GROUP BY conversation_id,turn
  ), samples AS (
    SELECT k.kind,t.asked_at,
      extract(isodow FROM t.asked_at AT TIME ZONE zone)::integer-1 AS dow,
      extract(epoch FROM k.answered_at-t.asked_at)/60.0 AS minutes
    FROM turns t CROSS JOIN LATERAL (VALUES ('human',human_at),('ai',ai_at)) k(kind,answered_at)
    WHERE asked_at>=previous_week AND k.answered_at IS NOT NULL
  ), series AS (
    SELECT k.kind, jsonb_build_object(
      'buckets', (SELECT jsonb_agg(jsonb_build_object(
        'dow', d.dow,
        'avgMinutes', (SELECT avg(s.minutes) FROM samples s WHERE s.kind=k.kind AND s.dow=d.dow),
        'samples', (SELECT count(*) FROM samples s WHERE s.kind=k.kind AND s.dow=d.dow)
      ) ORDER BY d.dow) FROM generate_series(0,6) d(dow)),
      'thisWeekAvg', (SELECT avg(minutes) FROM samples s WHERE s.kind=k.kind AND asked_at>=current_week),
      'lastWeekAvg', (SELECT avg(minutes) FROM samples s WHERE s.kind=k.kind AND asked_at<current_week)
    ) AS summary
    FROM (VALUES ('human'),('ai')) k(kind)
  )
  SELECT jsonb_build_object('timeZone',zone,
    'human',(SELECT summary FROM series WHERE kind='human'),
    'ai',(SELECT summary FROM series WHERE kind='ai')) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.dashboard_response_metrics(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.dashboard_response_metrics(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
