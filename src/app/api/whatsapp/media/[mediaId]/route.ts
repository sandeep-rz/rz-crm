import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { resolveWhatsAppConnection } from '@/lib/whatsapp/connection-resolver';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params;

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve the caller's active workspace before selecting the explicit
    // connection supplied by the conversation. Legacy requests without an
    // id intentionally fall back through the central resolver to primary.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const connectionId = new URL(request.url).searchParams.get(
      'whatsapp_config_id'
    );
    const config = await resolveWhatsAppConnection(supabase, {
      accountId,
      connectionId,
    });
    const accessToken = config.accessToken;

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':
          contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error);
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    );
  }
}
