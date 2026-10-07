import type { MessageTemplate } from '@/types';
import {
  positionalSlots,
  slotIdentity,
} from '@/lib/whatsapp/semantic-template';
import {
  validateBody,
  validateFooter,
  validateHeader,
} from '@/lib/whatsapp/template-validators';
import { TemplatePreparationError } from './errors';
import type { PreparedVariableOccurrence } from './types';

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const canonicalKey = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** Validate persisted mapping against transport slots, then semantic content. No recompilation/samples. */
export function validatePreparationMapping(
  template: Pick<
    MessageTemplate,
    | 'header_type'
    | 'header_content'
    | 'body_text'
    | 'footer_text'
    | 'buttons'
    | 'template_origin'
    | 'semantic_content'
  > & { semantic_variable_mapping?: unknown },
  verifySemanticContent = true
): PreparedVariableOccurrence[] {
  const invalid = () =>
    new TemplatePreparationError('invalid_semantic_mapping');
  const unsupported = () =>
    new TemplatePreparationError('unsupported_template_component');
  if (
    template.header_type &&
    !['text', 'image', 'video', 'document'].includes(template.header_type)
  )
    throw unsupported();
  if (template.buttons != null && !Array.isArray(template.buttons))
    throw invalid();
  for (const button of template.buttons ?? []) {
    if (
      !object(button) ||
      !['URL', 'QUICK_REPLY', 'PHONE_NUMBER'].includes(button.type)
    )
      throw unsupported();
    if (typeof button.text !== 'string' || /\{\{|\}\}/.test(button.text))
      throw invalid();
    if (button.type === 'URL' && typeof button.url !== 'string')
      throw invalid();
  }
  try {
    validateBody(template.body_text);
    validateFooter(template.footer_text);
    if (template.header_type === 'text') validateHeader(template);
    else if (
      template.header_content &&
      /\{\{|\}\}/.test(template.header_content)
    )
      throw unsupported();
    for (const button of template.buttons ?? []) {
      if (button.type !== 'URL') continue;
      // Step 3 permits exactly one suffix parameter per URL button.
      if (/\{\{|\}\}/.test(button.url.replace(/\{\{1\}\}$/, '')))
        throw invalid();
    }
  } catch (error) {
    if (error instanceof TemplatePreparationError) throw error;
    throw invalid();
  }
  const raw: unknown = template.semantic_variable_mapping;
  if (!Array.isArray(raw)) throw invalid();
  const slots = positionalSlots(template);
  const mapping: PreparedVariableOccurrence[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!object(entry)) throw invalid();
    if (!['HEADER', 'BODY', 'BUTTON'].includes(String(entry.component)))
      throw unsupported();
    if (
      !Number.isSafeInteger(entry.position) ||
      Number(entry.position) < 1 ||
      typeof entry.variable_key !== 'string' ||
      !canonicalKey.test(entry.variable_key)
    )
      throw invalid();
    if (entry.component === 'BUTTON') {
      if (
        !Number.isSafeInteger(entry.button_index) ||
        Number(entry.button_index) < 0 ||
        template.buttons?.[Number(entry.button_index)]?.type !== 'URL'
      )
        throw invalid();
    } else if (entry.button_index !== undefined) throw invalid();
    const slot = {
      component: entry.component as PreparedVariableOccurrence['component'],
      position: Number(entry.position),
      variable_key: entry.variable_key,
      ...(entry.component === 'BUTTON'
        ? { button_index: Number(entry.button_index) }
        : {}),
    };
    const identity = slotIdentity(slot);
    if (seen.has(identity) || !slots.some((s) => slotIdentity(s) === identity))
      throw invalid();
    seen.add(identity);
    mapping.push(slot);
  }
  if (mapping.length !== slots.length) throw invalid();
  const semantic: unknown = template.semantic_content;
  if (
    verifySemanticContent &&
    (template.template_origin === 'rgcrm' || slots.length || semantic != null)
  ) {
    if (!object(semantic) || typeof semantic.body_text !== 'string')
      throw invalid();
    const compare = (
      transport: string,
      content: unknown,
      component: PreparedVariableOccurrence['component'],
      button_index?: number
    ) => {
      if (typeof content !== 'string') throw invalid();
      const restored = transport.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
        const found = mapping.find(
          (m) =>
            slotIdentity(m) ===
            slotIdentity({ component, button_index, position: Number(n) })
        );
        if (!found) throw invalid();
        return `{{${found.variable_key}}}`;
      });
      if (restored !== content) throw invalid();
      // RGCRM compiler assigns a new slot to every occurrence, in encounter order.
      if (template.template_origin === 'rgcrm') {
        const indices = [...transport.matchAll(/\{\{(\d+)\}\}/g)].map((m) =>
          Number(m[1])
        );
        if (indices.some((n, i) => n !== i + 1)) throw invalid();
      }
    };
    compare(template.body_text, semantic.body_text, 'BODY');
    if (template.header_type === 'text')
      compare(
        template.header_content ?? '',
        semantic.header_content ?? '',
        'HEADER'
      );
    else if (semantic.header_content) throw invalid();
    const urls = semantic.button_urls ?? {};
    if (!object(urls)) throw invalid();
    for (const index of Object.keys(urls)) {
      if (
        !/^(0|[1-9]\d*)$/.test(index) ||
        template.buttons?.[Number(index)]?.type !== 'URL'
      )
        throw invalid();
    }
    template.buttons?.forEach((button, i) => {
      if (button.type === 'URL')
        compare(button.url, urls[String(i)], 'BUTTON', i);
    });
  }
  return mapping;
}
