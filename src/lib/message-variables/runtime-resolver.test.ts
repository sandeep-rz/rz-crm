import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
vi.mock('server-only', () => ({}));
import {
  resolveRuntimeVariables,
  type RuntimeVariableInput,
} from './runtime-resolver';
import { RukiyeZaraVariableResolver } from '@/lib/integrations/pms/providers/rukiye-zara-variables';
import { PmsHttpClient } from '@/lib/integrations/pms/http-client';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = id(1),
  reservation = id(2),
  property = id(3),
  integration = id(4),
  external = id(5);
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let failedTable: string | undefined;
let ignoreFilters: boolean;
let reads: string[];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let returned: Record<string, unknown>;
const db = {
  from(table: string) {
    reads.push(table);
    const filters: [string, unknown][] = [];
    const response = () => ({
      data: (tables[table] ?? []).filter(
        (row) =>
          ignoreFilters || filters.every(([key, val]) => row[key] === val)
      ),
      error:
        failedTable === table ? { message: 'sensitive database error' } : null,
    });
    const query = {
      select: () => query,
      eq: (key: string, val: unknown) => {
        filters.push([key, val]);
        return query;
      },
      order: () => query,
      maybeSingle: async () => ({
        ...response(),
        data: response().data[0] ?? null,
      }),
      then: (resolve: (value: unknown) => void) =>
        Promise.resolve(response()).then(resolve),
    };
    return query;
  },
} as unknown as SupabaseClient;
const input = (
  keys: string[] = ['contact.first_name']
): RuntimeVariableInput => ({
  accountId: account,
  context: { reservationId: reservation },
  variableKeys: keys,
});
const run = (keys?: string[]) =>
  resolveRuntimeVariables(input(keys), {
    db,
    createAdapter: () =>
      new RukiyeZaraVariableResolver(
        new PmsHttpClient({
          baseUrl: 'https://pms.test',
          keyId: id(9),
          secret: 'private-service-secret',
          fetchImpl: fetcher,
          timeoutMs: 20,
        })
      ),
  });
const failure = (
  result: Awaited<ReturnType<typeof run>>,
  code: string,
  retryable: boolean
) => {
  expect(result.success).toBe(false);
  expect(result.failures).toContainEqual(
    expect.objectContaining({ code, retryable })
  );
  expect(result.values['contact.first_name']).toBeUndefined();
};

