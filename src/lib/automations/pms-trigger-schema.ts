import type { AutomationTriggerType, PmsAutomationTriggerType } from '@/types';

/**
 * Shared PMS trigger vocabulary used by the scheduler, activation validator,
 * and builder. Keep configuration field semantics in PmsTriggerConfig.
 */
export const PMS_EVENT_AUTOMATION_TRIGGERS = [
  'reservation_confirmed',
  'reservation_updated',
  'reservation_cancelled',
] as const satisfies readonly PmsAutomationTriggerType[];

export const PMS_SCHEDULED_AUTOMATION_TRIGGERS = [
  'before_checkin',
  'checkin_day',
  'after_checkout',
] as const satisfies readonly PmsAutomationTriggerType[];

export const PMS_AUTOMATION_TRIGGERS = [
  ...PMS_EVENT_AUTOMATION_TRIGGERS,
  ...PMS_SCHEDULED_AUTOMATION_TRIGGERS,
] as const satisfies readonly PmsAutomationTriggerType[];

export const PMS_FILTER_CONFIG_FIELDS = [
  'property_ids',
  'channels',
  'reservation_statuses',
] as const;

export const PMS_OFFSET_DAYS_MIN = 0;
export const PMS_OFFSET_DAYS_MAX = 365;
export const PMS_LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidIanaTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function isPmsAutomationTrigger(
  triggerType: AutomationTriggerType | string
): triggerType is PmsAutomationTriggerType {
  return (PMS_AUTOMATION_TRIGGERS as readonly string[]).includes(triggerType);
}

export function isPmsScheduledAutomationTrigger(
  triggerType: AutomationTriggerType | string
): triggerType is (typeof PMS_SCHEDULED_AUTOMATION_TRIGGERS)[number] {
  return (PMS_SCHEDULED_AUTOMATION_TRIGGERS as readonly string[]).includes(
    triggerType
  );
}
