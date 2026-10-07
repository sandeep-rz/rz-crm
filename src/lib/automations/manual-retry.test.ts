import { beforeEach, expect, it, vi } from 'vitest';
import { retryPmsAutomationExecution } from './manual-retry';
const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => h }));
beforeEach(() => {
  vi.resetAllMocks();
  h.rpc.mockResolvedValue({ data: 'queued', error: null });
});
it('makes one scoped RPC with no context queries or timestamp arguments', async () => {
  await expect(retryPmsAutomationExecution('account', 'log')).resolves.toBe(
    'queued'
  );
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
    'retry_pms_automation_execution',
    {
      p_log_id: 'log',
      p_account_id: 'account',
    }
  );
  expect(h.from).not.toHaveBeenCalled();
});
it.each([
  'already_completed',
  'already_retried',
  'not_found',
  'not_failed',
  'unsafe_to_retry',
])('maps authoritative %s result', async (code) => {
  h.rpc.mockResolvedValue({ data: code, error: null });
  await expect(
    retryPmsAutomationExecution('account', 'log')
  ).rejects.toMatchObject({ code });
  expect(h.rpc).toHaveBeenCalledTimes(1);
  expect(h.from).not.toHaveBeenCalled();
});
it.each([
  { data: null, error: { message: 'PRIVATE SQL' } },
  { data: 'unknown_state', error: null },
])('hides database errors and unexpected results', async (result) => {
  h.rpc.mockResolvedValue(result);
  await expect(
    retryPmsAutomationExecution('account', 'log')
  ).rejects.toMatchObject({ message: 'retry_unavailable' });
});
