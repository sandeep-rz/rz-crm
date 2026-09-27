import { NextResponse } from 'next/server';

import {
  authenticateRukiyeZaraProvider,
  ProviderAuthenticationError,
} from '@/lib/integrations/pms/provider-auth';
import { provisionRukiyeZara } from '@/lib/integrations/pms/provisioning';
import {
  ProvisioningError,
  validateProvisionRequest,
} from '@/lib/integrations/pms/types';

export const runtime = 'nodejs';

function errorResponse(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

export async function POST(request: Request) {
  try {
    await authenticateRukiyeZaraProvider(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(
        'invalid_request',
        'Request body must be valid JSON.',
        400
      );
    }

    const validation = validateProvisionRequest(body);
    if (!validation.success || !validation.data) {
      return errorResponse(
        'invalid_request',
        validation.message ?? 'Request body is invalid.',
        400
      );
    }

    const result = await provisionRukiyeZara(validation.data);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ProviderAuthenticationError) {
      return errorResponse(error.code, error.message, error.status);
    }

    if (error instanceof ProvisioningError) {
      const status = error.code === 'provisioning_failed' ? 500 : 409;
      if (status === 500) {
        console.error(
          '[POST /api/integrations/rukiye-zara/provision] provisioning failed'
        );
      }
      return errorResponse(error.code, error.message, status);
    }

    // Deliberately do not log the request, headers, raw exception, or Supabase
    // payload. Provider secrets and internal database details must stay private.
    console.error(
      '[POST /api/integrations/rukiye-zara/provision] unexpected failure'
    );
    return errorResponse(
      'provisioning_failed',
      'The CRM workspace could not be provisioned.',
      500
    );
  }
}
