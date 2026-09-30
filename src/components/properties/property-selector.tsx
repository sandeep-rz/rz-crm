'use client';

import { useMemo, useState } from 'react';
import { Building2, Check, ChevronsUpDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  selectedProperty,
  type PropertyOption,
} from '@/lib/properties/property-context';
import { cn } from '@/lib/utils';

export function PropertySelector({
  options,
  value,
  onValueChange,
  loading = false,
}: {
  options: PropertyOption[];
  value: string | null;
  onValueChange: (propertyId: string | null) => void;
  loading?: boolean;
}) {
  const [search, setSearch] = useState('');
  const current = selectedProperty(options, value);
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return options;
    return options.filter((option) =>
      `${option.name} ${option.secondaryLabel ?? ''}`
        .toLocaleLowerCase()
        .includes(term)
    );
  }, [options, search]);

  if (loading || options.length === 0) return null;
  if (options.length === 1) {
    return (
      <div className="border-border/70 bg-card text-foreground inline-flex h-9 max-w-64 items-center gap-2 rounded-xl border px-3 text-sm shadow-sm">
        <Building2 className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{options[0].name}</span>
      </div>
    );
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setSearch('');
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="bg-card h-9 max-w-72 min-w-48 justify-between rounded-xl px-3 font-normal shadow-sm"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <Building2 className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{current?.name ?? 'All Properties'}</span>
        </span>
        <ChevronsUpDown className="text-muted-foreground size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-2 p-2">
        {options.length > 8 && (
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search properties"
              className="h-8 pl-8"
            />
          </div>
        )}
        <div className="max-h-72 overflow-y-auto">
          <PropertyOptionRow
            active={!current}
            label="All Properties"
            onSelect={() => onValueChange(null)}
          />
          <div className="bg-border my-1 h-px" />
          {filtered.map((option) => (
            <PropertyOptionRow
              key={option.id}
              active={current?.id === option.id}
              label={option.name}
              secondary={option.secondaryLabel}
              onSelect={() => onValueChange(option.id)}
            />
          ))}
          {filtered.length === 0 && (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
              No properties found
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PropertyOptionRow({
  active,
  label,
  secondary,
  onSelect,
}: {
  active: boolean;
  label: string;
  secondary?: string | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'hover:bg-muted flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
        active && 'bg-primary/8'
      )}
    >
      <Check
        className={cn('text-primary size-4 shrink-0', !active && 'opacity-0')}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        {secondary && (
          <span className="text-muted-foreground block truncate text-xs">
            {secondary}
          </span>
        )}
      </span>
    </button>
  );
}
