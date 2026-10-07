'use client';
import Link from 'next/link';
import {
  variableRequiresReservation,
  type MessageVariableSourceScope,
  type MessageVariableResolutionSource,
} from '@/lib/message-variables/contract';
import type { MessageTemplate } from '@/types';
import {
  renderSemanticText,
  type CatalogVariable,
} from '@/lib/whatsapp/semantic-template';
import {
  selectSemanticTemplateAction,
  semanticTemplateIsUsable,
} from '@/lib/automations/semantic-template-action';

/** Read-only template semantics. No runtime imports, positional pickers, or preview-value persistence. */
export function SendTemplateFields({
  config,
  templates,
  catalog,
  connectionId,
  reservationAvailable = true,
  onChange,
  labels,
}: {
  config: Record<string, unknown>;
  templates: MessageTemplate[];
  catalog: (CatalogVariable & {
    sourceScope?: MessageVariableSourceScope;
    resolutionSource?: MessageVariableResolutionSource;
  })[];
  reservationAvailable?: boolean;
  connectionId?: string | null;
  onChange: (config: Record<string, unknown>) => void;
  labels: { template: string; select: string };
}) {
  const selected = config.template_id
    ? templates.find((t) => t.id === config.template_id)
    : templates.find(
        (t) =>
          t.name === config.template_name &&
          (t.language ?? 'en_US') === (config.language ?? 'en_US')
      );
  const needsReservation = (template: MessageTemplate) =>
    template.semantic_variable_mapping?.some((entry) =>
      variableRequiresReservation(
        catalog.find((v) => v.variableKey === entry.variable_key)
      )
    );
  const incompatible =
    selected && !reservationAvailable && needsReservation(selected);
  const usable = selected && semanticTemplateIsUsable(selected, connectionId);
  const semantic = usable ? selected.semantic_content : null;
  return (
    <div className="space-y-2">
      <label className="text-muted-foreground block text-[11px] font-medium">
        {labels.template}
        <select
          aria-label={labels.template}
          value={selected?.id ?? ''}
          onChange={(e) =>
            onChange(
              selectSemanticTemplateAction(
                config,
                templates.find((t) => t.id === e.target.value)
              )
            )
          }
          className="border-border bg-muted text-foreground mt-1 h-9 w-full rounded-md border px-3 text-sm"
        >
          <option value="">{labels.select}</option>
          {templates.map((template) => (
            <option
              key={template.id}
              value={template.id}
              disabled={
                !semanticTemplateIsUsable(template, connectionId) ||
                (!reservationAvailable && Boolean(needsReservation(template)))
              }
            >
              {template.name} ({template.language ?? ''})
            </option>
          ))}
          {!selected && (config.template_id || config.template_name) ? (
            <option value="" disabled>
              Selected template is unavailable
            </option>
          ) : null}
        </select>
      </label>
      {incompatible ? (
        <p role="alert" className="text-destructive text-xs">
          This template needs a reservation. Choose a reservation trigger or a
          template using contact and workspace information.
        </p>
      ) : null}
      {semantic && selected ? (
        <div className="border-border bg-muted/40 space-y-2 rounded-lg border p-3">
          <p className="text-muted-foreground text-[11px] font-medium uppercase">
            Template preview
          </p>
          {selected.header_type === 'text' && semantic.header_content ? (
            <p className="text-foreground text-xs font-medium">
              {renderSemanticText(semantic.header_content, catalog, 'label')}
            </p>
          ) : null}
          <p className="text-foreground text-xs whitespace-pre-wrap">
            {renderSemanticText(semantic.body_text, catalog, 'label')}
          </p>
          {Object.entries(semantic.button_urls ?? {}).map(([index, url]) => (
            <p key={index} className="text-muted-foreground text-xs break-all">
              {selected.buttons?.[Number(index)]?.text}:{' '}
              {renderSemanticText(url, catalog, 'label')}
            </p>
          ))}
        </div>
      ) : selected ? (
        <p className="text-muted-foreground text-xs">
          {selected.variable_configuration_status === 'needs_mapping'
            ? "This template's variables need to be configured before it can be used."
            : 'This template is not available for the selected WhatsApp connection.'}
        </p>
      ) : null}
      <Link
        href="/settings?tab=templates"
        className="text-primary text-xs underline"
      >
        Manage message templates
      </Link>
    </div>
  );
}
