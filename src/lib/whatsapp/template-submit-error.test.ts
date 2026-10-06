import { afterEach, expect, it, vi } from 'vitest';
import { MetaApiError, submitMessageTemplate } from './meta-api';
import { templateSubmitError } from './template-submit-error';
import { compileSemanticTemplate } from './semantic-template';
import { buildMetaTemplatePayload } from './template-components';

afterEach(() => vi.unstubAllGlobals());
it('preserves Meta user fields from the real transport response parser', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Invalid parameter',
              code: 100,
              error_subcode: 2388299,
              type: 'OAuthException',
              error_user_title: 'Invalid body',
              error_user_msg: 'Add text after the variable.',
              fbtrace_id: 'trace',
              error_data: { details: 'Body format is invalid.' },
            },
          }),
          { status: 400 }
        )
      )
  );
  await expect(
    submitMessageTemplate({
      wabaId: 'waba',
      accessToken: 'secret',
      payload: {
        name: 'booking',
        category: 'UTILITY',
        language: 'en_US',
        components: [],
      },
    })
  ).rejects.toMatchObject({
    code: 100,
    subcode: 2388299,
    userTitle: 'Invalid body',
    userMessage: 'Add text after the variable.',
    fbtraceId: 'trace',
    details: 'Body format is invalid.',
  });
});
it('proves the exact example compiles to positional JSON on the v21.0 wire', async () => {
  const entries = [
    ['contact.first_name', 'Contact first name', 'Sandeep'],
    ['listing.name', 'Listing name', 'Luxury 1BHK near Cyber Hub'],
    ['reservation.check_in_date', 'Check-in date', '2026-10-15'],
    ['reservation.check_out_date', 'Check-out date', '2026-10-18'],
  ].map(([variableKey, label, previewValue], sortOrder) => ({
    variableKey,
    label,
    previewValue,
    sortOrder,
    category: 'contact' as const,
    isActive: true,
  }));
  const compiled = compileSemanticTemplate(
    { name: 'booking', category: 'Utility', language: 'en_US', body_text: '' },
    {
      body_text:
        'Hi {{contact.first_name}},\nYour booking is confirmed {{listing.name}}\nCheckin: {{reservation.check_in_date}}\nCheckout: {{reservation.check_out_date}}',
    },
    entries
  );
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: 'created', status: 'PENDING' }))
    );
  vi.stubGlobal('fetch', fetch);
  await submitMessageTemplate({
    wabaId: 'selected-waba',
    accessToken: 'secret',
    payload: buildMetaTemplatePayload(compiled.transport),
  });
  expect(fetch.mock.calls[0][0]).toBe(
    'https://graph.facebook.com/v21.0/selected-waba/message_templates'
  );
  const wire = JSON.parse(fetch.mock.calls[0][1].body);
  expect(wire.components).toEqual([
    {
      type: 'BODY',
      text: 'Hi {{1}},\nYour booking is confirmed {{2}}\nCheckin: {{3}}\nCheckout: {{4}}',
      example: {
        body_text: [
          ['Sandeep', 'Luxury 1BHK near Cyber Hub', '2026-10-15', '2026-10-18'],
        ],
      },
    },
  ]);
  for (const variable of entries) {
    expect(fetch.mock.calls[0][1].body).not.toContain(variable.variableKey);
    expect(fetch.mock.calls[0][1].body).not.toContain(variable.label);
  }
});
it('redacts tokens from every string field and retains useful failure diagnostics', () => {
  const failure = templateSubmitError(
    new MetaApiError('Invalid secret', {
      httpStatus: 400,
      code: 100,
      userMessage: 'Bearer secret access_token=secret',
      fbtraceId: 'secret',
    }),
    'secret'
  );
  expect(JSON.stringify(failure)).not.toContain('secret');
  expect(failure.stored).toContain('100');
});
it('recognizes HTTP and Graph rate limits even with an opaque error message', () => {
  expect(
    templateSubmitError(
      new MetaApiError('Invalid parameter', { httpStatus: 429 }),
      'secret'
    ).rateLimited
  ).toBe(true);
  expect(
    templateSubmitError(
      new MetaApiError('Limit', { httpStatus: 400, code: 80007 }),
      'secret'
    ).rateLimited
  ).toBe(true);
});
