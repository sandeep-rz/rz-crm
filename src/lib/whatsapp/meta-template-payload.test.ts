import { describe, expect, it, vi } from 'vitest';
import type { PreparedTemplateMessage } from '@/lib/message-preparation/types';
import {
  buildMetaTemplateComponents,
  buildMetaTemplateMessagePayload,
} from './meta-template-payload';
vi.mock('server-only', () => ({}));

const canonical = 'Staff: Ramesh\nPhone: +919999999999';
function prepared(): PreparedTemplateMessage {
  return {
    template: {
      id: 'template',
      name: 'booking_confirmat',
      language: 'en_US',
      connectionId: 'connection',
      body_text: 'Staff details: {{1}}. We look forward to welcoming you.',
    },
    context: { reservationId: 'reservation' },
    resolvedVariables: { 'property.staff_details': canonical },
    mapping: [
      {
        component: 'BODY',
        position: 1,
        variable_key: 'property.staff_details',
      },
    ],
  };
}

describe('Meta semantic text parameter normalization', () => {
  it('normalizes the staff BODY parameter without mutating any prepared data', () => {
    const input = prepared();
    const snapshot = structuredClone(input);
    Object.freeze(input.resolvedVariables);
    const payload = buildMetaTemplateMessagePayload(input);
    expect(payload.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Staff: Ramesh Phone: +919999999999' },
        ],
      },
    ]);
    expect(input.resolvedVariables['property.staff_details']).toBe(canonical);
    expect(input).toEqual(snapshot);
    expect(payload.name).toBe(snapshot.template.name);
    expect(payload.language.code).toBe(snapshot.template.language);
  });

  it('retains exactly five BODY parameters in the booking scenario', () => {
    const input = prepared();
    input.template.body_text =
      'Hello {{1}}, your stay at {{2}} is confirmed from {{3}} to {{4}}. Contact {{5}} for assistance.';
    input.resolvedVariables = {
      'contact.first_name': 'Sandeep',
      'listing.name': 'Lakeside',
      'reservation.check_in_date': '2026-10-08',
      'reservation.check_out_date': '2026-10-10',
      'property.staff_details': canonical,
    };
    input.mapping = Object.keys(input.resolvedVariables).map(
      (variable_key, index) => ({
        component: 'BODY',
        position: index + 1,
        variable_key,
      })
    );
    const snapshot = structuredClone(input);
    const components = buildMetaTemplateMessagePayload(input).components!;
    expect(components).toHaveLength(1);
    expect(components[0].parameters).toHaveLength(5);
    expect(components[0].parameters[4]).toEqual({
      type: 'text',
      text: 'Staff: Ramesh Phone: +919999999999',
    });
    expect(input).toEqual(snapshot);
  });

  it('applies the same policy to text HEADER and repeated BODY occurrences', () => {
    const input = prepared();
    input.template.header_type = 'text';
    input.template.header_content = 'Welcome {{1}}';
    input.template.body_text =
      'Details: {{1}}. Please contact {{2}} for your stay.';
    input.resolvedVariables['listing.name'] = 'Welcome\r\n\t     Guest';
    input.mapping.push(
      {
        component: 'BODY',
        position: 2,
        variable_key: 'property.staff_details',
      },
      { component: 'HEADER', position: 1, variable_key: 'listing.name' }
    );
    const snapshot = structuredClone(input);
    expect(buildMetaTemplateComponents(input)).toEqual([
      {
        type: 'header',
        parameters: [{ type: 'text', text: 'Welcome    Guest' }],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Staff: Ramesh Phone: +919999999999' },
          { type: 'text', text: 'Staff: Ramesh Phone: +919999999999' },
        ],
      },
    ]);
    expect(input).toEqual(snapshot);
  });

  it.each([1, 2, 3, 4])(
    'preserves valid runs of %i spaces in outgoing parameters',
    (spaces) => {
      const input = prepared();
      const value = `  Hello${' '.repeat(spaces)}Sandeep  `;
      input.resolvedVariables['property.staff_details'] = value;
      expect(buildMetaTemplateComponents(input)[0].parameters).toEqual([
        { type: 'text', text: value },
      ]);
    }
  );

  it('preserves template body formatting and media URLs', () => {
    const input = prepared();
    input.template.body_text = 'Hello\n\t     guest, staff details: {{1}}';
    input.template.header_type = 'image';
    input.template.header_media_url =
      'https://example.com/a%20%20%20%20%20b.png';
    const snapshot = structuredClone(input);
    expect(buildMetaTemplateComponents(input)[0]).toEqual({
      type: 'header',
      parameters: [
        { type: 'image', image: { link: input.template.header_media_url } },
      ],
    });
    expect(input).toEqual(snapshot);
  });

  it('leaves dynamic URL suffixes untouched pending verification of the rule', () => {
    const input = prepared();
    input.template.buttons = [
      { type: 'URL', text: 'View booking', url: 'https://example.com/{{1}}' },
    ];
    input.mapping.push({
      component: 'BUTTON',
      position: 1,
      button_index: 0,
      variable_key: 'reservation.reference',
    });
    input.resolvedVariables['reservation.reference'] =
      'url\t suffix     retained';
    const snapshot = structuredClone(input);
    expect(buildMetaTemplateComponents(input)[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'url\t suffix     retained' }],
    });
    expect(input).toEqual(snapshot);
  });
});
