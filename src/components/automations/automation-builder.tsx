'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  MousePointerClick,
  List,
  AlertCircle,
  SlidersHorizontal,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {
  AccountMember,
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  InteractiveMessagePayload,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  PmsTriggerConfig,
  Tag as TagRecord,
} from '@/types';
import {
  InteractiveBuilder,
  blankButtonsPayload,
  blankListPayload,
} from '@/components/interactive/interactive-builder';
import { interactivePayloadPreviewText } from '@/lib/whatsapp/interactive';
import { createClient } from '@/lib/supabase/client';
import {
  childPath,
  insertAt,
  mapAtPath,
  moveAt,
  removeAt,
  type ParentScope,
  type StepPath,
} from '@/lib/automations/builder-tree';
import { cn } from '@/lib/utils';
import {
  isPmsAutomationTrigger,
  isPmsScheduledAutomationTrigger,
  isValidIanaTimeZone,
  PMS_OFFSET_DAYS_MAX,
  PMS_OFFSET_DAYS_MIN,
} from '@/lib/automations/pms-trigger-schema';
import { isWhatsAppSendStep } from '@/lib/automations/action-schema';
import {
  ALL_AUTOMATION_TRIGGER_OPTIONS,
  AUTOMATION_TRIGGER_GROUPS,
  automationActionAvailability,
  automaticallySelectedWhatsAppConnection,
  buildPmsFilterOptions,
  defaultTriggerConfig,
  selectedPmsPropertyIds,
  updatePmsTriggerConfig,
  type FriendlyFilterOption,
  type PmsReservationFilterRow,
} from '@/lib/automations/automation-builder-model';

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string;
  step_type: AutomationStepType;
  step_config: Record<string, unknown>;
  branches?: { yes: BuilderStep[]; no: BuilderStep[] };
}

export interface BuilderInitial {
  id?: string;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  is_active: boolean;
  steps: BuilderStep[];
  whatsapp_config_id?: string | null;
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  label: string;
  icon: typeof Zap;
  /** Left-border accent color per spec. */
  border: string;
}

const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: {
    label: 'send_message',
    icon: MessageSquare,
    border: 'border-l-primary',
  },
  send_buttons: {
    label: 'send_buttons',
    icon: MousePointerClick,
    border: 'border-l-primary',
  },
  send_list: { label: 'send_list', icon: List, border: 'border-l-primary' },
  send_template: {
    label: 'send_template',
    icon: FileText,
    border: 'border-l-primary',
  },
  add_tag: { label: 'add_tag', icon: Tag, border: 'border-l-primary' },
  remove_tag: {
    label: 'remove_tag',
    icon: TagIcon,
    border: 'border-l-primary',
  },
  assign_conversation: {
    label: 'assign_conversation',
    icon: UserCheck,
    border: 'border-l-primary',
  },
  update_contact_field: {
    label: 'update_contact_field',
    icon: PencilLine,
    border: 'border-l-primary',
  },
  create_deal: {
    label: 'create_deal',
    icon: Briefcase,
    border: 'border-l-primary',
  },
  wait: { label: 'wait', icon: Hourglass, border: 'border-l-border' },
  condition: {
    label: 'condition',
    icon: GitBranch,
    border: 'border-l-amber-500',
  },
  send_webhook: {
    label: 'send_webhook',
    icon: Webhook,
    border: 'border-l-primary',
  },
  close_conversation: {
    label: 'close_conversation',
    icon: CircleSlash,
    border: 'border-l-primary',
  },
};

const ADDABLE_STEPS: AutomationStepType[] = [
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
  'add_tag',
  'remove_tag',
  'assign_conversation',
  'update_contact_field',
  'create_deal',
  'wait',
  'condition',
  'send_webhook',
  'close_conversation',
];

function builderStepsRequireWhatsApp(steps: BuilderStep[]): boolean {
  return steps.some((step) => {
    if (isWhatsAppSendStep(step.step_type)) return true;
    if (step.step_type !== 'condition' || !step.branches) return false;
    return (
      builderStepsRequireWhatsApp(step.branches.yes) ||
      builderStepsRequireWhatsApp(step.branches.no)
    );
  });
}

function cid(): string {
  return (
    'c_' +
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  );
}

// The send_buttons / send_list step_config IS an InteractiveMessagePayload,
// but step_config is typed generically as Record<string, unknown>. These two
// helpers hold the single unavoidable structural cast in one place so a
// payload-shape change has one seam to update instead of four scattered
// `as unknown as` sites.
function toStepConfig(p: InteractiveMessagePayload): Record<string, unknown> {
  return p as unknown as Record<string, unknown>;
}
function asInteractive(
  cfg: Record<string, unknown>
): InteractiveMessagePayload {
  return cfg as unknown as InteractiveMessagePayload;
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case 'send_message':
      return { text: '' };
    case 'send_buttons':
      return toStepConfig(blankButtonsPayload());
    case 'send_list':
      return toStepConfig(blankListPayload());
    case 'send_template':
      return { template_name: '', language: 'en_US' };
    case 'add_tag':
    case 'remove_tag':
      return { tag_id: '' };
    case 'assign_conversation':
      return { mode: 'round_robin' };
    case 'update_contact_field':
      return { field: 'name', value: '' };
    case 'create_deal':
      return { pipeline_id: '', stage_id: '', title: '', value: 0 };
    case 'wait':
      return { amount: 1, unit: 'hours' };
    case 'condition':
      return { subject: 'tag_presence', operand: '', value: '' };
    case 'send_webhook':
      return { url: '', headers: {}, body_template: '' };
    case 'close_conversation':
      return {};
    default:
      return {};
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates, pipelines)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[];
  members: AccountMember[];
  templates: MessageTemplate[];
  customFields: CustomField[];
  pipelines: PipelineOption[];
  stages: PipelineStageOption[];
  pmsProperties: PmsPropertyOption[];
  pmsChannels: FriendlyFilterOption[];
  pmsReservationStatuses: FriendlyFilterOption[];
  whatsappConnections: WhatsAppConnectionOption[];
  whatsappConnectionsLoading: boolean;
}

interface PipelineOption {
  id: string;
  name: string;
}

interface PipelineStageOption {
  id: string;
  name: string;
  pipeline_id: string;
  position: number;
}

