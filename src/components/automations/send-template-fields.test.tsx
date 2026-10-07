// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { MessageTemplate } from '@/types';
import type { CatalogVariable } from '@/lib/whatsapp/semantic-template';
import type {
  MessageVariableSourceScope,
  MessageVariableResolutionSource,
} from '@/lib/message-variables/contract';
import { SendTemplateFields } from './send-template-fields';
import {
  selectSemanticTemplateAction,
  serializeTemplateAction,
} from '@/lib/automations/semantic-template-action';
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));
let root: Root, host: HTMLDivElement;
let config: Record<string, unknown>;
let templates: MessageTemplate[];
let catalog: (CatalogVariable & {
  sourceScope?: MessageVariableSourceScope;
  resolutionSource?: MessageVariableResolutionSource;
})[];
let reservationAvailable: boolean;
const render = () =>
  root.render(
    <SendTemplateFields
      config={config}
      templates={templates}
      catalog={catalog}
      reservationAvailable={reservationAvailable}
      connectionId="connection"
      labels={{ template: 'Template', select: 'Select template' }}
      onChange={(next) => {
        config = next;
        render();
      }}
    />
  );
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  reservationAvailable = true;
  config = {
    template_name: 'booking_confirmat',
    language: 'en_US',
    variable_mappings: [
      { component: 'body', position: 1, variable_key: 'property.name' },
    ],
    variables: { '1': 'WRONG_LEGACY_VALUE' },
    unrelated: 'keep',
  };
  templates = [
    {
      id: 'template',
      account_id: 'account',
      user_id: 'user',
      name: 'booking_confirmat',
      language: 'en_US',
      whatsapp_config_id: 'connection',
      meta_template_id: 'meta',
      status: 'APPROVED',
      template_origin: 'rgcrm',
      variable_configuration_status: 'configured',
      body_text: 'Hi {{1}} at {{2}}',
      semantic_content: {
        body_text: 'Hi {{contact.first_name}} at {{property.name}}',
      },
      semantic_variable_mapping: [
        {
          component: 'BODY',
          position: 1,
          variable_key: 'contact.first_name',
          sample: 'sample',
        },
        {
          component: 'BODY',
          position: 2,
          variable_key: 'property.name',
          sample: 'sample',
        },
      ],
      category: 'Utility',
      created_at: '',
    },
  ];
  catalog = [
    {
      variableKey: 'contact.first_name',
      label: 'Live catalog name',
      previewValue: 'SAMPLE_NEVER_SAVED',
      category: 'contact',
      sortOrder: 0,
      isActive: true,
    },
    {
      variableKey: 'property.name',
      label: 'Live catalog property',
      previewValue: 'PREVIEW_ONLY',
      category: 'property',
      sortOrder: 1,
      isActive: true,
    },
  ];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(render);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
it('shows semantic labels and zero mapping dropdowns despite legacy action state', () => {
  expect(host.textContent).toContain(
    'Hi {{Live catalog name}} at {{Live catalog property}}'
  );
  expect(host.textContent).not.toMatch(
    /BODY|Select a variable|\{\{1\}\}|WRONG_LEGACY_VALUE/
  );
  expect(host.querySelectorAll('select')).toHaveLength(1);
});
it('follows catalog label changes without modifying canonical identity', async () => {
  catalog[0].label = 'Renamed current label';
  await act(render);
  expect(host.textContent).toContain('{{Renamed current label}}');
  expect(templates[0].semantic_variable_mapping![0].variable_key).toBe(
    'contact.first_name'
  );
});
it('selection stores template ID, preserves unrelated fields and drops duplicate mapping/value state', async () => {
  await act(() => {
    const select = host.querySelector('select')!;
    select.value = 'template';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(config).toEqual({
    template_id: 'template',
    template_name: 'booking_confirmat',
    language: 'en_US',
    unrelated: 'keep',
  });
  expect(JSON.stringify(config)).not.toContain('SAMPLE');
});
it('changing templates updates semantic preview', async () => {
  templates.push({
    ...templates[0],
    id: 'second',
    name: 'other',
    semantic_content: { body_text: 'Welcome {{property.name}}' },
    body_text: 'Welcome {{1}}',
    semantic_variable_mapping: [
      {
        component: 'BODY',
        position: 1,
        variable_key: 'property.name',
        sample: '',
      },
    ],
  });
  await act(render);
  await act(() => {
    const select = host.querySelector('select')!;
    select.value = 'second';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('Welcome {{Live catalog property}}');
  expect(host.textContent).not.toContain('Hi {{Live catalog name}}');
});
it('needs_mapping is disabled and directs configuration to template settings', async () => {
  templates[0].variable_configuration_status = 'needs_mapping';
  await act(render);
  expect(
    host.querySelector('option[value="template"]')!.hasAttribute('disabled')
  ).toBe(true);
  expect(host.textContent).toContain('variables need to be configured');
  expect(host.querySelector('a')!.getAttribute('href')).toBe(
    '/settings?tab=templates'
  );
  expect(host.querySelectorAll('select')).toHaveLength(1);
});
it.each([
  { status: 'PENDING' },
  { whatsapp_config_id: 'foreign' },
  { meta_template_id: undefined },
  { language: undefined },
])('disables unusable template %j', async (patch) => {
  Object.assign(templates[0], patch);
  config = { template_id: 'template' };
  await act(render);
  expect(
    host.querySelector('option[value="template"]')!.hasAttribute('disabled')
  ).toBe(true);
});
it('keeps trigger property filtering out of template variable configuration', () => {
  const trigger = { property_ids: ['lakeside-meadows'] };
  const before = JSON.stringify(trigger);
  const selected = selectSemanticTemplateAction(config, templates[0]);
  expect(selected).not.toHaveProperty('property_id');
  expect(JSON.stringify(trigger)).toBe(before);
});
it('retains untouched legacy serialization but never serializes mappings for semantic actions', () => {
  expect(serializeTemplateAction(config)).toEqual(config);
  expect(
    serializeTemplateAction({ ...config, template_id: 'template' })
  ).toEqual({
    template_id: 'template',
    template_name: 'booking_confirmat',
    language: 'en_US',
    unrelated: 'keep',
  });
});
it('performs no runtime resolution or network calls during preview/selection', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected network'));
  try {
    await act(render);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});

it('disables provider templates and warns about saved selections on CRM triggers', async () => {
  reservationAvailable = false;
  catalog.forEach((v) => {
    v.sourceScope = v.category;
    v.resolutionSource = 'context';
  });
  await act(render);
  expect(
    host.querySelector('option[value="template"]')!.hasAttribute('disabled')
  ).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'needs a reservation'
  );
});
it('allows CRM contact/workspace templates for non-PMS triggers', async () => {
  reservationAvailable = false;
  templates[0].semantic_content = {
    body_text: 'Welcome {{contact.first_name}}',
  };
  templates[0].semantic_variable_mapping = [
    {
      component: 'BODY',
      position: 1,
      variable_key: 'contact.first_name',
      sample: 'sample',
    },
  ];
  catalog[0].sourceScope = 'contact';
  catalog[0].resolutionSource = 'context';
  await act(render);
  expect(
    host.querySelector('option[value="template"]')!.hasAttribute('disabled')
  ).toBe(false);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
