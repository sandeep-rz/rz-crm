import { vi } from 'vitest';
// Existing provider tests isolate HTTP behavior. send-policy.test.ts explicitly
// removes this mock and exercises the real common database boundary.
vi.mock('@/lib/whatsapp/send-policy', () => ({
  acquireMetaSend: vi.fn(async () => 0),
}));
