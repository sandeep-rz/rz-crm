import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const step2 = readFileSync(
  new URL(
    '../components/broadcasts/step2-select-audience.tsx',
    import.meta.url
  ),
  'utf8'
);
const step1 = readFileSync(
  new URL(
    '../components/broadcasts/step1-choose-template.tsx',
    import.meta.url
  ),
  'utf8'
);
const step3 = readFileSync(
  new URL('../components/broadcasts/step3-personalize.tsx', import.meta.url),
  'utf8'
);
const step4 = readFileSync(
  new URL('../components/broadcasts/step4-schedule-send.tsx', import.meta.url),
  'utf8'
);
const sending = readFileSync(
  new URL('../hooks/use-broadcast-sending.ts', import.meta.url),
  'utf8'
);

describe('Broadcast active-workspace query guardrails', () => {
  it('scopes template options to accountId', () => {
    expect(step1).toMatch(
      /from\('message_templates'\)[\s\S]*?eq\('account_id', accountId\)/
    );
  });

  it('scopes Step 2 tags, custom fields, and contact counts to accountId', () => {
    expect(step2).toMatch(
      /from\('tags'\)[\s\S]*?select\('\*'\)[\s\S]*?eq\('account_id', accountId\)/
    );
    expect(step2).toMatch(
      /from\('custom_fields'\)[\s\S]*?select\('\*'\)[\s\S]*?eq\('account_id', accountId\)/
    );
    expect(step2).toContain(
      'countAudience(createClient(), audience, accountId)'
    );
  });

  it('scopes Step 3 custom-field options to the active account', () => {
    expect(step3).toMatch(
      /from\('custom_fields'\)[\s\S]*?select\('\*'\)[\s\S]*?eq\('account_id', accountId\)/
    );
  });

  it('scopes Step 4 reach estimates to active-account tags and contacts', () => {
    expect(step4).toContain(
      'countAudience(createClient(), audience, accountId)'
    );
  });

  it('scopes final audiences and validates tag/custom-field ownership', () => {
    expect(sending).toContain('resolveAudienceContacts');
    expect(sending).toMatch(
      /resolveAudienceContacts\([\s\S]*?audience,[\s\S]*?accountId,/
    );
  });

  it('renders a valid IMAGE header URL beneath the field', () => {
    expect(step3).toContain("mediaHeaderType === 'image'");
    expect(step3).toContain('headerMediaError === null');
    expect(step3).toContain('src={headerMediaUrl.trim()}');
  });
});
