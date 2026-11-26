-- Draft: manual rollout only after worker integration and tests.
-- Service-only, non-destructive, single-record rekey.
BEGIN;
CREATE FUNCTION public.crm_rekey_pms_reservation_v2(
 p_account_id uuid, p_integration_id uuid, p_property_id uuid,
 p_internal_id uuid, p_expected_child_id text, p_parent_id text,
 p_verified_child_ids text[], p_dry_run boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_count integer; v_id uuid; v_external text;
BEGIN
 IF p_account_id IS NULL OR p_integration_id IS NULL OR p_property_id IS NULL
 OR p_internal_id IS NULL OR p_expected_child_id IS NULL OR p_parent_id IS NULL
 OR btrim(p_parent_id)='' OR p_verified_child_ids IS NULL OR p_dry_run IS NULL
 OR NOT coalesce(p_expected_child_id=ANY(p_verified_child_ids),false) THEN
   RAISE EXCEPTION 'Invalid reconciliation input' USING ERRCODE='22023';
 END IF;
 -- Caller must obtain complete alias set from authenticated PMS export.
 -- Lock integration to serialize cooperating reconciliation calls.
 PERFORM 1 FROM public.pms_integrations
 WHERE id=p_integration_id AND account_id=p_account_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid integration scope'; END IF;
 SELECT count(*) INTO v_count FROM public.pms_reservations
 WHERE pms_integration_id=p_integration_id
 AND (external_reservation_id=p_parent_id OR external_reservation_id=ANY(p_verified_child_ids));
 IF v_count<>1 THEN RETURN jsonb_build_object('status','conflict','matches',v_count); END IF;
 SELECT id,external_reservation_id INTO v_id,v_external FROM public.pms_reservations
 WHERE id=p_internal_id AND account_id=p_account_id AND pms_integration_id=p_integration_id
 AND pms_property_id=p_property_id FOR UPDATE;
 IF NOT FOUND OR v_external NOT IN (p_expected_child_id,p_parent_id) THEN
 RETURN jsonb_build_object('status','conflict'); END IF;
 IF v_external=p_parent_id THEN RETURN jsonb_build_object('status','already_reconciled','id',v_id); END IF;
 IF p_dry_run THEN RETURN jsonb_build_object('status','would_rekey','id',v_id); END IF;
 -- Existing writers MUST be paused for cutover; integration lock alone
 -- does not serialize writers which do not take the same lock.
 UPDATE public.pms_reservations SET external_reservation_id=p_parent_id
 WHERE id=v_id AND account_id=p_account_id AND pms_integration_id=p_integration_id
 AND pms_property_id=p_property_id AND external_reservation_id=p_expected_child_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation changed concurrently'; END IF;
 RETURN jsonb_build_object('status','rekeyed','id',v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.crm_rekey_pms_reservation_v2(uuid,uuid,uuid,uuid,text,text,text[],boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_rekey_pms_reservation_v2(uuid,uuid,uuid,uuid,text,text,text[],boolean) TO service_role;
COMMIT;
