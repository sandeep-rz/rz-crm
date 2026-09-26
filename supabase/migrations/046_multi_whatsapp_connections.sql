-- 046_multi_whatsapp_connections.sql
-- Rukiye Zara CRM / WACRM fork
--
-- Purpose:
--   Make WhatsApp a one-to-many child of a CRM workspace while preserving
--   current single-number behaviour for every existing workspace.
--
-- Depends on migrations 001-045.
--
-- Design:
--   accounts
--      -> whatsapp_config (1..N connections)
--
--   Existing rows become the primary connection for their workspace.
--   phone_number_id remains globally unique.
--
--   Conversation/broadcast/automation/flow/template rows gain an optional
--   whatsapp_config_id so the application can route work through a specific
--   WhatsApp connection. Existing rows are backfilled to the workspace's
--   primary connection where one exists.
--
-- IMPORTANT:
--   This migration changes the schema only. Source code must be updated
--   immediately afterward so no path assumes whatsapp_config is one-row-per-
--   account or calls .single() using account_id alone.

BEGIN;

-- ============================================================================
-- 1. WHATSAPP CONFIG BECOMES A WORKSPACE CHILD COLLECTION
-- ============================================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.whatsapp_config.display_name IS
  'Workspace-facing label for this WhatsApp connection, e.g. Reservations or Varkala Property.';

COMMENT ON COLUMN public.whatsapp_config.is_primary IS
  'Default WhatsApp connection used when a feature has not selected a specific connection. Exactly one primary is allowed per workspace when configured.';

-- Existing schema (migration 017) guarantees at most one row per account,
-- therefore every existing connection can safely become primary.
UPDATE public.whatsapp_config
SET is_primary = TRUE
WHERE is_primary = FALSE;

-- Remove the old one-number-per-workspace invariant.
ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- Keep phone_number_id globally unique. Migration 013 created this already;
-- this block is defensive for databases that reached 046 through a repaired
-- migration history.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'whatsapp_config_phone_number_id_key'
      AND conrelid = 'public.whatsapp_config'::regclass
  ) THEN
    ALTER TABLE public.whatsapp_config
      ADD CONSTRAINT whatsapp_config_phone_number_id_key
      UNIQUE (phone_number_id);
  END IF;
END $$;

-- Supports account-safe composite foreign keys below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_id_account
  ON public.whatsapp_config (id, account_id);

-- A workspace can have many connections, but at most one primary.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary_per_account
  ON public.whatsapp_config (account_id)
  WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account_created
  ON public.whatsapp_config (account_id, created_at);

-- ============================================================================
-- 2. CONVERSATIONS BELONG TO A WHATSAPP CONNECTION
-- ============================================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

-- Backfill old conversations to the existing/primary connection.
UPDATE public.conversations c
SET whatsapp_config_id = wc.id
FROM public.whatsapp_config wc
WHERE wc.account_id = c.account_id
  AND wc.is_primary = TRUE
  AND c.whatsapp_config_id IS NULL;

