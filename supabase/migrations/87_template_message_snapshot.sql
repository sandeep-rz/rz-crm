BEGIN;
-- Store only the rendered template display fields and identity, not runtime variables or tokens.
ALTER TABLE public.messages ADD COLUMN template_snapshot jsonb;
COMMENT ON COLUMN public.messages.template_snapshot IS 'Frozen rendered template header/footer/button labels and identity for Inbox history';
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
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_url,template_name,template_snapshot,interactive_payload,message_id,status,reply_to_message_id)
 VALUES(p_conversation,'agent',p_message->>'content_type',p_message->>'content_text',p_message->>'media_url',p_message->>'template_name',CASE WHEN p_message->>'content_type'='template' THEN nullif(p_message->'template_snapshot','null') ELSE NULL END,nullif(p_message->'interactive_payload','null'),p_message->>'message_id','sent',nullif(p_message->>'reply_to_message_id','')::uuid)
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
COMMIT;
