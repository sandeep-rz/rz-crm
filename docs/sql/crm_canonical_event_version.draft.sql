-- Review-only SQL. Requires the existing worker to call the version guard
-- inside the SAME database transaction as reservation update and job enqueue.
-- Do not call the guard as a separate PostgREST RPC before the worker writes.
BEGIN;
ALTER TABLE public.pms_reservations ADD COLUMN canonical_source_version bigint
 CHECK (canonical_source_version IS NULL OR canonical_source_version > 0);

CREATE FUNCTION public.crm_lock_canonical_reservation_event(
 p_account_id uuid, p_integration_id uuid, p_property_id uuid,
 p_reservation_id uuid, p_source_version bigint
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path TO '' AS $$
DECLARE v_previous bigint;
BEGIN
 IF p_source_version IS NULL OR p_source_version <= 0 THEN
   RAISE EXCEPTION 'Invalid canonical event version' USING ERRCODE='22023';
 END IF;
 SELECT canonical_source_version INTO v_previous
 FROM public.pms_reservations
 WHERE id=p_reservation_id AND account_id=p_account_id
 AND pms_integration_id=p_integration_id AND pms_property_id=p_property_id
 FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 IF v_previous IS NOT NULL AND p_source_version<=v_previous THEN
   RETURN 'duplicate_or_stale';
 END IF;
 RETURN 'apply';
END;
$$;
REVOKE ALL ON FUNCTION public.crm_lock_canonical_reservation_event(uuid,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_lock_canonical_reservation_event(uuid,uuid,uuid,uuid,bigint) TO service_role;
COMMIT;
-- IMPORTANT: the worker's final transactional RPC must set
-- canonical_source_version only after successful reservation projection and
-- automation enqueue. Existing pms_webhook_events(provider,external_event_id)
-- and automation_trigger_jobs(occurrence_key) unique constraints are reused.
-- Confirmation occurrence key should use canonical CRM internal reservation
-- identity + automation identity, NOT event version; update jobs may use
-- the canonical version. Existing historical job keys must be reconciled
-- before enabling the new path. Do not rewrite or delete historical jobs.
-- For event version N fetched after source advances to N+1, consumer must
-- validate the snapshot version, or defer/refetch; never label a newer
-- snapshot as an older version. The current read API needs that field.
