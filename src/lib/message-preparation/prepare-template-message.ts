import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resolveRuntimeVariables } from '@/lib/message-variables/runtime-resolver';
import { TemplatePreparationError } from './errors';
import { validatePreparationMapping } from './mapping';
import type {
  PrepareTemplateMessageInput,
  PreparedTemplateMessage,
} from './types';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Trusted server callers supply an authorized account. Read-only; no provider send access. */
export async function prepareTemplateMessage(
  input: PrepareTemplateMessageInput,
  options: {
    db?: SupabaseClient;
    resolveVariables?: typeof resolveRuntimeVariables;
  } = {}
): Promise<PreparedTemplateMessage> {
  if (
    !object(input) ||
    Object.keys(input).some(
      (k) => !['accountId', 'templateId', 'context'].includes(k)
    ) ||
    !['accountId', 'templateId'].every(
      (k) => typeof input[k] === 'string' && uuid.test(input[k] as string)
    ) ||
    !object(input.context) ||
    Object.keys(input.context).some(
      (k) => !['contactId', 'reservationId'].includes(k)
    ) ||
    (input.context.contactId !== undefined &&
      (typeof input.context.contactId !== 'string' ||
        !uuid.test(input.context.contactId))) ||
    (input.context.reservationId !== undefined &&
      (typeof input.context.reservationId !== 'string' ||
        !uuid.test(input.context.reservationId)))
  )
    throw new TemplatePreparationError('invalid_input');
  let db: SupabaseClient;
  let template: MessageTemplate;
  try {
    db = options.db ?? supabaseAdmin();
    const { data, error } = await db
      .from('message_templates')
      .select(
        'id,account_id,whatsapp_config_id,name,language,status,meta_template_id,template_origin,semantic_content,semantic_variable_mapping,variable_configuration_status,body_text,header_type,header_content,header_media_url,footer_text,buttons'
      )
      .eq('id', input.templateId)
      .eq('account_id', input.accountId)
      .maybeSingle();
    if (error)
      throw new TemplatePreparationError('template_lookup_failed', {}, true);
    if (!data) {
      const exists = await db
        .from('message_templates')
        .select('id,account_id')
        .eq('id', input.templateId)
        .maybeSingle();
      if (exists.error)
        throw new TemplatePreparationError('template_lookup_failed', {}, true);
      throw new TemplatePreparationError(
        exists.data ? 'template_not_owned' : 'template_not_found'
      );
    }
    if (data.account_id !== input.accountId || data.id !== input.templateId)
      throw new TemplatePreparationError('template_not_owned');
    template = data as MessageTemplate;
    if (
      typeof template.whatsapp_config_id !== 'string' ||
      !uuid.test(template.whatsapp_config_id)
    )
      throw new TemplatePreparationError('template_connection_invalid');
    // Ownership only: preparation needs no access-token decryption or sending credentials.
    const connection = await db
      .from('whatsapp_config')
      .select('id,account_id')
      .eq('id', template.whatsapp_config_id)
      .eq('account_id', input.accountId)
      .maybeSingle();
    if (connection.error)
      throw new TemplatePreparationError('template_lookup_failed', {}, true);
    if (
      !connection.data ||
      connection.data.id !== template.whatsapp_config_id ||
      connection.data.account_id !== input.accountId
    )
      throw new TemplatePreparationError('template_connection_invalid');
  } catch (error) {
    if (error instanceof TemplatePreparationError) throw error;
    throw new TemplatePreparationError('template_lookup_failed', {}, true);
  }
  if (template.variable_configuration_status !== 'configured')
    throw new TemplatePreparationError('template_not_configured');
  if (
    template.status !== 'APPROVED' ||
    typeof template.meta_template_id !== 'string' ||
    !template.meta_template_id.trim() ||
    typeof template.name !== 'string' ||
    !/^[a-z0-9_]{1,512}$/.test(template.name) ||
    typeof template.language !== 'string' ||
    !template.language.trim()
  )
    throw new TemplatePreparationError('template_not_sendable');
  if (!['rgcrm', 'meta'].includes(template.template_origin ?? ''))
    throw new TemplatePreparationError('invalid_semantic_mapping');
  const mapping = validatePreparationMapping(template);
  const keys = [...new Set(mapping.map((m) => m.variable_key))];
  let runtime: Awaited<ReturnType<typeof resolveRuntimeVariables>>;
  try {
    // Exactly one call, including empty mappings; Step 4's empty request does no I/O.
    runtime = await (options.resolveVariables ?? resolveRuntimeVariables)(
      {
        accountId: input.accountId,
        context: { ...input.context },
        variableKeys: keys,
      },
      { db }
    );
  } catch {
    throw new TemplatePreparationError('runtime_resolution_failure', {}, true);
  }
  if (
    !runtime.success ||
    runtime.failures.length ||
    runtime.invalidKeys.length
  ) {
    // Copy only safe classifications; do not attach runtime results or upstream bodies.
    const failures = runtime.failures.map((f) => ({
      code: f.code,
      source: f.source,
      variableKeys: f.variableKeys,
      retryable: f.retryable,
      ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
      ...(f.providerCode === undefined ? {} : { providerCode: f.providerCode }),
    }));
    throw new TemplatePreparationError(
      failures.some((f) => f.source === 'provider')
        ? 'runtime_provider_failure'
        : 'runtime_resolution_failure',
      { runtimeFailures: failures },
      failures.length > 0 && failures.every((f) => f.retryable)
    );
  }
  const resolvedVariables: Record<string, string> = {};
  for (const key of keys) {
    const value = Object.hasOwn(runtime.values, key)
      ? runtime.values[key]
      : undefined;
    if (!value || value.status === 'missing')
      throw new TemplatePreparationError('variable_missing', {
        variableKey: key,
      });
    if (value.status === 'unsupported')
      throw new TemplatePreparationError('variable_unsupported', {
        variableKey: key,
      });
    if (value.status !== 'resolved' || typeof value.value !== 'string')
      throw new TemplatePreparationError('provider_payload_invalid', {
        variableKey: key,
      });
    resolvedVariables[key] = value.value;
  }
  return {
    template: {
      id: template.id,
      name: template.name,
      language: template.language,
      connectionId: template.whatsapp_config_id!,
      body_text: template.body_text,
      header_type: template.header_type,
      header_content: template.header_content,
      header_media_url: template.header_media_url,
      footer_text: template.footer_text,
      // Approval examples are not send-time data. COPY_CODE is explicitly unsupported.
      buttons: template.buttons?.map((button) => {
        if (button.type === 'URL')
          return { type: button.type, text: button.text, url: button.url };
        if (button.type === 'PHONE_NUMBER')
          return {
            type: button.type,
            text: button.text,
            phone_number: button.phone_number,
          };
        if (button.type === 'QUICK_REPLY')
          return { type: button.type, text: button.text };
        throw new TemplatePreparationError('unsupported_template_component');
      }),
    },
    context: { ...input.context },
    resolvedVariables,
    mapping,
  };
}
