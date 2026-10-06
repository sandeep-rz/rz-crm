'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  AlertCircle,
  X,
  Pencil,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import {
  MEDIA_HEADER_SPECS,
  isMediaHeaderKind,
  type MediaHeaderKind,
} from '@/lib/whatsapp/media-header-types';
import { useAuth } from '@/hooks/use-auth';
import { useWhatsAppCapability } from '@/hooks/use-whatsapp-capability';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MessageTemplate, TemplateButton } from '@/types';
import { templateStatusConfig } from '@/lib/template-status';
import { TEMPLATE_LIMITS } from '@/lib/whatsapp/template-validators';

import { SemanticTemplateEditor } from './semantic-template-editor';
import {
  canMapImportedTemplate,
  hasTemplateTokens,
  positionalSlots,
  slotIdentity,
  renderSemanticText,
  type CatalogVariable,
} from '@/lib/whatsapp/semantic-template';

const CATEGORIES = ['Marketing', 'Utility', 'Authentication'] as const;
type HeaderFormat = 'none' | 'text' | 'image' | 'video' | 'document';
const HEADER_FORMATS: HeaderFormat[] = [
  'none',
  'text',
  'image',
  'video',
  'document',
];

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
  Utility: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  Authentication: 'bg-amber-600/20 text-amber-400 border-amber-600/30',
};

interface TemplateFormData {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  header_format: HeaderFormat;
  header_content: string;
  header_media_url: string;
  body_text: string;
  footer_text: string;
  buttons: TemplateButton[];
}

const emptyForm: TemplateFormData = {
  name: '',
  category: 'Marketing',
  language: 'en_US',
  header_format: 'none',
  header_content: '',
  header_media_url: '',
  body_text: '',
  footer_text: '',
  buttons: [],
};

const COMMON_LANGUAGE_CODES = [
  'en_US',
  'en_GB',
  'en',
  'es',
  'es_ES',
  'es_MX',
  'fr',
  'fr_FR',
  'de',
  'it',
  'pt_BR',
  'pt_PT',
  'nl',
  'pl',
  'ru',
  'tr',
  'lt',
];

function emptyButton(type: TemplateButton['type']): TemplateButton {
  switch (type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: '' };
    case 'URL':
      return { type: 'URL', text: '', url: '' };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: '', phone_number: '' };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: '', example: '' };
  }
}

