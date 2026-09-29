import type {
  AutomationStepType,
  AutomationTriggerType,
  PmsTriggerConfig,
} from '@/types';
import {
  PMS_EVENT_AUTOMATION_TRIGGERS,
  PMS_SCHEDULED_AUTOMATION_TRIGGERS,
} from './pms-trigger-schema';
import { isWhatsAppSendStep } from './action-schema';

export const AUTOMATION_TRIGGER_GROUPS: Array<{
  label: 'crm' | 'whatsapp' | 'reservations' | 'stayTiming';
  options: readonly AutomationTriggerType[];
}> = [
  {
    label: 'crm',
    options: [
      'new_contact_created',
      'conversation_assigned',
      'tag_added',
      'time_based',
    ],
  },
  {
    label: 'whatsapp',
    options: [
      'new_message_received',
      'first_inbound_message',
      'keyword_match',
      'interactive_reply',
    ],
  },
  { label: 'reservations', options: PMS_EVENT_AUTOMATION_TRIGGERS },
  { label: 'stayTiming', options: PMS_SCHEDULED_AUTOMATION_TRIGGERS },
];

export const ALL_AUTOMATION_TRIGGER_OPTIONS = AUTOMATION_TRIGGER_GROUPS.flatMap(
  (group) => [...group.options]
);

export function defaultTriggerConfig(
  triggerType: AutomationTriggerType
): PmsTriggerConfig {
  if (triggerType === 'before_checkin') return { days_before: 1 };
  if (triggerType === 'after_checkout') return { days_after: 1 };
  return {};
}

export function selectedPmsPropertyIds(config: PmsTriggerConfig): string[] {
  return Array.isArray(config.property_ids)
    ? config.property_ids
    : config.property_id
      ? [config.property_id]
      : [];
}

export function updatePmsTriggerConfig(
  config: PmsTriggerConfig,
  key: keyof PmsTriggerConfig,
  value: unknown
): PmsTriggerConfig {
  const next = { ...config } as Record<string, unknown>;
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  ) {
    delete next[key];
  } else {
    next[key] = value;
  }
  if (key === 'property_ids') delete next.property_id;
  return next as PmsTriggerConfig;
}

export interface PmsReservationFilterRow {
  channel_code: string | null;
  channel_name: string | null;
  status: string;
}

export interface FriendlyFilterOption {
  value: string;
  label: string;
}

function humanizeCode(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Build friendly labels from the canonical values already synced by PMS. */
export function buildPmsFilterOptions(rows: PmsReservationFilterRow[]): {
  channels: FriendlyFilterOption[];
  statuses: FriendlyFilterOption[];
} {
  const channels = new Map<string, string>();
  const statuses = new Set<string>();
  for (const row of rows) {
    const code = row.channel_code?.trim();
    if (code)
      channels.set(code, row.channel_name?.trim() || humanizeCode(code));
    const status = row.status?.trim();
    if (status) statuses.add(status);
  }
  return {
    channels: [...channels]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    statuses: [...statuses]
      .map((value) => ({ value, label: humanizeCode(value) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function automationActionAvailability(
  stepType: AutomationStepType,
  input: { connectionsLoading: boolean; usableConnectionCount: number }
): { enabled: boolean; reason: 'checking' | 'connection_required' | null } {
  if (!isWhatsAppSendStep(stepType)) return { enabled: true, reason: null };
  if (input.connectionsLoading) return { enabled: false, reason: 'checking' };
  if (input.usableConnectionCount === 0) {
    return { enabled: false, reason: 'connection_required' };
  }
  return { enabled: true, reason: null };
}

export function automaticallySelectedWhatsAppConnection(
  currentId: string | null | undefined,
  usableConnectionIds: string[]
): string | null {
  if (currentId && usableConnectionIds.includes(currentId)) return currentId;
  return usableConnectionIds.length === 1 ? usableConnectionIds[0] : null;
}
