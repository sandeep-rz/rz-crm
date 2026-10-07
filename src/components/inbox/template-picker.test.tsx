// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  select: vi.fn(),
  stays: vi.fn(),
  templates: [] as unknown[],
  definitions: [] as unknown[],
  catalogError: null as unknown,
}));
vi.mock('lucide-react', () => ({
  ArrowLeft: () => null,
  ChevronRight: () => null,
  LayoutTemplate: () => null,
  Loader2: () => null,
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'account' }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) },
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        order: async () => ({
          data: table === 'message_templates' ? h.templates : h.definitions,
          error: table === 'message_variable_catalog' ? h.catalogError : null,
        }),
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/contacts/pms-stays', async (original) => ({
  ...(await original<object>()),
  loadContactStays: h.stays,
}));
vi.mock('@/components/ui/dialog', () => {
  const Container = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? <div>{children}</div> : null),
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});
vi.mock('@/components/ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));
vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));
vi.mock('@/components/ui/label', () => ({
  Label: (props: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props} />
  ),
}));
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
import { TemplatePicker } from './template-picker';
let host: HTMLDivElement, root: Root;
const semantic = {
  id: 'template',
  name: 'booking_confirmation',
  body_text: 'Hi {{1}}',
  semantic_content: { body_text: 'Hi {{listing.name}}', button_urls: {} },
  semantic_variable_mapping: [
    { component: 'BODY', position: 1, variable_key: 'listing.name' },
  ],
  variable_configuration_status: 'configured',
  whatsapp_config_id: 'config',
  status: 'APPROVED',
  category: 'Utility',
  language: 'en_US',
};
const stay = {
  id: 'reservation-one',
  reservationCode: 'RZ26100711c3',
  checkIn: '2026-10-15',
  checkOut: '2026-10-18',
  timing: 'upcoming',
};
const openAndPick = async () => {
  await act(async () =>
    root.render(
      <TemplatePicker
        open
        onOpenChange={() => {}}
        onSelect={h.select}
        whatsappConfigId="config"
        contactId="recipient"
      />
    )
  );
  const template = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('booking_confirmation')
  )!;
  await act(async () => template.click());
};
const sendButton = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'send')!;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.templates = [semantic];
  h.definitions = [
    {
      variable_key: 'listing.name',
      label: 'Listing name',
      preview_value: 'SAMPLE ONLY',
      is_active: true,
      category: 'listing',
      source_scope: 'listing',
      sort_order: 1,
      resolution_source: 'context',
    },
  ];
  h.catalogError = null;
  h.stays.mockResolvedValue([stay]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('auto-selects one relevant contact reservation without collecting runtime values', async () => {
  await openAndPick();
  expect(h.stays).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    accountId: 'account',
    contactId: 'recipient',
  });
  expect((host.querySelector('select') as HTMLSelectElement).value).toBe(
    'reservation-one'
  );
  expect(host.textContent).toContain('RZ26100711c3');
  expect(host.textContent).toContain('{{Listing name}}');
  expect(host.textContent).not.toContain('SAMPLE ONLY');
  expect(host.querySelector('input')).toBeNull();
  expect(sendButton().disabled).toBe(false);
  await act(async () => sendButton().click());
  expect(h.select).toHaveBeenCalledWith(semantic, {
    body: [],
    reservationId: 'reservation-one',
  });
  expect(JSON.stringify(h.select.mock.calls)).not.toContain('SAMPLE ONLY');
});
it('requires an explicit choice when multiple relevant reservations exist', async () => {
  h.stays.mockResolvedValue([
    stay,
    { ...stay, id: 'reservation-two', reservationCode: 'RZ-SECOND' },
  ]);
  await openAndPick();
  expect(sendButton().disabled).toBe(true);
  const select = host.querySelector('select')!;
  await act(async () => {
    select.value = 'reservation-two';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => sendButton().click());
  expect(h.select.mock.calls[0][1]).toEqual({
    body: [],
    reservationId: 'reservation-two',
  });
});
it('does not request a reservation for CRM-source variables', async () => {
  h.templates = [
    {
      ...semantic,
      body_text: 'Hello {{1}}',
      semantic_content: { body_text: 'Hello {{workspace.name}}' },
      semantic_variable_mapping: [
        { component: 'BODY', position: 1, variable_key: 'workspace.name' },
      ],
    },
  ];
  h.definitions = [
    {
      variable_key: 'workspace.name',
      source_scope: 'workspace',
      resolution_source: 'crm',
      label: 'Workspace',
      preview_value: 'SAMPLE ONLY',
      is_active: true,
    },
  ];
  await openAndPick();
  expect(host.querySelector('select')).toBeNull();
  expect(h.stays).not.toHaveBeenCalled();
  expect(sendButton().disabled).toBe(false);
});
it('does not request reservation context for static semantic templates', async () => {
  h.templates = [
    {
      ...semantic,
      body_text: 'Welcome!',
      semantic_content: { body_text: 'Welcome!' },
      semantic_variable_mapping: [],
    },
  ];
  await openAndPick();
  expect(host.querySelector('select')).toBeNull();
  expect(h.stays).not.toHaveBeenCalled();
  expect(sendButton().disabled).toBe(false);
});
it('blocks send if reservation details are unavailable', async () => {
  h.stays.mockRejectedValue(new Error('PRIVATE PROVIDER ERROR'));
  await openAndPick();
  expect(sendButton().disabled).toBe(true);
  expect(host.textContent).toContain('contextLoadError');
  expect(host.textContent).not.toContain('PRIVATE');
});
it('needs_mapping keeps the legacy positional picker', async () => {
  h.templates = [
    { ...semantic, variable_configuration_status: 'needs_mapping' },
  ];
  await openAndPick();
  expect(host.querySelector('input')).not.toBeNull();
  expect(host.querySelector('select')).toBeNull();
  expect(h.stays).not.toHaveBeenCalled();
  expect(sendButton().disabled).toBe(true);
});
it('catalog failures cannot turn a semantic template into a legacy send', async () => {
  h.catalogError = { message: 'PRIVATE DATABASE ERROR' };
  await openAndPick();
  expect(sendButton().disabled).toBe(true);
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).not.toContain('PRIVATE');
});

