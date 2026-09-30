import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  getBroadcastVariableCapabilities,
  inspectBroadcastVariableSlots,
  missingVariableIdentity,
  resolvedVariablesToSendParams,
  validateBroadcastVariableMappings,
} from '@/lib/broadcast-message-variables';
import {
  buildAndResolveMessageVariables,
  listMessageVariableDefinitions,
  type ResolveMessageVariablesResult,
} from '@/lib/message-variables';
import { MessageContextError } from '@/lib/message-variables/context';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

const MAX_CONTACTS = 1000;
const RESOLUTION_BATCH_SIZE = 20;

interface ResolveRequestBody {
  template_name?: unknown;
  template_language?: unknown;
  whatsapp_config_id?: unknown;
  contact_ids?: unknown;
  mappings?: unknown;
  validate_only?: unknown;
}

function badRequest(error: string, details?: string[]) {
  return NextResponse.json(
    { error, ...(details?.length ? { details } : {}) },
    { status: 400 }
  );
}

/**
 * Account-scoped semantic validation and per-recipient resolution for the
 * dashboard Broadcast wizard. account_id is intentionally absent from the
 * request contract: it always comes from the authenticated workspace.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const body = (await request.json()) as ResolveRequestBody;
    const templateName =
      typeof body.template_name === 'string' ? body.template_name.trim() : '';
    const templateLanguage =
      typeof body.template_language === 'string'
        ? body.template_language.trim()
        : undefined;
    const connectionId =
      typeof body.whatsapp_config_id === 'string'
        ? body.whatsapp_config_id.trim()
        : undefined;
    if (!templateName) return badRequest('template_name is required');

    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      templateName,
      templateLanguage,
      connectionId
    );
    if (resolvedTemplate.malformed || !resolvedTemplate.row) {
      return badRequest(
        'The selected template is not available in this workspace.'
      );
    }

    const definitions = await listMessageVariableDefinitions({
      includeInactive: true,
      db: supabase,
    });
    const mappings = body.mappings ?? [];
    const validationIssues = validateBroadcastVariableMappings({
      mappings,
      slots: inspectBroadcastVariableSlots(resolvedTemplate.row),
      definitions,
      capabilities: getBroadcastVariableCapabilities(),
    });
    if (validationIssues.length > 0) {
      return badRequest(
        'Template variable mappings are invalid.',
        validationIssues
      );
    }

    // Resolve once without a contact so catalog/custom-field ownership is
    // proven even for drafts. Missing contact values are expected here.
    const validationResult = await buildAndResolveMessageVariables({
      accountId,
      mappings,
      db: supabase,
    });
    if (validationResult.errors.length > 0) {
      return badRequest(
        'Template variable mappings are invalid.',
        validationResult.errors.map(
          (error) =>
            `${error.code}:${error.component ?? 'unknown'}:${error.position ?? 'unknown'}`
        )
      );
    }
    if (body.validate_only === true) {
      return NextResponse.json({ success: true });
    }

    const contactIds = Array.isArray(body.contact_ids)
      ? body.contact_ids.filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0
        )
      : [];
    if (contactIds.length === 0) {
      return badRequest('contact_ids must be a non-empty array');
    }
    if (contactIds.length > MAX_CONTACTS) {
      return badRequest(`A broadcast is capped at ${MAX_CONTACTS} contacts.`);
    }
    if (new Set(contactIds).size !== contactIds.length) {
      return badRequest('contact_ids must not contain duplicates');
    }

    const results: Array<{
      contact_id: string;
      success: boolean;
      message_params?: ReturnType<typeof resolvedVariablesToSendParams>;
      error?: string;
    }> = [];

    for (
      let offset = 0;
      offset < contactIds.length;
      offset += RESOLUTION_BATCH_SIZE
    ) {
      const batch = contactIds.slice(offset, offset + RESOLUTION_BATCH_SIZE);
      const settled = await Promise.all(
        batch.map(async (contactId) => {
          try {
            const result = await buildAndResolveMessageVariables({
              accountId,
              contactId,
              mappings,
              db: supabase,
            });
            return { contactId, result };
          } catch (error) {
            if (error instanceof MessageContextError) {
              return { contactId, contextError: true as const };
            }
            throw error;
          }
        })
      );
      if (settled.some((item) => 'contextError' in item)) {
        return badRequest(
          'One or more contacts are not available in this workspace.'
        );
      }
      for (const item of settled) {
        const result = item.result as ResolveMessageVariablesResult;
        if (result.success) {
          results.push({
            contact_id: item.contactId,
            success: true,
            message_params: resolvedVariablesToSendParams(result),
          });
        } else {
          results.push({
            contact_id: item.contactId,
            success: false,
            error: missingVariableIdentity(result),
          });
        }
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    return toErrorResponse(error);
  }
}
