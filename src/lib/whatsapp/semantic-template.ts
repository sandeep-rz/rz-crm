import type { MessageTemplate } from '@/types';
import type { MessageVariableDefinition } from '@/lib/message-variables/catalog';
import {
  extractVariableIndices,
  validateTemplatePayload,
  type TemplatePayload,
} from './template-validators';

export interface SemanticTemplateContent {
  body_text: string;
  header_content?: string;
  button_urls?: Record<string, string>;
}
export interface TemplateVariableOccurrence {
  component: 'HEADER' | 'BODY' | 'BUTTON';
  button_index?: number;
  position: number;
  variable_key: string;
  sample: string;
}
export type CatalogVariable = { description?: string | null } & Pick<
  MessageVariableDefinition,
  | 'variableKey'
  | 'label'
  | 'previewValue'
  | 'isActive'
  | 'category'
  | 'sortOrder'
>;
export type SemanticTemplateMetadata = {
  template_origin: 'rgcrm' | 'meta';
  semantic_content: SemanticTemplateContent | null;
  semantic_variable_mapping: TemplateVariableOccurrence[];
  variable_configuration_status: 'configured' | 'needs_mapping';
};

export function semanticSegments(
  text: string
): Array<{ text: string; variableKey?: string }> {
  const result: Array<{ text: string; variableKey?: string }> = [];
  let last = 0;
  for (const match of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (match.index! > last)
      result.push({ text: text.slice(last, match.index) });
    result.push({ text: match[0], variableKey: match[1] });
    last = match.index! + match[0].length;
  }
  result.push({ text: text.slice(last) });
  return result;
}

export function renderSemanticText(
  text: string,
  catalog: CatalogVariable[],
  mode: 'label' | 'preview'
): string {
  return semanticSegments(text)
    .map((part) => {
      if (!part.variableKey) return part.text;
      const entry = catalog.find((v) => v.variableKey === part.variableKey);
      if (!entry) return '{{Unavailable variable}}';
      return mode === 'label'
        ? `{{${entry.label}}}`
        : (entry.previewValue ?? '');
    })
    .join('');
}

function assertNoTokens(text: string | undefined, where: string) {
  if (text && /\{\{|\}\}/.test(text))
    throw new Error(`${where} cannot contain variables.`);
}

