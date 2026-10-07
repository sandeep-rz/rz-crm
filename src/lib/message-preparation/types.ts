import type { MessageTemplate } from '@/types';
import type { TemplateVariableOccurrence } from '@/lib/whatsapp/semantic-template';

/** Approval samples deliberately do not enter send-time preparation. */
export type PreparedVariableOccurrence = Omit<
  TemplateVariableOccurrence,
  'sample'
>;
export type PreparedTemplateIdentity = Pick<
  MessageTemplate,
  | 'id'
  | 'name'
  | 'body_text'
  | 'header_type'
  | 'header_content'
  | 'header_media_url'
  | 'footer_text'
  | 'buttons'
> & { language: string; connectionId: string };
export interface PrepareTemplateMessageInput {
  accountId: string;
  templateId: string;
  context: { contactId?: string; reservationId?: string };
}
export interface PreparedTemplateMessage {
  template: PreparedTemplateIdentity;
  context: { contactId?: string; reservationId?: string };
  resolvedVariables: Record<string, string>;
  mapping: PreparedVariableOccurrence[];
}
