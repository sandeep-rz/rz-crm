import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODE, DEFAULT_THEME, THEMES } from './themes';

describe('Rukiye Zara theme', () => {
  it('defaults to the rukiye accent and light mode', () => {
    expect(DEFAULT_THEME).toBe('rukiye');
    expect(DEFAULT_MODE).toBe('light');
    expect(THEMES[0]).toMatchObject({ id: 'rukiye', swatch: '#145C54' });
  });

  it('uses the PMS forest green and gold in both modes', () => {
    const css = readFileSync(
      new URL('../app/globals.css', import.meta.url),
      'utf8'
    );
    expect(css).toContain("html[data-theme='rukiye']");
    expect(css).toContain('--primary: #145c54');
    expect(css).toContain('--primary-hover: #0d4a45');
    expect(css).toContain("html[data-theme='rukiye'][data-mode='dark']");
    expect(css).toContain('--primary: #24766c');
    expect(css).toContain('--brand-accent: #c9a96e');
  });

  it('leaves buttons on the primary token instead of a hard-coded brand hex', () => {
    const button = readFileSync(
      new URL('../components/ui/button.tsx', import.meta.url),
      'utf8'
    );
    expect(button).toContain('bg-primary');
    expect(button).not.toContain('#145C54');
    expect(button).not.toContain('#145c54');
  });
});
