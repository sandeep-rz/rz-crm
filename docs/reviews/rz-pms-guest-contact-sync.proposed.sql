-- REVIEW DRAFT. Do not apply to DEV/production before approval.
-- No new tables. Values remain in pms_users; all new state is provenance/version metadata.
BEGIN;
ALTER TABLE public.bookings ADD COLUMN pms_user_id uuid REFERENCES public.pms_users(id) ON DELETE SET NULL;
ALTER TABLE public.bookings ADD COLUMN guest_contact_updated_at timestamptz;
ALTER TABLE public.pms_bookings ADD COLUMN guest_contact_updated_at timestamptz;
ALTER TABLE public.pms_users
  ADD COLUMN contact_provenance jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN contact_updated_at timestamptz,
  ADD CONSTRAINT pms_users_contact_provenance_check CHECK (
    jsonb_typeof(contact_provenance)='object'
    AND contact_provenance - ARRAY['name','email','phone']='{}'::jsonb
    AND NOT jsonb_path_exists(contact_provenance,'$.* ? (@.type() != "string" || (@ != "host" && @ != "cleared" && @ != "legacy"))'));
ALTER TABLE public.domain_events ADD COLUMN contact_sync_txid xid8;
CREATE INDEX bookings_pms_user_id_idx ON public.bookings(pms_user_id) WHERE pms_user_id IS NOT NULL;
CREATE INDEX domain_events_contact_tx_idx ON public.domain_events(contact_sync_txid,property_id,resource_type,resource_id)
  WHERE contact_sync_txid IS NOT NULL;

-- Preserve nonempty historical values conservatively. Missing fields have no
-- ownership key and remain eligible for OTA enrichment. Old NULLs alone cannot
-- prove host-clear intent; only explicit host clears create a cleared key.

WITH candidates AS (
  SELECT b.id, (array_agg(u.id))[1] profile_id FROM public.bookings b
  JOIN public.listings l ON l.id=b.listing_id JOIN public.properties p ON p.id=l.property_id
  JOIN public.pms_users u ON u.host_id=p.host_id AND u.last_seen_booking_id=b.id
  GROUP BY b.id HAVING count(*)=1
)
UPDATE public.bookings b SET pms_user_id=c.profile_id FROM candidates c WHERE b.id=c.id;
-- The projection now reads the directory, so mint a strictly newer source
-- version for existing rows. Reconciliation can discover old missed edits;
-- no historical event or booking business timestamp is rewritten.
UPDATE public.pms_users u SET
 contact_provenance=jsonb_strip_nulls(jsonb_build_object(
   'name',CASE WHEN coalesce(nullif(btrim(u.full_name),''),nullif(btrim(u.first_name),''),nullif(btrim(u.last_name),'')) IS NOT NULL THEN 'legacy' END,
   'email',CASE WHEN nullif(btrim(u.email),'') IS NOT NULL THEN 'legacy' END,
   'phone',CASE WHEN coalesce(nullif(btrim(u.phone_raw),''),nullif(btrim(u.phone_normalized),'')) IS NOT NULL THEN 'legacy' END)),
 contact_updated_at=greatest(clock_timestamp(),u.updated_at,(SELECT max(v) FROM (
   SELECT b.updated_at v FROM public.bookings b WHERE b.pms_user_id=u.id
   UNION ALL SELECT b.updated_at FROM public.pms_bookings b WHERE b.pms_user_id=u.id
 ) previous_versions))+interval '1 microsecond';

-- This trigger does NOT infer the writer from nesting. Source priority is
-- explicit in upsert_pms_user_from_booking; host RPCs mark their supplied fields.
CREATE FUNCTION private.version_pms_guest_contact() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE related_version timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.first_name,NEW.last_name,NEW.full_name,NEW.email,
      NEW.phone_raw,NEW.phone_normalized,coalesce(NEW.contact_provenance->>'name'='cleared',false), coalesce(NEW.contact_provenance->>'email'='cleared',false), coalesce(NEW.contact_provenance->>'phone'='cleared',false))
    IS NOT DISTINCT FROM ROW(OLD.first_name,OLD.last_name,OLD.full_name,OLD.email,
      OLD.phone_raw,OLD.phone_normalized,coalesce(OLD.contact_provenance->>'name'='cleared',false), coalesce(OLD.contact_provenance->>'email'='cleared',false), coalesce(OLD.contact_provenance->>'phone'='cleared',false)) THEN
    NEW.contact_updated_at := OLD.contact_updated_at; RETURN NEW;
  END IF;
  SELECT max(v) INTO related_version FROM (
    SELECT greatest(b.updated_at,b.guest_contact_updated_at) v FROM public.bookings b WHERE b.pms_user_id=NEW.id
    UNION ALL SELECT greatest(b.updated_at,b.guest_contact_updated_at) FROM public.pms_bookings b WHERE b.pms_user_id=NEW.id
  ) versions;
  NEW.contact_updated_at := greatest(clock_timestamp(),related_version,
    CASE WHEN TG_OP='UPDATE' THEN OLD.contact_updated_at END) + interval '1 microsecond';
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.version_pms_guest_contact() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER version_pms_guest_contact BEFORE INSERT OR UPDATE ON public.pms_users
  FOR EACH ROW EXECUTE FUNCTION private.version_pms_guest_contact();