/** Compile occurrence order independently for header, body and each URL button. */
export function compileSemanticTemplate(
  payload: TemplatePayload,
  content: SemanticTemplateContent,
  catalog: CatalogVariable[]
) {
  if (!content || typeof content.body_text !== 'string')
    throw new Error('Semantic body text is required.');
  const mappings: TemplateVariableOccurrence[] = [];
  const compile = (
    text: string,
    component: TemplateVariableOccurrence['component'],
    button_index?: number
  ) => {
    if (typeof text !== 'string')
      throw new Error('Semantic component text must be a string.');
    let position = 0;
    const samples: string[] = [];
    const output = text.replace(/\{\{([^{}]+)\}\}/g, (_token, key: string) => {
      const variable = catalog.find((v) => v.variableKey === key && v.isActive);
      if (!variable)
        throw new Error(`Unknown or inactive catalog variable: ${key}.`);
      if (!variable.previewValue?.trim())
        throw new Error(`Approval sample missing for ${key}.`);
      position++;
      mappings.push({
        component,
        ...(button_index === undefined ? {} : { button_index }),
        position,
        variable_key: key,
        sample: variable.previewValue,
      });
      samples.push(variable.previewValue);
      return `{{${position}}}`;
    });
    // Strip generated positional tokens; any remaining braces are malformed.
    if (/\{\{|\}\}/.test(output.replace(/\{\{\d+\}\}/g, '')))
      throw new Error('Malformed semantic variable token.');
    return { text: output, samples };
  };
  assertNoTokens(payload.footer_text, 'Footer');
  const header =
    payload.header_type === 'text'
      ? compile(content.header_content ?? '', 'HEADER')
      : undefined;
  if (payload.header_type !== 'text' && content.header_content)
    throw new Error('Semantic header requires a text header.');
  const body = compile(content.body_text, 'BODY');
  for (const index of Object.keys(content.button_urls ?? {})) {
    if (
      !/^\d+$/.test(index) ||
      payload.buttons?.[Number(index)]?.type !== 'URL'
    )
      throw new Error('Semantic button URL references an invalid URL button.');
  }
  const buttons = payload.buttons?.map((button, index) => {
    assertNoTokens(button.text, 'Button label');
    if (button.type !== 'URL') return button;
    const semanticUrl = content.button_urls?.[String(index)];
    if (typeof semanticUrl !== 'string')
      throw new Error('Semantic component text must be a string.');
    const compiled = compile(semanticUrl, 'BUTTON', index);
    if (compiled.samples.length && !compiled.text.endsWith('{{1}}'))
      throw new Error('URL variable must be a single suffix parameter.');
    return {
      ...button,
      url: compiled.text,
      ...(compiled.samples.length
        ? {
            example: compiled.text.replace(
              '{{1}}',
              encodeURIComponent(compiled.samples[0])
            ),
          }
        : {}),
    };
  });
  const transport: TemplatePayload = {
    ...payload,
    header_content: header?.text,
    body_text: body.text,
    buttons,
    sample_values: { body: body.samples, header: header?.samples ?? [] },
  };
  validateTemplatePayload(transport);
  const metadata: SemanticTemplateMetadata = {
    template_origin: 'rgcrm',
    semantic_content: content,
    semantic_variable_mapping: mappings,
    variable_configuration_status: 'configured',
  };
  return { transport, metadata };
}

export function positionalSlots(
  template: Pick<
    MessageTemplate,
    'header_type' | 'header_content' | 'body_text' | 'buttons'
  >
) {
  const slots: Array<
    Pick<TemplateVariableOccurrence, 'component' | 'button_index' | 'position'>
  > = [];
  const add = (
    text: string,
    component: TemplateVariableOccurrence['component'],
    button_index?: number
  ) => {
    for (const position of extractVariableIndices(text))
      slots.push({
        component,
        ...(button_index === undefined ? {} : { button_index }),
        position,
      });
  };
  if (template.header_type === 'text')
    add(template.header_content ?? '', 'HEADER');
  add(template.body_text, 'BODY');
  template.buttons?.forEach((button, index) => {
    if (button.type === 'URL') add(button.url, 'BUTTON', index);
  });
  return slots;
}
export function slotIdentity(
  slot: Pick<
    TemplateVariableOccurrence,
    'component' | 'button_index' | 'position'
  >
) {
  return `${slot.component}:${slot.button_index ?? ''}:${slot.position}`;
}

