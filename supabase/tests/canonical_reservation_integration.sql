-- Read-only checks after manual migration and full canonical synchronization.
-- Every query below must return zero rows. No contact data or tokens returned.
SELECT r.id FROM public.pms_reservations r JOIN public.pms_reservations c ON c.id=r.canonical_reservation_id
WHERE r.id=c.id OR r.account_id<>c.account_id OR r.pms_integration_id<>c.pms_integration_id OR r.pms_property_id<>c.pms_property_id;
SELECT id FROM public.pms_reservations WHERE metadata->>'source_type'='pms_reservations' AND canonical_reservation_id IS NULL
AND (canonical_source_version IS NULL OR canonical_source_version<=0 OR metadata->>'canonical_identity_pending'='true');
-- Retained aliases intentionally keep scheduled/failed job rows unchanged.
-- Their exclusion from claims is verified by the rollback-only reconciliation test.
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('crm_reconcile_pms_reservation_v2','crm_save_canonical_projection_v2','crm_complete_canonical_event_v2')
AND (has_function_privilege('anon',p.oid,'execute') OR has_function_privilege('authenticated',p.oid,'execute'));