-- Enforce that a selected connection belongs to the same workspace.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_whatsapp_config_account_fkey'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_whatsapp_config_account_fkey
      FOREIGN KEY (whatsapp_config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (whatsapp_config_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON public.conversations (whatsapp_config_id);

-- Migration 036 enforced one conversation per (workspace, contact).
-- With multiple business numbers, the same contact may legitimately have
-- one thread per WhatsApp connection.
DROP INDEX IF EXISTS public.idx_conversations_account_contact;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_whatsapp
  ON public.conversations (account_id, contact_id, whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- Preserve the old dedup invariant for non-WhatsApp/manual/unlinked threads.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_unlinked
  ON public.conversations (account_id, contact_id)
  WHERE whatsapp_config_id IS NULL;

COMMENT ON COLUMN public.conversations.whatsapp_config_id IS
  'WhatsApp connection that owns/routes this conversation. NULL is reserved for manual/unlinked conversations or workspaces without WhatsApp configured.';

-- ============================================================================
-- 3. BROADCASTS CHOOSE A CONNECTION
-- ============================================================================

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

UPDATE public.broadcasts b
SET whatsapp_config_id = wc.id
FROM public.whatsapp_config wc
WHERE wc.account_id = b.account_id
  AND wc.is_primary = TRUE
  AND b.whatsapp_config_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_whatsapp_config_account_fkey'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE public.broadcasts
      ADD CONSTRAINT broadcasts_whatsapp_config_account_fkey
      FOREIGN KEY (whatsapp_config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (whatsapp_config_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_config
  ON public.broadcasts (whatsapp_config_id);

-- ============================================================================
-- 4. AUTOMATIONS CHOOSE A CONNECTION
-- ============================================================================

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

UPDATE public.automations a
SET whatsapp_config_id = wc.id
FROM public.whatsapp_config wc
WHERE wc.account_id = a.account_id
  AND wc.is_primary = TRUE
  AND a.whatsapp_config_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automations_whatsapp_config_account_fkey'
      AND conrelid = 'public.automations'::regclass
  ) THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_whatsapp_config_account_fkey
      FOREIGN KEY (whatsapp_config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (whatsapp_config_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_automations_whatsapp_config
  ON public.automations (whatsapp_config_id);

-- ============================================================================
-- 5. FLOWS CHOOSE A CONNECTION
-- ============================================================================

ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

UPDATE public.flows f
SET whatsapp_config_id = wc.id
FROM public.whatsapp_config wc
WHERE wc.account_id = f.account_id
  AND wc.is_primary = TRUE
  AND f.whatsapp_config_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'flows_whatsapp_config_account_fkey'
      AND conrelid = 'public.flows'::regclass
  ) THEN
    ALTER TABLE public.flows
      ADD CONSTRAINT flows_whatsapp_config_account_fkey
      FOREIGN KEY (whatsapp_config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (whatsapp_config_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_flows_whatsapp_config
  ON public.flows (whatsapp_config_id);

-- ============================================================================
-- 6. MESSAGE TEMPLATES ARE CONNECTION-SCOPED
-- ============================================================================
-- This deliberately uses whatsapp_config_id instead of assuming one WABA per
-- workspace. The source layer can later optimise shared-WABA catalogs without
-- changing message routing semantics.

ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID;

UPDATE public.message_templates mt
SET whatsapp_config_id = wc.id
FROM public.whatsapp_config wc
WHERE wc.account_id = mt.account_id
  AND wc.is_primary = TRUE
  AND mt.whatsapp_config_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'message_templates_whatsapp_config_account_fkey'
      AND conrelid = 'public.message_templates'::regclass
  ) THEN
    ALTER TABLE public.message_templates
      ADD CONSTRAINT message_templates_whatsapp_config_account_fkey
      FOREIGN KEY (whatsapp_config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (whatsapp_config_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_templates_whatsapp_config
  ON public.message_templates (whatsapp_config_id);

-- Migration 014's user-scoped uniqueness prevents the same template name from
-- existing on two connections owned/created by the same user. Replace it with
-- connection-aware uniqueness.
DROP INDEX IF EXISTS public.message_templates_user_name_language_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_connection_name_language
  ON public.message_templates (whatsapp_config_id, name, language)
  WHERE whatsapp_config_id IS NOT NULL;

-- Keep local/unlinked drafts deduplicated inside the workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_account_name_language_unlinked
  ON public.message_templates (account_id, name, language)
  WHERE whatsapp_config_id IS NULL;

-- ============================================================================
-- 7. SAFE PRIMARY-CONNECTION RPC
-- ============================================================================
-- Changing the primary connection touches multiple rows, so expose one atomic
-- operation rather than asking the browser to toggle booleans itself.

CREATE OR REPLACE FUNCTION public.set_primary_whatsapp_connection(
  connection_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_account_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT wc.account_id
  INTO v_account_id
  FROM public.whatsapp_config wc
  WHERE wc.id = connection_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp connection not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'Insufficient permission'
      USING ERRCODE = '42501';
  END IF;

  -- Clear first, then set, so the partial unique index is never violated.
  UPDATE public.whatsapp_config
  SET is_primary = FALSE
  WHERE account_id = v_account_id
    AND is_primary = TRUE
    AND id <> connection_id;

  UPDATE public.whatsapp_config
  SET is_primary = TRUE
  WHERE id = connection_id;
END;
$$;

ALTER FUNCTION public.set_primary_whatsapp_connection(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_primary_whatsapp_connection(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_primary_whatsapp_connection(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_primary_whatsapp_connection(UUID) TO authenticated;

COMMENT ON FUNCTION public.set_primary_whatsapp_connection(UUID) IS
  'Atomically makes one WhatsApp connection primary for its workspace. Requires admin-or-owner account membership.';

COMMIT;
