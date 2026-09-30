import { describe, expect, it } from 'vitest';

import { validateProvisionRequest } from './types';

const request = {
  installation_id: '11111111-1111-4111-8111-111111111111',
  external_account_id: 'host-1',
  owner: {
    external_user_id: 'owner-1',
    email: 'owner@example.com',
    display_name: 'Owner',
  },
  property: {
    external_property_id: 'property-1',
    name: 'Lakeside',
  },
};

describe('Rukiye Zara provisioning request timezone', () => {
  it('accepts and preserves a valid optional property timezone', () => {
    expect(
      validateProvisionRequest({
        ...request,
        property: { ...request.property, timezone: 'Asia/Kolkata' },
      })
    ).toMatchObject({
      success: true,
      data: { property: { timezone: 'Asia/Kolkata' } },
    });
  });

  it('rejects invalid timezone identifiers and remains compatible when omitted', () => {
    expect(
      validateProvisionRequest({
        ...request,
        property: { ...request.property, timezone: 'India time' },
      })
    ).toMatchObject({ success: false });
    expect(validateProvisionRequest(request)).toMatchObject({
      success: true,
      data: { property: request.property },
    });
  });
});

describe('Rukiye Zara provisioning request communication', () => {
  it('accepts optional partial provider-neutral communication and normalizes blanks', () => {
    expect(
      validateProvisionRequest({
        ...request,
        property: {
          ...request.property,
          communication: {
            map_url: ' https://maps.example/lakeside ',
            directions: '   ',
            caretaker_phone: null,
          },
        },
      })
    ).toMatchObject({
      success: true,
      data: {
        property: {
          communication: {
            map_url: 'https://maps.example/lakeside',
            directions: null,
            caretaker_phone: null,
          },
        },
      },
    });
  });

  it('does not require communication or provider-specific fields', () => {
    expect(validateProvisionRequest(request)).toMatchObject({
      success: true,
      data: { property: request.property },
    });
  });
});