it('resolves contact-context templates without a reservation picker or positional inputs', async () => {
  h.templates = [
    {
      ...semantic,
      semantic_content: { body_text: 'Hi {{contact.first_name}}' },
      semantic_variable_mapping: [
        { component: 'BODY', position: 1, variable_key: 'contact.first_name' },
      ],
    },
  ];
  h.definitions = [
    {
      variable_key: 'contact.first_name',
      source_scope: 'contact',
      resolution_source: 'context',
      label: 'Contact first name',
      preview_value: 'Sample',
      is_active: true,
    },
  ];
  await openAndPick();
  expect(h.stays).not.toHaveBeenCalled();
  expect(host.querySelector('select')).toBeNull();
  expect(host.querySelector('input')).toBeNull();
  await act(async () => sendButton().click());
  expect(h.select.mock.calls[0][1]).toEqual({ body: [] });
});

it('blocks malformed configured mappings instead of collecting manual positional values', async () => {
  h.templates = [{ ...semantic, semantic_variable_mapping: [] }];
  await openAndPick();
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('select')).toBeNull();
  expect(host.textContent).toContain('invalidMapping');
  expect(sendButton().disabled).toBe(true);
  await act(async () => sendButton().click());
  expect(h.select).not.toHaveBeenCalled();
});
it('blocks configured mappings whose catalog definitions are unavailable', async () => {
  h.definitions = [];
  await openAndPick();
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('select')).toBeNull();
  expect(host.textContent).toContain('contextLoadError');
  expect(sendButton().disabled).toBe(true);
});
it('keeps imported unmapped templates on the manual send path', async () => {
  const legacy = {
    ...semantic,
    template_origin: 'meta',
    semantic_content: null,
    semantic_variable_mapping: [],
    variable_configuration_status: 'needs_mapping',
  };
  h.templates = [legacy];
  await openAndPick();
  const input = host.querySelector('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, 'Manual guest');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(sendButton().disabled).toBe(false);
  await act(async () => sendButton().click());
  expect(h.select).toHaveBeenCalledWith(legacy, { body: ['Manual guest'] });
});
it('configured booking_confirmat uses catalog labels and automatic values for every transport slot', async () => {
  const keys = [
    'contact.first_name',
    'listing.name',
    'reservation.check_in_date',
    'reservation.check_out_date',
    'property.staff_details',
  ];
  const labels = [
    'Contact first name',
    'Listing name',
    'Check-in date',
    'Check-out date',
    'Staff details',
  ];
  const template = {
    ...semantic,
    name: 'booking_confirmat',
    template_origin: 'rgcrm',
    body_text: keys.map((_, i) => `Value {{${i + 1}}}`).join('\n'),
    semantic_content: {
      body_text: keys.map((key) => `Value {{${key}}}`).join('\n'),
      button_urls: {},
    },
    semantic_variable_mapping: keys.map((key, i) => ({
      component: 'BODY',
      position: i + 1,
      variable_key: key,
    })),
  };
  h.templates = [template];
  h.definitions = keys.map((key, i) => ({
    variable_key: key,
    label: labels[i],
    source_scope: key.split('.')[0],
    resolution_source: i === 0 ? 'crm' : 'context',
    is_active: true,
  }));
  await act(async () =>
    root.render(
      <TemplatePicker
        open
        onOpenChange={() => {}}
        onSelect={h.select}
        whatsappConfigId="config"
        contactId="recipient"
      />
    )
  );
  expect(host.textContent).toContain('{{Contact first name}}');
  expect(host.textContent).not.toContain('{{1}}');
  const button = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('booking_confirmat')
  )!;
  await act(async () => button.click());
  expect(host.querySelector('input')).toBeNull();
  for (const label of labels)
    expect(host.textContent).toContain(`{{${label}}}`);
  await act(async () => sendButton().click());
  expect(h.select).toHaveBeenCalledWith(template, {
    body: [],
    reservationId: 'reservation-one',
  });
});
