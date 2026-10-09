import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  coexistenceRecords,
  captureCoexistenceWebhook,
  drainCoexistenceWebhook,
} from './coexistence-webhook';
import {
  signupLaunchOptions,
  signupEligibilityError,
} from './embedded-signup-context';
const metadata = {
  display_phone_number: '15551234567',
  phone_number_id: '456',
};
const message = {
  id: 'wamid.echo',
  from: '15551234567',
  to: '15557654321',
  timestamp: '1739230955',
  type: 'text',
  text: { body: 'Hello' },
};
describe('documented Coexistence payloads', () => {
  it('separates standard and Business app launch options', () => {
    expect(signupLaunchOptions('cloud_api').extras).toEqual({ setup: {} });
    expect(signupLaunchOptions('coexistence')).toEqual({
      config_id: '1445638484111991',
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      },
    });
    expect(JSON.stringify(signupLaunchOptions('coexistence'))).not.toContain(
      'app_only_install'
    );
  });
  it.each([2494064, 3441034])(
    'provides cautious actionable error %s without destructive advice',
    (code) => {
      expect(signupEligibilityError(code)).toContain(String(code));
      expect(signupEligibilityError(code)).toContain('Keep any AiSensy');
      expect(signupEligibilityError(code)).not.toMatch(/delete|deregister/i);
    }
  );
  it('mirrors echoes as outbound with Meta IDs', () => {
    expect(
      coexistenceRecords('smb_message_echoes', {
        metadata,
        message_echoes: [message],
      })[0]
    ).toMatchObject({
      kind: 'message',
      id: message.id,
      outbound: true,
      history: false,
      peer: message.to,
    });
  });
  it('rejects an echo carrying an unrelated business sender', () => {
    expect(() =>
      coexistenceRecords('smb_message_echoes', {
        metadata,
        message_echoes: [{ ...message, from: '15550001111' }],
      })
    ).toThrow('sender');
  });
  it('preserves chunk identity and actual history timestamps', () => {
    const rows = coexistenceRecords('history', {
      metadata,
      history: [
        {
          metadata: { phase: 2, chunk_order: 4, progress: 80 },
          threads: [
            {
              id: message.to,
              messages: [
                message,
                {
                  ...message,
                  id: 'wamid.inbound',
                  from: message.to,
                  type: 'media_placeholder',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(rows[0]).toMatchObject({
      history: true,
      outbound: true,
      at: new Date(Number(message.timestamp) * 1000).toISOString(),
    });
    expect(rows[1]).toMatchObject({
      history: true,
      outbound: false,
      placeholder: true,
      text: '[Historical media unavailable]',
    });
    expect(rows[2]).toMatchObject({
      kind: 'progress',
      phase: 2,
      chunk_order: 4,
      progress: 80,
    });
  });
  it('records Meta consent denial instead of retrying import', () => {
    expect(
      coexistenceRecords('history', {
        metadata,
        history: [{ errors: [{ code: 2593109 }] }],
      })
    ).toEqual([
      {
        kind: 'progress',
        denied: true,
        progress: null,
        phase: undefined,
        chunk_order: undefined,
        error: false,
      },
    ]);
  });
  it('handles separate historical media updates without guessing a thread', () => {
    expect(
      coexistenceRecords('history', {
        metadata,
        messages: [
          {
            ...message,
            type: 'image',
            image: { id: '789', mime_type: 'image/jpeg' },
          },
        ],
      })[0]
    ).toMatchObject({
      kind: 'message',
      media_only: true,
      outbound: undefined,
      media_id: '789',
    });
  });
  it('maps contact removals to relationship tombstones', () => {
    expect(
      coexistenceRecords('smb_app_state_sync', {
        metadata,
        state_sync: [
          {
            type: 'contact',
            action: 'remove',
            contact: { phone_number: message.to },
            metadata: { timestamp: message.timestamp },
          },
        ],
      })[0]
    ).toMatchObject({ kind: 'contact', removed: true, peer: message.to });
  });
  it('captures dated lifecycle events including reconnection', () => {
    expect(
      coexistenceRecords(
        'account_update',
        { event: 'ACCOUNT_RECONNECTED' },
        1739230955
      )[0]
    ).toMatchObject({ kind: 'lifecycle', event: 'ACCOUNT_RECONNECTED' });
  });
  it('durably captures bounded batches without accepting a workspace from payloads', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const value = {
      metadata,
      account_id: 'attacker',
      message_echoes: Array.from({ length: 201 }, (_, i) => ({
        ...message,
        id: `wamid.${i}`,
      })),
    };
    await captureCoexistenceWebhook({ rpc } as unknown as SupabaseClient, {
      entry: [{ id: '123', changes: [{ field: 'smb_message_echoes', value }] }],
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][1].p_events).toHaveLength(3);
    expect(rpc.mock.calls[0][1].p_events[0].records).toHaveLength(100);
    expect(rpc.mock.calls[0][1].p_events[2].records).toHaveLength(1);
    expect(rpc.mock.calls[0][1].p_events[0]).not.toHaveProperty('account_id');
  });
  it('fails delivery when durable capture fails', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: 'XX000' } });
    await expect(
      captureCoexistenceWebhook({ rpc } as unknown as SupabaseClient, {
        entry: [
          {
            id: '123',
            changes: [
              {
                field: 'smb_message_echoes',
                value: { metadata, message_echoes: [message] },
              },
            ],
          },
        ],
      })
    ).rejects.toThrow('capture failed');
  });
  it('rejects phone-less message batches instead of copying them across a WABA', async () => {
    const rpc = vi.fn();
    await expect(
      captureCoexistenceWebhook({ rpc } as unknown as SupabaseClient, {
        entry: [
          {
            id: '123',
            changes: [
              {
                field: 'smb_message_echoes',
                value: {
                  metadata: {
                    display_phone_number: metadata.display_phone_number,
                  },
                  message_echoes: [message],
                },
              },
            ],
          },
        ],
      })
    ).rejects.toThrow('phone identifier');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('bounds background processing and stops when no batch is due', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await drainCoexistenceWebhook({ rpc } as unknown as SupabaseClient);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      'process_whatsapp_coexistence_event',
      { p_limit: 25 }
    );
    rpc.mockClear().mockResolvedValue({ data: false, error: null });
    await drainCoexistenceWebhook({ rpc } as unknown as SupabaseClient);
    expect(rpc).toHaveBeenCalledOnce();
  });
});
