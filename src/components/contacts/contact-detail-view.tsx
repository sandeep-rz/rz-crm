'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type {
  Contact,
  Tag,
  ContactNote,
  CustomField,
  Deal,
  MessageTemplate,
} from '@/types';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Phone,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  DollarSign,
  LayoutTemplate,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ContactStaySummary,
  ContactStays,
  ReservationDetailSheet,
  StayStatusBadge,
} from '@/components/contacts/contact-stays';
import {
  formatStayDateShort,
  loadContactStay,
  loadContactStays,
  mostRelevantStay,
  type ContactStay,
  type StayReadClient,
} from '@/lib/contacts/pms-stays';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

const tabTriggerClass =
  'h-11 flex-none rounded-none px-3 text-sm text-muted-foreground after:!opacity-0 data-active:bg-transparent data-active:text-primary data-active:!shadow-[inset_0_-2px_0_0_var(--primary)]';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);
  const [stays, setStays] = useState<ContactStay[]>([]);
  const [loadingStays, setLoadingStays] = useState(false);
  const [staysError, setStaysError] = useState(false);
  const [activeTab, setActiveTab] = useState('details');
  const [selectedStay, setSelectedStay] = useState<ContactStay | null>(null);
  const [reservationOpen, setReservationOpen] = useState(false);
  const [loadingReservation, setLoadingReservation] = useState(false);
  const [reservationError, setReservationError] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId || !accountId) return;
    setLoading(true);

    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .single();

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
    }
    setLoading(false);
  }, [accountId, contactId, supabase]);

  const fetchTags = useCallback(async () => {
    if (!contactId || !accountId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase
        .from('tags')
        .select('*')
        .eq('account_id', accountId)
        .order('name'),
      supabase
        .from('contact_tags')
        .select('tag_id')
        .eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [accountId, contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId || !accountId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [accountId, contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase
        .from('custom_fields')
        .select('*')
        .eq('account_id', accountId)
        .order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [accountId, contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId || !accountId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [accountId, contactId, supabase]);

  const fetchStays = useCallback(async () => {
    if (!contactId || !accountId) return;
    setLoadingStays(true);
    setStaysError(false);
    try {
      const rows = await loadContactStays(
        supabase as unknown as StayReadClient,
        {
          accountId,
          contactId,
        }
      );
      setStays(rows);
    } catch {
      setStays([]);
      setStaysError(true);
    } finally {
      setLoadingStays(false);
    }
  }, [accountId, contactId, supabase]);

  const openReservation = useCallback(
    async (reservationId: string) => {
      if (!contactId || !accountId) return;
      setSelectedStay(null);
      setReservationError(false);
      setLoadingReservation(true);
      setReservationOpen(true);
      try {
        const stay = await loadContactStay(
          supabase as unknown as StayReadClient,
          { accountId, contactId, reservationId }
        );
        if (!stay) {
          setReservationError(true);
          return;
        }
        setSelectedStay(stay);
      } catch {
        setReservationError(true);
      } finally {
        setLoadingReservation(false);
      }
    },
    [accountId, contactId, supabase]
  );

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
      fetchStays();
    }
  }, [
    open,
    contactId,
    fetchContact,
    fetchTags,
    fetchNotes,
    fetchCustomFields,
    fetchDeals,
    fetchStays,
  ]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contactHandle(contact));
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('toastPhoneRequired'));
      return;
    }

    // Same rule as the create form: a changed number must start with `+`
    // and a country code (issue #586). Unchanged numbers — including the
    // digits-only form the inbound webhook stores — are left alone so a
    // name/email edit is never blocked by the phone field.
    const phoneChanged = editPhone.trim() !== (contact?.phone ?? '');
    if (phoneChanged && !parseInternationalPhone(editPhone)) {
      toast.error(t('toastPhoneNeedsCountryCode'));
      return;
    }

    setSavingDetails(true);
    const { error } = await supabase
      .from('contacts')
      .update({
        name: editName.trim() || null,
        phone: editPhone.trim(),
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId)
      .eq('account_id', accountId);

    if (error) {
      toast.error(t('toastUpdateFailed'));
    } else {
      toast.success(t('toastUpdated'));
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    try {
      if (isSelected) {
        await deleteContactTag(contactId, tagId);
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
      } else {
        await addContactTag(contactId, tagId);
        setContactTagIds((prev) => [...prev, tagId]);
      }
      onUpdated();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('toastUpdateFailed')
      );
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error(t('toastNotAuthenticated'));
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error(t('toastNoteAddFailed'));
    } else {
      setNewNote('');
      fetchNotes();
      toast.success(t('toastNoteAdded'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error(t('toastNoteDeleteFailed'));
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('toastNoteDeleted'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success(t('toastCustomFieldsSaved'));
    } catch {
      toast.error(t('toastCustomFieldsFailed'));
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact, mirroring the inbox template-send payload otherwise.
          contact_id: contactId,
          message_type: 'template',
          template_id: template.id,
          reservation_id: values.reservationId,
          whatsapp_config_id: template.whatsapp_config_id,
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(t('toastTemplateFailed', { reason }));
        return;
      }

      toast.success(t('toastTemplateSent', { name: template.name }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error';
      toast.error(`Failed to send template: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  const stayHighlight = mostRelevantStay(stays);
  const stayWhen = stayHighlight?.checkIn
    ? formatStayDateShort(stayHighlight.checkIn, locale)
    : null;

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setActiveTab('details');
      setReservationOpen(false);
      setSelectedStay(null);
    }
    onOpenChange(nextOpen);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          className="bg-popover border-border text-popover-foreground gap-0 p-0 data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:w-[min(94vw,56rem)] data-[side=right]:sm:max-w-none data-[side=right]:lg:w-[min(88vw,58rem)]"
        >
          {loading || !contact ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-primary size-6 animate-spin" />
            </div>
          ) : (
            <div className="flex h-full flex-col">
              {/* Header */}
              <SheetHeader className="border-border/60 border-b px-4 py-4 pr-14 sm:px-6 sm:py-5 sm:pr-16">
                <div className="flex items-start gap-3">
                  <Avatar className="border-border bg-muted size-10 shrink-0 border">
                    <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                      {getInitials(contact.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="text-popover-foreground truncate text-base">
                      {contact.name || t('unnamed')}
                    </SheetTitle>
                    <SheetDescription className="sr-only">
                      {t('contactDetailsDesc')}
                    </SheetDescription>
                    <div className="text-muted-foreground mt-1 flex min-w-0 items-center gap-1.5 text-xs">
                      <button
                        onClick={copyPhone}
                        className="hover:text-primary flex shrink-0 cursor-pointer items-center gap-1 transition-colors"
                      >
                        <Phone className="size-3 shrink-0" />
                        {contactHandle(contact)}
                        {copiedPhone ? (
                          <Check className="text-primary size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                      {contact.email && (
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span aria-hidden="true">·</span>
                          <span className="truncate" title={contact.email}>
                            {contact.email}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {stayHighlight && (
                  <button
                    type="button"
                    onClick={() => openReservation(stayHighlight.id)}
                    className="bg-primary-soft/70 hover:bg-primary-soft mt-2.5 flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StayStatusBadge stay={stayHighlight} />
                        {stayHighlight.propertyName && (
                          <span className="text-foreground truncate text-xs font-semibold">
                            {stayHighlight.propertyName}
                          </span>
                        )}
                      </div>
                      {(stayWhen ||
                        stayHighlight.checkOut ||
                        stayHighlight.nights !== null) && (
                        <p className="text-muted-foreground mt-1 truncate text-xs">
                          {stayWhen ?? ''}
                          {stayWhen && stayHighlight.checkOut ? ' → ' : ''}
                          {stayHighlight.checkOut
                            ? formatStayDateShort(
                                stayHighlight.checkOut,
                                locale
                              )
                            : ''}
                          {stayHighlight.nights !== null
                            ? ` · ${t('staysTab.nights', { count: stayHighlight.nights })}`
                            : ''}
                        </p>
                      )}
                    </div>
                    <span
                      className="text-muted-foreground text-sm"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </button>
                )}
                <div className="mt-3 flex">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTemplatePickerOpen(true)}
                    disabled={sendingTemplate}
                    className="h-9 w-full sm:w-auto"
                  >
                    {sendingTemplate ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <LayoutTemplate className="size-4" />
                    )}
                    {t('sendTemplateBtn')}
                  </Button>
                </div>
              </SheetHeader>

              {/* Tabs */}
              <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex min-h-0 flex-1 flex-col"
              >
                <TabsList
                  variant="line"
                  className="border-border bg-popover h-12 w-full max-w-none [scrollbar-width:none] justify-start gap-1 overflow-x-auto border-b px-4 group-data-horizontal/tabs:h-12 sm:px-6 [&::-webkit-scrollbar]:hidden"
                >
                  <TabsTrigger value="details" className={tabTriggerClass}>
                    {t('tabs.details')}
                  </TabsTrigger>
                  <TabsTrigger value="stays" className={tabTriggerClass}>
                    {stays.length > 0
                      ? t('tabs.staysCount', { count: stays.length })
                      : t('tabs.stays')}
                  </TabsTrigger>
                  <TabsTrigger value="tags" className={tabTriggerClass}>
                    {t('tabs.tags')}
                  </TabsTrigger>
                  <TabsTrigger value="notes" className={tabTriggerClass}>
                    {t('tabs.notes')}
                  </TabsTrigger>
                  <TabsTrigger value="custom" className={tabTriggerClass}>
                    {t('tabs.custom')}
                  </TabsTrigger>
                  <TabsTrigger value="deals" className={tabTriggerClass}>
                    {t('tabs.deals')}
                  </TabsTrigger>
                </TabsList>

                {/* Details Tab */}
                <TabsContent
                  value="details"
                  className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5"
                >
                  <div className="space-y-5">
                    {(loadingStays || staysError || stays.length > 0) && (
                      <div className="min-w-0">
                        <ContactStaySummary
                          stays={stays}
                          loading={loadingStays}
                          error={staysError}
                          onOpenStay={openReservation}
                          onViewAll={() => setActiveTab('stays')}
                        />
                      </div>
                    )}
                    <section className="border-border/70 bg-card min-w-0 rounded-2xl border p-4 shadow-sm sm:p-5">
                      <div className="mb-4">
                        <p className="text-foreground text-sm font-semibold">
                          {t('contactInfo')}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {t('contactDetailsDesc')}
                        </p>
                      </div>
                      <div className="space-y-3.5">
                        <div className="space-y-1.5">
                          <Label className="text-muted-foreground text-xs">
                            {t('name')}
                          </Label>
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="bg-muted border-border text-foreground h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-muted-foreground text-xs">
                            {t('phone')} <span className="text-red-400">*</span>
                          </Label>
                          <Input
                            value={editPhone}
                            onChange={(e) => setEditPhone(e.target.value)}
                            className="bg-muted border-border text-foreground h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-muted-foreground text-xs">
                            {t('email')}
                          </Label>
                          <Input
                            value={editEmail}
                            onChange={(e) => setEditEmail(e.target.value)}
                            className="bg-muted border-border text-foreground h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-muted-foreground text-xs">
                            {t('company')}
                          </Label>
                          <Input
                            value={editCompany}
                            onChange={(e) => setEditCompany(e.target.value)}
                            className="bg-muted border-border text-foreground h-8 text-sm"
                          />
                        </div>
                        <Button
                          onClick={saveDetails}
                          disabled={savingDetails}
                          className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                          size="sm"
                        >
                          {savingDetails ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Save className="size-3.5" />
                          )}
                          {t('saveChangesBtn')}
                        </Button>
                      </div>
                    </section>
                  </div>
                </TabsContent>

                {/* Tags Tab */}
                <TabsContent
                  value="tags"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  <div className="space-y-3">
                    <p className="text-muted-foreground text-xs">
                      {t('tagsTab.clickTagDesc')}
                    </p>
                    {allTags.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        {t('tagsTab.noTagsAvailable')}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {allTags.map((tag) => {
                          const selected = contactTagIds.includes(tag.id);
                          return (
                            <button
                              key={tag.id}
                              onClick={() => toggleTag(tag.id)}
                              disabled={savingTags}
                              className={`inline-flex cursor-pointer items-center rounded-full px-3 py-1 text-xs font-medium transition-all ${
                                selected
                                  ? 'ring-primary ring-offset-border ring-2 ring-offset-1'
                                  : 'opacity-50 hover:opacity-80'
                              }`}
                              style={{
                                backgroundColor: tag.color + '20',
                                color: tag.color,
                              }}
                            >
                              {selected && <Check className="mr-1 size-3" />}
                              {tag.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* Notes Tab */}
                <TabsContent
                  value="notes"
                  className="flex min-h-0 flex-1 flex-col px-4 py-3"
                >
                  <div className="mb-3 space-y-2">
                    <Textarea
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      placeholder={t('notesTab.placeholder')}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] resize-none text-sm"
                    />
                    <Button
                      onClick={addNote}
                      disabled={!newNote.trim() || savingNote}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground"
                      size="sm"
                    >
                      {savingNote ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      {t('notesTab.save')}
                    </Button>
                  </div>

                  <div className="flex-1 space-y-2 overflow-y-auto">
                    {loadingNotes ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="text-muted-foreground size-5 animate-spin" />
                      </div>
                    ) : notes.length === 0 ? (
                      <p className="text-muted-foreground py-8 text-center text-sm">
                        {t('notesTab.noNotes')}
                      </p>
                    ) : (
                      notes.map((note) => (
                        <div
                          key={note.id}
                          className="bg-muted/50 border-border/50 group rounded-lg border p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-muted-foreground flex-1 text-sm whitespace-pre-wrap">
                              {note.note_text}
                            </p>
                            <button
                              onClick={() => deleteNote(note.id)}
                              className="text-muted-foreground shrink-0 cursor-pointer opacity-0 transition-all group-hover:opacity-100 hover:text-red-400"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                          <p className="text-muted-foreground mt-1.5 text-xs">
                            {new Date(note.created_at).toLocaleDateString(
                              'en-US',
                              {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              }
                            )}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </TabsContent>

                {/* Custom Fields Tab */}
                <TabsContent
                  value="custom"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  {loadingCustom ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-muted-foreground size-5 animate-spin" />
                    </div>
                  ) : customFields.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      {t('noCustomFields')}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {customFields.map((field) => (
                        <div key={field.id} className="space-y-1.5">
                          <Label className="text-muted-foreground text-xs capitalize">
                            {field.field_name}
                          </Label>
                          <Input
                            value={customValues[field.id] ?? ''}
                            onChange={(e) =>
                              setCustomValues((prev) => ({
                                ...prev,
                                [field.id]: e.target.value,
                              }))
                            }
                            placeholder={t('enterCustomField', {
                              name: field.field_name,
                            })}
                            className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-sm"
                          />
                        </div>
                      ))}
                      <Button
                        onClick={saveCustomFields}
                        disabled={savingCustom}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                        size="sm"
                      >
                        {savingCustom ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Save className="size-3.5" />
                        )}
                        {t('saveCustomFieldsBtn')}
                      </Button>
                    </div>
                  )}
                </TabsContent>

                {/* Deals Tab */}
                <TabsContent
                  value="deals"
                  className="flex-1 overflow-y-auto px-4 py-3"
                >
                  {loadingDeals ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-primary size-5 animate-spin" />
                    </div>
                  ) : deals.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t('dealsTab.noDeals')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {deals.map((deal) => (
                        <div
                          key={deal.id}
                          className="border-border bg-muted/50 rounded-lg border p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-foreground text-sm font-medium">
                              {deal.title}
                            </p>
                            {deal.stage && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{
                                  backgroundColor: `${deal.stage.color}20`,
                                  color: deal.stage.color,
                                }}
                              >
                                {deal.stage.name}
                              </span>
                            )}
                          </div>
                          <div className="text-muted-foreground mt-1.5 flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1">
                              <DollarSign className="size-3" />
                              {formatCurrency(
                                deal.value ?? 0,
                                deal.currency || defaultCurrency
                              )}
                            </span>
                            {deal.status && deal.status !== 'open' && (
                              <span
                                className={
                                  deal.status === 'won'
                                    ? 'text-primary'
                                    : 'text-red-400'
                                }
                              >
                                {deal.status}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent
                  value="stays"
                  className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5"
                >
                  {loadingStays ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2
                        className="text-primary size-5 animate-spin"
                        aria-label={t('staysTab.loading')}
                      />
                    </div>
                  ) : (
                    <ContactStays
                      stays={stays}
                      error={staysError}
                      onOpenStay={openReservation}
                    />
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <ReservationDetailSheet
        open={reservationOpen}
        onOpenChange={setReservationOpen}
        stay={selectedStay}
        loading={loadingReservation}
        error={reservationError}
        guest={{
          name: contact?.name ?? null,
          phone: contact?.phone ?? null,
          email: contact?.email ?? null,
        }}
      />
      <TemplatePicker
        contactId={contactId}
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleSendTemplate}
      />
    </>
  );
}
