import type { AutomationStep } from '@/types';

export type RetryBlockReason =
  'external_action' | 'whatsapp_unknown' | 'whatsapp_accepted';
export interface RetrySafety {
  reason: RetryBlockReason;
  step_id: string;
  provider_message_id?: string;
}

const duplicateSensitiveActions = new Set([
  'send_template',
  'send_message',
  'send_buttons',
  'send_list',
  'send_webhook',
  'create_deal',
]);

export function isDuplicateSensitiveAction(step: AutomationStep): boolean {
  return (
    duplicateSensitiveActions.has(step.step_type) ||
    (step.step_type === 'assign_conversation' &&
      (step.step_config as { mode?: string }).mode === 'round_robin')
  );
}

export function isWhatsAppAction(step: AutomationStep): boolean {
  return [
    'send_template',
    'send_message',
    'send_buttons',
    'send_list',
  ].includes(step.step_type);
}
