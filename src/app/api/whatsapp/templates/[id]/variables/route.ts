import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { listMessageVariableDefinitions } from '@/lib/message-variables/catalog';
import {
  canMapImportedTemplate,
  mapImportedTemplate,
} from '@/lib/whatsapp/semantic-template';
import type { MessageTemplate } from '@/types';

/** Configuration only: does not edit Meta components, IDs or approval status. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;
    const { data: template, error } = await supabase
      .from('message_templates')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !template)
      return NextResponse.json(
        { error: 'Template not found.' },
        { status: 404 }
      );
    if (!canMapImportedTemplate(template as MessageTemplate))
      return NextResponse.json(
        {
          error:
            'Manual mapping is only available for imported Meta templates that need mapping.',
        },
        { status: 409 }
      );
    let metadata;
    try {
      const body = await request.json();
      metadata = mapImportedTemplate(
        template as MessageTemplate,
        body.mapping,
        await listMessageVariableDefinitions({ db: supabase })
      );
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Invalid mapping.' },
        { status: 400 }
      );
    }
    // Optimistic lock against a concurrent Meta sync/edit changing transport slots.
    const { data, error: updateError } = await supabase
      .from('message_templates')
      .update(metadata)
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('updated_at', template.updated_at)
      .select()
      .maybeSingle();
    if (updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    if (!data)
      return NextResponse.json(
        { error: 'Template changed. Refresh and map again.' },
        { status: 409 }
      );
    return NextResponse.json({ template: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
