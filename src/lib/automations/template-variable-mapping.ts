import type { MessageTemplate } from '@/types';
import type { MessageVariableMapping } from '@/lib/message-variables';
import { validateMessageVariableMappingShape } from '@/lib/message-variables';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';

export interface TemplateVariableSlot {
  component: 'header' | 'body';
  position: number;
}

export interface TemplateSlotInspection {
  slots: TemplateVariableSlot[];
  unsupported: string[];
}

export function inspectTemplateVariableSlots(
  template: MessageTemplate
): TemplateSlotInspection {
  const slots: TemplateVariableSlot[] = [];
  const unsupported: string[] = [];

  if (template.header_type === 'text') {
    const headerPositions = extractVariableIndices(
      template.header_content ?? ''
    );
    if (
      headerPositions.length > 1 ||
      (headerPositions.length === 1 && headerPositions[0] !== 1)
    ) {
      unsupported.push(
        'Only a single text-header parameter at {{1}} is supported.'
      );
    } else if (headerPositions.length === 1) {
      slots.push({ component: 'header', position: 1 });
    }
  }

  for (const position of extractVariableIndices(template.body_text)) {
    slots.push({ component: 'body', position });
  }

  template.buttons?.forEach((button, index) => {
    if (
      button.type === 'URL' &&
      extractVariableIndices(button.url).length > 0
    ) {
      unsupported.push(
        `Dynamic URL button ${index + 1} is not supported by automation variable mapping yet.`
      );
    }
  });

  slots.sort((left, right) => {
    const componentOrder = { header: 0, body: 1 } as const;
    return (
      componentOrder[left.component] - componentOrder[right.component] ||
      left.position - right.position
    );
  });
  return { slots, unsupported };
}

export function reconcileTemplateVariableMappings(
  mappings: unknown,
  slots: TemplateVariableSlot[]
): MessageVariableMapping[] {
  const shaped = validateMessageVariableMappingShape(mappings);
  if (shaped.errors.length > 0) return [];
  const required = new Set(
    slots.map((slot) => `${slot.component}:${slot.position}`)
  );
  return shaped.mappings.filter((mapping) =>
    required.has(`${mapping.component}:${mapping.position}`)
  );
}

export function validateTemplateVariableMappings(
  template: MessageTemplate,
  mappings: unknown
): string[] {
  const inspection = inspectTemplateVariableSlots(template);
  const shaped = validateMessageVariableMappingShape(mappings);
  const issues = [...inspection.unsupported];
  if (shaped.errors.length > 0) {
    issues.push('One or more template parameter mappings are invalid.');
    return issues;
  }
  const mapped = new Set(
    shaped.mappings.map((mapping) => `${mapping.component}:${mapping.position}`)
  );
  for (const slot of inspection.slots) {
    if (!mapped.has(`${slot.component}:${slot.position}`)) {
      issues.push(
        `${slot.component.toUpperCase()} parameter {{${slot.position}}} needs a mapping.`
      );
    }
  }
  return issues;
}

export function groupResolvedTemplateParameters(
  values: Array<{
    component: 'header' | 'body';
    position: number;
    value: string;
  }>
): { body: string[]; headerText?: string } {
  const body = values
    .filter((value) => value.component === 'body')
    .sort((a, b) => a.position - b.position)
    .map((value) => value.value);
  const header = values
    .filter((value) => value.component === 'header')
    .sort((a, b) => a.position - b.position);
  return {
    body,
    ...(header[0] ? { headerText: header[0].value } : {}),
  };
}
