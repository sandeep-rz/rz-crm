import { describe, expect, it } from 'vitest';
import { normalizeMetaTemplateTextParameter } from './meta-parameter-utils';

describe('normalizeMetaTemplateTextParameter', () => {
  it.each([
    ['Hello Sandeep', 'Hello Sandeep'],
    [
      'Staff: Ramesh\nPhone: +919999999999',
      'Staff: Ramesh Phone: +919999999999',
    ],
    ['Line 1\r\nLine 2', 'Line 1 Line 2'],
    ['Line 1\rLine 2', 'Line 1 Line 2'],
    ['Hello\tSandeep', 'Hello Sandeep'],
    ['Hello\r\n\t\nSandeep', 'Hello Sandeep'],
    ['Hello  Sandeep', 'Hello  Sandeep'],
    ['Hello   Sandeep', 'Hello   Sandeep'],
    ['Hello    Sandeep', 'Hello    Sandeep'],
    ['Hello     Sandeep', 'Hello    Sandeep'],
    ['Hello          Sandeep', 'Hello    Sandeep'],
    ['  Hello Sandeep  ', '  Hello Sandeep  '],
    ['     Hello     ', '    Hello    '],
    ['Hello  \n  Sandeep', 'Hello    Sandeep'],
    ['Hello\u00a0\u00a0Sandeep', 'Hello\u00a0\u00a0Sandeep'],
    ['Hello\u2028Sandeep', 'Hello\u2028Sandeep'],
    ['0', '0'],
    ['', ''],
    ['    ', '    '],
  ])('normalizes only prohibited sequences: %j', (input, expected) => {
    expect(normalizeMetaTemplateTextParameter(input)).toBe(expected);
  });

  it('is idempotent after Meta-required normalization', () => {
    const value = normalizeMetaTemplateTextParameter(
      '  Hello\r\n\t     Sandeep  '
    );
    expect(normalizeMetaTemplateTextParameter(value)).toBe(value);
  });
});
