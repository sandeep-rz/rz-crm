import { describe, expect, it } from 'vitest';

import {
  ALL_AUTOMATION_TRIGGER_OPTIONS,
  automationActionAvailability,
  automaticallySelectedWhatsAppConnection,
  buildPmsFilterOptions,
  defaultTriggerConfig,
  getAutomationTriggerContextCapabilities,
  selectedPmsPropertyIds,
  updatePmsTriggerConfig,
} from './automation-builder-model';

describe('automation builder hospitality model', () => {
  it('keeps every Phase 1 PMS trigger selectable alongside legacy triggers', () => {
    expect(ALL_AUTOMATION_TRIGGER_OPTIONS).toEqual(
      expect.arrayContaining([
        'new_message_received',
        'time_based',
        'reservation_confirmed',
        'reservation_updated',
        'reservation_cancelled',
        'before_checkin',
        'checkin_day',
        'after_checkout',
      ])
    );
  });

  it('uses friendly timing defaults without choosing a send time', () => {
    expect(defaultTriggerConfig('before_checkin')).toEqual({ days_before: 1 });
    expect(defaultTriggerConfig('checkin_day')).toEqual({});
    expect(defaultTriggerConfig('after_checkout')).toEqual({ days_after: 1 });
  });

  it('produces and restores the backend timing fields without UI-only fields', () => {
    let before = defaultTriggerConfig('before_checkin');
    before = updatePmsTriggerConfig(before, 'local_time', '10:00');
    before = updatePmsTriggerConfig(before, 'property_ids', ['property-a']);
    expect(before).toEqual({
      days_before: 1,
      local_time: '10:00',
      property_ids: ['property-a'],
    });
    expect(selectedPmsPropertyIds(before)).toEqual(['property-a']);

    let checkout = defaultTriggerConfig('after_checkout');
    checkout = updatePmsTriggerConfig(checkout, 'local_time', '11:00');
    expect(checkout).toEqual({ days_after: 1, local_time: '11:00' });
  });

  it('maps property names in the UI to canonical property ids in config', () => {
    const config = updatePmsTriggerConfig(
      { property_id: 'legacy-property' },
      'property_ids',
      ['property-a', 'property-b']
    );
    expect(config).toEqual({ property_ids: ['property-a', 'property-b'] });
    expect(selectedPmsPropertyIds(config)).toEqual([
      'property-a',
      'property-b',
    ]);
  });

  it('maps friendly channel and status choices from actually synced canonical values', () => {
    expect(
      buildPmsFilterOptions([
        {
          channel_code: 'booking_com',
          channel_name: 'Booking.com',
          status: 'confirmed',
        },
        {
          channel_code: 'direct',
          channel_name: 'Rukiye Zara / Direct',
          status: 'cancelled',
        },
        {
          channel_code: 'booking_com',
          channel_name: 'Booking.com',
          status: 'confirmed',
        },
      ])
    ).toEqual({
      channels: [
        { value: 'booking_com', label: 'Booking.com' },
        { value: 'direct', label: 'Rukiye Zara / Direct' },
      ],
      statuses: [
        { value: 'cancelled', label: 'Cancelled' },
        { value: 'confirmed', label: 'Confirmed' },
      ],
    });
  });

  it('represents no filter as an omitted backend field', () => {
    expect(
      updatePmsTriggerConfig({ channels: ['direct'] }, 'channels', [])
    ).toEqual({});
  });

  it('keeps CRM actions enabled and gates only WhatsApp actions', () => {
    expect(
      automationActionAvailability('add_tag', {
        connectionsLoading: false,
        usableConnectionCount: 0,
      })
    ).toEqual({ enabled: true, reason: null });
    expect(
      automationActionAvailability('send_template', {
        connectionsLoading: false,
        usableConnectionCount: 0,
      })
    ).toEqual({ enabled: false, reason: 'connection_required' });
    expect(
      automationActionAvailability('send_message', {
        connectionsLoading: false,
        usableConnectionCount: 1,
      })
    ).toEqual({ enabled: true, reason: null });
  });

  it('auto-selects only a sole WhatsApp connection and preserves multi-connection choice', () => {
    expect(
      automaticallySelectedWhatsAppConnection(null, ['connection-1'])
    ).toBe('connection-1');
    expect(
      automaticallySelectedWhatsAppConnection(null, ['one', 'two'])
    ).toBeNull();
    expect(automaticallySelectedWhatsAppConnection('two', ['one', 'two'])).toBe(
      'two'
    );
    expect(
      automaticallySelectedWhatsAppConnection('disconnected', ['one'])
    ).toBe('one');
  });

  it.each(['reservation_confirmed', 'before_checkin'] as const)(
    '%s guarantees contact, reservation, and property context',
    (trigger) => {
      expect(getAutomationTriggerContextCapabilities(trigger)).toEqual({
        contact: true,
        reservation: true,
        property: true,
        workspace: true,
        listing: false,
        host: false,
      });
    }
  );

  it('does not claim reservation/property context for contact-created', () => {
    expect(
      getAutomationTriggerContextCapabilities('new_contact_created')
    ).toEqual({
      contact: true,
      reservation: false,
      property: false,
      workspace: true,
      listing: false,
      host: false,
    });
  });

  it('does not accidentally expose PMS-only context for generic triggers', () => {
    for (const trigger of [
      'new_message_received',
      'keyword_match',
      'tag_added',
      'time_based',
    ] as const) {
      const capabilities = getAutomationTriggerContextCapabilities(trigger);
      expect(capabilities.reservation).toBe(false);
      expect(capabilities.property).toBe(false);
    }
  });
});
