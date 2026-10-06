'use client';
import { useEffect, useRef } from 'react';
import {
  semanticSegments,
  renderSemanticText,
  type CatalogVariable,
} from '@/lib/whatsapp/semantic-template';

/** Canonical tokens are non-editable DOM chips; labels are never serialized. */
export function readSemanticEditor(root: Node): string {
  if (root instanceof HTMLElement && root.dataset.variableKey)
    return `{{${root.dataset.variableKey}}}`;
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? '';
  if (root instanceof HTMLBRElement) return '\n';
  return Array.from(root.childNodes)
    .map((child, index) => {
      const block =
        child instanceof HTMLElement && ['DIV', 'P'].includes(child.tagName);
      return (block && index > 0 ? '\n' : '') + readSemanticEditor(child);
    })
    .join('');
}
export function SemanticTemplateEditor({
  value,
  onChange,
  catalog,
  label,
  multiline = false,
}: {
  value: string;
  onChange: (value: string) => void;
  catalog: CatalogVariable[];
  label: string;
  multiline?: boolean;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const cursor = useRef<Range | null>(null);
  const lastCatalog = useRef<CatalogVariable[]>([]);
  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    if (
      readSemanticEditor(element) === value &&
      lastCatalog.current === catalog
    )
      return;
    lastCatalog.current = catalog;
    element.replaceChildren();
    for (const segment of semanticSegments(value)) {
      if (!segment.variableKey)
        element.append(document.createTextNode(segment.text));
      else {
        const chip = document.createElement('span');
        chip.contentEditable = 'false';
        chip.dataset.variableKey = segment.variableKey;
        chip.textContent = renderSemanticText(segment.text, catalog, 'label');
        chip.className = 'rounded bg-primary/10 px-1 text-primary';
        element.append(chip);
      }
    }
    cursor.current = null;
  }, [value, catalog]);
  const remember = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.current?.contains(selection.anchorNode))
      cursor.current = selection.getRangeAt(0).cloneRange();
  };
  const insert = (node: Node) => {
    const element = editor.current;
    if (!element) return;
    element.focus();
    const range =
      cursor.current && element.contains(cursor.current.startContainer)
        ? cursor.current
        : document.createRange();
    if (!cursor.current || !element.contains(range.startContainer)) {
      range.selectNodeContents(element);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    cursor.current = range.cloneRange();
    onChange(readSemanticEditor(element));
  };
  const groups = [
    ...new Set(
      catalog
        .filter((v) => v.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((v) => v.category)
    ),
  ];
  return (
    <div className="space-y-2">
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline={multiline}
        className={`border-border bg-muted text-foreground rounded-md border px-3 py-2 text-sm whitespace-pre-wrap ${multiline ? 'min-h-28' : 'min-h-10'}`}
        onInput={() => {
          remember();
          if (editor.current) onChange(readSemanticEditor(editor.current));
        }}
        onKeyUp={remember}
        onMouseUp={remember}
        onBlur={remember}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (multiline) {
              remember();
              insert(document.createTextNode('\n'));
            }
          }
        }}
        onCopy={(event) => {
          const selection = window.getSelection();
          if (selection?.rangeCount) {
            event.preventDefault();
            event.clipboardData.setData(
              'text/plain',
              readSemanticEditor(selection.getRangeAt(0).cloneContents())
            );
          }
        }}
        onCut={(event) => {
          const selection = window.getSelection();
          if (selection?.rangeCount) {
            event.preventDefault();
            const range = selection.getRangeAt(0);
            event.clipboardData.setData(
              'text/plain',
              readSemanticEditor(range.cloneContents())
            );
            range.deleteContents();
            if (editor.current) onChange(readSemanticEditor(editor.current));
            remember();
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          remember();
          lastCatalog.current = [];
          insert(
            document.createTextNode(event.clipboardData.getData('text/plain'))
          );
        }}
        onDrop={(event) => event.preventDefault()}
      />
      <select
        aria-label={`Insert variable into ${label}`}
        value=""
        className="border-border bg-background rounded-md border px-2 py-1 text-sm"
        onMouseDown={remember}
        onChange={(event) => {
          const variable = catalog.find(
            (v) => v.variableKey === event.target.value && v.isActive
          );
          if (!variable) return;
          const chip = document.createElement('span');
          chip.contentEditable = 'false';
          chip.dataset.variableKey = variable.variableKey;
          chip.textContent = `{{${variable.label}}}`;
          chip.className = 'rounded bg-primary/10 px-1 text-primary';
          insert(chip);
        }}
      >
        <option value="">Insert variable</option>
        {groups.map((category) => (
          <optgroup
            key={category}
            label={category.charAt(0).toUpperCase() + category.slice(1)}
          >
            {catalog
              .filter((v) => v.category === category && v.isActive)
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((v) => (
                <option key={v.variableKey} value={v.variableKey}>
                  {v.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <p className="text-muted-foreground text-xs whitespace-pre-wrap">
        Preview: {renderSemanticText(value, catalog, 'preview')}
      </p>
    </div>
  );
}
