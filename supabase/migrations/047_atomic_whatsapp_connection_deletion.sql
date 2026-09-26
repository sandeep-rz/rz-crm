-- 047_atomic_whatsapp_connection_deletion.sql
-- WACRM fork
--
-- Final hardening for the multi-WhatsApp connection phase.
--
-- Purpose:
--   Delete a WhatsApp connection atomically.
--   If the deleted connection is primary and another connection exists,
--   promote a deterministic replacement in the SAME database transaction.
--
-- Depends on migrations 001-046.
-- Do not modify earlier migrations.

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_whatsapp_connection(
  connection_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_account_id UUID;
  v_is_primary BOOLEAN;
  v_active_account_id UUID;
  v_replacement_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the target connection so concurrent primary/delete operations cannot
  -- race against this deletion.
  SELECT wc.account_id, wc.is_primary
  INTO v_account_id, v_is_primary
  FROM public.whatsapp_config wc
  WHERE wc.id = connection_id
  FOR UPDATE;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp connection not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Normal application mutations are scoped to the user's active workspace.
  SELECT p.account_id
  INTO v_active_account_id
  FROM public.profiles p
  WHERE p.id = v_user_id;

  IF v_active_account_id IS DISTINCT FROM v_account_id THEN
    RAISE EXCEPTION 'WhatsApp connection does not belong to the active workspace'
      USING ERRCODE = '42501';
  END IF;

  -- Match the permission level used by set_primary_whatsapp_connection():
  -- workspace owner/admin may manage WhatsApp connections.
  IF NOT public.is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'Insufficient permission'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_primary THEN
    -- Deterministic replacement: oldest remaining connection, then UUID.
    SELECT wc.id
    INTO v_replacement_id
    FROM public.whatsapp_config wc
    WHERE wc.account_id = v_account_id
      AND wc.id <> connection_id
    ORDER BY wc.created_at ASC, wc.id ASC
    LIMIT 1
    FOR UPDATE;

    IF v_replacement_id IS NOT NULL THEN
      -- The partial unique index permits only one primary. Clear the target
      -- first, promote the replacement, then delete the target. Any failure
      -- rolls the entire function call back atomically.
      UPDATE public.whatsapp_config
      SET is_primary = FALSE
      WHERE id = connection_id;

      UPDATE public.whatsapp_config
      SET is_primary = TRUE
      WHERE id = v_replacement_id;
    END IF;
  END IF;

  DELETE FROM public.whatsapp_config
  WHERE id = connection_id
    AND account_id = v_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp connection could not be deleted'
      USING ERRCODE = 'P0002';
  END IF;

  -- NULL means either a non-primary connection was deleted or the workspace
  -- now has zero connections. A UUID means that connection was promoted.
  RETURN v_replacement_id;
END;
$$;

ALTER FUNCTION public.delete_whatsapp_connection(UUID) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.delete_whatsapp_connection(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_whatsapp_connection(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_whatsapp_connection(UUID) TO authenticated;

COMMENT ON FUNCTION public.delete_whatsapp_connection(UUID) IS
  'Atomically deletes a WhatsApp connection from the caller''s active workspace. If the deleted connection is primary and another connection exists, promotes the oldest remaining connection. Requires admin-or-owner membership.';

COMMIT;
