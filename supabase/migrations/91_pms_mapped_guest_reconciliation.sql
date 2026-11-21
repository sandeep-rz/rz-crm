-- Recover missed guest.updated webhooks for already-mapped reservation guests.
-- No guest directory enumeration or contact creation.
BEGIN;

CREATE OR REPLACE FUNCTION public.list_pms_reconciliation_guest_candidates(
  p_account_id uuid,
  p_integration_id uuid,
  p_property_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(external_guest_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'Guest reconciliation limit must be between 1 and 200';
  END IF;

  RETURN QUERY
  SELECT i.external_guest_id
  FROM public.pms_contact_external_identities AS i
  JOIN public.pms_integrations AS pi
    ON pi.id = i.pms_integration_id
   AND pi.account_id = i.account_id
   AND pi.status = 'connected'
  JOIN public.pms_properties AS pp
    ON pp.id = p_property_id
   AND pp.pms_integration_id = pi.id
   AND pp.account_id = pi.account_id
   AND pp.status = 'active'
  WHERE i.account_id = p_account_id
    AND i.pms_integration_id = p_integration_id
    AND EXISTS (
      SELECT 1
      FROM public.pms_reservations AS r
      WHERE r.account_id = p_account_id
        AND r.pms_integration_id = p_integration_id
        AND r.pms_property_id = p_property_id
        AND r.external_guest_id = i.external_guest_id
        AND r.contact_id = i.contact_id
    )
  ORDER BY i.last_guest_event_at ASC NULLS FIRST, i.external_guest_id ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_pms_reconciliation_guest_candidates(uuid,uuid,uuid,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_pms_reconciliation_guest_candidates(uuid,uuid,uuid,integer)
  TO service_role;

COMMIT;
