-- CLI-created migration renamed to 81 to follow the existing numbered order.
-- Adapt WACRM 1bf0cf8 to RZ's multi-workspace memberships. Public asset URLs
-- stay public for Meta fetching; SELECT/list access is scoped to membership.
BEGIN;

DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;

DROP POLICY IF EXISTS "Users can read their own avatar" ON storage.objects;
CREATE POLICY "Users can read their own avatar"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Members can read flow media" ON storage.objects;
CREATE POLICY "Members can read flow media"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'flow-media' AND (
    EXISTS (SELECT 1 FROM public.account_members am
      WHERE am.user_id = (SELECT auth.uid())
        AND ('account-' || am.account_id::text) = (storage.foldername(name))[1])
    -- Historical pre-account paths remain readable by their owner.
    OR (SELECT auth.uid())::text = (storage.foldername(name))[1]
  ));

DROP POLICY IF EXISTS "Members can read chat media" ON storage.objects;
CREATE POLICY "Members can read chat media"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media' AND EXISTS (
    SELECT 1 FROM public.account_members am
    WHERE am.user_id = (SELECT auth.uid())
      AND ('account-' || am.account_id::text) = (storage.foldername(name))[1]
  ));

-- Migration 79 already hardens internal functions and disables legacy global
-- deduplication. Do not import upstream 044's service-role dedupe grants.
COMMIT;
