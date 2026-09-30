import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/64_reservations_workspace_query.sql'), 'utf8');

describe('reservation workspace migration', () => {
  it('authorizes the requested workspace and scopes every reservation source', () => {
    expect(sql).toMatch(/r\.account_id = p_account_id/);
    expect(sql).toMatch(/public\.is_account_member\(p_account_id\)/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toMatch(/JOIN public\.pms_properties[\s\S]+p\.account_id = r\.account_id/);
    expect(sql).toMatch(/LEFT JOIN public\.contacts[\s\S]+c\.account_id = r\.account_id/);
  });

  it('derives lifecycle from the property timezone and never stores it', () => {
    expect(sql).toMatch(/now\(\) AT TIME ZONE COALESCE\(NULLIF\(p\.timezone/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]+ADD COLUMN[\s\S]+lifecycle/i);
  });

  it('implements database search, filters, stable pagination and bounded pages', () => {
    expect(sql).toMatch(/reservation_code ILIKE/);
    expect(sql).toMatch(/p_property_id IS NULL OR x\.property_id = p_property_id/);
    expect(sql).toMatch(/p_channel IS NULL/);
    expect(sql).toMatch(/p_status IS NULL/);
    expect(sql).toMatch(/x\.id ASC/);
    expect(sql).toMatch(/LIMIT LEAST\(GREATEST\(p_limit, 1\), 100\)/);
    expect(sql).toMatch(/OFFSET GREATEST\(p_offset, 0\)/);
  });
});