CREATE OR REPLACE FUNCTION public.upsert_pms_user_from_booking(p_host_id bigint, p_details jsonb, p_booking_id uuid, p_booking_date timestamp with time zone, p_is_authoritative boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    customer          jsonb;
    v_raw_name        text;
    v_first_json      text;
    v_last_json       text;
    v_first           text;
    v_last            text;
    v_full            text;
    v_email           text;
    v_phone_raw       text;
    v_phone_norm      text;
    v_country         text;
    existing_id       uuid;
    linked_host_id    bigint;
    v_email_available boolean := false;
    v_phone_available boolean := false;
BEGIN
    IF p_host_id IS NULL OR p_booking_id IS NULL THEN
        RETURN NULL;
    END IF;

    customer := COALESCE(p_details->'customer', '{}'::jsonb);

    SELECT pb.pms_user_id
    INTO existing_id
    FROM public.pms_bookings pb
    WHERE pb.booking_id = p_booking_id
      AND pb.pms_user_id IS NOT NULL
    LIMIT 1;

    IF existing_id IS NOT NULL THEN
        SELECT pu.host_id
        INTO linked_host_id
        FROM public.pms_users pu
        WHERE pu.id = existing_id;

        IF linked_host_id IS DISTINCT FROM p_host_id THEN
            existing_id := NULL;
        END IF;
    END IF;

    v_raw_name   := nullif(btrim(customer->>'name'), '');
    v_first_json := nullif(btrim(customer->>'first_name'), '');
    v_last_json  := nullif(
                       btrim(coalesce(customer->>'surname', customer->>'last_name')),
                       ''
                     );

    v_email := lower(
        nullif(
            btrim(coalesce(customer->>'email', customer->>'mail')),
            ''
        )
    );

    v_phone_raw := nullif(btrim(customer->>'phone'), '');
    v_country   := nullif(btrim(customer->>'country'), '');

    IF v_first_json IS NOT NULL THEN
        v_first := v_first_json;
    ELSIF v_last_json IS NOT NULL THEN
        v_first := v_raw_name;
    ELSIF v_raw_name IS NOT NULL THEN
        v_first := split_part(v_raw_name, ' ', 1);
    ELSE
        v_first := NULL;
    END IF;

    v_last := v_last_json;

    IF v_last IS NULL
       AND v_raw_name IS NOT NULL
       AND position(' ' IN v_raw_name) > 0
    THEN
        v_last := nullif(
            btrim(substr(v_raw_name, position(' ' IN v_raw_name) + 1)),
            ''
        );
    END IF;

    IF v_last IS NOT NULL
       AND v_first IS NOT NULL
       AND lower(v_last) = lower(v_first)
    THEN
        v_last := NULL;
    END IF;

    v_full := nullif(
        btrim(
            CASE
                WHEN v_first IS NOT NULL AND v_last IS NOT NULL
                    THEN v_first || ' ' || v_last
                WHEN v_first IS NOT NULL
                    THEN v_first
                WHEN v_last IS NOT NULL
                    THEN v_last
                ELSE v_raw_name
            END
        ),
        ''
    );

    -- Invalid or blank source input is absence, never an erase instruction.
    IF v_email IS NOT NULL AND v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN
        v_email := NULL;
    END IF;
    v_phone_norm := public.normalize_phone(v_phone_raw);

    IF v_phone_norm IS NULL
       OR (
            length(v_phone_norm) < 7
            OR v_phone_norm ~ '^(0+|1+|2+|3+|4+|5+|6+|7+|8+|9+)$'
            OR v_phone_norm IN ('1234567890', '0123456789')
       )
    THEN
        v_phone_norm := NULL;
        v_phone_raw := NULL;
    END IF;

    IF existing_id IS NULL AND v_email IS NOT NULL THEN
        SELECT pu.id
        INTO existing_id
        FROM public.pms_users pu
        WHERE pu.host_id = p_host_id
          AND lower(pu.email) = v_email
        ORDER BY pu.updated_at DESC NULLS LAST, pu.created_at DESC NULLS LAST
        LIMIT 1;
    END IF;

    IF existing_id IS NULL AND v_phone_norm IS NOT NULL THEN
        SELECT pu.id
        INTO existing_id
        FROM public.pms_users pu
        WHERE pu.host_id = p_host_id
          AND pu.phone_normalized = v_phone_norm
        ORDER BY pu.updated_at DESC NULLS LAST, pu.created_at DESC NULLS LAST
        LIMIT 1;
    END IF;

    IF existing_id IS NOT NULL THEN
        v_email_available :=
            v_email IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM public.pms_users x
                WHERE x.host_id = p_host_id
                  AND lower(x.email) = v_email
                  AND x.id <> existing_id
            );

        v_phone_available :=
            v_phone_norm IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM public.pms_users x
                WHERE x.host_id = p_host_id
                  AND x.phone_normalized = v_phone_norm
                  AND x.id <> existing_id
            );

        UPDATE public.pms_users u SET
            first_name = CASE WHEN (u.contact_provenance->>'name' IN ('host','cleared') OR (u.contact_provenance->>'name'='legacy' AND coalesce(nullif(btrim(u.full_name),''),nullif(btrim(u.first_name),''),nullif(btrim(u.last_name),'')) IS NOT NULL)) THEN u.first_name ELSE coalesce(v_first,u.first_name) END,
            last_name = CASE WHEN (u.contact_provenance->>'name' IN ('host','cleared') OR (u.contact_provenance->>'name'='legacy' AND coalesce(nullif(btrim(u.full_name),''),nullif(btrim(u.first_name),''),nullif(btrim(u.last_name),'')) IS NOT NULL)) THEN u.last_name ELSE coalesce(v_last,u.last_name) END,
            full_name = CASE WHEN (u.contact_provenance->>'name' IN ('host','cleared') OR (u.contact_provenance->>'name'='legacy' AND coalesce(nullif(btrim(u.full_name),''),nullif(btrim(u.first_name),''),nullif(btrim(u.last_name),'')) IS NOT NULL)) THEN u.full_name
              WHEN v_first IS NOT NULL OR v_last IS NOT NULL THEN nullif(btrim(concat_ws(' ',coalesce(v_first,u.first_name),coalesce(v_last,u.last_name))), '')
              ELSE u.full_name END,
            email = CASE WHEN (u.contact_provenance->>'email' IN ('host','cleared') OR (u.contact_provenance->>'email'='legacy' AND nullif(btrim(u.email),'') IS NOT NULL)) OR NOT v_email_available THEN u.email ELSE v_email END,
            phone_raw = CASE WHEN (u.contact_provenance->>'phone' IN ('host','cleared') OR (u.contact_provenance->>'phone'='legacy' AND coalesce(nullif(btrim(u.phone_raw),''),nullif(btrim(u.phone_normalized),'')) IS NOT NULL)) OR NOT v_phone_available THEN u.phone_raw ELSE v_phone_raw END,
            phone_normalized = CASE WHEN (u.contact_provenance->>'phone' IN ('host','cleared') OR (u.contact_provenance->>'phone'='legacy' AND coalesce(nullif(btrim(u.phone_raw),''),nullif(btrim(u.phone_normalized),'')) IS NOT NULL)) OR NOT v_phone_available THEN u.phone_normalized ELSE v_phone_norm END,
            contact_provenance = u.contact_provenance
              - CASE WHEN u.contact_provenance->>'name'='legacy'
                  AND coalesce(nullif(btrim(u.full_name),''),nullif(btrim(u.first_name),''),nullif(btrim(u.last_name),'')) IS NULL
                  AND v_full IS NOT NULL THEN 'name' ELSE '' END
              - CASE WHEN u.contact_provenance->>'email'='legacy' AND nullif(btrim(u.email),'') IS NULL
                  AND v_email_available THEN 'email' ELSE '' END
              - CASE WHEN u.contact_provenance->>'phone'='legacy'
                  AND coalesce(nullif(btrim(u.phone_raw),''),nullif(btrim(u.phone_normalized),'')) IS NULL
                  AND v_phone_available THEN 'phone' ELSE '' END,
            country = CASE
                WHEN p_is_authoritative AND v_country IS NOT NULL THEN v_country
                ELSE COALESCE(u.country, v_country)
            END,
            last_seen_booking_id = CASE
                WHEN COALESCE(p_booking_date, now())
                     >= COALESCE(u.last_seen_booking_at, '-infinity'::timestamptz)
                    THEN p_booking_id
                ELSE u.last_seen_booking_id
            END,
            last_seen_booking_at = CASE
                WHEN COALESCE(p_booking_date, now())
                     >= COALESCE(u.last_seen_booking_at, '-infinity'::timestamptz)
                    THEN COALESCE(p_booking_date, now())
                ELSE u.last_seen_booking_at
            END,
            updated_at = now()
        WHERE u.id = existing_id;

        RETURN existing_id;
    END IF;

    INSERT INTO public.pms_users (
        host_id,
        first_name,
        last_name,
        full_name,
        email,
        phone_raw,
        phone_normalized,
        country,
        last_seen_booking_id,
        last_seen_booking_at
    )
    VALUES (
        p_host_id,
        v_first,
        v_last,
        v_full,
        v_email,
        v_phone_raw,
        v_phone_norm,
        v_country,
        p_booking_id,
        COALESCE(p_booking_date, now())
    )
    RETURNING id INTO existing_id;

    RETURN existing_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_pms_bookings_sync_pms_users() RETURNS trigger
