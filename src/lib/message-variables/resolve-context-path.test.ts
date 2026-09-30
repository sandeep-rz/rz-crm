import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MessageVariableContext } from './context';
import { emptyPropertyCommunicationValues } from '@/lib/properties/communication-settings';
import { resolveContextPath } from './resolve-context-path';

const context: MessageVariableContext = {
  contact: {
    id: 'contact-a',
    first_name: 'Sandeep',
    last_name: 'Sharma',
    full_name: 'Sandeep Sharma',
    phone: null,
    email: null,
  },
  reservation: {
    id: 'reservation-a',
    reference: 'ABC123',
    status: 'confirmed',
    check_in: '2026-10-15',
    check_out: '2026-10-18',
    nights: 3,
    guest_count: 2,
    adult_count: 2,
    child_count: 0,
    channel: 'Direct',
    amount: '12500.00',
    currency: 'INR',
  },
  property: {
    id: 'property-a',
    name: 'Lakeside Meadows',
    ...emptyPropertyCommunicationValues(),
  },
  workspace: { id: 'account-a', name: 'Workspace A' },
};

describe('resolveContextPath', () => {
  it.each([
    ['contact.first_name', 'Sandeep'],
    ['reservation.check_in', '2026-10-15'],
    ['property.name', 'Lakeside Meadows'],
    ['workspace.name', 'Workspace A'],
    ['reservation.nights', 3],
    ['contact.phone', null],
  ])('resolves %s while preserving primitive values', (path, value) => {
    expect(resolveContextPath(context, path)).toEqual({ found: true, value });
  });

  it('returns a controlled missing result', () => {
    expect(resolveContextPath(context, 'contact.unknown')).toEqual({
      found: false,
      reason: 'missing',
    });
  });

  it.each([
    '',
    'contact',
    'contact..name',
    'contact.first-name',
    'contact.constructor.name',
    '__proto__.polluted',
    'contact.prototype.value',
  ])('rejects unsafe or invalid path %s', (path) => {
    expect(resolveContextPath(context, path)).toEqual({
      found: false,
      reason: 'invalid',
    });
  });

  it('uses property traversal rather than dynamic execution', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/message-variables/resolve-context-path.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/\beval\s*\(|new\s+Function|Function\s*\(/);
    expect(source).toContain('Object.prototype.hasOwnProperty.call');
  });
});
