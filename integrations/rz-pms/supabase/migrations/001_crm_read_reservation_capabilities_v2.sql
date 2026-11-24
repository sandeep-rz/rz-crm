-- RZ-PMS proposed migration, bundled for review in the ONE CRM PR.
-- NOT a CRM migration. DO NOT apply against the RZ-CRM database.
-- NOT APPLIED to PMS production or development.
-- The existing ensure_guest_checkin_session_for_booking() may CREATE/UPDATE
-- sessions; this function deliberately NEVER calls it.
BEGIN;

CREATE OR REPLACE FUNCTION public.crm_read_reservation_capabilities_v2(
  p_source_type text,
  p_source_record_id uuid,
  p_host_id bigint,
  p_property_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_context record;
  v_session record;
  v_enabled boolean := false;
  v_values jsonb := '{}'::jsonb;
  v_url text;
  v_source text;
  v_eligible boolean := false;
BEGIN
  IF p_source_type NOT IN ('rz_booking','pms_booking') OR
     p_source_record_id IS NULL OR p_host_id IS NULL OR p_property_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','invalid_request');
  END IF;

  -- CRM uses 'rz_booking'; existing PMS context view uses 'rzr_booking'.
  v_source := CASE WHEN p_source_type = 'rz_booking' THEN 'rzr_booking'
                   ELSE 'pms_booking' END;

  -- Caller authentication (including whether p_host_id belongs to the
  -- provisioned CRM installation) MUST be established by the PMS API handler.
  -- These equality checks provide additional reservation/property isolation.
  SELECT c.*
    INTO v_context
    FROM public.guest_checkin_reservation_context_view c
   WHERE c.source_type = v_source
     AND c.source_record_id = p_source_record_id
     AND c.host_id = p_host_id
     AND c.property_id = p_property_id
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'error','reservation_not_found');
  END IF;

  SELECT (
    public.has_digital_checkin_property_entitlement(p_property_id)
    AND EXISTS(
      SELECT 1 FROM public.property_checkin_settings pcs
       WHERE pcs.property_id = p_property_id
         AND pcs.host_id = p_host_id
         AND pcs.is_enabled = true
    )
  ) INTO v_enabled;

  v_eligible := CASE
    WHEN v_source = 'rzr_booking' THEN
      lower(coalesce(v_context.reservation_status,'')) = 'confirmed'
    ELSE lower(coalesce(v_context.reservation_status,''))
      IN ('new','modified','confirmed')
  END;

  IF NOT coalesce(v_enabled,false) THEN
    v_values := v_values || jsonb_build_object(
      'reservation.digital_checkin_url',
      jsonb_build_object('status','missing','value',NULL,'reason','feature_disabled')
    );
  ELSIF NOT v_eligible THEN
    v_values := v_values || jsonb_build_object(
      'reservation.digital_checkin_url',
      jsonb_build_object('status','missing','value',NULL,'reason','reservation_inactive')
    );
  ELSE
    SELECT s.access_token, s.expires_at, s.status
      INTO v_session
      FROM public.guest_checkin_sessions s
     WHERE s.host_id = p_host_id
       AND s.property_id = p_property_id
       AND (
         (v_source = 'rzr_booking' AND s.booking_id = p_source_record_id)
         OR (v_source = 'pms_booking' AND s.pms_booking_id = p_source_record_id)
       )
     ORDER BY s.created_at DESC
     LIMIT 1;

    IF NOT FOUND OR v_session.access_token IS NULL
       OR btrim(v_session.access_token) = '' THEN
      v_values := v_values || jsonb_build_object(
        'reservation.digital_checkin_url',
        jsonb_build_object('status','missing','value',NULL,'reason','not_ready')
      );
    ELSIF v_session.expires_at IS NULL OR
          v_session.expires_at <= now() OR
          v_session.status IN ('expired','cancelled') THEN
      v_values := v_values || jsonb_build_object(
        'reservation.digital_checkin_url',
        jsonb_build_object('status','missing','value',NULL,'reason','expired')
      );
    ELSE
      v_values := v_values || jsonb_build_object(
        'reservation.digital_checkin_url',
        jsonb_build_object(
          'status','resolved',
          'value',public.get_guest_checkin_base_url(p_host_id) || v_session.access_token
        )
      );
    END IF;
  END IF;

  -- These are general trips pages, NOT verified direct-review links.
  v_url := public.resolve_whatsapp_review_url(
    p_source_type,p_source_record_id
  );
  v_values := v_values || jsonb_build_object(
    'reservation.review_destination_url',
    CASE WHEN v_url IS NOT NULL AND v_url ~ '^https://'
         THEN jsonb_build_object('status','resolved','value',v_url)
         ELSE jsonb_build_object('status','missing','value',NULL,'reason','not_ready')
    END,
    'reservation.review_url',
    jsonb_build_object(
      'status','unsupported','value',NULL,'reason','provider_unsupported'
    )
  );

  RETURN jsonb_build_object(
    'success',true,
    'contract_version','v2',
    'context',jsonb_build_object(
      'source_type',p_source_type,
      'source_record_id',p_source_record_id,
      'host_id',p_host_id,
      'property_id',p_property_id
    ),
    'values',v_values
  );
END
$function$;

-- public functions default to EXECUTE granted to PUBLIC, revoke explicitly.
REVOKE ALL ON FUNCTION public.crm_read_reservation_capabilities_v2(text,uuid,bigint,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_read_reservation_capabilities_v2(text,uuid,bigint,bigint)
  TO service_role;

COMMENT ON FUNCTION public.crm_read_reservation_capabilities_v2(text,uuid,bigint,bigint)
IS 'Read-only, service-role-only RZ-PMS capability resolution. API must verify provisioned integration ownership and construct trusted host/property IDs before calling. Never generate tokens here.';

COMMIT;