interface PmsPropertyOption {
  id: string;
  name: string | null;
  status: string;
  timezone: string | null;
}

interface WhatsAppConnectionOption {
  id: string;
  display_name: string;
  is_primary: boolean;
  status: string;
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
  pmsProperties: [],
  pmsChannels: [],
  pmsReservationStatuses: [],
  whatsappConnections: [],
  whatsappConnectionsLoading: true,
});

function useResources(): AutomationResources {
  return useContext(ResourcesContext);
}

function ResourcesProvider({
  children,
  whatsappConfigId,
  loadPmsProperties,
  whatsappConnections,
  whatsappConnectionsLoading,
}: {
  children: ReactNode;
  whatsappConfigId?: string | null;
  loadPmsProperties: boolean;
  whatsappConnections: WhatsAppConnectionOption[];
  whatsappConnectionsLoading: boolean;
}) {
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]);
  const [stages, setStages] = useState<PipelineStageOption[]>([]);
  const [pmsProperties, setPmsProperties] = useState<PmsPropertyOption[]>([]);
  const [pmsChannels, setPmsChannels] = useState<FriendlyFilterOption[]>([]);
  const [pmsReservationStatuses, setPmsReservationStatuses] = useState<
    FriendlyFilterOption[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    void (async () => {
      let templateQuery = supabase
        .from('message_templates')
        .select('*')
        .eq('status', 'APPROVED');
      if (whatsappConfigId)
        templateQuery = templateQuery.eq(
          'whatsapp_config_id',
          whatsappConfigId
        );
      const pmsPropertiesPromise = loadPmsProperties
        ? supabase
            .from('pms_properties')
            .select('id, name, status, timezone')
            .order('name')
        : Promise.resolve({ data: [] as PmsPropertyOption[] });
      const pmsReservationsPromise = loadPmsProperties
        ? supabase
            .from('pms_reservations')
            .select('channel_code, channel_name, status')
            .limit(1000)
        : Promise.resolve({ data: [] as PmsReservationFilterRow[] });
      const [
        tagsRes,
        templatesRes,
        customFieldsRes,
        pipelinesRes,
        stagesRes,
        pmsPropertiesRes,
        pmsReservationsRes,
      ] = await Promise.all([
        supabase.from('tags').select('*').order('name'),
        templateQuery.order('name'),
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase.from('pipelines').select('id, name').order('name'),
        supabase
          .from('pipeline_stages')
          .select('id, name, pipeline_id, position')
          .order('position'),
        pmsPropertiesPromise,
        pmsReservationsPromise,
      ]);
      if (cancelled) return;
      setTags((tagsRes.data as TagRecord[] | null) ?? []);
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? []);
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? []);
      setPipelines((pipelinesRes.data as PipelineOption[] | null) ?? []);
      setStages((stagesRes.data as PipelineStageOption[] | null) ?? []);
      setPmsProperties(
        (pmsPropertiesRes.data as PmsPropertyOption[] | null) ?? []
      );
      const pmsFilters = buildPmsFilterOptions(
        (pmsReservationsRes.data as PmsReservationFilterRow[] | null) ?? []
      );
      setPmsChannels(pmsFilters.channels);
      setPmsReservationStatuses(pmsFilters.statuses);
    })();

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch('/api/account/members', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { members?: AccountMember[] };
        if (!cancelled) setMembers(json.members ?? []);
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadPmsProperties, whatsappConfigId]);

  return (
    <ResourcesContext.Provider
      value={{
        tags,
        members,
        templates,
        customFields,
        pipelines,
        stages,
        pmsProperties,
        pmsChannels,
        pmsReservationStatuses,
        whatsappConnections,
        whatsappConnectionsLoading,
      }}
    >
      {children}
    </ResourcesContext.Provider>
  );
}

