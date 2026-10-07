import { variableRequiresReservation } from '@/lib/message-variables/contract';
import type { MessageTemplate } from '@/types';
import type {
  MessageVariableDefinition,
  MessageVariableResolutionSource,
  MessageVariableContextCapabilities,
  MessageVariableMapping,
  MessageVariableSourceScope,
  ResolveMessageVariablesResult,
} from '@/lib/message-variables';
import {
  createMessageVariableContextCapabilities,
  validateMessageVariableMappingShape,
} from '@/lib/message-variables';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

export type BroadcastVariableCapabilities = MessageVariableContextCapabilities;

export interface BroadcastVariableSlot {
  component: 'header' | 'body';
  position: number;
}

export type LegacyBroadcastVariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

export type BroadcastVariableMappings =
  MessageVariableMapping[] | Record<string, LegacyBroadcastVariableMapping>;

/**
 * Today's Broadcast audiences are all contact-derived. Keep the capability
 * shape explicit so a future, canonical property/reservation audience can
 * enable those scopes without teaching Broadcasts new resolution rules.
 */
export function getBroadcastVariableCapabilities(input?: {
  propertyId?: string | null;
  reservationId?: string | null;
}): BroadcastVariableCapabilities {
  return createMessageVariableContextCapabilities({
    contact: true,
    property: Boolean(input?.propertyId || input?.reservationId),
    reservation: Boolean(input?.reservationId),
  });
}

export function inspectBroadcastVariableSlots(
  template: MessageTemplate
): BroadcastVariableSlot[] {
  const slots: BroadcastVariableSlot[] = [];
  if (template.header_type === 'text') {
    for (const position of extractVariableIndices(
      template.header_content ?? ''
    )) {
      slots.push({ component: 'header', position });
    }
  }
  for (const position of extractVariableIndices(template.body_text)) {
    slots.push({ component: 'body', position });
  }
  return slots.sort((left, right) =>
    left.component === right.component
      ? left.position - right.position
      : left.component === 'header'
        ? -1
        : 1
  );
}

export function mappingIdentity(
  mapping: Pick<MessageVariableMapping, 'component' | 'position'>
): string {
  return `${mapping.component}:${mapping.position}`;
}

export function validateBroadcastVariableMappings(input: {
  mappings: unknown;
  slots: BroadcastVariableSlot[];
  definitions: MessageVariableDefinition[];
  capabilities: BroadcastVariableCapabilities;
}): string[] {
  const shaped = validateMessageVariableMappingShape(input.mappings);
  if (shaped.errors.length > 0) {
    return shaped.errors.map(
      (error) =>
        `${error.code}:${error.component ?? 'unknown'}:${error.position ?? 'unknown'}`
    );
  }

  const issues: string[] = [];
  const required = new Set(input.slots.map(mappingIdentity));
  const definitions = new Map(
    input.definitions.map((definition) => [definition.variableKey, definition])
  );

  for (const mapping of shaped.mappings) {
    if (!required.has(mappingIdentity(mapping))) {
      issues.push(
        `UNEXPECTED_POSITION:${mapping.component}:${mapping.position}`
      );
    }
    if (mapping.source_type !== 'catalog_variable') continue;
    const definition = definitions.get(mapping.variable_key);
    if (!definition) {
      issues.push(`UNKNOWN_CATALOG_VARIABLE:${mapping.variable_key}`);
    } else if (!definition.isActive) {
      issues.push(`INACTIVE_CATALOG_VARIABLE:${mapping.variable_key}`);
    } else if (!input.capabilities[definition.sourceScope]) {
      issues.push(`CONTEXT_UNAVAILABLE:${mapping.variable_key}`);
    }
  }

  const mapped = new Set(shaped.mappings.map(mappingIdentity));
  for (const slot of input.slots) {
    if (!mapped.has(mappingIdentity(slot))) {
      issues.push(`MAPPING_REQUIRED:${slot.component}:${slot.position}`);
    }
  }
  return issues;
}

export function sourceScopeAvailabilityMessage(
  scope: MessageVariableSourceScope
): string {
  return scope === 'reservation'
    ? 'Requires a reservation-based audience'
    : scope === 'property'
      ? 'Requires a property- or reservation-based audience'
      : 'Unavailable for this audience';
}

export function resolvedVariablesToSendParams(
  result: ResolveMessageVariablesResult
): SendTimeParams | null {
  if (!result.success) return null;
  const body = result.values
    .filter((value) => value.component === 'body')
    .sort((left, right) => left.position - right.position)
    .map((value) => value.value);
  const header = result.values
    .filter((value) => value.component === 'header')
    .sort((left, right) => left.position - right.position);
  return {
    body,
    ...(header[0] ? { headerText: header[0].value } : {}),
  };
}

export function frozenTemplateParams(value: unknown): {
  params?: string[];
  messageParams?: SendTimeParams;
} {
  if (Array.isArray(value)) {
    return {
      params: value.filter((item): item is string => typeof item === 'string'),
    };
  }
  if (!value || typeof value !== 'object') return { params: [] };
  const candidate = value as Record<string, unknown>;
  const body = Array.isArray(candidate.body)
    ? candidate.body.filter((item): item is string => typeof item === 'string')
    : [];
  const messageParams: SendTimeParams = { body };
  if (typeof candidate.headerText === 'string') {
    messageParams.headerText = candidate.headerText;
  }
  if (typeof candidate.headerMediaUrl === 'string') {
    messageParams.headerMediaUrl = candidate.headerMediaUrl;
  }
  if (typeof candidate.headerMediaId === 'string') {
    messageParams.headerMediaId = candidate.headerMediaId;
  }
  if (
    candidate.buttonParams &&
    typeof candidate.buttonParams === 'object' &&
    !Array.isArray(candidate.buttonParams)
  ) {
    messageParams.buttonParams = Object.fromEntries(
      Object.entries(candidate.buttonParams).filter(
        ([key, item]) => /^\d+$/.test(key) && typeof item === 'string'
      )
    ) as Record<number, string>;
  }
  return { messageParams };
}

export function missingVariableIdentity(
  result: Exclude<ResolveMessageVariablesResult, { success: true }>
): string {
  const missing = result.missing[0];
  if (missing) {
    const source =
      missing.variable_key ?? missing.custom_field_id ?? missing.source_type;
    return `${missing.component.toUpperCase()} {{${missing.position}}}: ${source} is missing`;
  }
  const error = result.errors[0];
  if (error) {
    const source = error.variable_key ?? error.custom_field_id ?? error.code;
    return `${error.component?.toUpperCase() ?? 'MAPPING'} {{${error.position ?? '?'}}}: ${source}`;
  }
  return 'Template variable resolution failed';
}

/** Contact audiences carry no explicit reservation; never infer one. */
export function semanticBroadcastTemplateIssue(
  template: MessageTemplate,
  definitions: {
    variableKey: string;
    sourceScope?: MessageVariableSourceScope;
    resolutionSource?: MessageVariableResolutionSource;
    isActive?: boolean;
  }[]
): string | null {
  if (template.variable_configuration_status !== 'configured') return null;
  if (
    !template.semantic_content ||
    !Array.isArray(template.semantic_variable_mapping)
  )
    return 'This template is not ready to send.';
  for (const occurrence of template.semantic_variable_mapping) {
    const definition = definitions.find(
      (v) => v.variableKey === occurrence.variable_key
    );
    if (!definition || definition.isActive === false)
      return 'The template variable catalog is unavailable or incomplete.';
    if (variableRequiresReservation(definition))
      return "This template requires reservation context and can't be used with this broadcast audience.";
  }
  return null;
}
