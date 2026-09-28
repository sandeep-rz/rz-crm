import { NextResponse } from 'next/server';

import {
  establishRukiyeZaraSsoSession,
  isRukiyeZaraSsoError,
  isValidRukiyeZaraSsoCode,
  type RukiyeZaraSsoErrorCode,
} from '@/lib/integrations/pms/rukiye-zara-sso';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirect(
  request: Request,
  pathname: string,
  errorCode?: RukiyeZaraSsoErrorCode | 'missing_code'
) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  if (errorCode) url.searchParams.set('sso_error', errorCode);

  const response = NextResponse.redirect(url);
  response.headers.set(
    'Cache-Control',
    'no-store, no-cache, max-age=0, must-revalidate'
  );
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get('code');
  if (!isValidRukiyeZaraSsoCode(code)) {
    return redirect(request, '/login', 'missing_code');
  }

  try {
    await establishRukiyeZaraSsoSession(code);
    return redirect(request, '/dashboard');
  } catch (error) {
    if (isRukiyeZaraSsoError(error)) {
      return redirect(request, '/login', error.code);
    }

    // Never log the authorization code, PMS credentials, internal magic-link
    // token, Supabase session tokens, or exception details.
    console.error('[RZ PMS SSO] callback failed');
    return redirect(request, '/login', 'session_failed');
  }
}