LANGUAGE plpgsql SET search_path='public','pg_temp' AS $$
DECLARE host_id_value bigint; customer jsonb; details_value jsonb;
BEGIN
  host_id_value:=public.get_host_id_for_listing(NEW.listing_id);
  IF host_id_value IS NULL THEN RETURN NEW; END IF;
  customer:=coalesce(NEW.details->'customer','{}'::jsonb);
  customer:=customer || jsonb_strip_nulls(jsonb_build_object(
    'name',coalesce(nullif(btrim(customer->>'name'),''),nullif(btrim(NEW.payload->>'guest_name'),'')),
    'email',coalesce(nullif(btrim(coalesce(customer->>'email',customer->>'mail')),''),nullif(btrim(NEW.payload->>'guest_email'),'')),
    'phone',coalesce(nullif(btrim(customer->>'phone'),''),nullif(btrim(NEW.payload->>'guest_phone'),''))));
  details_value:=jsonb_set(coalesce(NEW.details,'{}'::jsonb),'{customer}',customer,true);
  NEW.pms_user_id:=public.upsert_pms_user_from_booking(host_id_value,details_value,NEW.booking_id,NEW.booking_date,false);
  RETURN NEW;
END $$;
DROP TRIGGER pms_bookings_sync_pms_users ON public.pms_bookings;
CREATE TRIGGER pms_bookings_sync_pms_users BEFORE INSERT OR UPDATE OF details,payload,listing_id ON public.pms_bookings
  FOR EACH ROW EXECUTE FUNCTION public.trg_pms_bookings_sync_pms_users();

CREATE OR REPLACE FUNCTION public.trg_bookings_sync_pms_users()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_host_id bigint;
    v_identity record;
    v_details jsonb;
    v_profile_id uuid;
BEGIN
    -- Resolve host for this listing
    SELECT public.get_host_id_for_listing(NEW.listing_id) INTO v_host_id;

    IF v_host_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.pms_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.pms_users u
      WHERE u.id=NEW.pms_user_id AND u.host_id=v_host_id) THEN RETURN NEW; END IF;
    -- Fetch identity from users table
    SELECT *
    INTO v_identity
    FROM public.get_user_identity_for_rzr(NEW.user_id);

    IF v_identity IS NULL THEN
        RETURN NEW;
    END IF;

    -- Pack into same structure as OTA customer JSON
    v_details := jsonb_build_object(
        'customer', jsonb_build_object(
            'name',    v_identity.full_name,
            -- no explicit surname here, let upsert parse it
            'email',   v_identity.email,
            'phone',   v_identity.phone_raw,
            'country', v_identity.country
        )
    );

    v_profile_id := public.upsert_pms_user_from_booking(
        v_host_id,
        v_details,
        NEW.id,
        NEW.created_at,
        true   -- RZR is authoritative identity
    );

    UPDATE public.bookings SET pms_user_id=v_profile_id WHERE id=NEW.id AND pms_user_id IS DISTINCT FROM v_profile_id;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION private.version_reservation_guest_link() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE host_id_value bigint; profile_version timestamptz; allowed boolean; context_changed boolean:=false;
BEGIN
  IF TG_TABLE_NAME='bookings' AND TG_OP='UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR (NEW.listing_id IS DISTINCT FROM OLD.listing_id
      AND NEW.pms_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pms_users u
        WHERE u.id=NEW.pms_user_id AND u.host_id=public.get_host_id_for_listing(NEW.listing_id)))
    THEN NEW.pms_user_id:=NULL; END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='bookings' THEN
      context_changed:=public.is_meaningful_rzr_booking_change(OLD,NEW)
        OR ROW(OLD.booking_status,OLD.reservation_code,OLD.is_from_booking_engine,OLD.updated_at)
          IS DISTINCT FROM ROW(NEW.booking_status,NEW.reservation_code,NEW.is_from_booking_engine,NEW.updated_at);
    ELSE
      context_changed:=public.is_meaningful_pms_booking_change(OLD,NEW)
        OR ROW(OLD.status,OLD.ota_name,OLD.pms_paid_amount,OLD.pms_balance_due,OLD.updated_at,
          OLD.details->'occupancy',OLD.details->'adults',OLD.details->'children',OLD.payload->'adults',OLD.payload->'children')
          IS DISTINCT FROM ROW(NEW.status,NEW.ota_name,NEW.pms_paid_amount,NEW.pms_balance_due,NEW.updated_at,
          NEW.details->'occupancy',NEW.details->'adults',NEW.details->'children',NEW.payload->'adults',NEW.payload->'children');
    END IF;
    IF NEW.pms_user_id IS NOT DISTINCT FROM OLD.pms_user_id AND NOT coalesce(context_changed,false) THEN
      NEW.guest_contact_updated_at:=OLD.guest_contact_updated_at; RETURN NEW;
    END IF;
  END IF;
  SELECT p.host_id INTO host_id_value FROM public.listings l JOIN public.properties p ON p.id=l.property_id WHERE l.id=NEW.listing_id;
  IF NEW.pms_user_id IS NOT NULL THEN
    SELECT u.contact_updated_at INTO profile_version FROM public.pms_users u WHERE u.id=NEW.pms_user_id AND u.host_id=host_id_value FOR SHARE;
    -- Every reservation context writer takes this barrier. A host profile
    -- update can commit its fanout without booking locks; a waiting business
    -- update then sees that profile version and cannot reuse an older version.
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Guest profile belongs to another host'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.pms_user_id IS DISTINCT FROM OLD.pms_user_id AND current_user NOT IN ('postgres','supabase_admin','service_role') THEN
    -- A parent profile deletion can only detach its now-missing FK target.
    IF NOT (NEW.pms_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.pms_users u WHERE u.id=OLD.pms_user_id)) THEN
      IF TG_TABLE_NAME='bookings' THEN allowed:=public.can_rzr_booking(NEW.id,'edit_reservations');
      ELSE allowed:=public.can_pms_booking(NEW.booking_id,'edit_reservations'); END IF;
      IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reservation edit permission required'; END IF;
    END IF;
  END IF;
  NEW.guest_contact_updated_at:=greatest(clock_timestamp(),NEW.updated_at,profile_version,
    CASE WHEN TG_OP='UPDATE' THEN greatest(OLD.updated_at,OLD.guest_contact_updated_at) END)+interval '1 microsecond';
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.version_reservation_guest_link() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zz_version_native_guest_link BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION private.version_reservation_guest_link();
CREATE TRIGGER zz_version_ota_guest_link BEFORE INSERT OR UPDATE ON public.pms_bookings
  FOR EACH ROW EXECUTE FUNCTION private.version_reservation_guest_link();

