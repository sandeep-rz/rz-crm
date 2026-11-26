-- Apply after crm_canonical_event_version and rekey drafts.
-- Service-only projection, serialized on integration and reservation.
BEGIN;
CREATE FUNCTION public.crm_save_canonical_projection_v2(
 p_row jsonb,p_source_version bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO '' AS $$
DECLARE r public.pms_reservations%ROWTYPE; old public.pms_reservations%ROWTYPE;
BEGIN
 r:=jsonb_populate_record(NULL::public.pms_reservations,p_row);
 IF p_source_version IS NULL OR p_source_version<=0 OR r.account_id IS NULL
 OR r.pms_integration_id IS NULL OR r.pms_property_id IS NULL OR r.external_reservation_id IS NULL
 OR r.metadata->>'source_type' IS DISTINCT FROM 'pms_reservations'
 THEN RAISE EXCEPTION 'Invalid canonical projection'; END IF;
 PERFORM 1 FROM public.pms_integrations WHERE id=r.pms_integration_id AND account_id=r.account_id
 AND status='connected' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Integration mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.pms_properties WHERE id=r.pms_property_id AND account_id=r.account_id
 AND pms_integration_id=r.pms_integration_id AND status='active') THEN RAISE EXCEPTION 'Property mismatch'; END IF;
 IF r.contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=r.contact_id AND account_id=r.account_id)
 THEN RAISE EXCEPTION 'Contact mismatch'; END IF;
 SELECT * INTO old FROM public.pms_reservations WHERE pms_integration_id=r.pms_integration_id
 AND external_reservation_id=r.external_reservation_id FOR UPDATE;
 IF FOUND THEN
 IF old.account_id<>r.account_id OR old.pms_property_id<>r.pms_property_id THEN RAISE EXCEPTION 'Reservation scope mismatch'; END IF;
 IF old.canonical_source_version IS NOT NULL AND old.canonical_source_version>=p_source_version
 THEN RETURN jsonb_build_object('id',old.id,'skippedStale',true); END IF;
 UPDATE public.pms_reservations SET contact_id=CASE WHEN r.metadata->>'guest_resolution'='unresolved' THEN old.contact_id ELSE r.contact_id END,
 external_guest_id=r.external_guest_id,external_listing_id=r.external_listing_id,reservation_code=r.reservation_code,
 status=r.status,provider_status=r.provider_status,check_in=r.check_in,check_out=r.check_out,
 adults=r.adults,children=r.children,infants=r.infants,pets=r.pets,occupancy_total=r.occupancy_total,
 channel_code=r.channel_code,channel_name=r.channel_name,total_amount=r.total_amount,paid_amount=r.paid_amount,
 balance_due=r.balance_due,currency=r.currency,payment_status=r.payment_status,
 external_created_at=r.external_created_at,external_updated_at=r.external_updated_at,last_synced_at=r.last_synced_at,
 metadata=old.metadata||r.metadata,canonical_source_version=p_source_version WHERE id=old.id;
 RETURN jsonb_build_object('id',old.id,'skippedStale',false);
 END IF;
 INSERT INTO public.pms_reservations(account_id,pms_integration_id,pms_property_id,contact_id,external_reservation_id,
 external_guest_id,external_listing_id,reservation_code,status,provider_status,check_in,check_out,adults,children,infants,pets,occupancy_total,
 channel_code,channel_name,total_amount,paid_amount,balance_due,currency,payment_status,external_created_at,external_updated_at,last_synced_at,metadata,canonical_source_version)
 VALUES(r.account_id,r.pms_integration_id,r.pms_property_id,r.contact_id,r.external_reservation_id,
 r.external_guest_id,r.external_listing_id,r.reservation_code,r.status,r.provider_status,r.check_in,r.check_out,r.adults,r.children,r.infants,r.pets,r.occupancy_total,
 r.channel_code,r.channel_name,r.total_amount,r.paid_amount,r.balance_due,r.currency,r.payment_status,r.external_created_at,r.external_updated_at,r.last_synced_at,r.metadata,p_source_version)
 RETURNING id INTO r.id;
 RETURN jsonb_build_object('id',r.id,'skippedStale',false);
END;
$$;
REVOKE ALL ON FUNCTION public.crm_save_canonical_projection_v2(jsonb,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.crm_save_canonical_projection_v2(jsonb,bigint) TO service_role;
COMMIT;
-- Projection and version are atomic. Automation scheduling still needs an
-- event-specific durable completion transaction; do not treat projection
-- version equality as proof that automation jobs have been scheduled.
