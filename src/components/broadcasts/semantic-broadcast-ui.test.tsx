// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from './step1-choose-template';
import { Step3Personalize } from './step3-personalize';
const h = vi.hoisted(() => ({
  templates: [] as unknown[],
  catalog: [] as unknown[],
  reads: [] as string[],
  pendingTemplates: null as Promise<{ data: unknown[]; error: null }> | null,
  filters: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('next-intl', () => ({ useTranslations: () => h.t }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'account' }),
}));
vi.mock('lucide-react', () => ({
  Loader2: () => null,
  FileText: () => null,
  ArrowRight: () => null,
  ArrowLeft: () => null,
  Eye: () => null,
  ImageIcon: () => null,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      h.reads.push(table);
      const q = {
        select: () => q,
        eq: (...args: unknown[]) => {
          h.filters(...args);
          return q;
        },
        order: async () =>
          table === 'message_templates' && h.pendingTemplates
            ? h.pendingTemplates
            : {
                data:
                  table === 'message_templates'
                    ? h.templates
                    : table === 'message_variable_catalog'
                      ? h.catalog
                      : [],
                error: null,
              },
      };
      return q;
    },
  }),
}));
const template = {
  id: 'crm',
  name: 'CRM news',
  status: 'APPROVED',
  category: 'Marketing',
  language: 'en_US',
  body_text: 'Hello {{1}}',
  semantic_content: { body_text: 'Hello {{contact.first_name}}' },
  semantic_variable_mapping: [
    {
      component: 'BODY',
      position: 1,
      variable_key: 'contact.first_name',
      sample: 'SAMPLE',
    },
  ],
  variable_configuration_status: 'configured',
  whatsapp_config_id: 'config',
} as MessageTemplate;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.reads = [];
  h.pendingTemplates = null;
  h.catalog = [
    {
      variable_key: 'contact.first_name',
      label: 'Contact first name',
      source_scope: 'contact',
      resolution_source: 'context',
      category: 'contact',
      sort_order: 1,
      is_active: true,
      preview_value: 'SAMPLE',
    },
    {
      variable_key: 'listing.name',
      label: 'Listing name',
      source_scope: 'listing',
      resolution_source: 'provider',
      category: 'listing',
      sort_order: 2,
      is_active: true,
      preview_value: 'SAMPLE',
    },
  ];
  h.templates = [
    template,
    {
      ...template,
      id: 'provider',
      name: 'Booking news',
      semantic_content: { body_text: 'Hello {{listing.name}}' },
      semantic_variable_mapping: [
        { component: 'BODY', position: 1, variable_key: 'listing.name' },
      ],
    },
  ];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('allows configured CRM templates and disables reservation-dependent templates with an explanation', async () => {
  await act(async () =>
    root.render(
      <Step1ChooseTemplate
        selectedTemplate={null}
        onSelect={h.select}
        onNext={() => {}}
        onBack={() => {}}
        whatsappConfigId="config"
      />
    )
  );
  const buttons = [...host.querySelectorAll('button')];
  const crm = buttons.find((b) => b.textContent?.includes('CRM news'))!;
  const provider = buttons.find((b) =>
    b.textContent?.includes('Booking news')
  )!;
  expect(crm.disabled).toBe(false);
  expect(provider.disabled).toBe(true);
  expect(provider.textContent).toContain('requires reservation context');
  expect(crm.textContent).toContain('{{Contact first name}}');
  await act(async () => crm.click());
  expect(h.select).toHaveBeenCalledWith(template);
});
it('shows catalog-driven semantic preview without an independently editable mapping', async () => {
  await act(async () =>
    root.render(
      <Step3Personalize
        template={template}
        variables={[]}
        onUpdate={h.update}
        headerMediaUrl=""
        onHeaderMediaUrlChange={() => {}}
        onNext={() => {}}
        onBack={() => {}}
      />
    )
  );
  expect(host.textContent).toContain('{{Contact first name}}');
  expect(host.textContent).toContain('filled automatically for each recipient');
  expect(host.querySelector('select')).toBeNull();
  expect(host.querySelector('input')).toBeNull();
  expect(h.update).not.toHaveBeenCalled();
  expect(h.reads).not.toContain('custom_fields');
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'next')!
      .disabled
  ).toBe(false);
});
it('preserves positional personalization controls for imported templates', async () => {
  await act(async () =>
    root.render(
      <Step3Personalize
        template={{
          ...template,
          variable_configuration_status: 'needs_mapping',
        }}
        variables={[]}
        onUpdate={h.update}
        headerMediaUrl=""
        onHeaderMediaUrlChange={() => {}}
        onNext={() => {}}
        onBack={() => {}}
      />
    )
  );
  expect(host.querySelector('select')).not.toBeNull();
  expect(h.reads).toContain('custom_fields');
});

it('waits for connection selection before querying templates and scopes the subsequent request', async () => {
  const render = (connectionId: string) =>
    root.render(
      <Step1ChooseTemplate
        selectedTemplate={template}
        onSelect={h.select}
        onNext={() => {}}
        onBack={() => {}}
        whatsappConfigId={connectionId}
      />
    );
  await act(async () => render(''));
  expect(h.reads).not.toContain('message_templates');
  expect(h.filters).not.toHaveBeenCalledWith('whatsapp_config_id', '');
  const next = () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'next')!;
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.textContent).not.toContain('chooseTemplate.noTemplates');
  expect(next()).toBeUndefined();
  await act(async () => render('config'));
  expect(h.filters).toHaveBeenCalledWith('whatsapp_config_id', 'config');
  expect(host.textContent).toContain('CRM news');
  expect(next().disabled).toBe(false);
  await act(async () => render('other-config'));
  expect(next().disabled).toBe(true);
});

it('shows a loader while templates are pending and only shows the empty state after completion', async () => {
  let finish!: (result: { data: unknown[]; error: null }) => void;
  h.pendingTemplates = new Promise((resolve) => {
    finish = resolve;
  });
  await act(async () =>
    root.render(
      <Step1ChooseTemplate
        selectedTemplate={null}
        onSelect={h.select}
        onNext={() => {}}
        onBack={() => {}}
        whatsappConfigId="config"
      />
    )
  );
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.textContent).not.toContain('chooseTemplate.noTemplates');
  await act(async () => finish({ data: [], error: null }));
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toContain('chooseTemplate.noTemplates');
});
