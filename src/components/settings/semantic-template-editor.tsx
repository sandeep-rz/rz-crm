'use client';
import { useEffect, useRef, useState, useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  filterVariables,
  VariablePicker,
  VariableAutocomplete,
} from './semantic-variable-picker';
import {
  semanticSegments,
  renderSemanticText,
  type CatalogVariable,
} from '@/lib/whatsapp/semantic-template';

export function autocompleteTrigger(
  range: Range
): { range: Range; query: string } | null {
  if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE)
    return null;
  const before = (range.startContainer.textContent ?? '').slice(
    0,
    range.startOffset
  );
  const match = /(?<!\{)\{\{([^{}\n]*)$/.exec(before);
  if (!match) return null;
  const replacement = range.cloneRange();
  replacement.setStart(range.startContainer, match.index);
  if (
    (range.startContainer.textContent ?? '')
      .slice(range.startOffset)
      .startsWith('}}')
  )
    replacement.setEnd(range.startContainer, range.startOffset + 2);
  return { range: replacement, query: match[1] };
}

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
  placeholder = '',
}: {
  value: string;
  onChange: (value: string) => void;
  catalog: CatalogVariable[];
  label: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<{
    range: Range;
    query: string;
    top: number;
    left: number;
  } | null>(null);
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const suggestions = filterVariables(catalog, suggestion?.query ?? '');
  const cursor = useRef<Range | null>(null);
  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    if (readSemanticEditor(element) === value) {
      // Update catalog labels in place without disturbing the caret or identities.
      element
        .querySelectorAll<HTMLElement>('[data-variable-key]')
        .forEach((chip) => {
          chip.textContent = renderSemanticText(
            `{{${chip.dataset.variableKey}}}`,
            catalog,
            'label'
          );
        });
      return;
    }
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
  const detectSuggestion = () => {
    remember();
    const trigger = cursor.current && autocompleteTrigger(cursor.current);
    if (!trigger) {
      setSuggestion(null);
      return;
    }
    const rect = cursor.current?.getBoundingClientRect?.();
    const bounds = wrapper.current?.getBoundingClientRect();
    const fallback = editor.current?.getBoundingClientRect();
    setSuggestion({
      ...trigger,
      top: rect?.height
        ? rect.bottom - (bounds?.top ?? 0) + 4
        : (fallback?.height ?? 40) + 4,
      left: Math.max(
        0,
        Math.min(
          rect?.height ? rect.left - (bounds?.left ?? 0) : 0,
          (bounds?.width ?? 320) - 320
        )
      ),
    });
    setSelected(0);
  };
  const selectVariable = (variable: CatalogVariable) => {
    if (suggestion) cursor.current = suggestion.range;
    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.dataset.variableKey = variable.variableKey;
    chip.textContent = `{{${variable.label}}}`;
    chip.className = 'rounded bg-primary/10 px-1 text-primary';
    setSuggestion(null);
    insert(chip);
  };
  const restoreCaret = () => {
    editor.current?.focus();
    if (
      cursor.current &&
      editor.current?.contains(cursor.current.startContainer)
    ) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(cursor.current);
    }
  };
  return (
    <div ref={wrapper} className="relative space-y-2">
      <div
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline={multiline}
        aria-autocomplete="list"
        aria-controls={suggestion ? listId : undefined}
        aria-haspopup="listbox"
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        data-empty={!value.trim()}
        aria-activedescendant={
          suggestion && suggestions.length ? `${listId}-${selected}` : undefined
        }
        className={`border-border bg-muted text-foreground before:text-muted-foreground relative rounded-md border px-3 py-2 text-sm whitespace-pre-wrap before:pointer-events-none before:absolute before:inset-x-3 before:top-2 data-[empty=true]:before:content-[attr(data-placeholder)] ${multiline ? 'min-h-28' : 'min-h-10'}`}
        onInput={() => {
          detectSuggestion();
          if (editor.current) onChange(readSemanticEditor(editor.current));
        }}
        onKeyUp={(event) => {
          remember();
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            detectSuggestion();
        }}
        onMouseUp={() => {
          remember();
          setSuggestion(null);
        }}
        onBlur={() => {
          remember();
          setSuggestion(null);
        }}
        onKeyDown={(event) => {
          if (suggestion) {
            if (event.key === 'Escape') {
              event.preventDefault();
              setSuggestion(null);
              return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((index) =>
                suggestions.length
                  ? (index +
                      (event.key === 'ArrowDown' ? 1 : -1) +
                      suggestions.length) %
                    suggestions.length
                  : 0
              );
              return;
            }
            if (
              (event.key === 'Enter' || event.key === 'Tab') &&
              suggestions[selected]
            ) {
              event.preventDefault();
              selectVariable(suggestions[selected]);
              return;
            }
          }
          if (event.key === 'Backspace' || event.key === 'Delete') {
            remember();
            const range = cursor.current;
            if (range?.collapsed) {
              const container = range.startContainer;
              const backwards = event.key === 'Backspace';
              const adjacent =
                container.nodeType === Node.TEXT_NODE
                  ? range.startOffset ===
                    (backwards ? 0 : (container.textContent?.length ?? 0))
                    ? backwards
                      ? container.previousSibling
                      : container.nextSibling
                    : null
                  : container.childNodes[
                      range.startOffset + (backwards ? -1 : 0)
                    ];
              if (
                adjacent instanceof HTMLElement &&
                adjacent.dataset.variableKey
              ) {
                event.preventDefault();
                adjacent.remove();
                setSuggestion(null);
                if (editor.current)
                  onChange(readSemanticEditor(editor.current));
                remember();
                return;
              }
            }
          }
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
          insert(
            document.createTextNode(event.clipboardData.getData('text/plain'))
          );
        }}
        onDrop={(event) => event.preventDefault()}
      />
      {suggestion && (
        <VariableAutocomplete
          variables={suggestions}
          selected={selected}
          id={listId}
          position={{ top: suggestion.top, left: suggestion.left }}
          onSelect={selectVariable}
        />
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onMouseDown={remember}
        onFocus={remember}
        onClick={() => {
          setSuggestion(null);
          setPickerOpen(true);
        }}
      >
        + Insert variable
      </Button>
      <VariablePicker
        open={pickerOpen}
        catalog={catalog}
        editorRef={editor}
        onSelect={selectVariable}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) requestAnimationFrame(restoreCaret);
        }}
      />
      <p className="text-muted-foreground text-xs whitespace-pre-wrap">
        Preview: {renderSemanticText(value, catalog, 'preview')}
      </p>
    </div>
  );
}
