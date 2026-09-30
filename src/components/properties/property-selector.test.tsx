import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PropertySelector } from './property-selector';
import type { PropertyOption } from '@/lib/properties/property-context';

const one: PropertyOption = {
  id: 'canonical-property-id',
  name: 'Lakeside Meadows',
  secondaryLabel: null,
  status: 'active',
  initialSyncStatus: 'completed',
};

describe('PropertySelector', () => {
  it('renders nothing for a zero-property workspace', () => {
    expect(
      renderToStaticMarkup(
        <PropertySelector
          options={[]}
          value={null}
          onValueChange={() => undefined}
        />
      )
    ).toBe('');
  });

  it('renders a clean non-interactive label for one property', () => {
    const html = renderToStaticMarkup(
      <PropertySelector
        options={[one]}
        value={null}
        onValueChange={() => undefined}
      />
    );
    expect(html).toContain('Lakeside Meadows');
    expect(html).not.toContain('canonical-property-id');
    expect(html).not.toContain('button');
  });
});
