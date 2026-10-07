'use client';

import {
  MESSAGE_VARIABLE_CATEGORIES,
  MESSAGE_VARIABLE_CATEGORY_LABELS,
} from '@/lib/message-variables/contract';
import type {
  MessageVariableResolutionSource,
  MessageVariableSourceScope,
} from '@/lib/message-variables/contract';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Eye, ImageIcon, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  semanticBroadcastTemplateIssue,
  getBroadcastVariableCapabilities,
  inspectBroadcastVariableSlots,
  mappingIdentity,
  sourceScopeAvailabilityMessage,
} from '@/lib/broadcast-message-variables';
import { renderSemanticText } from '@/lib/whatsapp/semantic-template';
import type { MessageVariableMapping } from '@/lib/message-variables';
import { createClient } from '@/lib/supabase/client';
import type { CustomField, MessageTemplate } from '@/types';
import { useAuth } from '@/hooks/use-auth';

interface CatalogOption {
  variable_key: string;
  label: string;
  category: MessageVariableSourceScope;
  source_scope: MessageVariableSourceScope;
  preview_value: string | null;
  is_sensitive: boolean;
  resolution_source: MessageVariableResolutionSource;
}

interface Step3Props {
  template: MessageTemplate;
  variables: MessageVariableMapping[];
  onUpdate: (variables: MessageVariableMapping[]) => void;
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  onNext,
  onBack,
}: Step3Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { accountId } = useAuth();
  const [catalog, setCatalog] = useState<CatalogOption[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const slots = useMemo(
    () => inspectBroadcastVariableSlots(template),
    [template]
  );
  const capabilities = getBroadcastVariableCapabilities();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!accountId) {
        setCatalog([]);
        setCustomFields([]);
        setLoadingSources(false);
        return;
      }
      setLoadingSources(true);
      const supabase = createClient();
      const [catalogResult, customFieldResult] = await Promise.all([
        supabase
          .from('message_variable_catalog')
          .select(
            'variable_key, label, category, source_scope, resolution_source, preview_value, is_sensitive'
          )
          .eq('is_active', true)
          .order('sort_order'),
        template.variable_configuration_status === 'configured'
          ? Promise.resolve({ data: [] })
          : supabase
              .from('custom_fields')
              .select('*')
              .eq('account_id', accountId)
              .order('field_name'),
      ]);
      if (cancelled) return;
      setCatalog((catalogResult.data as CatalogOption[] | null) ?? []);
      setCustomFields((customFieldResult.data as CustomField[] | null) ?? []);
      setLoadingSources(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, template.variable_configuration_status]);

  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
    // Only seed the approved media once; never overwrite user input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaHeaderType, template.header_media_url]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    return isValidHttpUrl(value) ? null : 'invalid';
  }, [headerMediaUrl, mediaHeaderType]);

  const findMapping = (component: 'header' | 'body', position: number) =>
    variables.find(
      (mapping) =>
        mapping.component === component && mapping.position === position
    );

  const replaceMapping = (mapping: MessageVariableMapping) => {
    onUpdate(
      variables
        .filter(
          (candidate) => mappingIdentity(candidate) !== mappingIdentity(mapping)
        )
        .concat(mapping)
        .sort((left, right) =>
          left.component === right.component
            ? left.position - right.position
            : left.component === 'header'
              ? -1
              : 1
        )
    );
  };

  const removeMapping = (component: 'header' | 'body', position: number) => {
    onUpdate(
      variables.filter(
        (mapping) =>
          mapping.component !== component || mapping.position !== position
      )
    );
  };

  const mappingValue = (mapping: MessageVariableMapping | undefined) => {
    if (!mapping) return '';
    if (mapping.source_type === 'catalog_variable') {
      return `catalog:${mapping.variable_key}`;
    }
    if (mapping.source_type === 'custom_field') {
      return `custom:${mapping.custom_field_id}`;
    }
    return 'static';
  };

  const incompleteSlots = slots.filter((slot) => {
    const mapping = findMapping(slot.component, slot.position);
    return (
      !mapping ||
      (mapping.source_type === 'static' && !mapping.static_value.trim())
    );
  });

  const previewValue = (mapping: MessageVariableMapping | undefined) => {
    if (!mapping) return null;
    if (mapping.source_type === 'static') return mapping.static_value || null;
    if (mapping.source_type === 'custom_field') {
      const field = customFields.find(
        (candidate) => candidate.id === mapping.custom_field_id
      );
      return field ? `[${field.field_name}]` : null;
    }
    const definition = catalog.find(
      (candidate) => candidate.variable_key === mapping.variable_key
    );
    if (!definition) return null;
    return definition.is_sensitive
      ? '••••••'
      : definition.preview_value || `[${definition.label}]`;
  };

  const renderPreview = (text: string, component: 'header' | 'body') => {
    let preview = text;
    for (const slot of slots.filter(
      (candidate) => candidate.component === component
    )) {
      const replacement = previewValue(findMapping(component, slot.position));
      if (replacement) {
        preview = preview.replaceAll(`{{${slot.position}}}`, replacement);
      }
    }
    return preview;
  };

  if (template.variable_configuration_status === 'configured') {
    const definitions = catalog.map((v, i) => ({
      variableKey: v.variable_key,
      label: v.label,
      previewValue: v.preview_value,
      category: v.category,
      sourceScope: v.source_scope,
      resolutionSource: v.resolution_source,
      isActive: true,
      sortOrder: i,
    }));
    const issue = semanticBroadcastTemplateIssue(template, definitions);
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-foreground text-lg font-semibold">
            {t('personalize.title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Contact and workspace information is filled automatically for each
            recipient when sent.
          </p>
        </div>
        <div className="border-border bg-card/50 rounded-xl border p-4">
          {template.semantic_content?.header_content ? (
            <p className="text-sm font-medium">
              {renderSemanticText(
                template.semantic_content.header_content,
                definitions,
                'label'
              )}
            </p>
          ) : null}
          <p className="text-sm whitespace-pre-wrap">
            {renderSemanticText(
              template.semantic_content?.body_text ?? '',
              definitions,
              'label'
            )}
          </p>
        </div>
        {issue ? (
          <p role="alert" className="text-destructive text-sm">
            {issue}
          </p>
        ) : null}
        <div className="border-border flex justify-between border-t pt-4">
          <Button variant="outline" onClick={onBack}>
            {t('back')}
          </Button>
          <Button onClick={onNext} disabled={loadingSources || Boolean(issue)}>
            {t('next')}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('personalize.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Contact and workspace values are available for this contact-based
          audience.
        </p>
      </div>

      {mediaHeaderType && (
        <div className="border-border bg-card/50 rounded-xl border p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="text-primary h-4 w-4" />
            <p className="text-foreground text-sm font-medium">
              {t('personalize.headerImage')}
            </p>
            <span className="bg-primary/10 text-primary rounded-md px-2 py-0.5 text-xs font-medium uppercase">
              {mediaHeaderType}
            </span>
          </div>
          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(event) => onHeaderMediaUrlChange(event.target.value)}
            placeholder={t('personalize.imageUrlPlaceholder')}
          />
          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-300">
              {headerMediaError === 'missing'
                ? t('personalize.mediaUrlRequired')
                : t('personalize.mediaUrlInvalid')}
            </p>
          )}
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt={t('personalize.headerPreviewAlt')}
                className="border-border mt-3 max-h-40 rounded-lg border object-contain"
              />
            )}
        </div>
      )}

      {slots.length > 0 && (
        <div className="space-y-4">
          {slots.map((slot) => {
            const mapping = findMapping(slot.component, slot.position);
            return (
              <div
                key={mappingIdentity(slot)}
                className="border-border bg-card/50 rounded-xl border p-4"
              >
                <label className="text-foreground mb-2 block text-sm font-medium">
                  {slot.component.toUpperCase()} {'{{'}
                  {slot.position}
                  {'}}'}
                </label>
                <select
                  value={mappingValue(mapping)}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) removeMapping(slot.component, slot.position);
                    else if (value === 'static') {
                      replaceMapping({
                        component: slot.component,
                        position: slot.position,
                        source_type: 'static',
                        static_value: '',
                      });
                    } else if (value.startsWith('custom:')) {
                      replaceMapping({
                        component: slot.component,
                        position: slot.position,
                        source_type: 'custom_field',
                        custom_field_id: value.slice('custom:'.length),
                      });
                    } else if (value.startsWith('catalog:')) {
                      replaceMapping({
                        component: slot.component,
                        position: slot.position,
                        source_type: 'catalog_variable',
                        variable_key: value.slice('catalog:'.length),
                      });
                    }
                  }}
                  className="border-border bg-muted text-foreground h-10 w-full rounded-md border px-3 text-sm"
                >
                  <option value="">
                    {loadingSources ? 'Loading variables…' : 'Select a value…'}
                  </option>
                  {MESSAGE_VARIABLE_CATEGORIES.map((category) => {
                    const options = catalog.filter(
                      (definition) => definition.category === category
                    );
                    return options.length ? (
                      <optgroup
                        key={category}
                        label={MESSAGE_VARIABLE_CATEGORY_LABELS[category]}
                      >
                        {options.map((definition) => {
                          const available =
                            definition.resolution_source !== 'provider' &&
                            capabilities[definition.source_scope];
                          return (
                            <option
                              key={definition.variable_key}
                              value={`catalog:${definition.variable_key}`}
                              disabled={!available}
                            >
                              {definition.label}
                              {!available
                                ? definition.resolution_source === 'provider'
                                  ? ' — not available yet'
                                  : ` — ${sourceScopeAvailabilityMessage(definition.source_scope)}`
                                : ''}
                            </option>
                          );
                        })}
                      </optgroup>
                    ) : null;
                  })}
                  {customFields.length > 0 && (
                    <optgroup label="CUSTOM FIELDS">
                      {customFields.map((field) => (
                        <option key={field.id} value={`custom:${field.id}`}>
                          {field.field_name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="OTHER">
                    <option value="static">Static value</option>
                  </optgroup>
                </select>
                {mapping?.source_type === 'static' && (
                  <Input
                    className="mt-2"
                    value={mapping.static_value}
                    placeholder={t('personalize.enterValue')}
                    onChange={(event) =>
                      replaceMapping({
                        ...mapping,
                        static_value: event.target.value,
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="border-border bg-card/50 rounded-xl border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="text-primary h-4 w-4" />
          <p className="text-foreground text-sm font-medium">
            {t('personalize.preview')}
          </p>
          {loadingSources && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span className="text-muted-foreground text-xs">
            (safe sample values)
          </span>
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="bg-primary/30 ml-auto max-w-[85%] rounded-lg px-3 py-2">
            {template.header_type === 'text' && template.header_content && (
              <p className="text-primary mb-1 text-sm font-semibold">
                {renderPreview(template.header_content, 'header')}
              </p>
            )}
            <p className="text-primary text-sm whitespace-pre-wrap">
              {renderPreview(template.body_text, 'body')}
            </p>
          </div>
        </div>
      </div>

      {incompleteSlots.length > 0 && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Map every required template variable before continuing.
        </p>
      )}

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={incompleteSlots.length > 0 || headerMediaError !== null}
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
