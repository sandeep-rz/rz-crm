import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/67_fix_whatsapp_connection_delete_active_workspace.sql'
  ),
  'utf8'
);

describe('WhatsApp connection delete migration', () => {
  it('resolves the active workspace through the auth user id', () => {
    expect(sql).toMatch(
      /FROM public\.profiles p\s+WHERE p\.user_id = v_user_id/
    );
    expect(sql).not.toMatch(/WHERE p\.id = v_user_id/);
  });

  it('preserves active-workspace and admin-or-owner authorization', () => {
    expect(sql).toMatch(/v_active_account_id IS DISTINCT FROM v_account_id/);
    expect(sql).toMatch(/public\.is_account_member\(v_account_id, 'admin'\)/);
  });

  it('preserves atomic primary replacement and deletion', () => {
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/ORDER BY wc\.created_at ASC, wc\.id ASC/);
    expect(sql).toMatch(
      /UPDATE public\.whatsapp_config\s+SET is_primary = TRUE/
    );
    expect(sql).toMatch(/DELETE FROM public\.whatsapp_config/);
  });
});
