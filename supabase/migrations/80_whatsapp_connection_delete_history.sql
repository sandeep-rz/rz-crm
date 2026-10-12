BEGIN;
-- ON DELETE SET NULL retains historical rows. Different deleted numbers may
-- have conversations for the same contact or templates with identical names.
-- Those unlinked rows must not collide, and must not be merged or deleted.
-- Active connection-scoped unique indexes remain unchanged.
DROP INDEX public.idx_conversations_account_contact_unlinked;
CREATE INDEX idx_conversations_account_contact_unlinked
 ON public.conversations(account_id,contact_id) WHERE whatsapp_config_id IS NULL;
DROP INDEX public.idx_message_templates_account_name_language_unlinked;
CREATE INDEX idx_message_templates_account_name_language_unlinked
 ON public.message_templates(account_id,name,language) WHERE whatsapp_config_id IS NULL;
COMMIT;
