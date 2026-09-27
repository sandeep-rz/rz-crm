-- DEV ONLY: Register RZ PMS as a trusted provisioning provider in RZ CRM.
-- Migration 049 must already be applied.
-- The raw secret is intentionally NOT stored here or in Git.

insert into public.pms_provider_credentials
  (provider, name, key_id, secret_hash, status, scopes, metadata)
values
  (
    'rukiye_zara',
    'Rukiye Zara PMS DEV',
    '4c621815-f779-4011-b954-60c82941c09b'::uuid,
    'a8a5284a29a373af2f12f5a1e967bb647de2a087a4526c602b3900b0dc80ebc1',
    'active',
    array['provision']::text[],
    '{"environment":"dev","purpose":"rz_pms_to_rz_crm_provisioning"}'::jsonb
  )
on conflict (key_id) do nothing;
