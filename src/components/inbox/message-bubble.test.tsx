import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { MessageBubble } from './message-bubble';
import type { Message } from '@/types';
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
it('renders the frozen template header, body, footer and button labels', () => {
  const message: Message = {
    id: 'm',
    conversation_id: 'c',
    sender_type: 'agent',
    content_type: 'template',
    content_text: 'Your reservation is confirmed.',
    status: 'sent',
    created_at: '2026-10-27T00:00:00Z',
    template_snapshot: {
      version: 1,
      templateId: 't',
      name: 'welcome',
      language: 'en',
      connectionId: 'wa',
      header: { type: 'text', text: 'Welcome Taylor' },
      footer: 'Your RZ team',
      buttons: [{ type: 'QUICK_REPLY', text: 'Need help' }],
    },
  };
  const html = renderToStaticMarkup(<MessageBubble message={message} />);
  for (const text of [
    'Welcome Taylor',
    'Your reservation is confirmed.',
    'Your RZ team',
    'Need help',
  ])
    expect(html).toContain(text);
});
