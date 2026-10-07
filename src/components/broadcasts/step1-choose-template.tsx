'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { semanticBroadcastTemplateIssue } from '@/lib/broadcast-message-variables';
import {
  renderSemanticText,
  type CatalogVariable,
} from '@/lib/whatsapp/semantic-template';
import type {
  MessageVariableSourceScope,
  MessageVariableResolutionSource,
} from '@/lib/message-variables/contract';
import { useAuth } from '@/hooks/use-auth';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
  whatsappConfigId: string;
}

export function Step1ChooseTemplate({
  selectedTemplate,
  onSelect,
  onNext,
  onBack,
  whatsappConfigId,
}: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { accountId } = useAuth();
  const [catalog, setCatalog] = useState<
    (CatalogVariable & {
      sourceScope: MessageVariableSourceScope;
      resolutionSource: MessageVariableResolutionSource;
    })[]
  >([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchTemplates() {
      setLoading(true);
      setError(null);
      setTemplates([]);
      setCatalog([]);
      try {
        // Connection selection loads asynchronously; never filter a UUID by ''.
        if (!accountId || !whatsappConfigId.trim()) {
          setTemplates([]);
          return;
        }
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time. Hide them rather than letting
        // the user pick a template that will fail.
        const templateQuery = supabase
          .from('message_templates')
          .select('*')
          .eq('account_id', accountId)
          .eq('status', 'APPROVED')
          .eq('whatsapp_config_id', whatsappConfigId)
          .order('created_at', { ascending: false });
        const [{ data, error: fetchError }, definitions] = await Promise.all([
          templateQuery,
          supabase
            .from('message_variable_catalog')
            .select(
              'variable_key,label,preview_value,category,sort_order,source_scope,resolution_source,is_active'
            )
            .eq('is_active', true)
            .order('sort_order'),
        ]);
        if (cancelled) return;
        setCatalog(
          (definitions.data ?? []).map((v) => ({
            variableKey: v.variable_key,
            label: v.label,
            previewValue: v.preview_value,
            category: v.category,
            sortOrder: v.sort_order,
            sourceScope: v.source_scope,
            resolutionSource: v.resolution_source,
            isActive: v.is_active,
          }))
        );

        if (fetchError) throw fetchError;
        setTemplates(data ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : t('chooseTemplate.errorLoad')
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchTemplates();
    return () => {
      cancelled = true;
    };
  }, [accountId, whatsappConfigId, t]);

  if (loading || !accountId || !whatsappConfigId.trim()) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t('chooseTemplate.title')}
        className="flex h-64 items-center justify-center"
      >
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-foreground text-lg font-semibold">
          {t('chooseTemplate.title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('chooseTemplate.subtitle')}
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="border-border bg-card/50 flex h-48 flex-col items-center justify-center rounded-xl border">
          <FileText className="text-muted-foreground mb-2 h-8 w-8" />
          <p className="text-muted-foreground text-sm">
            {t('chooseTemplate.noTemplates')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('chooseTemplate.createFirst')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const issue = semanticBroadcastTemplateIssue(template, catalog);
            const isSelected = selectedTemplate?.id === template.id;
            const catColor =
              categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                disabled={Boolean(issue)}
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                    : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-foreground text-sm font-medium">
                    {template.name}
                  </h3>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="text-muted-foreground line-clamp-3 text-xs">
                  {template.semantic_content
                    ? renderSemanticText(
                        template.semantic_content.body_text,
                        catalog,
                        'label'
                      )
                    : template.body_text}
                </p>
                {issue ? (
                  <p className="text-destructive text-xs">{issue}</p>
                ) : null}
                <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
                  <span>{template.language ?? 'en_US'}</span>
                  {/* Status is omitted on purpose — every template
                      shown here is already filtered to APPROVED,
                      so the chip carried no information. */}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="border-border flex items-center justify-between border-t pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={
            !whatsappConfigId.trim() ||
            !selectedTemplate ||
            selectedTemplate.whatsapp_config_id !== whatsappConfigId ||
            Boolean(semanticBroadcastTemplateIssue(selectedTemplate, catalog))
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
