'use client';
import { useWhatsAppCapability } from '@/hooks/use-whatsapp-capability';
import {
  variableRequiresReservation,
  type MessageVariableSourceScope,
} from '@/lib/message-variables/contract';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, ChevronRight, LayoutTemplate, Loader2 } from 'lucide-react';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { useLocale, useTranslations } from 'next-intl';
import {
  renderSemanticText,
  type CatalogVariable,
} from '@/lib/whatsapp/semantic-template';
import type { MessageVariableResolutionSource } from '@/lib/message-variables/contract';
import {
  loadContactStays,
  formatStayDateShort,
  type ContactStay,
  type StayReadClient,
} from '@/lib/contacts/pms-stays';
import { useAuth } from '@/hooks/use-auth';
import { validatePreparationMapping } from '@/lib/message-preparation/mapping';

export interface TemplateSendValues {
  body: string[];
  reservationId?: string;
  headerText?: string;
  buttonParams?: Record<number, string>;
}

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
  whatsappConfigId?: string | null;
  contactId?: string | null;
}

function renderBodyPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

/**
 * Templates may need values for: body variables, a text-header
 * variable, and per-URL-button suffixes. Collect them all so the
 * send-message path doesn't 400 on missing parameters.
 */
function collectVariableSlots(template: MessageTemplate): {
  bodyVars: number[];
  headerVarCount: number;
  urlButtonSlots: UrlButtonSlot[];
} {
  const bodyVars = extractVariableIndices(template.body_text);
  const headerVarCount =
    template.header_type === 'text' && template.header_content
      ? extractVariableIndices(template.header_content).length
      : 0;
  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === 'URL' && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });
  return { bodyVars, headerVarCount, urlButtonSlots };
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
  whatsappConfigId,
  contactId,
}: TemplatePickerProps) {
  const t = useTranslations('Inbox.templatePicker');
  const { accountId } = useAuth();
  const locale = useLocale();
  const [catalog, setCatalog] = useState<
    (CatalogVariable & {
      resolutionSource: MessageVariableResolutionSource;
      sourceScope: MessageVariableSourceScope;
    })[]
  >([]);
  const [catalogError, setCatalogError] = useState(false);
  const [stays, setStays] = useState<ContactStay[]>([]);
  const [staysLoading, setStaysLoading] = useState(false);
  const [staysError, setStaysError] = useState(false);
  const [reservationId, setReservationId] = useState('');

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const whatsapp = useWhatsAppCapability();
  const fallbackConnectionId = whatsapp.primaryConnection?.id ?? null;
  const [headerText, setHeaderText] = useState<string>('');
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open || (!whatsappConfigId && whatsapp.loading)) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user || !accountId) {
        if (!cancelled) {
          setTemplates([]);
          setLoading(false);
        }
        return;
      }

      // Templates are workspace-owned. Filter by the active workspace rather
      // than creator user_id (which would hide teammate-created templates).
      const connectionId = whatsappConfigId || fallbackConnectionId;
      let query = supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('status', 'APPROVED');
      if (connectionId) query = query.eq('whatsapp_config_id', connectionId);
      const [{ data, error }, definitions] = await Promise.all([
        query.order('created_at', { ascending: false }),
        supabase
          .from('message_variable_catalog')
          .select(
            'variable_key,label,preview_value,is_active,category,sort_order,resolution_source,source_scope'
          )
          .eq('is_active', true)
          .order('sort_order'),
      ]);
      if (!cancelled) {
        setCatalogError(Boolean(definitions.error));
        setCatalog(
          (definitions.data ?? []).map((row) => ({
            variableKey: row.variable_key,
            label: row.label,
            previewValue: row.preview_value,
            isActive: row.is_active,
            category: row.category,
            sortOrder: row.sort_order,
            resolutionSource: row.resolution_source,
            sourceScope: row.source_scope,
          }))
        );
      }

      if (cancelled) return;
      if (error) {
        console.error('Failed to fetch templates:', error);
        setTemplates([]);
      } else {
        setTemplates((data as MessageTemplate[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    accountId,
    open,
    whatsappConfigId,
    fallbackConnectionId,
    whatsapp.loading,
  ]);

  const semantic = selected?.variable_configuration_status === 'configured';
  const mapping = useMemo(() => {
    if (!semantic || !selected) return null;
    try {
      return validatePreparationMapping(selected);
    } catch {
      return null;
    }
  }, [semantic, selected]);
  const catalogUnavailable =
    catalogError ||
    Boolean(
      mapping?.some(
        (entry) =>
          !catalog.some(
            (definition) => definition.variableKey === entry.variable_key
          )
      )
    );
  // Catalog source semantics, not a second variable classification map.
  const requiresReservation = Boolean(
    semantic &&
    !catalogUnavailable &&
    mapping?.some((entry) =>
      variableRequiresReservation(
        catalog.find(
          (definition) => definition.variableKey === entry.variable_key
        )
      )
    )
  );
  useEffect(() => {
    if (!open || !requiresReservation) return;
    let cancelled = false;
    void (async () => {
      setReservationId('');
      setStays([]);
      setStaysError(false);
      if (!accountId || !contactId) {
        setStaysError(true);
        setStaysLoading(false);
        return;
      }
      setStaysLoading(true);
      try {
        const rows = await loadContactStays(
          createClient() as unknown as StayReadClient,
          { accountId, contactId }
        );
        if (cancelled) return;
        setStays(rows);
        const relevant = rows.filter((stay) =>
          ['current', 'upcoming'].includes(stay.timing)
        );
        const only =
          relevant.length === 1
            ? relevant[0]
            : rows.length === 1 && rows[0].timing !== 'cancelled'
              ? rows[0]
              : undefined;
        setReservationId(only?.id ?? '');
      } catch {
        if (!cancelled) setStaysError(true);
      } finally {
        if (!cancelled) setStaysLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, contactId, requiresReservation]);

  function resetSelection() {
    setSelected(null);
    setReservationId('');
    setParams([]);
    setHeaderText('');
    setButtonParams({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSelection();
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    if (template.variable_configuration_status === 'configured') {
      setSelected(template);
      setParams([]);
      setHeaderText('');
      setButtonParams({});
      return;
    }
    const slots = collectVariableSlots(template);
    const noInputsNeeded =
      slots.bodyVars.length === 0 &&
      slots.headerVarCount === 0 &&
      slots.urlButtonSlots.length === 0;
    if (noInputsNeeded) {
      onSelect(template, { body: [] });
      handleOpenChange(false);
      return;
    }
    setSelected(template);
    setParams(new Array(slots.bodyVars.length).fill(''));
    setHeaderText('');
    setButtonParams({});
  }

  function confirm() {
    if (!selected || !canConfirm) return;
    if (semantic) {
      onSelect(selected, {
        body: [],
        ...(requiresReservation ? { reservationId } : {}),
      });
      handleOpenChange(false);
      return;
    }
    const values: TemplateSendValues = { body: params };
    if (headerText.trim()) values.headerText = headerText.trim();
    if (Object.keys(buttonParams).length > 0) {
      values.buttonParams = Object.fromEntries(
        Object.entries(buttonParams).map(([k, v]) => [Number(k), v.trim()])
      );
    }
    onSelect(selected, values);
    handleOpenChange(false);
  }

  const slots = useMemo(
    () => (selected ? collectVariableSlots(selected) : null),
    [selected]
  );
  const canConfirm = semantic
    ? mapping !== null &&
      !catalogUnavailable &&
      (!requiresReservation ||
        (!!reservationId && !staysLoading && !staysError))
    : !!selected &&
      !!slots &&
      slots.bodyVars.every((_, i) => (params[i] ?? '').trim().length > 0) &&
      (slots.headerVarCount === 0 || headerText.trim().length > 0) &&
      slots.urlButtonSlots.every(
        (s) => (buttonParams[s.index] ?? '').trim().length > 0
      );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground flex items-center gap-2">
            <LayoutTemplate className="text-primary h-4 w-4" />
            {selected ? selected.name : t('sendTemplate')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected
              ? semantic
                ? t('semanticHint')
                : t('fillPlaceholders')
              : t('pickTemplate')}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-primary h-5 w-5 animate-spin" />
              </div>
            ) : templates.length === 0 ? (
              <div className="border-border bg-background/50 rounded-md border p-6 text-center">
                <p className="text-popover-foreground text-sm">
                  {t('noApprovedTemplates')}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('noApprovedTemplatesHint')}
                </p>
              </div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="border-border bg-background/50 hover:border-primary/40 hover:bg-popover w-full rounded-md border p-3 text-left transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-popover-foreground truncate text-sm font-medium">
                          {t.name}
                        </p>
                        <Badge className="border-primary/30 bg-primary/20 text-primary border text-[10px]">
                          {t.category}
                        </Badge>
                        {t.language && (
                          <span className="text-muted-foreground text-[10px] uppercase">
                            {t.language}
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                        {t.variable_configuration_status === 'configured' &&
                        t.semantic_content
                          ? renderSemanticText(
                              t.semantic_content.body_text,
                              catalog,
                              'label'
                            )
                          : t.body_text}
                      </p>
                    </div>
                    <ChevronRight className="text-muted-foreground h-4 w-4 flex-shrink-0" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="border-border bg-background/50 rounded-md border p-3">
              <p className="text-muted-foreground mb-1 text-xs">
                {t('preview')}
              </p>
              {semantic && (
                <p className="text-muted-foreground mb-2 text-xs">
                  {t('previewHint')}
                </p>
              )}
              <p className="text-popover-foreground text-sm whitespace-pre-wrap">
                {semantic && selected.semantic_content
                  ? renderSemanticText(
                      selected.semantic_content.body_text,
                      catalog,
                      'label'
                    )
                  : renderBodyPreview(selected.body_text, params)}
              </p>
              {selected.footer_text && (
                <p className="text-muted-foreground mt-2 text-xs italic">
                  {selected.footer_text}
                </p>
              )}
            </div>
            {semantic && !mapping && (
              <p className="text-destructive text-xs">{t('invalidMapping')}</p>
            )}
            {semantic && catalogUnavailable && (
              <p className="text-destructive text-xs">
                {t('contextLoadError')}
              </p>
            )}
            {requiresReservation && (
              <div className="space-y-2">
                <Label htmlFor="template-reservation">{t('reservation')}</Label>
                <select
                  id="template-reservation"
                  value={reservationId}
                  onChange={(event) => setReservationId(event.target.value)}
                  disabled={staysLoading || staysError}
                  className="border-border bg-background text-foreground h-9 w-full rounded-md border px-3 text-sm"
                >
                  <option value="">
                    {staysLoading
                      ? t('loadingReservations')
                      : t('selectReservation')}
                  </option>
                  {stays.map((stay) => (
                    <option key={stay.id} value={stay.id}>
                      {stay.reservationCode ||
                        stay.propertyName ||
                        t('reservation')}
                      {stay.checkIn
                        ? ` · ${formatStayDateShort(stay.checkIn, locale)}`
                        : ''}
                      {stay.checkOut
                        ? ` – ${formatStayDateShort(stay.checkOut, locale)}`
                        : ''}
                    </option>
                  ))}
                </select>
                {staysError ? (
                  <p className="text-destructive text-xs">
                    {t('contextLoadError')}
                  </p>
                ) : !staysLoading && !stays.length ? (
                  <p className="text-muted-foreground text-xs">
                    {t('noReservations')}
                  </p>
                ) : null}
              </div>
            )}
            {!semantic && slots && slots.headerVarCount > 0 && (
              <div className="space-y-1">
                <Label className="text-popover-foreground text-xs">
                  {`Header {{1}}`}
                </Label>
                <Input
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  placeholder={t('headerValuePlaceholder')}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}
            {!semantic &&
              slots?.bodyVars.map((v, i) => (
                <div key={v} className="space-y-1">
                  <Label className="text-popover-foreground text-xs">{`Body {{${v}}}`}</Label>
                  <Input
                    value={params[i] ?? ''}
                    onChange={(e) => {
                      const next = [...params];
                      next[i] = e.target.value;
                      setParams(next);
                    }}
                    placeholder={t('bodyValuePlaceholder', { val: `{{${v}}}` })}
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              ))}
            {!semantic &&
              slots?.urlButtonSlots.map((slot) => (
                <div key={slot.index} className="space-y-1">
                  <Label className="text-popover-foreground text-xs">
                    {`URL button "${slot.text}" — value for `}
                    {`{{1}}`}
                  </Label>
                  <Input
                    value={buttonParams[slot.index] ?? ''}
                    onChange={(e) =>
                      setButtonParams((prev) => ({
                        ...prev,
                        [slot.index]: e.target.value,
                      }))
                    }
                    placeholder={t('urlSuffixValuePlaceholder')}
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                  <p className="text-muted-foreground text-[10px] break-all">
                    {t('finalUrl', {
                      url: slot.url.replace(
                        /\{\{1\}\}/g,
                        buttonParams[slot.index] || '{{1}}'
                      ),
                    })}
                  </p>
                </div>
              ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('back')}
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t('send')}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
