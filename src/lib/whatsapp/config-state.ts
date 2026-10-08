import type { WhatsAppConfig } from '@/types';

/** Locally stored lifecycle data. None of these fields claims live Meta health. */
export type WhatsAppConnectionSummary = Pick<
  WhatsAppConfig,
  | 'id'
  | 'display_name'
  | 'is_primary'
  | 'phone_number_id'
  | 'waba_id'
  | 'status'
  | 'connected_at'
  | 'registered_at'
  | 'subscribed_apps_at'
  | 'last_registration_error'
  | 'mirror_inbound_media'
> & { has_verify_token: boolean; created_at?: string; updated_at?: string };

export interface WhatsAppLocalConfig {
  account_id: string;
  configured: boolean;
  connections: WhatsAppConnectionSummary[];
  selected_connection_id: string | null;
}