beforeEach(() => {
  reads = [];
  ignoreFilters = false;
  failedTable = undefined;
  tables = {
    message_variable_catalog: [
      'workspace.name',
      'contact.first_name',
      'property.name',
      'property.wifi_details',
      'listing.check_in_time',
      'reservation.nights',
    ].map((variable_key, i) => ({
      id: id(i + 20),
      variable_key,
      label: variable_key,
      is_active: true,
      resolution_source:
        variable_key === 'workspace.name'
          ? 'crm'
          : variable_key === 'reservation.nights'
            ? 'derived'
            : 'context',
      category: variable_key.split('.')[0],
      sort_order: i,
      preview_value: 'EDITOR SAMPLE NOT RUNTIME',
      default_fallback: 'FALLBACK NOT RUNTIME',
    })),
    accounts: [{ id: account, name: 'Current workspace' }],
    pms_reservations: [
      {
        id: reservation,
        account_id: account,
        pms_property_id: property,
        pms_integration_id: integration,
        external_reservation_id: external,
        metadata: { source_type: 'pms_bookings' },
        reservation_code: 'stale projection',
      },
    ],
    pms_properties: [
      {
        id: property,
        account_id: account,
        pms_integration_id: integration,
        external_property_id: '12',
        status: 'active',
        name: 'Stale property',
      },
    ],
    pms_integrations: [
      {
        id: integration,
        account_id: account,
        provider: 'rukiye_zara',
        external_account_id: 'owner',
        status: 'connected',
      },
    ],
  };
  returned = {
    'contact.first_name': { status: 'resolved', value: 'Current contact' },
    'property.name': { status: 'resolved', value: 'Current property' },
    'property.wifi_details': { status: 'missing', value: null },
    'listing.check_in_time': { status: 'unsupported', value: null },
    'reservation.nights': { status: 'resolved', value: '0' },
  };
  fetcher = vi.fn<typeof fetch>().mockImplementation(
    async (_url, init) =>
      new Response(
        JSON.stringify({
          success: true,
          contract_version: 'v1',
          context: JSON.parse(init!.body as string).context,
          values: returned,
        })
      )
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('provider-neutral runtime resolution', () => {
  it('resolves active canonical variables from the current provider', async () => {
    expect(await run()).toMatchObject({
      success: true,
      values: {
        'contact.first_name': {
          status: 'resolved',
          value: 'Current contact',
          source: 'provider',
        },
      },
    });
  });
  it.each(['unknown.key', 'contact.first_name'])(
    'rejects unknown/inactive key %s before any provider call',
    async (key) => {
      if (key === 'contact.first_name')
        tables.message_variable_catalog[1].is_active = false;
      const result = await run([key]);
      expect(result.invalidKeys).toEqual([key]);
      failure(result, 'invalid_variables', false);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
  it('resolves workspace locally without reading reservations or calling a provider', async () => {
    const result = await run(['workspace.name']);
    expect(result.values['workspace.name']).toEqual({
      status: 'resolved',
      value: 'Current workspace',
      source: 'crm',
    });
    expect(reads).toEqual(['message_variable_catalog', 'accounts']);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('merges local/provider results and deduplicates one bulk request', async () => {
    const result = await run([
      'workspace.name',
      'contact.first_name',
      'property.name',
      'contact.first_name',
      'workspace.name',
    ]);
    expect(result.success).toBe(true);
    expect(Object.keys(result.values)).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      'https://pms.test/v1/integrations/rz-crm/variables/resolve'
    );
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      headers: {
        authorization: 'Bearer private-service-secret',
        'x-rz-key-id': id(9),
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      contract_version: 'v1',
      context: { source_type: 'pms_booking', source_record_id: external },
      variables: ['contact.first_name', 'property.name'],
    });
  });
  it('maps native bookings to rz_booking using persisted metadata', async () => {
    tables.pms_reservations[0].metadata = { source_type: 'bookings' };
    await run();
    expect(
      JSON.parse(fetcher.mock.calls[0][1]!.body as string).context.source_type
    ).toBe('rz_booking');
  });
  it('preserves missing and unsupported without samples or fallback values', async () => {
    const result = await run([
      'property.wifi_details',
      'listing.check_in_time',
    ]);
    expect(result).toMatchObject({
      success: true,
      values: {
        'property.wifi_details': {
          status: 'missing',
          value: null,
          source: 'provider',
        },
        'listing.check_in_time': {
          status: 'unsupported',
          value: null,
          source: 'provider',
        },
      },
    });
  });
  it('late-binds derived values and preserves zero', async () => {
    const result = await run(['reservation.nights']);
    expect(result.values['reservation.nights'].value).toBe('0');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 429, 500, 400])(
    'classifies provider HTTP %i separately from missing',
    async (status) => {
      fetcher.mockResolvedValue(
        new Response('sensitive private error', { status })
      );
      const codes: Record<number, string> = {
        401: 'authentication',
        403: 'access_denied',
        429: 'rate_limited',
        500: 'upstream_temporary',
        400: 'invalid_request',
      };
      failure(await run(), codes[status], status === 429 || status === 500);
    }
  );
  it('keeps local success when the provider fails', async () => {
    fetcher.mockResolvedValue(new Response('', { status: 500 }));
    const result = await run(['workspace.name', 'contact.first_name']);
    failure(result, 'upstream_temporary', true);
    expect(result.values['workspace.name'].value).toBe('Current workspace');
  });
  it('classifies network failure safely', async () => {
    fetcher.mockRejectedValue(new Error('private-service-secret'));
    const result = await run();
    failure(result, 'upstream_temporary', true);
    expect(JSON.stringify(result)).not.toContain('private-service-secret');
  });
  it.each(['headers', 'body'])(
    'bounds a hanging response at %s',
    async (phase) => {
      vi.useFakeTimers();
      fetcher.mockImplementation(() =>
        phase === 'headers'
          ? new Promise(() => {})
          : Promise.resolve({
              ok: true,
              status: 200,
              json: () => new Promise(() => {}),
            } as Response)
      );
      const promise = run();
      await vi.advanceTimersByTimeAsync(21);
      failure(await promise, 'timeout', true);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
  );
  it('rejects malformed JSON', async () => {
    fetcher.mockResolvedValue(new Response('not json'));
    failure(await run(), 'invalid_response', true);
  });
  it.each([
    null,
    { status: 'resolved', value: '' },
    { status: 'resolved', value: 5 },
    { status: 'missing', value: 'fallback' },
    { status: 'unsupported', value: undefined },
    { status: 'arbitrary', value: null },
  ])('rejects malformed variable entries %j', async (entry) => {
    returned['contact.first_name'] = entry;
    failure(await run(), 'invalid_response', true);
  });
  it('rejects incomplete responses instead of creating missing results', async () => {
    returned = {};
    failure(await run(), 'invalid_response', true);
  });
  it('rejects the wrong response context/version', async () => {
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          contract_version: 'v2',
          context: { source_type: 'pms_booking', source_record_id: id(99) },
          values: returned,
        })
      )
    );
    failure(await run(), 'invalid_response', true);
  });
  it('does not let the response inject an unrequested variable', async () => {
    returned['unknown.key'] = { status: 'resolved', value: 'private' };
    expect(Object.keys((await run()).values)).toEqual(['contact.first_name']);
  });
  it('does not log sensitive values or complete booking contexts', async () => {
    const log = vi.spyOn(console, 'log'),
      warn = vi.spyOn(console, 'warn'),
      error = vi.spyOn(console, 'error');
    returned['contact.first_name'] = {
      status: 'resolved',
      value: 'sensitive-guest-phone-email-wifi',
    };
    await run();
    fetcher.mockRejectedValue(new Error('sensitive context'));
    await run();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it('requires reservation ownership in the requested workspace', async () => {
    tables.pms_reservations[0].account_id = id(99);
    failure(await run(), 'reservation_not_found', false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['pms_reservations', 'pms_properties', 'pms_integrations'])(
    'defends against a mismatched %s row even if filters are bypassed',
    async (table) => {
      ignoreFilters = true;
      tables[table][0].account_id = id(99);
      const result = await run();
      expect(result.success).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
  it('rejects an inconsistent property/integration relationship', async () => {
    ignoreFilters = true;
    tables.pms_properties[0].pms_integration_id = id(99);
    failure(await run(), 'property_mapping_invalid', false);
  });
  it.each(['provider', 'source_record_id', 'source_type', 'property_id'])(
    'rejects caller-controlled context field %s',
    async (field) => {
      const forged = input();
      (forged.context as unknown as Row)[field] = 'forged';
      const result = await resolveRuntimeVariables(forged, { db });
      failure(result, 'invalid_input', false);
      expect(reads).toEqual([]);
    }
  );
  it('rejects caller-controlled top-level provider fields', async () => {
    failure(
      await resolveRuntimeVariables(
        { ...input(), provider: 'rukiye_zara' } as RuntimeVariableInput,
        { db }
      ),
      'invalid_input',
      false
    );
  });
  it('requires a canonical reservation for provider values', async () => {
    const request = input();
    request.context = {};
    failure(
      await resolveRuntimeVariables(request, { db }),
      'reservation_context_required',
      false
    );
  });
  it('rejects disconnected integration before provider construction', async () => {
    tables.pms_integrations[0].status = 'disconnected';
    failure(await run(), 'integration_not_connected', false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not guess unknown source types from a channel', async () => {
    tables.pms_reservations[0].metadata = { source_type: 'airbnb' };
    failure(await run(), 'configuration', false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects invalid external source record IDs', async () => {
    tables.pms_reservations[0].external_reservation_id = '123';
    failure(await run(), 'configuration', false);
  });
  it('returns catalog/database failures separately', async () => {
    failedTable = 'message_variable_catalog';
    failure(await run(), 'catalog_unavailable', true);
    failedTable = 'pms_reservations';
    failure(await run(), 'lookup_failed', true);
  });
  it('keeps empty local data missing without a fallback', async () => {
    tables.accounts[0].name = ' ';
    const result = await run(['workspace.name']);
    expect(result.values['workspace.name']).toEqual({
      status: 'missing',
      value: null,
      source: 'crm',
    });
  });
  it('handles an empty variable operation without I/O', async () => {
    expect((await run([])).success).toBe(true);
    expect(reads).toEqual([]);
  });
  it('rejects unsupported provider configuration in the neutral registry', async () => {
    tables.pms_integrations[0].provider = 'future-provider';
    failure(
      await resolveRuntimeVariables(input(), { db }),
      'configuration',
      false
    );
  });
});

it.each([
  [400, 'unsupported_contract_version', 'invalid_request', false],
  [401, 'invalid_service_credential', 'authentication', false],
  [403, 'missing_scope', 'access_denied', false],
  [403, 'property_not_connected', 'access_denied', false],
  [404, 'RZ_BOOKING_NOT_FOUND', 'not_found', false],
  [404, 'PMS_BOOKING_NOT_FOUND', 'not_found', false],
  [413, 'invalid_request', 'invalid_request', false],
  [500, 'internal_error', 'upstream_temporary', true],
] as const)(
  'preserves safe diagnostics for HTTP %i %s',
  async (status, providerCode, code, retryable) => {
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: providerCode,
            message: 'sensitive booking context should not escape',
          },
        }),
        { status }
      )
    );
    const result = await run();
    failure(result, code, retryable);
    expect(result.failures[0]).toMatchObject({
      httpStatus: status,
      providerCode,
    });
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(fetcher).toHaveBeenCalledOnce();
  }
);
it('discards unknown upstream error codes and messages', async () => {
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({
        error: {
          code: 'sensitive-guest-phone',
          message: 'private-service-secret',
        },
      }),
      { status: 500 }
    )
  );
  const result = await run();
  expect(result.failures[0].providerCode).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('sensitive');
});
it('keeps reservation channel and currency provider-owned and preserves unsupported', async () => {
  for (const key of ['reservation.channel', 'reservation.currency']) {
    tables.message_variable_catalog.push({
      variable_key: key,
      is_active: true,
      resolution_source: 'context',
    });
    returned[key] = { status: 'unsupported', value: null };
  }
  tables.pms_reservations[0].channel_name = 'Stale channel';
  tables.pms_reservations[0].currency = 'USD';
  tables.pms_properties[0].currency = 'INR';
  const result = await run([
    'workspace.name',
    'reservation.channel',
    'reservation.currency',
  ]);
  expect(result.values['reservation.channel']).toEqual({
    status: 'unsupported',
    value: null,
    source: 'provider',
  });
  expect(result.values['reservation.currency']).toEqual({
    status: 'unsupported',
    value: null,
    source: 'provider',
  });
  expect(
    JSON.parse(fetcher.mock.calls[0][1]!.body as string).variables
  ).toEqual(['reservation.channel', 'reservation.currency']);
});
it('sends only normal credentials and the three contract fields without mutating metadata', async () => {
  const original = JSON.stringify(tables);
  await run();
  expect(JSON.stringify(tables)).toBe(original);
  expect(
    Object.keys(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).sort()
  ).toEqual(['context', 'contract_version', 'variables']);
  expect(
    Object.keys(
      JSON.parse(fetcher.mock.calls[0][1]!.body as string).context
    ).sort()
  ).toEqual(['source_record_id', 'source_type']);
  expect(Object.keys(fetcher.mock.calls[0][1]!.headers!)).toEqual([
    'accept',
    'content-type',
    'authorization',
    'x-rz-key-id',
  ]);
});
it('aborts an actual abort-aware in-flight fetch at the default ten-second deadline', async () => {
  vi.useFakeTimers();
  let aborted = false;
  fetcher.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })
  );
  const promise = resolveRuntimeVariables(input(), {
    db,
    createAdapter: () =>
      new RukiyeZaraVariableResolver(
        new PmsHttpClient({
          baseUrl: 'https://pms.test',
          keyId: id(9),
          secret: 'private-service-secret',
          fetchImpl: fetcher,
        })
      ),
  });
  await vi.advanceTimersByTimeAsync(9999);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  failure(await promise, 'timeout', true);
  expect(aborted).toBe(true);
});
