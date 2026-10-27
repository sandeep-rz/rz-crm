import type { Message, MessageTemplate, TemplateButton } from '@/types';
import type { PreparedTemplateIdentity } from '@/lib/message-preparation/types';
import type {
  MetaSendComponent,
  SendTimeParams,
} from './template-send-builder';
import { renderTemplateBody } from './template-body';

export type TemplateMessageHeader =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video' | 'document'; url: string | null };
export interface TemplateMessageSnapshot {
  version: 1;
  templateId: string;
  name: string;
  language: string | null;
  connectionId: string | null;
  header: TemplateMessageHeader | null;
  footer: string | null;
  buttons: Pick<TemplateButton, 'type' | 'text'>[];
}
export type TemplateMessageView = Pick<
  TemplateMessageSnapshot,
  'header' | 'footer' | 'buttons'
>;

/** Freeze only fields needed to show what was sent; approval samples and full
 * resolved reservation/contact context never enter this snapshot. */
export function buildTemplateMessageSnapshot(
  template: MessageTemplate | PreparedTemplateIdentity,
  components: MetaSendComponent[] = [],
  legacyParams: SendTimeParams = {}
): TemplateMessageSnapshot {
  const params =
    components.find((component) => component.type === 'header')?.parameters ??
    (legacyParams.headerText
      ? [{ type: 'text' as const, text: legacyParams.headerText }]
      : []);
  let header: TemplateMessageHeader | null = null;
  if (template.header_type === 'text' && template.header_content) {
    const text = renderTemplateBody(
      template.header_content,
      params.filter((p) => p.type === 'text').map((p) => p.text)
    );
    if (!/\{\{\d+\}\}/.test(text)) header = { type: 'text', text };
  } else if (template.header_type && template.header_type !== 'text') {
    const parameter = params[0];
    const media =
      parameter?.type === 'image'
        ? parameter.image
        : parameter?.type === 'video'
          ? parameter.video
          : parameter?.type === 'document'
            ? parameter.document
            : null;
    // A Meta media ID is not a public URL. Keep the authenticated proxy route.
    const connectionId =
      'connectionId' in template
        ? template.connectionId
        : template.whatsapp_config_id;
    const link = media
      ? (media.link ?? null)
      : (legacyParams.headerMediaUrl ?? template.header_media_url ?? null);
    const id = media?.id ?? (!link ? legacyParams.headerMediaId : undefined);
    const candidate =
      link ??
      (id
        ? `/api/whatsapp/media/${encodeURIComponent(id)}${connectionId ? `?whatsapp_config_id=${encodeURIComponent(connectionId)}` : ''}`
        : null);
    const url =
      candidate &&
      (candidate.startsWith('/api/whatsapp/media/') ||
        /^https?:\/\//i.test(candidate))
        ? candidate
        : null;
    header = { type: template.header_type, url };
  }
  return {
    version: 1,
    templateId: template.id,
    name: template.name,
    language: template.language ?? null,
    connectionId:
      'connectionId' in template
        ? template.connectionId
        : (template.whatsapp_config_id ?? null),
    header,
    footer: template.footer_text || null,
    buttons: (template.buttons ?? []).map(({ type, text }) => ({ type, text })),
  };
}

/** Legacy rows lack a frozen snapshot. Only decorate an unambiguous body/name
 * match from the conversation's own connection; never choose the first language. */
export function matchMessageTemplate(
  message: Pick<Message, 'template_name' | 'content_text'>,
  templates: MessageTemplate[],
  connectionId: string | null | undefined
): MessageTemplate | null {
  if (!message.template_name || !connectionId) return null;
  const candidates = templates.filter((template) => {
    if (
      template.name !== message.template_name ||
      template.whatsapp_config_id !== connectionId
    )
      return false;
    if (!message.content_text) return false;
    const pattern = template.body_text
      .split(/\{\{\d+\}\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s\\S]*?');
    return new RegExp(`^${pattern}$`).test(message.content_text);
  });
  return candidates.length === 1 ? candidates[0] : null;
}
export function templateMessageView(
  message: Pick<Message, 'template_snapshot' | 'media_url'>,
  template: MessageTemplate | null
): TemplateMessageView {
  const snapshot = message.template_snapshot;
  if (
    snapshot?.version === 1 &&
    Array.isArray(snapshot.buttons) &&
    snapshot.buttons.every(
      (button) =>
        button &&
        ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE'].includes(
          button.type
        ) &&
        typeof button.text === 'string'
    ) &&
    (snapshot.footer === null || typeof snapshot.footer === 'string') &&
    (snapshot.header === null ||
      (snapshot.header &&
        (snapshot.header.type === 'text'
          ? typeof snapshot.header.text === 'string'
          : ['image', 'video', 'document'].includes(snapshot.header.type) &&
            (snapshot.header.url === null ||
              (typeof snapshot.header.url === 'string' &&
                (snapshot.header.url.startsWith('/api/whatsapp/media/') ||
                  /^https?:\/\//i.test(snapshot.header.url)))))))
  )
    return snapshot;
  if (!template) return { header: null, footer: null, buttons: [] };
  const view = buildTemplateMessageSnapshot(template);
  if (view.header && view.header.type !== 'text')
    view.header.url = message.media_url || view.header.url;
  return view;
}
