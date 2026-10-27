import { describe, expect, it } from 'vitest';
import type { MessageTemplate } from '@/types';
import {
  buildTemplateMessageSnapshot,
  matchMessageTemplate,
  templateMessageView,
} from './template-message-view';
const template = {
  created_at: '2026-10-27T00:00:00Z',
  id: 't1',
  name: 'welcome',
  user_id: 'u',
  account_id: 'a',
  whatsapp_config_id: 'c1',
  language: 'en',
  category: 'Utility',
  body_text: 'Hello {{1}}',
  header_type: 'text',
  header_content: 'Welcome {{1}}',
  footer_text: 'Your host',
  buttons: [{ type: 'QUICK_REPLY', text: 'Check-in help' }],
} satisfies MessageTemplate;
describe('template display snapshots', () => {
  it('freezes the rendered header/footer/buttons instead of following catalog edits', () => {
    const snapshot = buildTemplateMessageSnapshot(template, [
      { type: 'header', parameters: [{ type: 'text', text: 'Taylor' }] },
    ]);
    const edited = {
      ...template,
      header_content: 'Changed',
      footer_text: 'Changed',
    };
    expect(
      templateMessageView({ template_snapshot: snapshot }, edited)
    ).toMatchObject({
      header: { type: 'text', text: 'Welcome Taylor' },
      footer: 'Your host',
      buttons: [{ type: 'QUICK_REPLY', text: 'Check-in help' }],
      language: 'en',
      connectionId: 'c1',
      templateId: 't1',
    });
  });
  it('uses the actual header override instead of an approval sample', () => {
    const snapshot = buildTemplateMessageSnapshot(
      {
        ...template,
        header_type: 'image',
        header_media_url: 'https://example.test/static.jpg',
      },
      [
        {
          type: 'header',
          parameters: [
            { type: 'image', image: { link: 'https://example.test/sent.jpg' } },
          ],
        },
      ]
    );
    expect(snapshot.header).toEqual({
      type: 'image',
      url: 'https://example.test/sent.jpg',
    });
    expect(JSON.stringify(snapshot)).not.toContain('static.jpg');
  });
  it('uses the authenticated connection-scoped media proxy for a Meta media ID', () => {
    const snapshot = buildTemplateMessageSnapshot(
      { ...template, header_type: 'document' },
      [
        {
          type: 'header',
          parameters: [{ type: 'document', document: { id: '123' } }],
        },
      ]
    );
    expect(snapshot.header).toEqual({
      type: 'document',
      url: '/api/whatsapp/media/123?whatsapp_config_id=c1',
    });
  });
  it('never substitutes a header sample for an unresolved legacy variable', () => {
    expect(templateMessageView({}, template).header).toBeNull();
  });
});
describe('legacy template matching', () => {
  const message = { template_name: 'welcome', content_text: 'Hello Taylor' };
  it('matches only the correct connection and a matching body', () => {
    expect(
      matchMessageTemplate(
        message,
        [{ ...template, whatsapp_config_id: 'c2' }, template],
        'c1'
      )
    ).toBe(template);
    expect(matchMessageTemplate(message, [template], 'c2')).toBeNull();
    expect(
      matchMessageTemplate(
        { ...message, content_text: 'Different body' },
        [template],
        'c1'
      )
    ).toBeNull();
  });
  it('does not guess a language when multiple translations match', () => {
    expect(
      matchMessageTemplate(
        message,
        [template, { ...template, id: 't2', language: 'es' }],
        'c1'
      )
    ).toBeNull();
    expect(
      matchMessageTemplate({ template_name: 'welcome' }, [template], 'c1')
    ).toBeNull();
    expect(matchMessageTemplate(message, [template], null)).toBeNull();
  });
});
