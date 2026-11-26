-- OPERATOR-RUN ONLY: isolated migrated fixture database; all writes roll back.
BEGIN;
DO $$
DECLARE scope record; audit_user uuid; fixture_automation uuid:=gen_random_uuid();
 first_id uuid:=gen_random_uuid(); second_id uuid:=gen_random_uuid();
 first_child text:=gen_random_uuid()::text; second_child text:=gen_random_uuid()::text; parent text:=gen_random_uuid()::text;
 jobs_before jsonb; jobs_after jsonb; result jsonb; alias_id uuid; alias_job public.automation_trigger_jobs%ROWTYPE; gate text;
BEGIN
 SELECT p.account_id,p.pms_integration_id,p.id property_id INTO scope FROM public.pms_properties p
 JOIN public.pms_integrations i ON i.id=p.pms_integration_id AND i.account_id=p.account_id
 WHERE p.status='active' AND i.status='connected' AND i.provider='rukiye_zara' ORDER BY p.id LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Connected PMS fixture mapping required'; END IF;
 SELECT user_id INTO audit_user FROM public.automations WHERE account_id=scope.account_id LIMIT 1;
 IF audit_user IS NULL THEN RAISE EXCEPTION 'An automation owner fixture is required'; END IF;
 INSERT INTO public.automations(id,account_id,user_id,name,trigger_type,trigger_config,is_active)
 VALUES(fixture_automation,scope.account_id,audit_user,'canonical reconciliation regression','before_checkin','{}',true);
 INSERT INTO public.pms_reservations(id,account_id,pms_integration_id,pms_property_id,external_reservation_id,status,provider_status,metadata)
 VALUES(first_id,scope.account_id,scope.pms_integration_id,scope.property_id,first_child,'confirmed','new','{"source_type":"pms_bookings"}'),
 (second_id,scope.account_id,scope.pms_integration_id,scope.property_id,second_child,'confirmed','new','{"source_type":"pms_bookings"}');
 INSERT INTO public.automation_trigger_jobs(account_id,automation_id,pms_reservation_id,trigger_type,occurrence_key,run_at,status,attempt_count,last_error)
 VALUES(scope.account_id,fixture_automation,first_id,'before_checkin','pms:schedule:'||fixture_automation||':'||first_id||':before_checkin',now(),'failed',2,'Original provider error must survive'),
 (scope.account_id,fixture_automation,second_id,'before_checkin','pms:schedule:'||fixture_automation||':'||second_id||':before_checkin',now(),'scheduled',0,'Original scheduling diagnostic must survive');
 SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) INTO jobs_before FROM public.automation_trigger_jobs j WHERE j.automation_id=fixture_automation;
 result:=public.crm_reconcile_pms_reservation_v2(scope.account_id,scope.pms_integration_id,scope.property_id,parent,ARRAY[first_child,second_child]);
 IF result->>'status'<>'reconciled' THEN RAISE EXCEPTION 'Reconciliation failed'; END IF;
 PERFORM public.crm_reconcile_pms_reservation_v2(scope.account_id,scope.pms_integration_id,scope.property_id,parent,ARRAY[first_child,second_child]);
 SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) INTO jobs_after FROM public.automation_trigger_jobs j WHERE j.automation_id=fixture_automation;
 IF jobs_before IS DISTINCT FROM jobs_after THEN RAISE EXCEPTION 'Legacy job rows or diagnostics were changed'; END IF;
 IF (SELECT count(*) FROM public.pms_reservations WHERE id IN(first_id,second_id))<>2 THEN RAISE EXCEPTION 'Reservation IDs lost'; END IF;
 -- The normal post-sync scheduler must not erase a winner's original failure.
 UPDATE public.pms_reservations SET metadata=(metadata-'canonical_identity_pending')||'{"guest_resolution":"resolved"}'::jsonb
 WHERE id=(result->>'id')::uuid;
 UPDATE public.automation_trigger_jobs SET status='failed',last_error='Preserve winner failure'
 WHERE pms_reservation_id=(result->>'id')::uuid;
 SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) INTO jobs_before FROM public.automation_trigger_jobs j WHERE j.automation_id=fixture_automation;
 PERFORM public.upsert_pms_automation_schedule_jobs(jsonb_build_array(jsonb_build_object(
 'account_id',scope.account_id,'automation_id',fixture_automation,'pms_reservation_id',result->>'id',
 'trigger_type','before_checkin','occurrence_key','pms:schedule:'||fixture_automation||':'||(result->>'id')||':before_checkin',
 'run_at',now(),'source_updated_at',(SELECT updated_at FROM public.pms_reservations WHERE id=(result->>'id')::uuid))));
 SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) INTO jobs_after FROM public.automation_trigger_jobs j WHERE j.automation_id=fixture_automation;
 IF jobs_before IS DISTINCT FROM jobs_after THEN RAISE EXCEPTION 'Post-sync scheduling erased historical failure'; END IF;
 SELECT id INTO alias_id FROM public.pms_reservations WHERE id IN(first_id,second_id) AND canonical_reservation_id IS NOT NULL;
 UPDATE public.automation_trigger_jobs SET status='processing',attempt_count=3,processing_started_at=now()
 WHERE pms_reservation_id=alias_id RETURNING * INTO alias_job;
 SELECT disposition INTO gate FROM public.begin_pms_automation_execution(alias_job.id,3,NULL,
   (SELECT updated_at FROM public.pms_reservations WHERE id=alias_id));
 IF gate IS DISTINCT FROM 'ineligible' THEN RAISE EXCEPTION 'Retained alias was permitted to execute'; END IF;
END;
$$;
ROLLBACK;