export function TemplateManager() {
  const t = useTranslations('Settings.templates');
  const supabase = createClient();
  const { user, accountId, loading: authLoading } = useAuth();
  const whatsapp = useWhatsAppCapability();

  const [catalog, setCatalog] = useState<CatalogVariable[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [mappingTemplate, setMappingTemplate] =
    useState<MessageTemplate | null>(null);
  const [mappingSelection, setMappingSelection] = useState<
    Record<string, string>
  >({});
  const [savingMapping, setSavingMapping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [connections, setConnections] = useState<
    Array<{ id: string; display_name: string; is_primary: boolean }>
  >([]);
  const [whatsappConfigId, setWhatsappConfigId] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [form, setForm] = useState<TemplateFormData>(emptyForm);
  // Non-null when the dialog is editing an existing row — switches the
  // submit handler from POST /submit to PATCH /[id] and changes the
  // dialog title + CTA. Set to the template id to pre-fill from a row.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Template selected for the confirm-delete dialog. The destructive
  // action goes through this two-step so a slip on the trash icon
  // doesn't take the template off Meta as well as locally.
  const [templateToDelete, setTemplateToDelete] =
    useState<MessageTemplate | null>(null);
  // Header-media upload (image #230; video/document #562). Uploads to the
  // account-scoped chat-media bucket and stores the public URL in
  // header_media_url; the submit route turns that into a Meta
  // Resumable-Upload handle.
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const headerFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient()
        .from('message_variable_catalog')
        .select(
          'variable_key,label,description,category,data_type,preview_value,is_sensitive,is_active,sort_order'
        )
        .eq('is_active', true)
        .order('sort_order');
      if (cancelled) return;
      if (error) {
        setCatalogError(error.message);
        return;
      }
      setCatalogError('');
      setCatalog(
        (data ?? []).map((row) => ({
          variableKey: row.variable_key,
          label: row.label,
          previewValue: row.preview_value,
          isActive: row.is_active,
          category: row.category,
          sortOrder: row.sort_order,
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (authLoading) return;
    if (!user || !accountId) return;
    void (async () => {
      const response = await fetch('/api/whatsapp/config');
      const payload = await response.json();
      const rows = payload.connections ?? [];
      const selectedId =
        rows.find((row: { is_primary: boolean }) => row.is_primary)?.id ??
        rows[0]?.id ??
        '';
      setConnections(rows);
      setWhatsappConfigId(selectedId);
      await fetchTemplates(accountId, selectedId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, authLoading, user?.id]);

  async function fetchTemplates(
    activeAccountId: string,
    connectionId = whatsappConfigId
  ) {
    try {
      setLoading(true);
      let query = supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', activeAccountId);
      if (connectionId) query = query.eq('whatsapp_config_id', connectionId);
      const { data, error } = await query.order('created_at', {
        ascending: false,
      });
      if (error) throw error;
      setTemplates(data || []);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }

  function buildSubmitPayload() {
    return {
      whatsapp_config_id: whatsappConfigId,
      name: form.name.trim(),
      category: form.category,
      language: form.language.trim() || 'en_US',
      header_type:
        form.header_format === 'none' ? undefined : form.header_format,
      header_media_url:
        form.header_format !== 'none' && form.header_format !== 'text'
          ? form.header_media_url.trim() || undefined
          : undefined,
      semantic_content: {
        body_text: form.body_text.trim(),
        ...(form.header_format === 'text'
          ? { header_content: form.header_content.trim() }
          : {}),
        button_urls: Object.fromEntries(
          form.buttons.flatMap((button, index) =>
            button.type === 'URL' ? [[String(index), button.url]] : []
          )
        ),
      },
      footer_text: form.footer_text.trim() || undefined,
      buttons: form.buttons.length > 0 ? form.buttons : undefined,
    };
  }

  function openEdit(template: MessageTemplate) {
    if (!whatsapp.available) return;
    if (canMapImportedTemplate(template)) {
      setMappingTemplate(template);
      setMappingSelection({});
      return;
    }
    // Only static Meta imports can initialize an editor without semantic content.
    let content = template.semantic_content;
    if (!content) {
      if (template.template_origin !== 'meta' || hasTemplateTokens(template)) {
        toast.error('This template has no supported semantic content.');
        return;
      }
      content = {
        body_text: template.body_text,
        header_content:
          template.header_type === 'text' ? template.header_content : undefined,
        button_urls: Object.fromEntries(
          (template.buttons ?? []).flatMap((button, index) =>
            button.type === 'URL' ? [[String(index), button.url]] : []
          )
        ),
      };
    }
    setEditingId(template.id);
    setForm({
      name: template.name,
      category: template.category,
      language: template.language || 'en_US',
      header_format: (template.header_type ?? 'none') as HeaderFormat,
      header_content: content.header_content ?? '',
      header_media_url: template.header_media_url ?? '',
      body_text: content.body_text,
      footer_text: template.footer_text ?? '',
      buttons: (template.buttons ?? []).map((button, index) =>
        button.type === 'URL'
          ? {
              ...button,
              url: content.button_urls?.[String(index)] ?? '',
            }
          : button
      ),
    });
    setDialogOpen(true);
  }

  function openCreate() {
    if (!whatsapp.available) return;
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  async function handleSubmit() {
    if (!whatsapp.available) return;
    // AUTHENTICATION is blocked by the persistent banner + disabled
    // submit button; this is a defensive second line of defense.
    if (form.category === 'Authentication') return;
    try {
      setSubmitting(true);
      const isEdit = editingId !== null;
      const url = isEdit
        ? `/api/whatsapp/templates/${editingId}`
        : '/api/whatsapp/templates/submit';
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSubmitPayload()),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error ||
            t(isEdit ? 'editFailedHttp' : 'submitFailedHttp', {
              status: res.status,
            })
        );
      }
      // Refresh first, then close — re-opening the dialog
      // immediately should not show a stale list.
      if (accountId) await fetchTemplates(accountId);
      toast.success(
        data.dry_run
          ? isEdit
            ? t('toastSaveEditDry')
            : t('toastSaveNewDry')
          : isEdit
            ? t('toastSubmitEditSuccess')
            : t('toastSubmitNewSuccess')
      );
      setDialogOpen(false);
      setForm(emptyForm);
      setEditingId(null);
    } catch (err) {
      console.error('Submit error:', err);
      toast.error(err instanceof Error ? err.message : t('toastSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSyncFromMeta() {
    if (!user || !whatsapp.available) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp_config_id: whatsappConfigId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Sync failed (HTTP ${res.status})`);
      }
      toast.success(
        t('toastSyncCount', { total: data.total }) +
          (data.inserted || data.updated
            ? t('toastSyncDetails', {
                inserted: data.inserted,
                updated: data.updated,
              })
            : '')
      );
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const preview = data.errors
          .slice(0, 3)
          .map(
            (e: { name: string; language: string; message: string }) =>
              `${e.name} (${e.language})`
          );
        const suffix =
          data.errors.length > 3 ? `, +${data.errors.length - 3} more` : '';
        toast.error(
          t('toastSyncFailed', { preview: preview.join(', ') + suffix })
        );
      }
      if (data.truncated) {
        // Use error (not warning) so the message survives long
        // enough to read — sonner's `warning` auto-dismisses on
        // the same short timer as `success`.
        toast.error(t('toastSyncTruncated'), { duration: 10000 });
      }
      if (accountId) await fetchTemplates(accountId);
    } catch (err) {
      console.error('Template sync error:', err);
      toast.error(err instanceof Error ? err.message : t('toastSyncError'));
    } finally {
      setSyncing(false);
    }
  }

  async function confirmDelete() {
    const target = templateToDelete;
    if (!target || deletingId) return;
    if (target.meta_template_id && !whatsapp.available) return;
    setDeletingId(target.id);
    try {
      // Route handler scopes the Meta delete via hsm_id (so sibling
      // language variants survive) and falls through to remove the
      // local row. Local-only rows skip the Meta call.
      const res = await fetch(`/api/whatsapp/templates/${target.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Delete failed (HTTP ${res.status})`);
      }
      toast.success(t('toastDeleteSuccess'));
      setTemplates((prev) => prev.filter((t) => t.id !== target.id));
      setTemplateToDelete(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(err instanceof Error ? err.message : t('toastDeleteError'));
    } finally {
      setDeletingId(null);
    }
  }

  // The patch type unions every field across button variants. The
  // conditional rendering below ensures only fields valid for the
  // current button's `type` reach this function, so the runtime
  // assertion + per-type spread preserves discriminated-union
  // invariants without forcing every call site to thread the type
  // through generics (which TS can't infer from a partial literal).
  type ButtonPatch = {
    text?: string;
    url?: string;
    phone_number?: string;
    example?: string;
  };
  function updateButton(index: number, patch: ButtonPatch) {
    setForm((prev) => {
      const current = prev.buttons[index];
      if (!current) return prev;
      const next = [...prev.buttons];
      // Per-variant spread keeps the discriminant pinned. Switch
      // exhaustiveness is enforced by TypeScript.
      switch (current.type) {
        case 'QUICK_REPLY':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
          };
          break;
        case 'URL':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
            ...(patch.url !== undefined && { url: patch.url }),
            ...(patch.example !== undefined && { example: patch.example }),
          };
          break;
        case 'PHONE_NUMBER':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
            ...(patch.phone_number !== undefined && {
              phone_number: patch.phone_number,
            }),
          };
          break;
        case 'COPY_CODE':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
            ...(patch.example !== undefined && { example: patch.example }),
          };
          break;
      }
      return { ...prev, buttons: next };
    });
  }

  function changeButtonType(index: number, type: TemplateButton['type']) {
    setForm((prev) => {
      const next = [...prev.buttons];
      next[index] = emptyButton(type);
      return { ...prev, buttons: next };
    });
  }

  function removeButton(index: number) {
    setForm((prev) => ({
      ...prev,
      buttons: prev.buttons.filter((_, i) => i !== index),
    }));
  }

  function addButton() {
    if (form.buttons.length >= TEMPLATE_LIMITS.maxButtonsTotal) return;
    setForm((prev) => ({
      ...prev,
      buttons: [...prev.buttons, emptyButton('QUICK_REPLY')],
    }));
  }

  if (authLoading || (loading && user && accountId)) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const headerNeedsMedia =
    form.header_format !== 'none' && form.header_format !== 'text';
  const headerMediaKind: MediaHeaderKind | null = isMediaHeaderKind(
    form.header_format
  )
    ? form.header_format
    : null;

  // Per-kind copy for the file picker. Kept as explicit key maps (not
  // `t(\`upload${kind}\`)`) so the catalogue scanner can see every key.
  const uploadLabelKey = {
    image: 'uploadImage',
    video: 'uploadVideo',
    document: 'uploadDocument',
  } as const;
  const uploadHintKey = {
    image: 'uploadHint',
    video: 'uploadHintVideo',
    document: 'uploadHintDocument',
  } as const;
  const invalidTypeKey = {
    image: 'toastInvalidImage',
    video: 'toastInvalidVideo',
    document: 'toastInvalidDocument',
  } as const;

  async function handleHeaderMediaFile(file: File, kind: MediaHeaderKind) {
    if (!MEDIA_HEADER_SPECS[kind].mimeTypes.includes(file.type)) {
      toast.error(t(invalidTypeKey[kind]));
      return;
    }
    // The upload lands in the chat-media bucket, whose 16 MB ceiling is
    // below Meta's 100 MB document cap — so this is the bucket-side
    // limit, not Meta's. A larger document can still be pasted as a link.
    const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (file.size > maxBytes) {
      toast.error(
        t('toastMediaTooLarge', {
          size: (file.size / 1024 / 1024).toFixed(1),
          max: Math.round(maxBytes / 1024 / 1024),
        })
      );
      return;
    }
    setUploadingHeader(true);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      setForm((f) => ({ ...f, header_media_url: publicUrl }));
      toast.success(t('toastUploadSuccess'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastUploadFailed'));
    } finally {
      setUploadingHeader(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleSyncFromMeta}
              disabled={syncing || !whatsapp.available}
              title={t('syncTitle')}
            >
              <RefreshCw
                className={`size-4 ${syncing ? 'animate-spin' : ''}`}
              />
              {syncing ? t('syncing') : t('syncFromMeta')}
            </Button>
            <Button onClick={openCreate} disabled={!whatsapp.available}>
              <Plus className="size-4" />
              {t('newTemplate')}
            </Button>
          </div>
        }
      />

      {whatsapp.status === 'unavailable' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <span>
            Connect WhatsApp before creating, syncing, or submitting Meta
            templates.
          </span>
          <a
            href="/settings?tab=whatsapp"
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Set up WhatsApp
          </a>
        </div>
      )}
      {whatsapp.status === 'error' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <span>WhatsApp availability could not be verified.</span>
          <button
            type="button"
            onClick={whatsapp.refresh}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}

      {connections.length > 1 && (
        <select
          value={whatsappConfigId}
          onChange={(event) => {
            const id = event.target.value;
            setWhatsappConfigId(id);
            setEditingId(null);
            if (accountId) void fetchTemplates(accountId, id);
          }}
          className="border-border bg-background h-10 w-full max-w-sm rounded-md border px-3 text-sm"
          aria-label="WhatsApp connection"
        >
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.display_name}
            </option>
          ))}
        </select>
      )}

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">{t('noTemplates')}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('createFirst')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {templates.map((template) => {
            const statusKey = template.status || 'DRAFT';
            const status = templateStatusConfig[statusKey];
            return (
              <Card key={template.id}>
                <CardContent className="flex items-start justify-between pt-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-foreground font-medium">
                        {template.name}
                      </h3>
                      <Badge
                        className={`border text-xs ${categoryColors[template.category] || ''}`}
                      >
                        {template.category}
                      </Badge>
                      <Badge className={`border text-xs ${status.classes}`}>
                        {status.label}
                      </Badge>
                      {template.language && (
                        <span className="text-muted-foreground text-xs uppercase">
                          {template.language}
                        </span>
                      )}
                      <Badge variant="outline">
                        {template.variable_configuration_status === 'configured'
                          ? 'Variables configured'
                          : 'Needs variable mapping'}
                      </Badge>
                      {template.quality_score && (
                        <span
                          className={`text-[10px] font-medium uppercase ${
                            template.quality_score === 'GREEN'
                              ? 'text-emerald-400'
                              : template.quality_score === 'YELLOW'
                                ? 'text-yellow-400'
                                : 'text-red-400'
                          }`}
                          title={t('qualityScoreTitle')}
                        >
                          {template.quality_score}
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground line-clamp-2 text-sm">
                      {template.semantic_content
                        ? renderSemanticText(
                            template.semantic_content.body_text,
                            catalog,
                            'label'
                          )
                        : template.body_text}
                    </p>
                    {template.footer_text && (
                      <p className="text-muted-foreground text-xs italic">
                        {template.footer_text}
                      </p>
                    )}
                    {(template.rejection_reason ||
                      template.submission_error) && (
                      <div className="flex items-start gap-1.5 rounded border border-red-900/40 bg-red-950/20 px-2 py-1.5 text-xs text-red-400">
                        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          {template.rejection_reason ||
                            template.submission_error}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="ml-2 flex shrink-0 items-center gap-1">
                    {canMapImportedTemplate(template) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setMappingTemplate(template);
                          setMappingSelection(
                            Object.fromEntries(
                              (template.semantic_variable_mapping ?? []).map(
                                (m) => [slotIdentity(m), m.variable_key]
                              )
                            )
                          );
                        }}
                      >
                        Map variables
                      </Button>
                    )}
                    {statusKey === 'APPROVED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(template)}
                        disabled={!whatsapp.available}
                        title={t('editTitle')}
                        aria-label={t('editLabel')}
                        className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                      >
                        <Pencil className="size-3.5" />
                        {t('edit')}
                      </Button>
                    )}
                    {(statusKey === 'REJECTED' || statusKey === 'PAUSED') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(template)}
                        disabled={!whatsapp.available}
                        title={t('resubmitTitle')}
                        aria-label={t('resubmitLabel')}
                        className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                      >
                        <RotateCcw className="size-3.5" />
                        {t('resubmit')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setTemplateToDelete(template)}
                      disabled={
                        deletingId === template.id ||
                        (!!template.meta_template_id && !whatsapp.available)
                      }
                      aria-label={
                        template.meta_template_id
                          ? t('deleteMetaLocallyAria')
                          : t('deleteLocallyAria')
                      }
                      title={
                        template.meta_template_id
                          ? t('deleteMetaLocallyTitle')
                          : t('deleteLocallyTitle')
                      }
                      className="text-muted-foreground h-8 w-8 hover:bg-red-950/30 hover:text-red-400"
                    >
                      {deletingId === template.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={!!mappingTemplate}
        onOpenChange={(open) => {
          if (!open) setMappingTemplate(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Map template variables</DialogTitle>
            <DialogDescription>
              Choose a catalog variable for each imported position. Meta
              approval and message content remain unchanged.
            </DialogDescription>
          </DialogHeader>
          {mappingTemplate &&
            positionalSlots(mappingTemplate).map((slot) => (
              <div key={slotIdentity(slot)} className="space-y-1">
                <Label>
                  {slot.component}
                  {slot.button_index === undefined
                    ? ''
                    : ` ${slot.button_index + 1}`}{' '}
                  {`{{${slot.position}}}`}
                </Label>
                <select
                  aria-label={`Map ${slotIdentity(slot)}`}
                  className="border-border bg-background w-full rounded border p-2"
                  value={mappingSelection[slotIdentity(slot)] ?? ''}
                  onChange={(event) =>
                    setMappingSelection({
                      ...mappingSelection,
                      [slotIdentity(slot)]: event.target.value,
                    })
                  }
                >
                  <option value="">Select a variable</option>
                  {[...new Set(catalog.map((v) => v.category))].map(
                    (category) => (
                      <optgroup
                        key={category}
                        label={
                          category.charAt(0).toUpperCase() + category.slice(1)
                        }
                      >
                        {catalog
                          .filter((v) => v.category === category)
                          .map((v) => (
                            <option key={v.variableKey} value={v.variableKey}>
                              {v.label}
                            </option>
                          ))}
                      </optgroup>
                    )
                  )}
                </select>
              </div>
            ))}
          <DialogFooter>
            <Button
              disabled={
                savingMapping ||
                !mappingTemplate ||
                positionalSlots(mappingTemplate).some(
                  (slot) => !mappingSelection[slotIdentity(slot)]
                )
              }
              onClick={async () => {
                if (!mappingTemplate) return;
                setSavingMapping(true);
                try {
                  const response = await fetch(
                    `/api/whatsapp/templates/${mappingTemplate.id}/variables`,
                    {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        mapping: positionalSlots(mappingTemplate).map(
                          (slot) => ({
                            ...slot,
                            variable_key: mappingSelection[slotIdentity(slot)],
                          })
                        ),
                      }),
                    }
                  );
                  const data = await response.json();
                  if (!response.ok) throw new Error(data.error);
                  if (accountId) await fetchTemplates(accountId);
                  setMappingTemplate(null);
                  toast.success('Variable mapping saved.');
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : 'Mapping failed.'
                  );
                } finally {
                  setSavingMapping(false);
                }
              }}
            >
              Save mapping
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditingId(null);
            setForm(emptyForm);
          }
        }}
      >
        <DialogContent className="bg-popover border-border max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editingId ? t('dialogEditTitle') : t('dialogNewTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {editingId ? t('dialogEditDesc') : t('dialogNewDesc')}
            </DialogDescription>
          </DialogHeader>

          {form.category === 'Authentication' && (
            <div className="flex items-start gap-2 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <p>
                {t.rich('authWarning', {
                  bold: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            </div>
          )}

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('templateName')}
              </Label>
              <Input
                placeholder={t('namePlaceholder')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={editingId !== null}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p className="text-muted-foreground text-[11px]">
                {editingId ? t('nameFixed') : t('nameHint')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('category')}</Label>
                <Select
                  value={form.category}
                  onValueChange={(val) =>
                    setForm({
                      ...form,
                      category: val as MessageTemplate['category'],
                    })
                  }
                >
                  <SelectTrigger className="bg-muted border-border text-foreground w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                    {CATEGORIES.map((cat) => (
                      <SelectItem
                        key={cat}
                        value={cat}
                        className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                      >
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('language')}</Label>
                <Input
                  list="template-language-codes"
                  placeholder="en_US"
                  value={form.language}
                  onChange={(e) =>
                    setForm({ ...form, language: e.target.value })
                  }
                  disabled={editingId !== null}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                />
                <datalist id="template-language-codes">
                  {COMMON_LANGUAGE_CODES.map((code) => (
                    <option key={code} value={code} />
                  ))}
                </datalist>
                <p className="text-muted-foreground text-[11px]">
                  {editingId ? (
                    t('langFixed')
                  ) : (
                    <span>
                      {t.rich('langHint', {
                        code: (chunks) => <code>{chunks}</code>,
                      })}
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('header')}</Label>
              <Select
                value={form.header_format}
                onValueChange={(val) =>
                  // Preserve header_content, header_media_url, and
                  // semantic tokens across format switches. The submit
                  // payload builder only reads the field that matches
                  // the active format, so an orphan value on a hidden
                  // field is harmless — and keeping it lets the user
                  // switch formats to compare without losing typing.
                  setForm({
                    ...form,
                    header_format: (val || 'none') as HeaderFormat,
                  })
                }
              >
                <SelectTrigger className="bg-muted border-border text-foreground w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  {HEADER_FORMATS.map((type) => (
                    <SelectItem
                      key={type}
                      value={type}
                      className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                    >
                      {type === 'none'
                        ? t('headerNone')
                        : type === 'text'
                          ? t('headerText')
                          : type === 'image'
                            ? t('headerImage')
                            : type === 'video'
                              ? t('headerVideo')
                              : t('headerDocument')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {form.header_format === 'text' && (
                <div className="mt-2 space-y-2">
                  <SemanticTemplateEditor
                    label="Header text"
                    value={form.header_content}
                    catalog={catalog}
                    onChange={(value) =>
                      setForm({ ...form, header_content: value })
                    }
                  />
                </div>
              )}

              {headerNeedsMedia && (
                <div className="mt-2 space-y-2">
                  {headerMediaKind && (
                    <div className="flex items-center gap-2">
                      <input
                        ref={headerFileRef}
                        type="file"
                        accept={MEDIA_HEADER_SPECS[
                          headerMediaKind
                        ].mimeTypes.join(',')}
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleHeaderMediaFile(f, headerMediaKind);
                          e.target.value = '';
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploadingHeader}
                        onClick={() => headerFileRef.current?.click()}
                      >
                        {uploadingHeader ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        {t(uploadLabelKey[headerMediaKind])}
                      </Button>
                      <span className="text-muted-foreground text-[11px]">
                        {t(uploadHintKey[headerMediaKind])}
                      </span>
                    </div>
                  )}
                  <Input
                    placeholder={t('mediaUrlPlaceholder', {
                      format: form.header_format,
                    })}
                    value={form.header_media_url}
                    onChange={(e) =>
                      setForm({ ...form, header_media_url: e.target.value })
                    }
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                  {form.header_format === 'image' && form.header_media_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={form.header_media_url}
                      alt="Header sample"
                      className="border-border max-h-28 rounded-md border object-contain"
                    />
                  )}
                  <p className="text-muted-foreground text-[11px] leading-relaxed">
                    {form.header_format === 'image'
                      ? t('imageHint')
                      : t('mediaHint')}
                    {form.header_format === 'video' && t('videoHint')}
                    {form.header_format === 'document' && t('documentHint')}
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('bodyText')}</Label>
              <SemanticTemplateEditor
                label="Body text"
                value={form.body_text}
                catalog={catalog}
                onChange={(value) => setForm({ ...form, body_text: value })}
                multiline
              />
              {catalogError && (
                <p className="text-destructive text-xs">
                  Variables could not be loaded: {catalogError}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('footer')}</Label>
              <Input
                placeholder={t('footerPlaceholder')}
                value={form.footer_text}
                onChange={(e) =>
                  setForm({ ...form, footer_text: e.target.value })
                }
                maxLength={TEMPLATE_LIMITS.footerMaxLength}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-muted-foreground">{t('buttons')}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addButton}
                  disabled={
                    form.buttons.length >= TEMPLATE_LIMITS.maxButtonsTotal
                  }
                  className="border-border text-muted-foreground hover:bg-muted h-7 bg-transparent text-xs"
                >
                  <Plus className="size-3" />
                  {t('addButton')}
                </Button>
              </div>
              {form.buttons.length === 0 ? (
                <p className="text-muted-foreground text-[11px]">
                  {t('buttonsLimit', { max: TEMPLATE_LIMITS.maxButtonsTotal })}
                </p>
              ) : (
                <div className="space-y-2">
                  {form.buttons.map((btn, i) => (
                    <div
                      key={i}
                      className="border-border bg-muted/50 space-y-2 rounded border p-2"
                    >
                      <div className="flex items-center gap-2">
                        <Select
                          value={btn.type}
                          onValueChange={(val) => {
                            // Same null guard as the Header Select
                            // (per PR 148): @base-ui Select fires
                            // onValueChange(null) on deselect.
                            if (!val) return;
                            changeButtonType(i, val as TemplateButton['type']);
                          }}
                        >
                          <SelectTrigger className="bg-muted border-border text-foreground h-8 w-40 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-popover border-border">
                            <SelectItem
                              value="QUICK_REPLY"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnQuickReply')}
                            </SelectItem>
                            <SelectItem
                              value="URL"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnUrl')}
                            </SelectItem>
                            <SelectItem
                              value="PHONE_NUMBER"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnPhone')}
                            </SelectItem>
                            <SelectItem
                              value="COPY_CODE"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnCopyCode')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder={t('btnLabelPlaceholder')}
                          value={btn.text}
                          maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
                          onChange={(e) =>
                            updateButton(i, { text: e.target.value })
                          }
                          className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 flex-1 text-xs"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeButton(i)}
                          className="text-muted-foreground size-7 hover:bg-red-950/30 hover:text-red-400"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                      {btn.type === 'URL' && (
                        <div className="space-y-1 pl-1">
                          <SemanticTemplateEditor
                            label={`Button ${i + 1} URL`}
                            value={btn.url}
                            catalog={catalog}
                            onChange={(value) =>
                              updateButton(i, { url: value })
                            }
                          />
                        </div>
                      )}
                      {btn.type === 'PHONE_NUMBER' && (
                        <Input
                          placeholder={t('phonePlaceholder')}
                          value={btn.phone_number}
                          onChange={(e) =>
                            updateButton(i, { phone_number: e.target.value })
                          }
                          className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                        />
                      )}
                      {btn.type === 'COPY_CODE' && (
                        <Input
                          placeholder={t('codePlaceholder')}
                          value={btn.example}
                          onChange={(e) =>
                            updateButton(i, { example: e.target.value })
                          }
                          className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={
                submitting ||
                !whatsapp.available ||
                form.category === 'Authentication'
              }
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {editingId ? t('saving') : t('submitting')}
                </>
              ) : editingId ? (
                t('saveResubmit')
              ) : (
                t('submitApproval')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm-delete dialog. Surfacing the meta_template_id case
          separately so users understand a real Meta delete is happening,
          not just a local cleanup. */}
      <Dialog
        open={templateToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setTemplateToDelete(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {templateToDelete?.meta_template_id
                ? t('deleteMetaDesc', { name: templateToDelete.name })
                : t('deleteLocalDesc', { name: templateToDelete?.name || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setTemplateToDelete(null)}
              disabled={deletingId !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={
                deletingId !== null ||
                (!!templateToDelete?.meta_template_id && !whatsapp.available)
              }
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deletingId !== null ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('delete')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
