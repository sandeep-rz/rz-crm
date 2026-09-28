import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODE, DEFAULT_THEME, THEMES } from './themes';

describe('Rukiye Zara theme', () => {
  it('defaults to the rukiye accent and light mode', () => {
    expect(DEFAULT_THEME).toBe('rukiye');
    expect(DEFAULT_MODE).toBe('light');
    expect(THEMES[0]).toMatchObject({ id: 'rukiye', swatch: '#0A7EA4' });
  });

  it('keeps the teal primary in the shared stylesheet', () => {
    const css = readFileSync(
      new URL('../app/globals.css', import.meta.url),
      'utf8'
    );
    expect(css).toContain("html[data-theme='rukiye']");
    expect(css).toContain('#0a7ea4');
    expect(css).toContain('--brand-accent: #ccda4e');
  });

  it('leaves buttons on the primary token instead of a hard-coded brand hex', () => {
    const button = readFileSync(
      new URL('../components/ui/button.tsx', import.meta.url),
      'utf8'
    );
    expect(button).toContain('bg-primary');
    expect(button).not.toContain('#0A7EA4');
    expect(button).not.toContain('#0a7ea4');
  });
});