CREATE OR REPLACE VIEW public.guest_checkin_reservation_context_view AS
SELECT 'rzr_booking'::text AS source_type,
    b.id AS source_record_id,
    b.id AS booking_id,
    NULL::uuid AS pms_booking_id,
    b.reservation_code::text AS reservation_code,
    b.listing_id,
    l.property_id,
    p.host_id,
    b.checkin_date,
    b.checkout_date,
    GREATEST(1, COALESCE(b.guest_adults, 1) + COALESCE(b.guest_children, 0)) AS expected_guest_count,
    CASE WHEN pu.id IS NOT NULL THEN CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_rzr_booking(b.id, 'view_reservations')) THEN coalesce(nullif(btrim(pu.full_name), ''), nullif(btrim(concat_ws(' ', pu.first_name, pu.last_name)), '')) END ELSE NULLIF(TRIM(BOTH FROM concat_ws(' '::text, gu.first_name, gu.last_name)), ''::text) END AS primary_guest_name,
    CASE WHEN pu.id IS NOT NULL THEN CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_rzr_booking(b.id, 'view_reservations')) AND (public.is_service_role() OR public.is_platform_admin() OR public.can_rzr_booking(b.id,'call_guests')) AND public.normalize_phone(pu.phone_raw) = pu.phone_normalized THEN nullif(btrim(pu.phone_raw), '') END ELSE NULLIF(TRIM(BOTH FROM gu.phone::text), ''::text) END AS primary_guest_phone,
    CASE WHEN pu.id IS NOT NULL THEN CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_rzr_booking(b.id, 'view_reservations')) THEN nullif(btrim(pu.email), '') END ELSE NULLIF(TRIM(BOTH FROM gu.email), ''::text) END AS primary_guest_email,
    b.booking_status::text AS reservation_status,
        CASE
            WHEN b.is_from_booking_engine THEN 'Booking Engine'::text
            ELSE 'Rukiye Zara'::text
        END AS channel_name,
    b.created_at AS reservation_created_at,
    greatest(b.updated_at, b.guest_contact_updated_at, pu.contact_updated_at) AS reservation_updated_at,
    jsonb_build_object('guest_adults', b.guest_adults, 'guest_children', b.guest_children, 'guest_pets', b.guest_pets, 'infant_count', b.infant_count, 'payment_status', b.payment_status, 'is_from_booking_engine', b.is_from_booking_engine) AS source_metadata,
    normalize_reservation_status('rzr_booking'::text, b.booking_status::text) AS canonical_status,
    cl.short_code AS channel_code,
    cl.title AS canonical_channel_name,
    b.user_id::text AS guest_external_id,
    CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_rzr_booking(b.id, 'view_reservations')) THEN array_remove(ARRAY[
      CASE WHEN pu.contact_provenance->>'name'='cleared' THEN 'name' END,
      CASE WHEN pu.contact_provenance->>'email'='cleared' THEN 'email' END,
      CASE WHEN pu.contact_provenance->>'phone'='cleared' THEN 'phone' END
    ],NULL) ELSE '{}'::text[] END AS guest_cleared_fields
   FROM bookings b
     JOIN listings l ON l.id = b.listing_id
     JOIN properties p ON p.id = l.property_id
     LEFT JOIN users gu ON gu.auth_id = b.user_id
     LEFT JOIN pms_users pu ON pu.id = b.pms_user_id AND pu.host_id = p.host_id

     LEFT JOIN channels_list cl ON lower(TRIM(BOTH FROM cl.short_code)) = lower(
        CASE
            WHEN b.is_from_booking_engine THEN 'BE'::text
            ELSE 'RZR'::text
        END) AND COALESCE(cl.is_active, true) = true
