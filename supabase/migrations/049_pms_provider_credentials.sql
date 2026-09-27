-- 049_pms_provider_credentials.sql
-- Rukiye Zara CRM / WACRM fork
--
-- Trusted server-to-server PMS provider authentication foundation.
-- This is intentionally separate from workspace-level pms_integrations.
--
-- IMPORTANT:
-- - Store only SHA-256 hashes of provider bearer credentials.
-- - Never store the raw credential in this table.
-- - Credential creation/rotation will be handled by trusted server/admin code.
-- - Depends on migrations 001-048.

BEGIN;

CREATE TABLE public.pms_provider_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Stable adapter/provider code, e.g. rukiye_zara.
  provider TEXT NOT NULL,

  -- Human-readable identifier for operations/admin use.
  name TEXT NOT NULL,

  -- Public identifier carried alongside the secret so lookup does not require
  -- scanning/hash-comparing every credential.
  key_id UUID NOT NULL DEFAULT uuid_generate_v4(),

  -- SHA-256 digest encoded as lowercase hex (64 chars).
  secret_hash TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),

  -- Optional provider permissions for future expansion.
  scopes TEXT[] NOT NULL DEFAULT ARRAY['provision']::TEXT[],

  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pms_provider_credentials_provider_not_blank
    CHECK (btrim(provider) <> ''),

  CONSTRAINT pms_provider_credentials_name_not_blank
    CHECK (btrim(name) <> ''),

  CONSTRAINT pms_provider_credentials_key_id_unique
    UNIQUE (key_id),

  CONSTRAINT pms_provider_credentials_secret_hash_format
    CHECK (secret_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT pms_provider_credentials_revocation_consistent
    CHECK (
      (status = 'active' AND revoked_at IS NULL)
      OR
      (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX idx_pms_provider_credentials_provider_status
  ON public.pms_provider_credentials(provider, status);

CREATE INDEX idx_pms_provider_credentials_active_key
  ON public.pms_provider_credentials(key_id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS set_updated_at ON public.pms_provider_credentials;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON public.pms_provider_credentials
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.pms_provider_credentials IS
  'Hashed credentials used by trusted external PMS providers to authenticate server-to-server with RZ CRM. Raw secrets must never be stored here.';

COMMENT ON COLUMN public.pms_provider_credentials.key_id IS
  'Non-secret credential identifier. The caller sends this together with its raw secret.';

COMMENT ON COLUMN public.pms_provider_credentials.secret_hash IS
  'Lowercase hex SHA-256 digest of the raw provider secret.';

-- ============================================================================
-- Credential verification RPC
--
-- Called only from trusted CRM server code using service_role.
-- Input:
--   key id + SHA-256 hash computed by the server from the presented raw secret.
--
-- We intentionally do NOT accept or hash the raw secret in SQL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.verify_pms_provider_credential(
  p_key_id UUID,
  p_secret_hash TEXT,
  p_required_scope TEXT DEFAULT NULL
)
RETURNS TABLE (
  credential_id UUID,
  provider TEXT,
  scopes TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.pms_provider_credentials%ROWTYPE;
BEGIN
  IF p_key_id IS NULL
     OR p_secret_hash IS NULL
     OR p_secret_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  SELECT *
    INTO v_row
    FROM public.pms_provider_credentials c
   WHERE c.key_id = p_key_id
     AND c.status = 'active'
     AND (c.expires_at IS NULL OR c.expires_at > NOW())
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Constant-time comparison should additionally be performed in application
  -- code before calling provider-specific business logic. SQL equality here
  -- is a secondary DB-side verification boundary.
  IF v_row.secret_hash <> p_secret_hash THEN
    RETURN;
  END IF;

  IF p_required_scope IS NOT NULL
     AND NOT (p_required_scope = ANY(v_row.scopes)) THEN
    RETURN;
  END IF;

  UPDATE public.pms_provider_credentials
     SET last_used_at = NOW(),
         updated_at = NOW()
   WHERE id = v_row.id;

  RETURN QUERY
  SELECT v_row.id, v_row.provider, v_row.scopes;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_pms_provider_credential(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.verify_pms_provider_credential(UUID, TEXT, TEXT)
  TO service_role;

-- ============================================================================
-- Rotation helper
--
-- Trusted server/admin supplies a NEW SHA-256 hash. This revokes the previous
-- credential and creates a replacement atomically. It never handles raw keys.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rotate_pms_provider_credential(
  p_credential_id UUID,
  p_new_secret_hash TEXT,
  p_new_key_id UUID DEFAULT uuid_generate_v4()
)
RETURNS TABLE (
  credential_id UUID,
  key_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old public.pms_provider_credentials%ROWTYPE;
  v_new_id UUID;
BEGIN
  IF p_new_secret_hash IS NULL
     OR p_new_secret_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid SHA-256 secret hash';
  END IF;

  SELECT *
    INTO v_old
    FROM public.pms_provider_credentials
   WHERE id = p_credential_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PMS provider credential not found';
  END IF;

  UPDATE public.pms_provider_credentials
     SET status = 'revoked',
         revoked_at = NOW(),
         updated_at = NOW()
   WHERE id = v_old.id;

  INSERT INTO public.pms_provider_credentials (
    provider,
    name,
    key_id,
    secret_hash,
    status,
    scopes,
    expires_at,
    metadata
  )
  VALUES (
    v_old.provider,
    v_old.name,
    p_new_key_id,
    p_new_secret_hash,
    'active',
    v_old.scopes,
    v_old.expires_at,
    v_old.metadata
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, p_new_key_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_pms_provider_credential(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rotate_pms_provider_credential(UUID, TEXT, UUID)
  TO service_role;

-- ============================================================================
-- RLS / grants
--
-- Provider credentials are infrastructure secrets/metadata, not workspace data.
-- Normal CRM users should not be able to read hashes or mutate credentials.
-- ============================================================================

ALTER TABLE public.pms_provider_credentials ENABLE ROW LEVEL SECURITY;

-- No authenticated-user policies by design.
-- service_role bypasses RLS and is the only normal runtime principal intended
-- to access this table/functions.

REVOKE ALL ON TABLE public.pms_provider_credentials
  FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.pms_provider_credentials
  TO service_role;

COMMIT;
