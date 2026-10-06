'use client';

import { useState } from 'react';
import type { CatalogVariable } from '@/lib/whatsapp/semantic-template';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Both entry points search the live catalog; there is no frontend variable dictionary. */
export function filterVariables(catalog: CatalogVariable[], query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return catalog
    .filter(
      (v) =>
        v.isActive &&
        words.every((word) =>
          `${v.label} ${v.variableKey} ${v.category}`
            .toLocaleLowerCase()
            .includes(word)
        )
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
export function groupVariables(variables: CatalogVariable[]) {
  const groups = new Map<string, CatalogVariable[]>();
  for (const variable of variables) {
    const group = groups.get(variable.category) ?? [];
    group.push(variable);
    groups.set(variable.category, group);
  }
  return [...groups.entries()];
}
export const categoryHeading = (category: string) =>
  category.charAt(0).toUpperCase() + category.slice(1);

export function VariablePicker({
  open,
  onOpenChange,
  catalog,
  onSelect,
  editorRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: CatalogVariable[];
  onSelect: (variable: CatalogVariable) => void;
  editorRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [search, setSearch] = useState('');
  const groups = groupVariables(filterVariables(catalog, search));
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) setSearch('');
      }}
    >
      <DialogContent className="sm:max-w-xl" finalFocus={editorRef}>
        <DialogHeader>
          <DialogTitle>Add variable</DialogTitle>
          <DialogDescription>
            Add personalised booking, guest, property and listing details to
            this template.
          </DialogDescription>
        </DialogHeader>
        <input
          aria-label="Search variables"
          placeholder="Search variables"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border-border bg-background rounded-md border px-3 py-2"
        />
        <div
          className="max-h-[55vh] space-y-5 overflow-y-auto"
          aria-label="Variable groups"
        >
          {groups.map(([category, variables]) => (
            <section key={category} aria-label={categoryHeading(category)}>
              <h3 className="mb-2 font-medium">{categoryHeading(category)}</h3>
              <div className="flex flex-wrap gap-2">
                {variables.map((variable) => (
                  <Button
                    key={variable.variableKey}
                    type="button"
                    variant="outline"
                    size="sm"
                    title={variable.description ?? undefined}
                    onClick={() => {
                      onSelect(variable);
                      onOpenChange(false);
                      setSearch('');
                    }}
                  >
                    {variable.label}
                  </Button>
                ))}
              </div>
            </section>
          ))}
          {!groups.length && (
            <p className="text-muted-foreground py-4">No variables found.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function VariableAutocomplete({
  variables,
  selected,
  id,
  position,
  onSelect,
}: {
  variables: CatalogVariable[];
  selected: number;
  id: string;
  position: { top: number; left: number };
  onSelect: (variable: CatalogVariable) => void;
}) {
  return (
    <div
      className="bg-popover text-popover-foreground absolute z-50 w-80 max-w-full rounded-lg border p-2 shadow-lg"
      style={position}
    >
      <p className="text-muted-foreground px-2 pb-2 text-xs">
        Search variables… Type to filter
      </p>
      <div
        id={id}
        role="listbox"
        aria-label="Variable suggestions"
        className="max-h-64 overflow-y-auto"
      >
        {groupVariables(variables).map(([category, entries]) => (
          <div
            key={category}
            role="group"
            aria-label={categoryHeading(category)}
          >
            <div className="text-muted-foreground px-2 pt-2 text-xs font-medium">
              {categoryHeading(category)}
            </div>
            {entries.map((variable) => {
              const index = variables.indexOf(variable);
              return (
                <div
                  key={variable.variableKey}
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  ref={(node) => {
                    if (index === selected)
                      node?.scrollIntoView?.({ block: 'nearest' });
                  }}
                  className={`cursor-pointer rounded px-2 py-2 text-sm ${index === selected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelect(variable)}
                  title={variable.description ?? undefined}
                >
                  {variable.label}
                </div>
              );
            })}
          </div>
        ))}
        {!variables.length && (
          <p className="text-muted-foreground px-2 py-3 text-sm">
            No variables found.
          </p>
        )}
      </div>
    </div>
  );
}

/** Imported Meta slots reuse the same picker without semantic authoring state. */
export function VariableSelection({
  catalog,
  value,
  label,
  onChange,
}: {
  catalog: CatalogVariable[];
  value: string;
  label: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        {catalog.find((variable) => variable.variableKey === value)?.label ??
          'Select a variable'}
      </Button>
      <VariablePicker
        open={open}
        onOpenChange={setOpen}
        catalog={catalog}
        onSelect={(variable) => onChange(variable.variableKey)}
      />
    </>
  );
}
