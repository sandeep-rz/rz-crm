-- Account-scoped, provider-neutral reservation workspace query.
-- Lifecycle is derived at read time using each property's local calendar date.

CREATE INDEX IF NOT EXISTS pms_reservations_account_check_in_id_idx
  ON public.pms_reservations (account_id, check_in, id);

CREATE INDEX IF NOT EXISTS pms_reservations_account_check_out_id_idx
  ON public.pms_reservations (account_id, check_out DESC, id);

CREATE OR REPLACE FUNCTION public.list_crm_reservations(
  p_account_id UUID,
  p_lifecycle TEXT DEFAULT 'all',
  p_search TEXT DEFAULT NULL,
  p_property_id UUID DEFAULT NULL,
  p_channel TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_date_from DATE DEFAULT NULL,
  p_date_to DATE DEFAULT NULL,
  p_limit INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  contact_id UUID,
  property_id UUID,
  property_name TEXT,
  property_timezone TEXT,
  integration_provider TEXT,
  integration_display_name TEXT,
  guest_name TEXT,
  guest_phone TEXT,
  guest_email TEXT,
  reservation_code TEXT,
  status TEXT,
  provider_status TEXT,
  lifecycle TEXT,
  check_in DATE,
  check_out DATE,
  adults INTEGER,
  children INTEGER,
  infants INTEGER,
  pets INTEGER,
  occupancy_total INTEGER,
  channel_code TEXT,
  channel_name TEXT,
  total_amount NUMERIC,
  currency TEXT,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH projected AS (
    SELECT
      r.id,
      r.contact_id,
      r.pms_property_id AS property_id,
      p.name AS property_name,
      COALESCE(NULLIF(p.timezone, ''), 'UTC') AS property_timezone,
      i.provider AS integration_provider,
      i.display_name AS integration_display_name,
      c.name AS guest_name,
      c.phone AS guest_phone,
      c.email AS guest_email,
      r.reservation_code,
      r.status,
      r.provider_status,
      CASE
        WHEN r.status ~* 'cancel' THEN 'cancelled'
        WHEN r.status ~* '^(completed|checked[ _-]?out)$'
          OR (r.check_out IS NOT NULL AND r.check_out <= (now() AT TIME ZONE COALESCE(NULLIF(p.timezone, ''), 'UTC'))::date)
          THEN 'checked_out'
        WHEN r.check_in IS NOT NULL
          AND r.check_in <= (now() AT TIME ZONE COALESCE(NULLIF(p.timezone, ''), 'UTC'))::date
          AND (r.check_out IS NULL OR r.check_out > (now() AT TIME ZONE COALESCE(NULLIF(p.timezone, ''), 'UTC'))::date)
          THEN 'staying_now'
        ELSE 'upcoming'
      END AS lifecycle,
      r.check_in,
      r.check_out,
      r.adults,
      r.children,
      r.infants,
      r.pets,
      r.occupancy_total,
      r.channel_code,
      r.channel_name,
      r.total_amount,
      r.currency,
      r.last_synced_at,
      r.updated_at
    FROM public.pms_reservations AS r
    JOIN public.pms_properties AS p
      ON p.id = r.pms_property_id AND p.account_id = r.account_id
    JOIN public.pms_integrations AS i
      ON i.id = r.pms_integration_id AND i.account_id = r.account_id
    LEFT JOIN public.contacts AS c
      ON c.id = r.contact_id AND c.account_id = r.account_id
    WHERE r.account_id = p_account_id
      AND public.is_account_member(p_account_id)
  ), filtered AS (
    SELECT *
    FROM projected AS x
    WHERE (p_lifecycle = 'all' OR x.lifecycle = p_lifecycle)
      AND (p_property_id IS NULL OR x.property_id = p_property_id)
      AND (p_channel IS NULL OR COALESCE(x.channel_name, x.channel_code) = p_channel)
      AND (p_status IS NULL OR x.status = p_status)
      AND (p_date_from IS NULL OR x.check_out IS NULL OR x.check_out >= p_date_from)
      AND (p_date_to IS NULL OR x.check_in IS NULL OR x.check_in <= p_date_to)
      AND (
        NULLIF(btrim(p_search), '') IS NULL
        OR x.reservation_code ILIKE '%' || btrim(p_search) || '%'
        OR x.guest_name ILIKE '%' || btrim(p_search) || '%'
        OR x.guest_phone ILIKE '%' || btrim(p_search) || '%'
        OR x.guest_email ILIKE '%' || btrim(p_search) || '%'
        OR x.property_name ILIKE '%' || btrim(p_search) || '%'
        OR x.channel_name ILIKE '%' || btrim(p_search) || '%'
        OR x.channel_code ILIKE '%' || btrim(p_search) || '%'
      )
  )
  SELECT x.*, count(*) OVER () AS total_count
  FROM filtered AS x
  ORDER BY
    CASE WHEN p_lifecycle = 'upcoming' THEN x.check_in END ASC NULLS LAST,
    CASE WHEN p_lifecycle = 'staying_now' THEN x.check_out END ASC NULLS LAST,
    CASE WHEN p_lifecycle = 'checked_out' THEN x.check_out END DESC NULLS LAST,
    CASE WHEN p_lifecycle = 'cancelled' THEN x.updated_at END DESC NULLS LAST,
    CASE WHEN p_lifecycle = 'all' THEN x.updated_at END DESC NULLS LAST,
    x.id ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

REVOKE ALL ON FUNCTION public.list_crm_reservations(UUID, TEXT, TEXT, UUID, TEXT, TEXT, DATE, DATE, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_crm_reservations(UUID, TEXT, TEXT, UUID, TEXT, TEXT, DATE, DATE, INTEGER, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_crm_reservation_filter_options(p_account_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'channels', COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM (
      SELECT DISTINCT COALESCE(r.channel_name, r.channel_code) AS value
      FROM public.pms_reservations AS r
      WHERE r.account_id = p_account_id AND COALESCE(r.channel_name, r.channel_code) IS NOT NULL
    ) AS channels), '[]'::jsonb),
    'statuses', COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM (
      SELECT DISTINCT r.status AS value FROM public.pms_reservations AS r
      WHERE r.account_id = p_account_id AND r.status IS NOT NULL
    ) AS statuses), '[]'::jsonb)
  )
  WHERE public.is_account_member(p_account_id);
$$;

REVOKE ALL ON FUNCTION public.get_crm_reservation_filter_options(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crm_reservation_filter_options(UUID) TO authenticated;