const SELECT_CLASS =
  'w-full cursor-pointer rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none disabled:cursor-not-allowed';

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { tags } = useResources();
  if (tags.length === 0) {
    return (
      <Input
        placeholder={t('tags.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    );
  }
  const selected = tags.find((t) => t.id === value);
  return (
    <div className="flex items-center gap-2">
      <span
        className="border-border h-3 w-3 shrink-0 rounded-full border"
        style={{ backgroundColor: selected?.color ?? 'transparent' }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t('tags.select')}</option>
        {tags.map((tg) => (
          <option key={tg.id} value={tg.id}>
            {tg.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{t('tags.unknown', { id: value })}</option>
        )}
      </select>
    </div>
  );
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { customFields } = useResources();
  const customValue = value.startsWith('custom:') ? value : '';
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue);
  return (
    <select
      value={value || 'name'}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">{t('fields.name')}</option>
      <option value="email">{t('fields.email')}</option>
      <option value="company">{t('fields.company')}</option>
      {customFields.length > 0 && (
        <optgroup label={t('fields.customFields')}>
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>
          {t('fields.unknown', { id: customValue })}
        </option>
      )}
    </select>
  );
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { members } = useResources();
  if (members.length === 0) {
    return (
      <Input
        placeholder={t('agents.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    );
  }
  const selected = members.find((m) => m.user_id === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{t('agents.select')}</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{t('agents.unknown', { id: value })}</option>
      )}
    </select>
  );
}

/** Pipeline + stage picker for Create Deal. The automation stores ids because
 *  the engine writes directly to deals, but authors should choose by name. */
function DealPipelineFields({
  pipelineId,
  stageId,
  onChange,
  t,
}: {
  pipelineId: string;
  stageId: string;
  onChange: (patch: { pipeline_id: string; stage_id: string }) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { pipelines, stages } = useResources();

  if (pipelines.length === 0) {
    return (
      <>
        <FieldBlock label={t('pipelines.pipelineIdLabel')}>
          <Input
            value={pipelineId}
            onChange={(e) =>
              onChange({ pipeline_id: e.target.value, stage_id: stageId })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t('pipelines.stageIdLabel')}>
          <Input
            value={stageId}
            onChange={(e) =>
              onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    );
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const stageOptions = stages.filter((s) => s.pipeline_id === pipelineId);
  const selectedStage = stageOptions.find((s) => s.id === stageId);

  return (
    <>
      <FieldBlock label={t('pipelines.pipelineLabel')}>
        <select
          value={pipelineId}
          onChange={(e) => {
            const nextPipelineId = e.target.value;
            const firstStage = stages.find(
              (s) => s.pipeline_id === nextPipelineId
            );
            onChange({
              pipeline_id: nextPipelineId,
              stage_id: firstStage?.id ?? '',
            });
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t('pipelines.selectPipeline')}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !selectedPipeline && (
            <option value={pipelineId}>
              {t('pipelines.unknownPipeline', { id: pipelineId })}
            </option>
          )}
        </select>
      </FieldBlock>
      <FieldBlock label={t('pipelines.stageLabel')}>
        <select
          value={stageId}
          onChange={(e) =>
            onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
          }
          className={SELECT_CLASS}
          disabled={!pipelineId || stageOptions.length === 0}
        >
          <option value="">
            {pipelineId
              ? t('pipelines.selectStage')
              : t('pipelines.selectPipelineFirst')}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && pipelineId && !selectedStage && (
            <option value={stageId}>
              {t('pipelines.unknownStage', { id: stageId })}
            </option>
          )}
        </select>
      </FieldBlock>
    </>
  );
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. */
function SendTemplateFields({
  templateName,
  language,
  onChange,
  t,
}: {
  templateName: string;
  language: string;
  onChange: (patch: { template_name: string; language: string }) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { templates } = useResources();

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label={t('templates.templateNameLabel')}>
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t('templates.languageLabel')}>
          <Input
            value={language}
            onChange={(e) =>
              onChange({
                template_name: templateName,
                language: e.target.value,
              })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    );
  }

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`;
  const current = templateName ? toValue(templateName, language) : '';
  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? 'en_US') === current
  );

  return (
    <FieldBlock label={t('templates.templateLabel')}>
      <select
        value={current}
        onChange={(e) => {
          const [name, lang] = e.target.value.split('::');
          onChange({ template_name: name ?? '', language: lang ?? '' });
        }}
        className={SELECT_CLASS}
      >
        <option value="">{t('templates.select')}</option>
        {templates.map((tmpl) => {
          const lang = tmpl.language ?? 'en_US';
          return (
            <option key={tmpl.id} value={toValue(tmpl.name, lang)}>
              {tmpl.name} ({lang})
            </option>
          );
        })}
        {current && !hasMatch && (
          <option value={current}>
            {t('templates.unknown', {
              name: templateName,
              lang: language || t('templates.unknownLang'),
            })}
          </option>
        )}
      </select>
    </FieldBlock>
  );
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter();
  const t = useTranslations('Automations.builder');
  const isEditing = !!initial.id;
  const [state, setState] = useState<BuilderInitial>(initial);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [connections, setConnections] = useState<WhatsAppConnectionOption[]>(
    []
  );
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const requiresWhatsApp = builderStepsRequireWhatsApp(state.steps);
  const usesPmsTrigger = isPmsAutomationTrigger(state.trigger_type);
  const usableConnections = useMemo(
    () => connections.filter((connection) => connection.status === 'connected'),
    [connections]
  );
  const selectedConnectionIsUsable = Boolean(
    state.whatsapp_config_id &&
    usableConnections.some(
      (connection) => connection.id === state.whatsapp_config_id
    )
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/config')
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        const rows = Array.isArray(body.connections) ? body.connections : [];
        setConnections(rows);
        const usableIds = (rows as WhatsAppConnectionOption[])
          .filter((connection) => connection.status === 'connected')
          .map((connection) => connection.id);
        setState((current) => {
          if (!builderStepsRequireWhatsApp(current.steps)) return current;
          const automaticConnectionId = automaticallySelectedWhatsAppConnection(
            current.whatsapp_config_id,
            usableIds
          );
          return automaticConnectionId &&
            automaticConnectionId !== current.whatsapp_config_id
            ? { ...current, whatsapp_config_id: automaticConnectionId }
            : current;
        });
      })
      .catch(() => {
        if (!cancelled) setConnections([]);
      })
      .finally(() => {
        if (!cancelled) setConnectionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function patchTop<K extends keyof BuilderInitial>(
    key: K,
    value: BuilderInitial[K]
  ) {
    setState((s) => ({ ...s, [key]: value }));
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(
    path: StepPath,
    updater: (s: BuilderStep) => BuilderStep
  ) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }));
  }

  function addStepAt(
    parent: ParentScope,
    index: number,
    type: AutomationStepType
  ) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === 'condition' ? { yes: [], no: [] } : undefined,
    };
    setState((s) => {
      const nextSteps = insertAt(s.steps, parent, index, node);
      const automaticConnectionId = isWhatsAppSendStep(type)
        ? automaticallySelectedWhatsAppConnection(
            s.whatsapp_config_id,
            usableConnections.map((connection) => connection.id)
          )
        : (s.whatsapp_config_id ?? null);
      return {
        ...s,
        steps: nextSteps,
        whatsapp_config_id: automaticConnectionId,
      };
    });
    setExpandedId(node.cid);
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }));
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }));
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {
        name: state.name || t('untitled'),
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        whatsapp_config_id: state.whatsapp_config_id,
        steps: toApiSteps(state.steps),
      };

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0];
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          });
        } else {
          toast.error(body?.error ?? t('toasts.saveFailed'));
        }
        return;
      }
      toast.success(isEditing ? t('toasts.saved') : t('toasts.created'));
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-background fixed inset-0 flex flex-col">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="border-border bg-card/80 flex flex-shrink-0 items-center gap-2 border-b px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push('/automations')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 flex-shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
          aria-label={t('backToAutomations')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop('name', e.target.value)}
          placeholder={t('untitled')}
          className="text-foreground placeholder:text-muted-foreground focus:bg-muted min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold focus:outline-none sm:text-base"
        />
        {requiresWhatsApp && usableConnections.length > 1 && (
          <label className="hidden min-w-0 items-center gap-2 md:flex">
            <span className="text-muted-foreground text-xs whitespace-nowrap">
              {t('whatsapp.sendFrom')}
            </span>
            <select
              value={state.whatsapp_config_id ?? ''}
              onChange={(event) =>
                patchTop('whatsapp_config_id', event.target.value || null)
              }
              className="border-border bg-background h-9 max-w-44 cursor-pointer rounded-md border px-2 text-xs"
              aria-label={t('whatsapp.sendFrom')}
            >
              <option value="">{t('whatsapp.chooseConnection')}</option>
              {usableConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.display_name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="hidden sm:inline">{t('active')}</span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop('is_active', !!v)}
            aria-label={t('activeAria')}
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? t('save') : t('saveDraft')}
        </Button>
      </header>

      {requiresWhatsApp && usableConnections.length > 1 && (
        <label className="border-border bg-card flex items-center gap-2 border-b px-3 py-2 text-xs md:hidden">
          <span className="text-muted-foreground whitespace-nowrap">
            {t('whatsapp.sendFrom')}
          </span>
          <select
            value={state.whatsapp_config_id ?? ''}
            onChange={(event) =>
              patchTop('whatsapp_config_id', event.target.value || null)
            }
            className="border-border bg-background h-9 min-w-0 flex-1 cursor-pointer rounded-md border px-2"
          >
            <option value="">{t('whatsapp.chooseConnection')}</option>
            {usableConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.display_name}
              </option>
            ))}
          </select>
        </label>
      )}

      {requiresWhatsApp &&
        !connectionsLoading &&
        usableConnections.length === 0 && (
          <div className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            <span>{t('whatsapp.connectionRequired')}</span>
            <Link
              href="/settings?tab=whatsapp"
              className="font-medium underline underline-offset-2"
            >
              {t('whatsapp.connect')}
            </Link>
          </div>
        )}
      {requiresWhatsApp &&
        !selectedConnectionIsUsable &&
        usableConnections.length > 0 && (
          <div className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            <span>{t('whatsapp.reconnectOrChoose')}</span>
          </div>
        )}

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px]" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-0 px-4 py-10">
          <ResourcesProvider
            whatsappConfigId={state.whatsapp_config_id}
            loadPmsProperties={usesPmsTrigger}
            whatsappConnections={usableConnections}
            whatsappConnectionsLoading={connectionsLoading}
          >
            <TriggerCard
              type={state.trigger_type}
              config={state.trigger_config}
              onTypeChange={(tVal) => {
                setState((current) => ({
                  ...current,
                  trigger_type: tVal,
                  trigger_config: defaultTriggerConfig(
                    tVal
                  ) as BuilderInitial['trigger_config'],
                }));
              }}
              onConfigChange={(c) => patchTop('trigger_config', c)}
              t={t}
            />
            <StepList
              steps={state.steps}
              basePath={[]}
              scope={{ kind: 'root' }}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              updateStep={updateStep}
              addStepAt={addStepAt}
              deleteStepAt={deleteStepAt}
              moveStepAt={moveStepAt}
            />
          </ResourcesProvider>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  onTypeChange,
  onConfigChange,
  t,
}: {
  type: AutomationTriggerType;
  config: Record<string, unknown>;
  onTypeChange: (t: AutomationTriggerType) => void;
  onConfigChange: (c: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [open, setOpen] = useState(false);
  return (
    // Card width: full on mobile, fixed 320px on sm+. The canvas wrapper
    // (max-w-2xl + px-4) keeps this tidy on tablet/desktop.
    <div className="z-10 w-full max-w-[320px] sm:w-80">
      <div className="border-border bg-card rounded-lg border border-l-4 border-l-blue-500 shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] tracking-wide text-blue-300 uppercase">
              {t('trigger')}
            </div>
            <div className="text-foreground truncate text-sm font-medium">
              {t(`triggers.${type}.label`)}
            </div>
          </div>
          <ChevronDown
            className={cn(
              'text-muted-foreground h-4 w-4 transition-transform',
              open && 'rotate-180'
            )}
          />
        </button>
        {open && (
          <div className="border-border space-y-3 border-t px-4 py-3">
            <div>
              <label className="text-muted-foreground mb-1 block text-xs font-medium">
                {t('triggerType')}
              </label>
              <select
                value={type}
                onChange={(e) =>
                  onTypeChange(e.target.value as AutomationTriggerType)
                }
                className="border-border bg-muted text-foreground focus:border-primary w-full rounded-md border px-2 py-1.5 text-sm focus:outline-none"
              >
                {!ALL_AUTOMATION_TRIGGER_OPTIONS.includes(type) && (
                  <option value={type} disabled>
                    {t(`triggers.${type}.label`)}
                  </option>
                )}
                {AUTOMATION_TRIGGER_GROUPS.map((group) => (
                  <optgroup
                    key={group.label}
                    label={t(`triggerGroups.${group.label}`)}
                  >
                    {group.options.map((option) => (
                      <option key={option} value={option}>
                        {t(`triggers.${option}.label`)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-muted-foreground mt-1 text-[11px]">
                {t(`triggers.${type}.hint`)}
              </p>
            </div>
            {type === 'keyword_match' && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
                t={t}
              />
            )}
            {type === 'interactive_reply' && (
              <InteractiveReplyConfig
                config={config}
                onChange={onConfigChange}
                t={t}
              />
            )}
            {type === 'tag_added' && (
              <div>
                <label className="text-muted-foreground mb-1 block text-xs font-medium">
                  Tag
                </label>
                <TagSelect
                  value={(config.tag_id as string) ?? ''}
                  onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                  t={t}
                />
              </div>
            )}
            {type === 'time_based' && (
              <div>
                <label className="text-muted-foreground mb-1 block text-xs font-medium">
                  {t('schedule')}
                </label>
                <Input
                  placeholder={t('schedulePlaceholder')}
                  value={(config.schedule as string) ?? ''}
                  onChange={(e) =>
                    onConfigChange({ ...config, schedule: e.target.value })
                  }
                  className="bg-muted text-foreground"
                />
                <p className="text-muted-foreground mt-1 text-[11px]">
                  {t('scheduleHint')}
                </p>
              </div>
            )}
            {isPmsAutomationTrigger(type) && (
              <PmsTriggerConfigFields
                key={type}
                type={type}
                config={config as PmsTriggerConfig}
                onChange={onConfigChange}
                t={t}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PmsTriggerConfigFields({
  type,
  config,
  onChange,
  t,
}: {
  type: AutomationTriggerType;
  config: PmsTriggerConfig;
  onChange: (config: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { pmsProperties, pmsChannels, pmsReservationStatuses } = useResources();
  const selectedPropertyIds = selectedPmsPropertyIds(config);
  const [visibleConditions, setVisibleConditions] = useState<
    Set<'channels' | 'reservation_statuses'>
  >(
    () =>
      new Set([
        ...(config.channels ? ['channels' as const] : []),
        ...(config.reservation_statuses
          ? ['reservation_statuses' as const]
          : []),
      ])
  );
  const propertyOptions = [
    ...pmsProperties,
    ...selectedPropertyIds
      .filter((id) => !pmsProperties.some((property) => property.id === id))
      .map((id) => ({ id, name: null, status: 'unknown', timezone: null })),
  ];

  function setOptionalField(key: keyof PmsTriggerConfig, value: unknown) {
    onChange(
      updatePmsTriggerConfig(config, key, value) as Record<string, unknown>
    );
  }

  const scopedProperties =
    selectedPropertyIds.length > 0
      ? propertyOptions.filter((property) =>
          selectedPropertyIds.includes(property.id)
        )
      : propertyOptions.filter((property) => property.status === 'active');
  const missingTimezoneProperties = config.timezone
    ? []
    : scopedProperties.filter(
        (property) => !isValidIanaTimeZone(property.timezone)
      );

  function addCondition(key: 'channels' | 'reservation_statuses') {
    setVisibleConditions((current) => new Set([...current, key]));
  }

  function removeCondition(key: 'channels' | 'reservation_statuses') {
    setVisibleConditions((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setOptionalField(key, undefined);
  }

  return (
    <div className="border-border/70 space-y-3 border-t pt-3">
      <FieldBlock label={t('pms.properties')}>
        <FriendlyMultiSelect
          values={selectedPropertyIds}
          options={propertyOptions.map((property) => ({
            value: property.id,
            label: property.name || t('pms.unknownProperty'),
          }))}
          emptyLabel={t('pms.allProperties')}
          multipleLabel={(count) => t('pms.propertyCount', { count })}
          onChange={(values) => setOptionalField('property_ids', values)}
        />
        {propertyOptions.length === 0 && (
          <p className="text-muted-foreground mt-1 text-[11px]">
            {t('pms.noProperties')}
          </p>
        )}
      </FieldBlock>

      {isPmsScheduledAutomationTrigger(type) && (
        <>
          {type === 'before_checkin' && (
            <FriendlyDayOffset
              value={config.days_before}
              relationLabel={t('pms.beforeCheckin')}
              onChange={(value) => setOptionalField('days_before', value)}
              t={t}
            />
          )}
          {type === 'after_checkout' && (
            <FriendlyDayOffset
              value={config.days_after}
              relationLabel={t('pms.afterCheckout')}
              onChange={(value) => setOptionalField('days_after', value)}
              t={t}
            />
          )}
          <FieldBlock label={t('pms.sendAt')}>
            <Input
              type="time"
              value={config.local_time ?? ''}
              onChange={(event) =>
                setOptionalField('local_time', event.target.value)
              }
              aria-describedby={
                !config.local_time ? 'pms-send-time-help' : undefined
              }
              className="bg-muted text-foreground"
            />
            {!config.local_time && (
              <p
                id="pms-send-time-help"
                className="mt-1 text-[11px] text-amber-600 dark:text-amber-300"
              >
                {t('pms.chooseSendTime')}
              </p>
            )}
          </FieldBlock>
          <p className="text-muted-foreground text-[11px]">
            {t('pms.propertyLocalTime')}
          </p>
          {missingTimezoneProperties.length > 0 && (
            <p className="flex gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertCircle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              {t('pms.missingPropertyTimezone', {
                properties: missingTimezoneProperties
                  .slice(0, 2)
                  .map((property) => property.name || t('pms.unknownProperty'))
                  .join(', '),
              })}
            </p>
          )}
        </>
      )}

      {visibleConditions.has('channels') && (
        <OptionalPmsCondition
          label={t('pms.channels')}
          onRemove={() => removeCondition('channels')}
          removeLabel={t('pms.removeCondition')}
        >
          <FriendlyMultiSelect
            values={config.channels ?? []}
            options={withSavedOptions(pmsChannels, config.channels)}
            emptyLabel={t('pms.anyChannel')}
            multipleLabel={(count) => t('pms.channelCount', { count })}
            onChange={(values) => setOptionalField('channels', values)}
          />
        </OptionalPmsCondition>
      )}
      {visibleConditions.has('reservation_statuses') && (
        <OptionalPmsCondition
          label={t('pms.reservationStatuses')}
          onRemove={() => removeCondition('reservation_statuses')}
          removeLabel={t('pms.removeCondition')}
        >
          <FriendlyMultiSelect
            values={config.reservation_statuses ?? []}
            options={withSavedOptions(
              pmsReservationStatuses,
              config.reservation_statuses
            )}
            emptyLabel={t('pms.anyStatus')}
            multipleLabel={(count) => t('pms.statusCount', { count })}
            onChange={(values) =>
              setOptionalField('reservation_statuses', values)
            }
          />
        </OptionalPmsCondition>
      )}

      {visibleConditions.size < 2 && (
        <DropdownMenu>
          <DropdownMenuTrigger className="text-primary flex cursor-pointer items-center gap-1.5 text-xs font-medium hover:underline">
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            {t('pms.addCondition')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            {!visibleConditions.has('channels') && (
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => addCondition('channels')}
              >
                {t('pms.channels')}
              </DropdownMenuItem>
            )}
            {!visibleConditions.has('reservation_statuses') && (
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => addCondition('reservation_statuses')}
              >
                {t('pms.reservationStatuses')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function FriendlyDayOffset({
  value,
  relationLabel,
  onChange,
  t,
}: {
  value?: number;
  relationLabel: string;
  onChange: (value: number | undefined) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <FieldBlock label={t('pms.when')}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={PMS_OFFSET_DAYS_MIN}
          max={PMS_OFFSET_DAYS_MAX}
          step={1}
          value={value ?? ''}
          onChange={(event) =>
            onChange(
              event.target.value === '' ? undefined : Number(event.target.value)
            )
          }
          className="bg-muted text-foreground w-20"
        />
        <span className="text-muted-foreground text-xs">
          {t('pms.days', { count: value ?? 0 })} {relationLabel}
        </span>
      </div>
    </FieldBlock>
  );
}

function FriendlyMultiSelect({
  values,
  options,
  emptyLabel,
  multipleLabel,
  onChange,
}: {
  values: string[];
  options: FriendlyFilterOption[];
  emptyLabel: string;
  multipleLabel: (count: number) => string;
  onChange: (values: string[]) => void;
}) {
  const selectedLabels = values
    .map((value) => options.find((option) => option.value === value)?.label)
    .filter((label): label is string => Boolean(label));
  const buttonLabel =
    selectedLabels.length === 0
      ? emptyLabel
      : selectedLabels.length === 1
        ? selectedLabels[0]
        : multipleLabel(selectedLabels.length);

  function toggle(value: string, checked: boolean) {
    onChange(
      checked
        ? [...new Set([...values, value])]
        : values.filter((selected) => selected !== value)
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          SELECT_CLASS,
          'flex cursor-pointer items-center justify-between text-left'
        )}
      >
        <span className="truncate">{buttonLabel}</span>
        <ChevronDown
          className="text-muted-foreground h-3.5 w-3.5 shrink-0"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-64 min-w-(--anchor-width)"
      >
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => onChange([])}
        >
          {emptyLabel}
        </DropdownMenuItem>
        {options.length > 0 && <DropdownMenuSeparator />}
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            className="cursor-pointer"
            checked={values.includes(option.value)}
            onCheckedChange={(checked) =>
              toggle(option.value, checked === true)
            }
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OptionalPmsCondition({
  label,
  removeLabel,
  onRemove,
  children,
}: {
  label: string;
  removeLabel: string;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border/70 rounded-md border p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {label}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px] hover:underline"
          aria-label={`${removeLabel}: ${label}`}
        >
          {removeLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

function withSavedOptions(
  options: FriendlyFilterOption[],
  savedValues: string[] | undefined
): FriendlyFilterOption[] {
  return [
    ...options,
    ...(savedValues ?? [])
      .filter((value) => !options.some((option) => option.value === value))
      .map((value) => ({
        value,
        label: value
          .replace(/[_-]+/g, ' ')
          .replace(/\b\w/g, (character) => character.toUpperCase()),
      })),
  ];
}

function KeywordMatchConfig({
  config,
  onChange,
  t,
}: {
  config: KeywordMatchTriggerConfig;
  onChange: (c: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const keywords = config?.keywords ?? [];
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(', '));

  // Persist the default the <select> displays. The dropdown falls back to
  // "contains" for display, but leaving it untouched would otherwise omit
  // match_type from the saved config — and activation validation then
  // rejected it (trigger.match_type). Seed once on mount; the component
  // remounts when the trigger type changes, matching the keywords draft.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: 'contains' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit() {
    const parsed = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setDraft(parsed.join(', '));
    onChange({ ...config, keywords: parsed });
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          {t('keywords')}
        </label>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={t('keywordsHint')}
          className="bg-muted text-foreground"
        />
      </div>
      <div>
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          {t('config.matchType')}
        </label>
        <select
          value={config?.match_type ?? 'contains'}
          onChange={(e) =>
            onChange({
              ...config,
              match_type: e.target.value as 'exact' | 'contains' | 'word',
            })
          }
          className="border-border bg-muted text-foreground w-full rounded-md border px-2 py-1.5 text-sm focus:outline-none"
        >
          <option value="contains">{t('config.matchContains')}</option>
          <option value="word">{t('config.matchWord')}</option>
          <option value="exact">{t('config.matchExact')}</option>
        </select>
        {/* Only worth explaining for `word` — "contains" and "exact" read
            for themselves, and this is the one that changes which messages
            fire an automation in a way that isn't obvious. */}
        {config?.match_type === 'word' && (
          <p className="text-muted-foreground mt-1 text-xs">
            {t('config.matchWordHint')}
          </p>
        )}
      </div>
    </div>
  );
}

function InteractiveReplyConfig({
  config,
  onChange,
  t,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const ids = (config?.reply_ids as string[] | undefined) ?? [];
  // Same local-draft-then-commit pattern as KeywordMatchConfig so
  // commas + spaces survive keystrokes.
  const [draft, setDraft] = useState(ids.join(', '));

  function commit() {
    const parsed = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setDraft(parsed.join(', '));
    onChange({ ...config, reply_ids: parsed });
  }

  return (
    <div>
      <label className="text-muted-foreground mb-1 block text-xs font-medium">
        {t('replyIds')}
      </label>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={t('replyIdsHint')}
        className="bg-muted text-foreground font-mono"
      />
      <p className="text-muted-foreground mt-1 text-[11px]">
        {t('replyIdsHelp')}
      </p>
    </div>
  );
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

interface StepListProps {
  steps: BuilderStep[];
  /**
   * Path of the step that owns this list — `[]` for the root canvas,
   * the condition's own path for a branch column. Combined with
   * `scope` by `childPath` to address each child.
   */
  basePath: StepPath;
  /** Which bucket this list reads and writes. */
  scope: ParentScope;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  updateStep: (
    path: StepPath,
    updater: (s: BuilderStep) => BuilderStep
  ) => void;
  addStepAt: (
    parent: ParentScope,
    index: number,
    type: AutomationStepType
  ) => void;
  deleteStepAt: (path: StepPath) => void;
  moveStepAt: (path: StepPath, direction: -1 | 1) => void;
}

function StepList(props: StepListProps) {
  const { steps, basePath, scope, ...rest } = props;

  return (
    <div className="flex w-full flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(scope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          basePath={basePath}
          scope={scope}
          {...rest}
        />
      ))}
    </div>
  );
}

function StepRenderer({
  step,
  index,
  total,
  scope,
  basePath,
  ...props
}: {
  step: BuilderStep;
  index: number;
  total: number;
  scope: ParentScope;
  basePath: StepPath;
} & Omit<StepListProps, 'steps' | 'basePath' | 'scope'>) {
  const t = useTranslations('Automations.builder');
  const path = childPath(basePath, scope, index);
  const meta = STEP_META[step.step_type];
  const Icon = meta.icon;
  const expanded = props.expandedId === step.cid;
  const isCondition = step.step_type === 'condition';
  const nested = basePath.length > 0;
  // Card widths on mobile fill the full canvas column (max-w-2xl px-4
  // still keeps them reasonable). On sm+ fixed widths come back so the
  // flow visual stays recognisable — but only at the top level: a
  // branch column is a fraction of its condition's width, so a 320px
  // card inside one overflowed its own column and dragged the editor's
  // controls out of reach (issue #474). Nested cards fill the column
  // they were given instead.
  //
  // A condition is wider than a plain step because it has to hold two
  // branch columns side by side; 600px (the canvas is max-w-2xl, i.e.
  // 640px of content) leaves each branch ~294px — near enough to the
  // 320px a step gets at the top level for the same editors to fit.
  const width = nested
    ? 'w-full'
    : isCondition
      ? 'w-full max-w-[600px] sm:w-[600px]'
      : 'w-full max-w-[320px] sm:w-80';

  return (
    <>
      <div className={cn('z-10 flex min-w-0 flex-col', width)}>
        <div
          className={cn(
            'border-border bg-card rounded-lg border border-l-4 shadow-lg',
            meta.border
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical
              className="text-muted-foreground h-4 w-4 flex-shrink-0"
              aria-hidden
            />
            <div className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-muted-foreground text-[11px] tracking-wide uppercase">
                {isCondition
                  ? t('kindCondition')
                  : step.step_type === 'wait'
                    ? t('kindWait')
                    : t('kindAction')}
              </div>
              <div className="text-foreground truncate text-sm font-medium">
                {t(`steps.${meta.label}`)}
              </div>
              <div className="text-muted-foreground truncate text-[11px]">
                {previewFor(step)}
              </div>
            </div>
            <ChevronDown
              className={cn(
                'text-muted-foreground h-4 w-4 transition-transform',
                expanded && 'rotate-180'
              )}
            />
          </button>
          {expanded && (
            <div className="border-border border-t px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <div className="border-border mt-3 flex items-center justify-between gap-2 border-t pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="cursor-pointer disabled:cursor-not-allowed"
                    disabled={index === 0}
                    aria-label={t('moveUp')}
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="cursor-pointer disabled:cursor-not-allowed"
                    disabled={index === total - 1}
                    aria-label={t('moveDown')}
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('delete')}
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} path={path} {...props} />
        )}
      </div>

      {/* A condition branches into Yes/No (rendered above by
          ConditionBranches), so it has no linear "continue" path — adding
          the trailing connector here would produce a spurious third output. */}
      {!isCondition && (
        <AddButton onPick={(t) => props.addStepAt(scope, index + 1, t)} />
      )}
    </>
  );
}

function ConditionBranches({
  step,
  path,
  ...props
}: {
  step: BuilderStep;
  /** The condition's OWN path. Children hang off it, one marker each. */
  path: StepPath;
} & Omit<StepListProps, 'steps' | 'basePath' | 'scope'>) {
  const t = useTranslations('Automations.builder');
  const yes = step.branches?.yes ?? [];
  const no = step.branches?.no ?? [];
  return (
    // Stack Yes/No vertically until THIS CARD is wide enough for two
    // columns. A viewport breakpoint can't tell: a condition nested in
    // a branch is a fraction of the screen, and `sm:grid-cols-2` split
    // it anyway, leaving two columns too narrow to render a step in.
    <div className="@container mt-3 w-full">
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
        <BranchColumn label={t('branches.yes')} color="text-primary">
          <StepList
            {...props}
            steps={yes}
            basePath={path}
            scope={{ kind: 'branch', parentCid: step.cid, branch: 'yes' }}
          />
        </BranchColumn>
        <BranchColumn label={t('branches.no')} color="text-rose-400">
          <StepList
            {...props}
            steps={no}
            basePath={path}
            scope={{ kind: 'branch', parentCid: step.cid, branch: 'no' }}
          />
        </BranchColumn>
      </div>
    </div>
  );
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center">
      <div className={cn('mb-2 text-[11px] font-semibold uppercase', color)}>
        {label}
      </div>
      {children}
    </div>
  );
}

function AddButton({ onPick }: { onPick: (t: AutomationStepType) => void }) {
  const t = useTranslations('Automations.builder');
  const { whatsappConnections, whatsappConnectionsLoading } = useResources();
  const whatsappAvailable = whatsappConnections.length > 0;
  return (
    <div className="relative flex flex-col items-center">
      <div className="bg-border h-4 w-[2px]" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="border-border bg-background text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-dashed transition-colors"
          aria-label={t('addStep')}
        >
          <Plus className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="border-border bg-popover max-h-80 min-w-56 overflow-y-auto"
        >
          {ADDABLE_STEPS.map((tp) => {
            const Icon = STEP_META[tp].icon;
            const availability = automationActionAvailability(tp, {
              connectionsLoading: whatsappConnectionsLoading,
              usableConnectionCount: whatsappConnections.length,
            });
            const disabled = !availability.enabled;
            return (
              <DropdownMenuItem
                key={tp}
                disabled={disabled}
                aria-disabled={disabled}
                onClick={() => onPick(tp)}
                className="cursor-pointer items-start py-1.5 data-disabled:cursor-not-allowed"
              >
                <Icon className="h-4 w-4" />
                <span className="flex min-w-0 flex-col">
                  <span>{t(`steps.${STEP_META[tp].label}`)}</span>
                  {disabled && (
                    <span className="text-muted-foreground text-[11px] font-normal">
                      {availability.reason === 'checking'
                        ? t('whatsapp.checkingConnection')
                        : t('whatsapp.connectionRequiredShort')}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            );
          })}
          {!whatsappConnectionsLoading && !whatsappAvailable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="max-w-60 font-normal whitespace-normal">
                  {t('whatsapp.connectBeforeUsing')}
                </DropdownMenuLabel>
                <DropdownMenuItem className="cursor-pointer">
                  <Link
                    href="/settings?tab=whatsapp"
                    className="text-primary w-full font-medium"
                  >
                    {t('whatsapp.connect')}
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="bg-border h-4 w-[2px]" aria-hidden />
    </div>
  );
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep;
  onChange: (s: BuilderStep) => void;
}) {
  const t = useTranslations('Automations.builder');
  const cfg = step.step_config;
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } });

  switch (step.step_type) {
    case 'send_message':
      return (
        <FieldBlock label={t('config.messageText')}>
          <Textarea
            value={(cfg.text as string) ?? ''}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t('config.placeholderMessageText')}
            className="bg-muted text-foreground min-h-24"
          />
        </FieldBlock>
      );
    case 'send_buttons':
    case 'send_list':
      // The whole step_config IS the interactive payload; the shared
      // builder edits it in place (and enforces Meta's limits + preview).
      return (
        <InteractiveBuilder
          value={asInteractive(cfg)}
          onChange={(payload) =>
            onChange({ ...step, step_config: toStepConfig(payload) })
          }
        />
      );
    case 'send_template':
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ''}
          language={(cfg.language as string) ?? ''}
          onChange={(patch) => set(patch)}
          t={t}
        />
      );
    case 'add_tag':
    case 'remove_tag':
      return (
        <FieldBlock label={t('config.tagLabel')}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ''}
            onChange={(v) => set({ tag_id: v })}
            t={t}
          />
        </FieldBlock>
      );
    case 'assign_conversation':
      return (
        <>
          <FieldBlock label={t('config.modeLabel')}>
            <select
              value={(cfg.mode as string) ?? 'round_robin'}
              onChange={(e) => set({ mode: e.target.value })}
              className="border-border bg-muted text-foreground w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="round_robin">
                {t('config.modes.round_robin')}
              </option>
              <option value="specific">{t('config.modes.specific')}</option>
            </select>
          </FieldBlock>
          {cfg.mode === 'specific' && (
            <FieldBlock label={t('config.agentLabel')}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ''}
                onChange={(v) => set({ agent_id: v })}
                t={t}
              />
            </FieldBlock>
          )}
        </>
      );
    case 'update_contact_field':
      return (
        <>
          <FieldBlock label={t('config.fieldLabel')}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? 'name'}
              onChange={(v) => set({ field: v })}
              t={t}
            />
          </FieldBlock>
          <FieldBlock label={t('config.valueLabel')}>
            <Input
              value={(cfg.value as string) ?? ''}
              onChange={(e) => set({ value: e.target.value })}
              placeholder={t.raw('config.placeholderValue')}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      );
    case 'create_deal':
      return (
        <>
          <DealPipelineFields
            pipelineId={(cfg.pipeline_id as string) ?? ''}
            stageId={(cfg.stage_id as string) ?? ''}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <FieldBlock label={t('config.titleLabel')}>
            <Input
              value={(cfg.title as string) ?? ''}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t('config.valueLabel')}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      );
    case 'wait':
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t('config.amountLabel')}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) =>
                set({ amount: Math.max(1, Number(e.target.value)) })
              }
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t('config.unitLabel')}>
            <select
              value={(cfg.unit as string) ?? 'hours'}
              onChange={(e) => set({ unit: e.target.value })}
              className="border-border bg-muted text-foreground w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="minutes">{t('config.units.minutes')}</option>
              <option value="hours">{t('config.units.hours')}</option>
              <option value="days">{t('config.units.days')}</option>
            </select>
          </FieldBlock>
        </div>
      );
    case 'condition':
      return (
        <>
          <FieldBlock label={t('config.subjectLabel')}>
            <select
              value={(cfg.subject as string) ?? 'tag_presence'}
              onChange={(e) => set({ subject: e.target.value })}
              className="border-border bg-muted text-foreground w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="tag_presence">
                {t('config.subjects.tag_presence')}
              </option>
              <option value="contact_field">
                {t('config.subjects.contact_field')}
              </option>
              <option value="message_content">
                {t('config.subjects.message_content')}
              </option>
              <option value="time_of_day">
                {t('config.subjects.time_of_day')}
              </option>
            </select>
          </FieldBlock>
          <FieldBlock label={t('config.operandLabel')}>
            <Input
              placeholder={
                cfg.subject === 'time_of_day'
                  ? t('config.placeholderTime')
                  : cfg.subject === 'contact_field'
                    ? t('config.placeholderContact')
                    : cfg.subject === 'tag_presence'
                      ? t('config.placeholderTag')
                      : ''
              }
              value={(cfg.operand as string) ?? ''}
              onChange={(e) => set({ operand: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          {(cfg.subject === 'contact_field' ||
            cfg.subject === 'message_content') && (
            <FieldBlock label={t('config.valueLabel')}>
              <Input
                value={(cfg.value as string) ?? ''}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          )}
        </>
      );
    case 'send_webhook':
      return (
        <>
          <FieldBlock label={t('config.urlLabel')}>
            <Input
              value={(cfg.url as string) ?? ''}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t('config.bodyTemplateLabel')}>
            <Textarea
              value={(cfg.body_template as string) ?? ''}
              onChange={(e) => set({ body_template: e.target.value })}
              className="bg-muted text-foreground min-h-20 font-mono text-xs"
            />
          </FieldBlock>
        </>
      );
    case 'close_conversation':
      return (
        <p className="text-muted-foreground text-xs">
          {t('config.closeConversationHint', {
            defaultValue:
              'Sets the conversation status to "closed". No configuration needed.',
          })}
        </p>
      );
    default:
      return null;
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="text-muted-foreground mb-1 block text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function previewFor(step: BuilderStep): string {
  switch (step.step_type) {
    case 'send_message':
      return (step.step_config.text as string) || 'no text yet';
    case 'send_buttons':
    case 'send_list':
      return (
        interactivePayloadPreviewText(asInteractive(step.step_config)) ||
        'no body yet'
      );
    case 'send_template':
      return (step.step_config.template_name as string) || 'pick a template';
    case 'wait':
      return `${step.step_config.amount ?? '?'} ${step.step_config.unit ?? ''}`;
    case 'condition':
      return `when ${step.step_config.subject ?? '?'}`;
    case 'send_webhook':
      return (step.step_config.url as string) || 'no url';
    default:
      return '';
  }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: ApiStep[]; no?: ApiStep[] };
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }));
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] };
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === 'condition'
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }));
}