UNION ALL
 SELECT 'pms_booking'::text AS source_type,
    pb.booking_id AS source_record_id,
    NULL::uuid AS booking_id,
    pb.booking_id AS pms_booking_id,
    COALESCE(NULLIF(TRIM(BOTH FROM pb.ota_reservation_code), ''::text), pb.booking_id::text) AS reservation_code,
    pb.listing_id,
    l.property_id,
    p.host_id,
    pb.checkin_date,
    pb.checkout_date,
    GREATEST(1, COALESCE(NULLIF(pb.details #>> '{occupancy,adults}'::text[], ''::text)::integer, NULLIF(pb.details ->> 'adults'::text, ''::text)::integer, NULLIF(pb.payload ->> 'adults'::text, ''::text)::integer, 1) + COALESCE(NULLIF(pb.details #>> '{occupancy,children}'::text[], ''::text)::integer, NULLIF(pb.details ->> 'children'::text, ''::text)::integer, NULLIF(pb.payload ->> 'children'::text, ''::text)::integer, 0)) AS expected_guest_count,
    CASE WHEN pu.id IS NOT NULL THEN CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_pms_booking(pb.booking_id, 'view_reservations')) THEN coalesce(nullif(btrim(pu.full_name), ''), nullif(btrim(concat_ws(' ', pu.first_name, pu.last_name)), '')) END
      ELSE COALESCE(NULLIF(TRIM(BOTH FROM concat_ws(' ', NULLIF(pb.details #>> '{customer,name}', ''), NULLIF(pb.details #>> '{customer,surname}', ''))), ''), NULLIF(TRIM(BOTH FROM pb.payload->>'guest_name'), '')) END AS primary_guest_name,
    CASE WHEN pu.id IS NOT NULL THEN CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_pms_booking(pb.booking_id, 'view_reservations')) AND (public.is_service_role() OR public.is_platform_admin() OR public.can_pms_booking(pb.booking_id,'call_guests')) AND public.normalize_phone(pu.phone_raw) = pu.phone_normalized THEN nullif(btrim(pu.phone_raw), '') END
      ELSE COALESCE(NULLIF(TRIM(BOTH FROM pb.details #>> '{customer,phone}'), ''), NULLIF(TRIM(BOTH FROM pb.payload->>'guest_phone'), '')) END AS primary_guest_phone,
    CASE WHEN pu.id IS NOT NULL THEN CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_pms_booking(pb.booking_id, 'view_reservations')) THEN nullif(btrim(pu.email), '') END
      ELSE COALESCE(NULLIF(TRIM(BOTH FROM pb.details #>> '{customer,email}'), ''), NULLIF(TRIM(BOTH FROM pb.payload->>'guest_email'), '')) END AS primary_guest_email,
    pb.status AS reservation_status,
    COALESCE(NULLIF(TRIM(BOTH FROM pb.ota_name), ''::text), 'PMS'::text) AS channel_name,
    pb.created_at AS reservation_created_at,
    greatest(pb.updated_at, pb.guest_contact_updated_at, pu.contact_updated_at) AS reservation_updated_at,
    jsonb_build_object('ota_name', pb.ota_name, 'ota_reservation_code', pb.ota_reservation_code, 'pms_payment_status', pb.pms_payment_status) AS source_metadata,
    normalize_reservation_status('pms_booking'::text, pb.status) AS canonical_status,
    cl.short_code AS channel_code,
    cl.title AS canonical_channel_name,
    pb.pms_user_id::text AS guest_external_id,
    CASE WHEN (public.is_service_role() OR public.is_platform_admin() OR public.can_pms_booking(pb.booking_id, 'view_reservations')) THEN array_remove(ARRAY[
      CASE WHEN pu.contact_provenance->>'name'='cleared' THEN 'name' END,
      CASE WHEN pu.contact_provenance->>'email'='cleared' THEN 'email' END,
      CASE WHEN pu.contact_provenance->>'phone'='cleared' THEN 'phone' END
    ],NULL) ELSE '{}'::text[] END AS guest_cleared_fields
   FROM pms_bookings pb
     JOIN listings l ON l.id = pb.listing_id
     JOIN properties p ON p.id = l.property_id
     LEFT JOIN pms_users pu ON pu.id = pb.pms_user_id AND pu.host_id = p.host_id

     LEFT JOIN channels_list cl ON lower(TRIM(BOTH FROM cl.short_code)) = lower(TRIM(BOTH FROM pb.ota_name)) AND COALESCE(cl.is_active, true) = true;

CREATE OR REPLACE FUNCTION public.emit_domain_event(p_event_type text, p_host_id bigint, p_property_id bigint, p_resource_type text, p_resource_id text, p_source_type text, p_source_record_id text, p_data jsonb, p_idempotency_key text, p_occurred_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_event_id uuid;
    v_source_version timestamptz;
begin
    if p_event_type is null or length(trim(p_event_type)) < 3 then
        raise exception 'event_type is required';
    end if;

    if p_host_id is null or p_property_id is null then
        raise exception 'host_id and property_id are required';
    end if;

    if not exists (
        select 1
        from public.properties p
        where p.id = p_property_id
          and p.host_id = p_host_id
    ) then
        raise exception 'Property % does not belong to host %',
            p_property_id, p_host_id
            using errcode = '23514';
    end if;

    IF p_resource_type='reservation' AND p_source_type IN ('bookings','pms_bookings') THEN
      SELECT v.reservation_updated_at INTO v_source_version FROM public.guest_checkin_reservation_context_view v
      WHERE v.source_record_id::text=p_resource_id AND v.host_id=p_host_id AND v.property_id=p_property_id
        AND v.source_type=CASE p_source_type WHEN 'bookings' THEN 'rzr_booking' ELSE 'pms_booking' END;
    END IF;
    insert into public.domain_events (
        event_type,
        host_id,
        property_id,
        resource_type,
        resource_id,
        source_type,
        source_record_id,
        data,
        idempotency_key,
        occurred_at,
        contact_sync_txid
    )
    values (
        trim(p_event_type),
        p_host_id,
        p_property_id,
        trim(p_resource_type),
        trim(p_resource_id),
        nullif(trim(coalesce(p_source_type, '')), ''),
        nullif(trim(coalesce(p_source_record_id, '')), ''),
        coalesce(p_data, '{}'::jsonb) || CASE WHEN v_source_version IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('source_updated_at',v_source_version) END,
        trim(p_idempotency_key),
        coalesce(v_source_version,p_occurred_at,now()),
        pg_current_xact_id()
    )
    on conflict (idempotency_key)
    do nothing
    returning id into v_event_id;

    if v_event_id is null then
        select de.id
          into v_event_id
          from public.domain_events de
         where de.idempotency_key = trim(p_idempotency_key);
    end if;

    return v_event_id;
end;
$function$;

CREATE FUNCTION private.publish_reservation_guest_contact(p_source text,p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record; found_event boolean;
BEGIN
  SELECT v.*,p.timezone INTO r FROM public.guest_checkin_reservation_context_view v
    JOIN public.properties p ON p.id=v.property_id
    WHERE v.source_record_id=p_id AND v.source_type=p_source;
  IF NOT FOUND OR r.canonical_status='cancelled' OR
    (r.checkout_date IS NOT NULL AND r.checkout_date < (now() AT TIME ZONE coalesce(nullif(r.timezone,''),'UTC'))::date) THEN RETURN; END IF;
  UPDATE public.domain_events e SET occurred_at=r.reservation_updated_at,
    data=e.data||jsonb_build_object('source_updated_at',r.reservation_updated_at,'guest_contact_changed',true)
  WHERE e.contact_sync_txid=pg_current_xact_id() AND e.host_id=r.host_id AND e.property_id=r.property_id
    AND e.resource_type='reservation' AND e.resource_id=p_id::text
    AND e.source_type=CASE p_source WHEN 'rzr_booking' THEN 'bookings' ELSE 'pms_bookings' END
    AND e.event_type IN ('reservation.confirmed','reservation.cancelled','reservation.updated');
  found_event:=FOUND;
  IF NOT found_event THEN
    PERFORM public.emit_domain_event('reservation.updated',r.host_id,r.property_id,'reservation',p_id::text,
      CASE p_source WHEN 'rzr_booking' THEN 'bookings' ELSE 'pms_bookings' END,p_id::text,
      jsonb_build_object('reservation_id',p_id,'guest_contact_changed',true),
      format('reservation:contact:%s:%s:%s',p_source,p_id,r.reservation_updated_at),r.reservation_updated_at);
  END IF;
END $$;
REVOKE ALL ON FUNCTION private.publish_reservation_guest_contact(text,uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION private.fanout_pms_guest_contact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record;
BEGIN
  -- Query final links at commit. This never UPDATEs bookings or their timestamps,
  -- and never holds booking locks while the source writer is waiting on a profile.
  FOR r IN
    SELECT 'rzr_booking'::text source,b.id FROM public.bookings b
      JOIN public.listings l ON l.id=b.listing_id JOIN public.properties p ON p.id=l.property_id
      WHERE b.pms_user_id=NEW.id AND p.host_id=NEW.host_id
        AND lower(coalesce(b.booking_status,'')) NOT IN ('cancelled','canceled')
        AND (b.checkout_date IS NULL OR b.checkout_date >= (now() AT TIME ZONE coalesce(nullif(p.timezone,''),'UTC'))::date)
    UNION ALL
    SELECT 'pms_booking',b.booking_id FROM public.pms_bookings b
      JOIN public.listings l ON l.id=b.listing_id JOIN public.properties p ON p.id=l.property_id
      WHERE b.pms_user_id=NEW.id AND p.host_id=NEW.host_id
        AND lower(coalesce(b.status,'')) NOT IN ('cancelled','canceled')
        AND (b.checkout_date IS NULL OR b.checkout_date >= (now() AT TIME ZONE coalesce(nullif(p.timezone,''),'UTC'))::date)
  LOOP PERFORM private.publish_reservation_guest_contact(r.source,r.id); END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION private.fanout_pms_guest_contact() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER fanout_pms_guest_contact AFTER UPDATE ON public.pms_users
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (ROW(OLD.first_name,OLD.last_name,OLD.full_name,OLD.email,OLD.phone_raw,OLD.phone_normalized,coalesce(OLD.contact_provenance->>'name'='cleared',false), coalesce(OLD.contact_provenance->>'email'='cleared',false), coalesce(OLD.contact_provenance->>'phone'='cleared',false))
  IS DISTINCT FROM ROW(NEW.first_name,NEW.last_name,NEW.full_name,NEW.email,NEW.phone_raw,NEW.phone_normalized,coalesce(NEW.contact_provenance->>'name'='cleared',false), coalesce(NEW.contact_provenance->>'email'='cleared',false), coalesce(NEW.contact_provenance->>'phone'='cleared',false)))
EXECUTE FUNCTION private.fanout_pms_guest_contact();
CREATE FUNCTION private.publish_reservation_guest_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_TABLE_NAME='bookings' THEN PERFORM private.publish_reservation_guest_contact('rzr_booking',NEW.id);
  ELSE PERFORM private.publish_reservation_guest_contact('pms_booking',NEW.booking_id); END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION private.publish_reservation_guest_link() FROM PUBLIC,anon,authenticated;
CREATE CONSTRAINT TRIGGER publish_native_guest_link AFTER UPDATE ON public.bookings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.pms_user_id IS DISTINCT FROM NEW.pms_user_id)
EXECUTE FUNCTION private.publish_reservation_guest_link();
CREATE CONSTRAINT TRIGGER publish_ota_guest_link AFTER UPDATE ON public.pms_bookings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.pms_user_id IS DISTINCT FROM NEW.pms_user_id)
EXECUTE FUNCTION private.publish_reservation_guest_link();

CREATE OR REPLACE FUNCTION public.update_pms_booking_guest(p_booking_id uuid, p_updates jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_pms_user_id uuid;
    v_host_id bigint;

    v_current_first text;
    v_current_last text;
    v_current_full text;
    v_current_email text;
    v_current_phone_raw text;
    v_current_phone_norm text;

    v_first text;
    v_last text;
    v_full text;
    v_email text;
    v_phone_raw text;
    v_phone_norm text;

    v_has_first boolean;
    v_has_last boolean;
    v_has_email boolean;
    v_has_phone boolean;

    v_phone_match_id uuid;
    v_email_match_id uuid;
    v_conflict_user_id uuid;
    v_conflict_field text;
    v_conflict_name text;
    v_previous_reservations integer;
begin
    if p_booking_id is null then
        raise exception 'booking_id is required';
    end if;

    if p_updates is null or jsonb_typeof(p_updates) <> 'object' then
        raise exception 'updates must be a JSON object';
    end if;

    if exists (
        select 1
        from jsonb_object_keys(p_updates) as k(key)
        where k.key not in ('first_name','last_name','email','phone')
    ) then
        raise exception 'Unsupported guest field';
    end if;

    if p_updates = '{}'::jsonb then
        raise exception 'No guest fields supplied';
    end if;

    select pb.pms_user_id, l.host_id
    into v_pms_user_id, v_host_id
    from public.pms_bookings pb
    join public.listings l on l.id = pb.listing_id
    where pb.booking_id = p_booking_id
    for update of pb;

    if not found then
        raise exception 'PMS booking not found';
    end if;

    if not public.can_pms_booking(p_booking_id, 'edit_reservations') then
        raise exception 'Unauthorized: edit_reservations permission required';
    end if;

    if v_pms_user_id is null then
        raise exception 'Guest profile is not linked to this booking';
    end if;

    select
        pu.first_name,
        pu.last_name,
        pu.full_name,
        pu.email,
        pu.phone_raw,
        pu.phone_normalized
    into
        v_current_first,
        v_current_last,
        v_current_full,
        v_current_email,
        v_current_phone_raw,
        v_current_phone_norm
    from public.pms_users pu
    where pu.id = v_pms_user_id
      and pu.host_id = v_host_id;

    if not found then
        raise exception 'Invalid guest profile relationship';
    end if;

    v_has_first := p_updates ? 'first_name';
    v_has_last  := p_updates ? 'last_name';
    v_has_email := p_updates ? 'email';
    v_has_phone := p_updates ? 'phone';

    v_first := case
        when v_has_first then nullif(btrim(p_updates->>'first_name'), '')
        else v_current_first
    end;

    v_last := case
        when v_has_last then nullif(btrim(p_updates->>'last_name'), '')
        else v_current_last
    end;

    v_email := case
        when v_has_email then lower(nullif(btrim(p_updates->>'email'), ''))
        else v_current_email
    end;

    v_phone_raw := case
        when v_has_phone then nullif(btrim(p_updates->>'phone'), '')
        else v_current_phone_raw
    end;

    if v_has_first or v_has_last then
        v_full := nullif(btrim(concat_ws(' ', v_first, v_last)), '');
    else
        v_full := v_current_full;
    end if;

    if v_has_phone then
        v_phone_norm := public.normalize_phone(v_phone_raw);

        if v_phone_norm is not null
           and (
               length(v_phone_norm) < 7
               or v_phone_norm ~ '^(0+|1+|2+|3+|4+|5+|6+|7+|8+|9+)$'
               or v_phone_norm in ('1234567890','0123456789')
           )
        then
            v_phone_norm := null;
        end if;
    else
        v_phone_norm := v_current_phone_norm;
    end if;

    -- Strong identity matches only: same host + normalized phone/email.
    if v_has_phone and v_phone_norm is not null then
        select pu.id
        into v_phone_match_id
        from public.pms_users pu
        where pu.host_id = v_host_id
          and pu.phone_normalized = v_phone_norm
          and pu.id <> v_pms_user_id
        order by pu.updated_at desc nulls last, pu.created_at desc nulls last
        limit 1;
    end if;

    if v_has_email and v_email is not null then
        select pu.id
        into v_email_match_id
        from public.pms_users pu
        where pu.host_id = v_host_id
          and lower(pu.email) = v_email
          and pu.id <> v_pms_user_id
        order by pu.updated_at desc nulls last, pu.created_at desc nulls last
        limit 1;
    end if;

    -- Never guess when phone and email point at different existing people.
    if v_phone_match_id is not null
       and v_email_match_id is not null
       and v_phone_match_id <> v_email_match_id
    then
        return jsonb_build_object(
            'success', false,
            'error_code', 'identity_conflict_ambiguous',
            'error', 'The phone number and email belong to different existing guest profiles. Review the guest details before linking.'
        );
    end if;

    v_conflict_user_id := coalesce(v_phone_match_id, v_email_match_id);

    if v_conflict_user_id is not null then
        v_conflict_field := case
            when v_phone_match_id is not null and v_email_match_id is not null then 'phone_and_email'
            when v_phone_match_id is not null then 'phone'
            else 'email'
        end;

        select
            coalesce(
                nullif(btrim(pu.full_name), ''),
                nullif(btrim(concat_ws(' ', pu.first_name, pu.last_name)), ''),
                'Existing guest'
            )
        into v_conflict_name
        from public.pms_users pu
        where pu.id = v_conflict_user_id
          and pu.host_id = v_host_id;

        select count(*)::integer
        into v_previous_reservations
        from public.pms_bookings pb
        where pb.pms_user_id = v_conflict_user_id
          and pb.booking_id <> p_booking_id;

        return jsonb_build_object(
            'success', false,
            'requires_link_confirmation', true,
            'error_code', 'existing_guest_match',
            'conflict', jsonb_build_object(
                'field', v_conflict_field,
                'existing_pms_user_id', v_conflict_user_id,
                'guest', jsonb_build_object(
                    'name', v_conflict_name,
                    'previous_reservations', coalesce(v_previous_reservations, 0)
                )
            )
        );
    end if;

    -- No identity collision: normal edit.
    update public.pms_users
    set
        first_name = v_first,
        last_name = v_last,
        full_name = v_full,
        email = v_email,
        phone_raw = v_phone_raw,
        phone_normalized = v_phone_norm,
        contact_provenance = contact_provenance || jsonb_strip_nulls(jsonb_build_object(
          'name',CASE WHEN v_has_first OR v_has_last THEN CASE WHEN v_full IS NULL THEN 'cleared' ELSE 'host' END END,
          'email',CASE WHEN v_has_email THEN CASE WHEN v_email IS NULL THEN 'cleared' ELSE 'host' END END,
          'phone',CASE WHEN v_has_phone THEN CASE WHEN v_phone_raw IS NULL THEN 'cleared' ELSE 'host' END END)),
        updated_at = now()
    where id = v_pms_user_id
      and host_id = v_host_id;

    return jsonb_build_object(
        'success', true,
        'booking_id', p_booking_id,
        'pms_user_id', v_pms_user_id,
        'guest', jsonb_build_object(
            'pms_user_id', v_pms_user_id,
            'first_name', v_first,
            'last_name', v_last,
            'name', v_full,
            'email', v_email,
            'phone', v_phone_raw
        )
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.link_pms_booking_to_existing_guest(p_booking_id uuid, p_target_pms_user_id uuid, p_updates jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_source_pms_user_id uuid;
    v_host_id bigint;
    v_booking_date timestamptz;

    v_target_host_id bigint;
    v_target_phone text;
    v_target_email text;

    v_input_phone_norm text;
    v_input_email text;
    v_phone_matches boolean := false;
    v_email_matches boolean := false;

    v_source_first text;
    v_source_last text;
    v_source_full text;
    v_source_country text;
    v_source_notes text;
    v_source_provenance jsonb;
    v_source_remaining integer;
    v_source_deleted boolean := false;

    v_result jsonb;
begin
    if p_booking_id is null or p_target_pms_user_id is null then
        raise exception 'booking_id and target_pms_user_id are required';
    end if;

    if p_updates is null or jsonb_typeof(p_updates) <> 'object' then
        raise exception 'updates must be a JSON object';
    end if;

    if exists (
        select 1
        from jsonb_object_keys(p_updates) as k(key)
        where k.key not in ('first_name','last_name','email','phone')
    ) then
        raise exception 'Unsupported guest field';
    end if;

    select pb.pms_user_id, l.host_id, pb.booking_date
    into v_source_pms_user_id, v_host_id, v_booking_date
    from public.pms_bookings pb
    join public.listings l on l.id = pb.listing_id
    where pb.booking_id = p_booking_id
    for update of pb;

    if not found then
        raise exception 'PMS booking not found';
    end if;

    if not public.can_pms_booking(p_booking_id, 'edit_reservations') then
        raise exception 'Unauthorized: edit_reservations permission required';
    end if;

    if v_source_pms_user_id is null then
        raise exception 'Guest profile is not linked to this booking';
    end if;

    select pu.host_id, pu.phone_normalized, lower(pu.email)
    into v_target_host_id, v_target_phone, v_target_email
    from public.pms_users pu
    where pu.id = p_target_pms_user_id
    for update;

    if not found or v_target_host_id is distinct from v_host_id then
        raise exception 'Existing guest profile is not valid for this host';
    end if;

    -- Re-check the identifier on confirmation. This prevents a stale modal from
    -- linking to a profile that no longer owns the phone/email.
    if p_updates ? 'phone' then
        v_input_phone_norm := public.normalize_phone(nullif(btrim(p_updates->>'phone'), ''));
        v_phone_matches := v_input_phone_norm is not null and v_target_phone = v_input_phone_norm;
    end if;

    if p_updates ? 'email' then
        v_input_email := lower(nullif(btrim(p_updates->>'email'), ''));
        v_email_matches := v_input_email is not null and v_target_email = v_input_email;
    end if;

    if not (v_phone_matches or v_email_matches) then
        raise exception 'The existing guest no longer matches the phone or email being saved';
    end if;

    if v_source_pms_user_id = p_target_pms_user_id then
        return public.update_pms_booking_guest(p_booking_id, p_updates);
    end if;

    select first_name, last_name, full_name, country, notes, contact_provenance
    into v_source_first, v_source_last, v_source_full, v_source_country, v_source_notes, v_source_provenance
    from public.pms_users
    where id = v_source_pms_user_id
      and host_id = v_host_id
    for update;

    if not found then
        raise exception 'Current guest profile was not found';
    end if;

    -- Relink ONLY this reservation. We never bulk-move bookings based solely on a manual edit.
    update public.pms_bookings
    set pms_user_id = p_target_pms_user_id
    where booking_id = p_booking_id;

    -- Preserve useful information from the temporary profile without overwriting
    -- established data on the canonical profile.
    update public.pms_users target
    set
        first_name = CASE WHEN target.contact_provenance ? 'name' THEN target.first_name ELSE coalesce(target.first_name, v_source_first) END,
        last_name = CASE WHEN target.contact_provenance ? 'name' THEN target.last_name ELSE coalesce(target.last_name, v_source_last) END,
        full_name = CASE WHEN target.contact_provenance ? 'name' THEN target.full_name ELSE coalesce(target.full_name, v_source_full) END,
        -- If linking adopts a host/historical name, carry its ownership with
        -- the adopted value. Never transfer a source clear onto a populated target.
        contact_provenance = target.contact_provenance || CASE
          WHEN NOT target.contact_provenance ? 'name'
           AND v_source_provenance->>'name' IN ('host','legacy')
           AND ((target.first_name IS NULL AND nullif(btrim(v_source_first),'') IS NOT NULL)
             OR (target.last_name IS NULL AND nullif(btrim(v_source_last),'') IS NOT NULL)
             OR (target.full_name IS NULL AND nullif(btrim(v_source_full),'') IS NOT NULL))
          THEN jsonb_build_object('name',v_source_provenance->>'name') ELSE '{}'::jsonb END,
        country = coalesce(target.country, v_source_country),
        notes = coalesce(target.notes, v_source_notes),
        last_seen_booking_id = case
            when coalesce(v_booking_date, now()) >= coalesce(target.last_seen_booking_at, '-infinity'::timestamptz)
            then p_booking_id
            else target.last_seen_booking_id
        end,
        last_seen_booking_at = greatest(
            coalesce(target.last_seen_booking_at, '-infinity'::timestamptz),
            coalesce(v_booking_date, now())
        ),
        updated_at = now()
    where target.id = p_target_pms_user_id
      and target.host_id = v_host_id;

    -- Apply the fields the host just entered to the now-canonical profile.
    v_result := public.update_pms_booking_guest(p_booking_id, p_updates);

    if coalesce((v_result->>'success')::boolean, false) is not true then
        raise exception '%', coalesce(v_result->>'error', 'Could not update linked guest profile');
    end if;

    -- Remove the provisional duplicate only when nothing references it anymore.
    select count(*)::integer
    into v_source_remaining
    from public.pms_bookings
    where pms_user_id = v_source_pms_user_id;

    if v_source_remaining = 0 AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.pms_user_id=v_source_pms_user_id) then
        delete from public.pms_users
        where id = v_source_pms_user_id
          and host_id = v_host_id;
        v_source_deleted := found;
    end if;

    return v_result || jsonb_build_object(
        'linked_existing_guest', true,
        'previous_pms_user_id', v_source_pms_user_id,
        'source_profile_deleted', v_source_deleted
    );
end;
$function$;

CREATE FUNCTION public.update_rzr_booking_guest_contact(
 p_booking_id uuid,p_name text,p_email text,p_phone text,p_profile_id uuid DEFAULT NULL,p_update_shared_profile boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE host_id_value bigint; linked_id uuid; target_id uuid; guest public.pms_users%ROWTYPE;
 name_value text:=nullif(btrim(p_name),''); email_value text:=lower(nullif(btrim(p_email),'')); phone_value text:=nullif(btrim(p_phone),'');
 fields_value jsonb; other_count integer; changed boolean; r record;
BEGIN
 IF NOT coalesce(public.can_rzr_booking(p_booking_id,'edit_reservations'),false) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reservation edit permission required'; END IF;
 IF length(p_name)>200 OR length(p_email)>320 OR length(p_phone)>50
   OR (email_value IS NOT NULL AND email_value !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
   OR (phone_value IS NOT NULL AND phone_value !~ '^[+0-9[:space:]().-]{7,30}$') THEN RAISE EXCEPTION 'Invalid guest contact details'; END IF;
 SELECT p.host_id,b.pms_user_id INTO STRICT host_id_value,linked_id FROM public.bookings b
   JOIN public.listings l ON l.id=b.listing_id JOIN public.properties p ON p.id=l.property_id
   WHERE b.id=p_booking_id FOR UPDATE OF b;
 IF linked_id IS NOT NULL AND p_profile_id IS NOT NULL AND linked_id<>p_profile_id THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Changing the linked guest requires an explicit linking flow'; END IF;
 target_id:=coalesce(linked_id,p_profile_id);
 IF target_id IS NOT NULL THEN
   SELECT * INTO STRICT guest FROM public.pms_users u WHERE u.id=target_id AND u.host_id=host_id_value FOR UPDATE;
   -- All three RPC arguments are supplied host intent, even when the displayed
   -- value already matches the source. Protect it without emitting a value event.
   fields_value:=guest.contact_provenance || jsonb_build_object(
     'name',CASE WHEN name_value IS NULL THEN 'cleared' ELSE 'host' END,
     'email',CASE WHEN email_value IS NULL THEN 'cleared' ELSE 'host' END,
     'phone',CASE WHEN phone_value IS NULL THEN 'cleared' ELSE 'host' END);
   changed:=ROW(name_value,email_value,phone_value,fields_value) IS DISTINCT FROM ROW(guest.full_name,guest.email,guest.phone_raw,guest.contact_provenance);
   SELECT count(*) INTO other_count FROM (
     SELECT b.id FROM public.bookings b WHERE b.pms_user_id=target_id AND b.id<>p_booking_id
     UNION ALL SELECT b.booking_id FROM public.pms_bookings b WHERE b.pms_user_id=target_id
   ) others;
   IF changed AND other_count>0 THEN
     IF NOT p_update_shared_profile THEN RETURN jsonb_build_object('success',false,'requires_shared_guest_confirmation',true,'affected_other_reservations',other_count); END IF;
     -- A new native caller cannot edit a profile across reservations it cannot edit.
     FOR r IN SELECT 'rzr_booking'::text source,b.id FROM public.bookings b WHERE b.pms_user_id=target_id
       UNION ALL SELECT 'pms_booking',b.booking_id FROM public.pms_bookings b WHERE b.pms_user_id=target_id
     LOOP
       IF NOT coalesce(CASE r.source WHEN 'rzr_booking' THEN public.can_rzr_booking(r.id,'edit_reservations') ELSE public.can_pms_booking(r.id,'edit_reservations') END,false)
       THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Shared guest edit includes an unauthorized reservation'; END IF;
     END LOOP;
   END IF;
   IF changed THEN
   UPDATE public.pms_users SET first_name=CASE WHEN name_value IS DISTINCT FROM guest.full_name THEN split_part(name_value,' ',1) ELSE guest.first_name END,last_name=CASE WHEN name_value IS DISTINCT FROM guest.full_name THEN nullif(btrim(substr(name_value,length(split_part(name_value,' ',1))+1)),'') ELSE guest.last_name END,
     full_name=name_value,email=email_value,phone_raw=phone_value,phone_normalized=public.normalize_phone(phone_value),
     contact_provenance=fields_value,updated_at=now()
   WHERE id=target_id AND host_id=host_id_value RETURNING * INTO guest;
   END IF;
 ELSE
   INSERT INTO public.pms_users(host_id,first_name,last_name,full_name,email,phone_raw,phone_normalized,last_seen_booking_id,contact_provenance)
     VALUES(host_id_value,split_part(name_value,' ',1),nullif(btrim(substr(name_value,length(split_part(name_value,' ',1))+1)),''),
       name_value,email_value,phone_value,public.normalize_phone(phone_value),p_booking_id,jsonb_build_object('name',CASE WHEN name_value IS NULL THEN 'cleared' ELSE 'host' END,'email',CASE WHEN email_value IS NULL THEN 'cleared' ELSE 'host' END,'phone',CASE WHEN phone_value IS NULL THEN 'cleared' ELSE 'host' END)) RETURNING * INTO guest;
   target_id:=guest.id;
 END IF;
 UPDATE public.bookings SET pms_user_id=target_id WHERE id=p_booking_id AND pms_user_id IS DISTINCT FROM target_id;
 RETURN jsonb_build_object('success',true,'pms_user_id',guest.id,'name',guest.full_name,'email',guest.email,'phone',guest.phone_raw);
END $$;
REVOKE ALL ON FUNCTION public.update_rzr_booking_guest_contact(uuid,text,text,text,uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_rzr_booking_guest_contact(uuid,text,text,text,uuid,boolean) TO authenticated,service_role;
COMMIT;
