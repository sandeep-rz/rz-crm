// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SemanticTemplateEditor,
  readSemanticEditor,
} from './semantic-template-editor';
import {
  filterVariables,
  groupVariables,
  VariableSelection,
} from './semantic-variable-picker';
import type { CatalogVariable } from '@/lib/whatsapp/semantic-template';

const catalog: CatalogVariable[] = [
  {
    variableKey: 'contact.first_name',
    label: 'Contact first name',
    previewValue: 'Sandeep',
    category: 'contact',
    sortOrder: 1,
    isActive: true,
  },
  {
    variableKey: 'reservation.check_in_date',
    label: 'Check-in date',
    previewValue: '2026-10-15',
    category: 'reservation',
    sortOrder: 2,
    isActive: true,
  },
  {
    variableKey: 'reservation.check_out_date',
    label: 'Check-out date',
    previewValue: '2026-10-18',
    category: 'reservation',
    sortOrder: 3,
    isActive: true,
  },
  {
    variableKey: 'property.name',
    label: 'Property name',
    previewValue: 'Our property',
    category: 'property',
    sortOrder: 4,
    isActive: true,
  },
];
let root: Root;
let host: HTMLDivElement;
let value: string;
let variables: CatalogVariable[];
const render = () =>
  root.render(
    <SemanticTemplateEditor
      value={value}
      onChange={(next) => {
        value = next;
        render();
      }}
      catalog={variables}
      label="Body"
      multiline
    />
  );
const editor = () => host.querySelector('[role="textbox"]') as HTMLDivElement;
const input = async (text: string, offset = text.length) => {
  await act(async () => {
    editor().textContent = text;
    caret(editor().firstChild!, offset);
    editor().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const caret = (node: Node, offset: number) => {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
};
const key = async (key: string) =>
  act(async () => {
    editor().dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  });
const click = async (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    (element as HTMLElement).click();
  });
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  value = '';
  variables = catalog;
  await act(async () => render());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('semantic editor interactions', () => {
  it('opens only after the second brace and filters labels case-insensitively', async () => {
    await input('Hi {');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await input('Hi {{');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(4);
    await input('Hi {{CHECK');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
  });
  it('shares canonical-key and category search, hides inactive variables and groups by catalog order', () => {
    expect(filterVariables(catalog, 'CONTACT.FIRST')).toEqual([catalog[0]]);
    expect(filterVariables(catalog, 'reservation')).toHaveLength(2);
    expect(filterVariables([{ ...catalog[0], isActive: false }], '')).toEqual(
      []
    );
    expect(
      groupVariables(filterVariables([...catalog].reverse(), '')).map(
        ([category]) => category
      )
    ).toEqual(['contact', 'reservation', 'property']);
  });
  it('navigates down/up and Enter replaces trigger without duplicate braces', async () => {
    await input('Hi {{');
    await key('ArrowDown');
    await key('ArrowDown');
    await key('ArrowUp');
    await key('Enter');
    expect(value).toBe('Hi {{reservation.check_in_date}}');
    expect(editor().textContent).toBe('Hi {{Check-in date}}');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(editor().querySelector('span')?.dataset.variableKey).toBe(
      'reservation.check_in_date'
    );
    expect(host.textContent).toContain('Preview: Hi 2026-10-15');
  });
  it('Tab selects and restores the caret immediately after the token', async () => {
    await input('Hi {{contact');
    await key('Tab');
    expect(value).toBe('Hi {{contact.first_name}}');
    const range = window.getSelection()!.getRangeAt(0);
    expect(range.startContainer).toBe(editor());
    expect(editor().childNodes[range.startOffset - 1]).toBe(
      editor().querySelector('span')
    );
  });
  it('Escape leaves typed text intact for continued editing', async () => {
    await input('{{check');
    await key('Escape');
    expect(value).toBe('{{check');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await input('{{chec');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
  it('click selects at the current caret and preserves following text', async () => {
    await input('Your booking at {{ is confirmed.', 18);
    await click(document.querySelector('[role="option"]')!);
    expect(value).toBe('Your booking at {{contact.first_name}} is confirmed.');
  });
  it('does not recognize arbitrary complete labels as semantic identity', async () => {
    await input('{{Something}}');
    expect(editor().querySelector('[data-variable-key]')).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('deletes an entire chip with Backspace', async () => {
    await input('Hi {{');
    await key('Enter');
    await key('Backspace');
    expect(value).toBe('Hi ');
    expect(editor().querySelector('span')).toBeNull();
  });
  it('updates displayed catalog labels while keeping canonical content and preview', async () => {
    await input('Hi {{');
    await key('Enter');
    variables = catalog.map((v) => ({
      ...v,
      label:
        v.variableKey === 'contact.first_name' ? 'First name updated' : v.label,
    }));
    await act(async () => render());
    expect(editor().textContent).toBe('Hi {{First name updated}}');
    expect(readSemanticEditor(editor())).toBe('Hi {{contact.first_name}}');
    expect(value).toBe('Hi {{contact.first_name}}');
    expect(host.textContent).toContain('Sandeep');
  });
  it('opens a searchable grouped chip dialog and inserts at the remembered caret', async () => {
    await input('Your booking at  is confirmed.', 16);
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === '+ Insert variable'
    )!;
    await click(button);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector('section[aria-label="Contact"]')
    ).not.toBeNull();
    expect(document.querySelector('select')).toBeNull();
    const search = document.querySelector(
      'input[aria-label="Search variables"]'
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )!.set!.call(search, 'property');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('section[aria-label="Contact"]')).toBeNull();
    const chip = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Property name'
    )!;
    await click(chip);
    expect(value).toBe('Your booking at {{property.name}} is confirmed.');
    expect(editor().textContent).toContain('{{Property name}}');
  });
});

it('replaces an existing closing brace pair when selecting between braces', async () => {
  await input('Hi {{}} there', 5);
  await key('Enter');
  expect(value).toBe('Hi {{contact.first_name}} there');
  expect(editor().textContent).toBe('Hi {{Contact first name}} there');
});
it('deletes a whole chip with Delete from its preceding boundary', async () => {
  await input('{{');
  await key('Enter');
  caret(editor(), 1); // The empty leading text node precedes the inserted chip.
  await key('Delete');
  expect(value).toBe('');
});
it('shows no results and allows normal backspacing to remove the trigger', async () => {
  await input('{{no-such-variable');
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  await input('{');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});
it('uses the same semantic interaction in a single-line header or URL editor', async () => {
  await act(async () =>
    root.render(
      <SemanticTemplateEditor
        value=""
        onChange={(next) => {
          value = next;
        }}
        catalog={catalog}
        label="URL"
      />
    )
  );
  await input('https://example.com/{{property');
  await key('Enter');
  expect(value).toBe('https://example.com/{{property.name}}');
});

it('uses the same chip picker for imported mapping and returns only canonical identity', async () => {
  const choose = vi.fn();
  await act(async () =>
    root.render(
      <VariableSelection
        catalog={catalog}
        value=""
        label="Map BODY 1"
        onChange={choose}
      />
    )
  );
  await click(host.querySelector('button')!);
  expect(document.querySelector('select')).toBeNull();
  await click(
    [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Contact first name'
    )!
  );
  expect(choose).toHaveBeenCalledWith('contact.first_name');
});