/** Map imported transport slots without guessing or changing Meta content. */
export function mapImportedTemplate(
  template: MessageTemplate,
  mapping: Array<
    Pick<
      TemplateVariableOccurrence,
      'component' | 'button_index' | 'position' | 'variable_key'
    >
  >,
  catalog: CatalogVariable[]
): SemanticTemplateMetadata {
  if (!canMapImportedTemplate(template))
    throw new Error(
      'Manual mapping is only available for imported Meta templates that need mapping.'
    );
  const slots = positionalSlots(template);
  if (
    !Array.isArray(mapping) ||
    mapping.length !== slots.length ||
    new Set(mapping.map(slotIdentity)).size !== slots.length
  )
    throw new Error('Map every template variable exactly once.');
  const occurrences = slots.map((slot) => {
    const selected = mapping.find(
      (m) => slotIdentity(m) === slotIdentity(slot)
    );
    const definition = catalog.find(
      (v) => v.variableKey === selected?.variable_key && v.isActive
    );
    if (!definition)
      throw new Error(
        'Each position must reference an active catalog variable.'
      );
    return {
      ...slot,
      variable_key: definition.variableKey,
      sample:
        slot.component === 'BODY'
          ? (template.sample_values?.body?.[slot.position - 1] ?? '')
          : slot.component === 'HEADER'
            ? (template.sample_values?.header?.[slot.position - 1] ?? '')
            : ((template.buttons?.[slot.button_index!] as { example?: string })
                ?.example ?? ''),
    };
  });
  const convert = (
    text: string,
    component: TemplateVariableOccurrence['component'],
    button_index?: number
  ) => {
    const result = text.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
      const entry = occurrences.find(
        (m) =>
          slotIdentity(m) ===
          slotIdentity({ component, button_index, position: Number(n) })
      );
      if (!entry)
        throw new Error('Unsupported or unmapped template parameter.');
      return `{{${entry.variable_key}}}`;
    });
    if (
      /\{\{|\}\}/.test(
        result.replace(/\{\{[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\}\}/g, '')
      )
    )
      throw new Error(
        'Named or malformed Meta parameters require a supported positional template.'
      );
    return result;
  };
  return {
    template_origin: 'meta',
    semantic_content: {
      body_text: convert(template.body_text, 'BODY'),
      ...(template.header_type === 'text'
        ? { header_content: convert(template.header_content ?? '', 'HEADER') }
        : {}),
      button_urls: Object.fromEntries(
        (template.buttons ?? []).flatMap((b, i) =>
          b.type === 'URL' ? [[String(i), convert(b.url, 'BUTTON', i)]] : []
        )
      ),
    },
    semantic_variable_mapping: occurrences,
    variable_configuration_status: 'configured',
  };
}

export function hasTemplateTokens(
  template: Pick<MessageTemplate, 'header_content' | 'body_text' | 'buttons'>
) {
  return [
    template.header_content,
    template.body_text,
    ...(template.buttons ?? [])
      .filter((b) => b.type === 'URL')
      .map((b) => b.url),
  ].some((text) => text && /\{\{|\}\}/.test(text));
}
export function importedMetadata(
  template: Pick<MessageTemplate, 'header_content' | 'body_text' | 'buttons'>
): SemanticTemplateMetadata {
  return {
    template_origin: 'meta',
    semantic_content: null,
    semantic_variable_mapping: [],
    variable_configuration_status: hasTemplateTokens(template)
      ? 'needs_mapping'
      : 'configured',
  };
}
export function reconcileTemplateSemantics(
  existing: MessageTemplate | null,
  incoming: MessageTemplate
): SemanticTemplateMetadata {
  const unchanged =
    existing &&
    existing.body_text === incoming.body_text &&
    (existing.header_content ?? null) === (incoming.header_content ?? null) &&
    JSON.stringify(existing.buttons ?? null) ===
      JSON.stringify(incoming.buttons ?? null) &&
    existing.header_type === incoming.header_type;
  if (existing?.template_origin === 'rgcrm') {
    if (!unchanged)
      throw new Error(
        'Meta content differs from authoritative RGCRM semantic content. Edit/resubmit this template in RGCRM.'
      );
    if (!existing.semantic_content)
      throw new Error(
        'RGCRM template is missing authoritative semantic content.'
      );
    return {
      template_origin: 'rgcrm',
      semantic_content: existing.semantic_content,
      semantic_variable_mapping: existing.semantic_variable_mapping ?? [],
      variable_configuration_status: 'configured',
    };
  }
  if (unchanged && existing?.variable_configuration_status === 'configured')
    return {
      template_origin: 'meta',
      semantic_content: existing.semantic_content ?? null,
      semantic_variable_mapping: existing.semantic_variable_mapping ?? [],
      variable_configuration_status: 'configured',
    };
  return importedMetadata(incoming);
}

export function canMapImportedTemplate(template: MessageTemplate): boolean {
  return (
    template.template_origin === 'meta' &&
    template.variable_configuration_status === 'needs_mapping' &&
    positionalSlots(template).length > 0
  );
}
