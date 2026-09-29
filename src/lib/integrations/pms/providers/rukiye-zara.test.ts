import { describe, expect, it } from 'vitest';

import { PmsHttpClient } from '../http-client';
import { PmsProviderError } from '../provider';
import { RukiyeZaraPmsProvider } from './rukiye-zara';

const reservation = {
  id: 'res-1',
  source_type: 'bookings',
  property_id: 22008,
  listing_id: 'listing-1',
  reservation_code: 'RZ-1',
  status: 'confirmed',
  provider_status: 'confirmed',
  check_in: '2026-10-01',
  check_out: '2026-10-03',
  guest: {
    external_guest_id: 'guest-1',
    full_name: 'Guest',
    email: 'guest@example.com',
    phone: '+919999999999',
  },
  occupancy: { adults: 2, children: 1, infants: 0, pets: 0, total: 3 },
  channel: { code: 'direct', name: 'Direct' },
  financial: {
    total_amount: 100,
    paid_amount: 50,
    balance_due: 50,
    currency: 'INR',
    payment_status: 'partial',
  },
  created_at: '2026-09-01T00:00:00Z',
  updated_at: null,
};

function providerFor(body: unknown, status = 200) {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(input)).origin).toBe('https://pms.example.test');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      'Bearer secret'
    );
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return new RukiyeZaraPmsProvider(
    new PmsHttpClient({
      baseUrl: 'https://pms.example.test',
      keyId: 'key',
      secret: 'secret',
      fetchImpl,
    })
  );
}

describe('Rukiye Zara PMS provider adapter', () => {
  it('fetches and normalizes a property', async () => {
    const property = await providerFor({
      data: {
        id: 22008,
        name: 'Villa',
        status: 'active',
        active: true,
        timezone: 'Asia/Kolkata',
        address: { city: 'Goa' },
        currency: 'INR',
        created_at: null,
      },
    }).getProperty({ integration: {} as never, externalPropertyId: '22008' });
    expect(property.externalId).toBe('22008');
    expect(property.address.city).toBe('Goa');
    expect(property.timezone).toBe('Asia/Kolkata');
  });

  it('normalizes numeric property ids and reservation fields', async () => {
    const result = await providerFor({
      data: [reservation],
      pagination: { next_cursor: 'next', has_more: true },
    }).listReservations({
      integration: {} as never,
      externalPropertyId: '22008',
      limit: 50,
    });
    expect(result.items[0].externalPropertyId).toBe('22008');
    expect(result.items[0].guest.externalId).toBe('guest-1');
    expect(result.nextCursor).toBe('next');
  });

  it('uses the reservation detail route', async () => {
    const result = await providerFor({ data: reservation }).getReservation({
      integration: {} as never,
      externalPropertyId: '22008',
      externalReservationId: 'res-1',
    });
    expect(result.externalId).toBe('res-1');
  });

  it('maps upstream auth, access, rate-limit, not-found, and temporary failures', async () => {
    const failures: Array<[number, string]> = [
      [401, 'authentication'],
      [403, 'access_denied'],
      [404, 'not_found'],
      [429, 'rate_limited'],
      [503, 'upstream_temporary'],
    ];
    for (const [status, code] of failures) {
      await expect(
        providerFor({}, status).getProperty({
          integration: {} as never,
          externalPropertyId: '1',
        })
      ).rejects.toMatchObject({ code });
    }
  });

  it('rejects malformed provider responses and invalid limits', async () => {
    await expect(
      providerFor({ data: [] }).listReservations({
        integration: {} as never,
        externalPropertyId: '1',
        limit: 201,
      })
    ).rejects.toBeInstanceOf(PmsProviderError);
    await expect(
      providerFor({ data: [{}], pagination: {} }).listReservations({
        integration: {} as never,
        externalPropertyId: '1',
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('forwards the cursor, max-safe limit, and updated_since watermark', async () => {
    let requested = '';
    const fetchImpl = async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(
        JSON.stringify({
          data: [],
          pagination: { next_cursor: null, has_more: false },
        }),
        { status: 200 }
      );
    };
    const client = new PmsHttpClient({
      baseUrl: 'https://pms.example.test',
      keyId: 'key',
      secret: 'secret',
      fetchImpl,
    });
    await new RukiyeZaraPmsProvider(client).listReservations({
      integration: {} as never,
      externalPropertyId: '22008',
      limit: 200,
      cursor: 'cursor-1',
      updatedSince: '2026-09-28T10:06:11.328Z',
    });
    expect(requested).toContain('limit=200');
    expect(requested).toContain('cursor=cursor-1');
    expect(new URL(requested).searchParams.get('updated_since')).toBe(
      '2026-09-28T10:06:11.328Z'
    );
  });

  it('accepts omitted nullable provider fields', async () => {
    const result = await providerFor({
      data: [
        {
          ...reservation,
          guest: { external_guest_id: null },
          occupancy: {},
          financial: {},
        },
      ],
      pagination: { next_cursor: null, has_more: false },
    }).listReservations({
      integration: {} as never,
      externalPropertyId: '22008',
    });
    expect(result.items[0].guest.fullName).toBeNull();
    expect(result.items[0].occupancy.adults).toBeNull();
  });

  it('maps an aborted request to a safe temporary failure', async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        setTimeout(resolve, 20);
      });
      return new Response('{}', { status: 200 });
    };
    await expect(
      new RukiyeZaraPmsProvider(
        new PmsHttpClient({
          baseUrl: 'https://pms.example.test',
          keyId: 'key',
          secret: 'secret',
          fetchImpl,
          timeoutMs: 1,
        })
      ).getProperty({ integration: {} as never, externalPropertyId: '1' })
    ).rejects.toMatchObject({ code: 'upstream_temporary' });
  });
});
