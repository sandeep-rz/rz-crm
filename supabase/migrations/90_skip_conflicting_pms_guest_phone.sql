-- Fix PMS contact enrichment conflicts without merging different guest identities.
-- Apply separately only when the matching CRM code is ready for deployment.
BEGIN;

CREATE OR REPLACE FUNCTION public.sync_mapped_pms_guest_contact(
  p_account_id uuid,
  p_integration_id uuid,
  p_property_id uuid,
  p_external_guest_id text,
  p_event_at timestamptz,
  p_name text,
  p_email text,
  p_phone text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_identity public.pms_contact_external_identities%ROWTYPE;
  v_contact_id uuid;
  v_constraint text;
BEGIN
  IF p_event_at IS NULL OR p_external_guest_id IS NULL OR btrim(p_external_guest_id) = '' THEN
    RAISE EXCEPTION 'guest event version and id required';
  END IF;

  -- A guest event can only affect an already linked contact, never a CRM-only contact.
  -- Lock the identity row to serialize concurrent out-of-order events.
  SELECT i.* INTO v_identity
  FROM public.pms_contact_external_identities i
  JOIN public.pms_integrations pi
    ON pi.id=i.pms_integration_id AND pi.account_id=i.account_id
   AND pi.status='connected'
  JOIN public.pms_properties pp
    ON pp.id=p_property_id AND pp.pms_integration_id=pi.id
   AND pp.account_id=pi.account_id AND pp.status='active'
  WHERE i.account_id=p_account_id
    AND i.pms_integration_id=p_integration_id
    AND i.external_guest_id=p_external_guest_id
    AND EXISTS (
      SELECT 1 FROM public.pms_reservations pr
      WHERE pr.account_id=p_account_id AND pr.pms_integration_id=p_integration_id
        AND pr.pms_property_id=p_property_id
        AND pr.external_guest_id=p_external_guest_id
        AND pr.contact_id=i.contact_id
    )
  FOR UPDATE OF i;

  IF NOT FOUND THEN RETURN false; END IF;
  IF v_identity.last_guest_event_at IS NOT NULL
     AND v_identity.last_guest_event_at >= p_event_at THEN RETURN true; END IF;

  -- Keep the contact mapping stable even if another CRM contact owns this phone.
  -- Isolate the conflicting update in a subtransaction; apply name/email only.
  BEGIN
    UPDATE public.contacts c
    SET name=NULLIF(btrim(p_name),''),
        email=NULLIF(lower(btrim(p_email)),''),
        phone=CASE WHEN p_phone IS NULL THEN c.phone ELSE p_phone END
    WHERE c.id=v_identity.contact_id AND c.account_id=p_account_id
    RETURNING c.id INTO v_contact_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'idx_contacts_account_phone_normalized' THEN
      RAISE;
    END IF;
    UPDATE public.contacts c
    SET name=NULLIF(btrim(p_name),''),
        email=NULLIF(lower(btrim(p_email)),'')
    WHERE c.id=v_identity.contact_id AND c.account_id=p_account_id
    RETURNING c.id INTO v_contact_id;
  END;
  IF v_contact_id IS NULL THEN RETURN false; END IF;

  UPDATE public.pms_contact_external_identities
  SET last_guest_event_at=p_event_at
  WHERE id=v_identity.id;
  RETURN true;
END;
$$;


REVOKE ALL ON FUNCTION public.sync_mapped_pms_guest_contact(uuid,uuid,uuid,text,timestamptz,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_mapped_pms_guest_contact(uuid,uuid,uuid,text,timestamptz,text,text,text)
  TO service_role;

COMMIT;
