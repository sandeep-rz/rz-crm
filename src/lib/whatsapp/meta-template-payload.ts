import 'server-only';
import type { MetaSendComponent } from './template-send-builder';
import type { PreparedTemplateMessage } from '@/lib/message-preparation/types';
import { TemplatePreparationError } from '@/lib/message-preparation/errors';
import { validatePreparationMapping } from '@/lib/message-preparation/mapping';

/** Pure assembly. No API client imports, sending, token access, samples, or fallback values. */
export function buildMetaTemplateComponents(
  prepared: PreparedTemplateMessage
): MetaSendComponent[] {
  // Revalidate positional slots so even a forged or mutated prepared object cannot omit parameters.
  const mapping = validatePreparationMapping(
    {
      ...prepared.template,
      template_origin: 'meta',
      semantic_content: null,
      semantic_variable_mapping: prepared.mapping,
    },
    false
  );
  const text = (key: string) => {
    const value = Object.hasOwn(prepared.resolvedVariables, key)
      ? prepared.resolvedVariables[key]
      : undefined;
    if (typeof value !== 'string')
      throw new TemplatePreparationError('provider_payload_invalid', {
        variableKey: key,
      });
    return { type: 'text' as const, text: value };
  };
  const out: MetaSendComponent[] = [];
  for (const component of ['HEADER', 'BODY'] as const) {
    const entries = mapping
      .filter((m) => m.component === component)
      .sort((a, b) => a.position - b.position);
    if (entries.length)
      out.push({
        type: component === 'HEADER' ? 'header' : 'body',
        parameters: entries.map((m) => text(m.variable_key)),
      });
  }
  const header = prepared.template.header_type;
  if (header && header !== 'text') {
    const link = prepared.template.header_media_url;
    try {
      if (!link || !['http:', 'https:'].includes(new URL(link).protocol))
        throw new Error();
    } catch {
      throw new TemplatePreparationError('provider_payload_invalid');
    }
    // Existing static media capability only; approval upload handles are never runtime IDs.
    out.unshift({
      type: 'header',
      parameters: [
        header === 'image'
          ? { type: 'image', image: { link } }
          : header === 'video'
            ? { type: 'video', video: { link } }
            : { type: 'document', document: { link } },
      ],
    });
  }
  const indexes = [
    ...new Set(
      mapping
        .filter((m) => m.component === 'BUTTON')
        .map((m) => m.button_index!)
    ),
  ].sort((a, b) => a - b);
  for (const index of indexes)
    out.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters: mapping
        .filter((m) => m.component === 'BUTTON' && m.button_index === index)
        .sort((a, b) => a.position - b.position)
        .map((m) => text(m.variable_key)),
    });
  return out;
}

/** Template portion of a future Meta request. Recipient/phone number are intentionally outside Step 5A. */
export function buildMetaTemplateMessagePayload(
  prepared: PreparedTemplateMessage
) {
  if (
    !/^[a-z0-9_]{1,512}$/.test(prepared.template.name) ||
    !prepared.template.language?.trim()
  )
    throw new TemplatePreparationError('provider_payload_invalid');
  const components = buildMetaTemplateComponents(prepared);
  return {
    name: prepared.template.name,
    language: { code: prepared.template.language },
    ...(components.length ? { components } : {}),
  };
}
