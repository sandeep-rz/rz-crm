import { expect, it } from 'vitest';
import {
  coexistenceHistoryLabel,
  type WhatsAppConnectionSummary,
} from './config-state';
const config = (pending: number, failed: number) =>
  ({
    coexistence_state: { history: { state: 'complete', progress: 100 } },
    coexistence_import: { pending, failed },
  }) as WhatsAppConnectionSummary;
it('shows received history pending or failed instead of complete, even at Meta progress 100', () => {
  expect(coexistenceHistoryLabel(config(2, 0))).toBe(
    'Importing received history'
  );
  expect(coexistenceHistoryLabel(config(2, 1))).toBe('Import needs review');
  expect(coexistenceHistoryLabel(config(0, 0))).toBe('Complete');
  expect(
    coexistenceHistoryLabel({ ...config(0, 0), coexistence_import: null })
  ).toBe('Checking import progress');
});
