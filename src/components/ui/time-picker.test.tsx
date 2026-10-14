// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TimePicker, TimeRangePicker } from './time-picker';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function choose(label: string, time: string) {
  await act(async () => {
    const input = host.querySelector(
      `[aria-label="${label}"][role="combobox"]`
    )!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
  });
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (option) => option.textContent === time
  );
  expect(option).toBeDefined();
  await act(async () =>
    option!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
}
it('selects a complete time directly, including noon and midnight', async () => {
  const change = vi.fn();
  await act(async () =>
    root.render(<TimePicker label="Send at" value="" onChange={change} />)
  );
  expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(1);
  await choose('Send at', '12 PM');
  expect(change).toHaveBeenLastCalledWith('12:00');
  await choose('Send at', '12 AM');
  expect(change).toHaveBeenLastCalledWith('00:00');
});
it('sets 6 PM to 9 AM with two complete-time selections', async () => {
  function Form() {
    const [value, setValue] = useState('');
    return (
      <>
        <TimeRangePicker value={value} onChange={setValue} />
        <output>{value}</output>
      </>
    );
  }
  await act(async () => root.render(<Form />));
  expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(2);
  await choose('from', '6 PM');
  await choose('to', '9 AM');
  expect(host.querySelector('output')?.textContent).toBe('18:00-09:00');
  expect(host.textContent).toContain('overnight');
});
it('preserves existing precise minutes while editing the other endpoint', async () => {
  function Form() {
    const [value, setValue] = useState('18:07–09:13');
    return (
      <>
        <TimeRangePicker value={value} onChange={setValue} />
        <output>{value}</output>
      </>
    );
  }
  await act(async () => root.render(<Form />));
  expect(host.textContent).toContain('6:07 PM');
  expect(host.textContent).toContain('9:13 AM');
  await choose('to', '9:30 AM');
  expect(host.querySelector('output')?.textContent).toBe('18:07-09:30');
});
