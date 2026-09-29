import type { AutomationStepType } from '@/types';

export const WHATSAPP_SEND_STEP_TYPES = [
  'send_message',
  'send_template',
  'send_buttons',
  'send_list',
] as const satisfies readonly AutomationStepType[];

export function isWhatsAppSendStep(
  stepType: AutomationStepType | string
): stepType is (typeof WHATSAPP_SEND_STEP_TYPES)[number] {
  return (WHATSAPP_SEND_STEP_TYPES as readonly string[]).includes(stepType);
}
