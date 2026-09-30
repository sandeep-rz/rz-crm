'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { BedDouble, ChevronLeft, ChevronRight, Loader2, Search, SlidersHorizontal } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import { parseReservation, type ReservationLifecycle, type ReservationRecord } from '@/lib/reservations';
import { formatStayDateShort, formatStayTotal, nightsBetween, stayStatusLabel } from '@/lib/contacts/pms-stays';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const PAGE_SIZE = 25;
const LIFECYCLES = ['upcoming', 'staying_now', 'checked_out', 'cancelled', 'all'] as const;
type View = (typeof LIFECYCLES)[number];

interface PropertyOption { id: string; name: string | null; initial_sync_status: string }
interface IntegrationState { status: string; last_sync_at: string | null }

export function ReservationsPage() {
  const { accountId } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const params = useSearchParams();
  const router = useRouter();
  const requestId = useRef(0);
  const view = validView(params.get('view'));
  const page = Math.max(1, Number(params.get('page')) || 1);
  const search = params.get('q') ?? '';
  const property = params.get('property') ?? 'all';
  const channel = params.get('channel') ?? 'all';
  const status = params.get('status') ?? 'all';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const [searchDraft, setSearchDraft] = useState(search);
  const [rows, setRows] = useState<ReservationRecord[]>([]);
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationState[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<ReservationRecord | null>(null);

  const setParams = useCallback((changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (!value || value === 'all') next.delete(key); else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    router.replace(`/reservations${next.size ? `?${next}` : ''}`);
  }, [params, router]);

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    Promise.all([
      supabase.from('pms_properties').select('id, name, initial_sync_status').eq('account_id', accountId).order('name'),
      supabase.from('pms_integrations').select('status, last_sync_at').eq('account_id', accountId),
      supabase.rpc('get_crm_reservation_filter_options', { p_account_id: accountId }),
    ]).then(([propertyResult, integrationResult, optionResult]) => {
      if (!active) return;
      setProperties((propertyResult.data ?? []) as PropertyOption[]);
      setIntegrations((integrationResult.data ?? []) as IntegrationState[]);
      const options = optionResult.data as { channels?: unknown; statuses?: unknown } | null;
      setChannels(stringList(options?.channels));
      setStatuses(stringList(options?.statuses));
    });
    return () => { active = false; };
  }, [accountId, supabase]);

  useEffect(() => {
    if (!accountId) return;
    const id = ++requestId.current;
    const load = async () => {
      setLoading(true);
      setError(false);
      const { data, error: queryError } = await supabase.rpc('list_crm_reservations', {
        p_account_id: accountId,
        p_lifecycle: view,
        p_search: search.trim() || null,
        p_property_id: property === 'all' ? null : property,
        p_channel: channel === 'all' ? null : channel,
        p_status: status === 'all' ? null : status,
        p_date_from: from || null,
        p_date_to: to || null,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
      });
      if (id !== requestId.current) return;
      setError(Boolean(queryError));
      setRows(queryError ? [] : ((data ?? []) as Record<string, unknown>[]).flatMap((row) => {
        const parsed = parseReservation(row);
        return parsed ? [parsed] : [];
      }));
      setLoading(false);
    };
    void load();
  }, [accountId, channel, from, page, property, search, status, supabase, to, view]);

  const total = rows[0]?.totalCount ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(search || property !== 'all' || channel !== 'all' || status !== 'all' || from || to);
  const connected = integrations.some((item) => item.status === 'connected');
  const syncing = properties.some((item) => item.initial_sync_status === 'pending' || item.initial_sync_status === 'syncing') || integrations.some((item) => item.status === 'provisioning' || item.status === 'pending');
  const lastSync = integrations.map((item) => item.last_sync_at).filter(Boolean).sort().at(-1);

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reservations</h1>
          <p className="text-muted-foreground text-sm">Guest stay context synchronized from your connected PMS.</p>
        </div>
        {connected && <p className="text-muted-foreground text-xs">Connected{lastSync ? ` · Last synced ${new Date(lastSync).toLocaleString()}` : ''}</p>}
      </header>

      <Tabs value={view} onValueChange={(value) => setParams({ view: value === 'upcoming' ? null : value })}>
        <TabsList className="h-auto flex-wrap justify-start">
          {LIFECYCLES.map((item) => <TabsTrigger key={item} value={item}>{viewLabel(item)}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <section className="border-border bg-card space-y-3 rounded-xl border p-3 sm:p-4" aria-label="Reservation filters">
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setParams({ q: searchDraft.trim() || null }); }}>
          <div className="relative flex-1"><Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" /><Input className="pl-9" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search guest, reference, phone, email, property or channel" /></div>
          <Button type="submit">Search</Button>
        </form>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <FilterSelect label="Property" value={property} values={properties.map((item) => ({ value: item.id, label: item.name ?? 'Unnamed property' }))} onChange={(value) => setParams({ property: value })} />
          <FilterSelect label="Channel" value={channel} values={channels.map((value) => ({ value, label: value }))} onChange={(value) => setParams({ channel: value })} />
          <FilterSelect label="Status" value={status} values={statuses.map((value) => ({ value, label: stayStatusLabel(value) }))} onChange={(value) => setParams({ status: value })} />
          <label className="space-y-1"><span className="text-muted-foreground text-xs">Stay from</span><Input type="date" value={from} onChange={(event) => setParams({ from: event.target.value || null })} /></label>
          <label className="space-y-1"><span className="text-muted-foreground text-xs">Stay to</span><Input type="date" value={to} onChange={(event) => setParams({ to: event.target.value || null })} /></label>
        </div>
        {hasFilters && <Button variant="ghost" size="sm" onClick={() => router.replace(`/reservations${view === 'upcoming' ? '' : `?view=${view}`}`)}><SlidersHorizontal className="size-4" />Reset filters</Button>}
      </section>

      {loading ? <div className="flex min-h-56 items-center justify-center"><Loader2 className="text-primary size-6 animate-spin" aria-label="Loading reservations" /></div>
        : error ? <Empty title="Reservations could not be loaded" body="Check that the latest database migration is applied, then try again." />
        : rows.length === 0 ? <EmptyState connected={connected} syncing={syncing} filtered={hasFilters} />
        : <>
          <div className="border-border hidden overflow-hidden rounded-xl border md:block"><ReservationTable rows={rows} onSelect={setSelected} /></div>
          <div className="space-y-2 md:hidden">{rows.map((row) => <ReservationCard key={row.id} row={row} onSelect={() => setSelected(row)} />)}</div>
          <div className="flex items-center justify-between"><p className="text-muted-foreground text-sm">{total} reservation{total === 1 ? '' : 's'}</p><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}><ChevronLeft className="size-4" />Previous</Button><span className="text-sm">{page} / {pages}</span><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setParams({ page: String(page + 1) })}>Next<ChevronRight className="size-4" /></Button></div></div>
        </>}
      <ReservationSheet row={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </div>
  );
}

function ReservationTable({ rows, onSelect }: { rows: ReservationRecord[]; onSelect: (row: ReservationRecord) => void }) {
  return <Table><TableHeader><TableRow><TableHead>Guest</TableHead><TableHead>Property</TableHead><TableHead>Reference</TableHead><TableHead>Channel</TableHead><TableHead>Stay</TableHead><TableHead>Status</TableHead><TableHead>Guests</TableHead><TableHead className="text-right">Value</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.id} tabIndex={0} className="cursor-pointer" onClick={() => onSelect(row)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(row); }}><TableCell><p className="max-w-44 truncate font-medium">{row.guestName ?? 'Unlinked guest'}</p>{row.contactId && <span className="text-primary text-xs">CRM contact</span>}</TableCell><TableCell className="max-w-44 truncate">{row.propertyName ?? 'Unnamed property'}</TableCell><TableCell>{row.reservationCode ?? '—'}</TableCell><TableCell>{row.channel ?? '—'}</TableCell><TableCell>{stayRange(row)}</TableCell><TableCell><LifecycleBadge row={row} /></TableCell><TableCell>{guestCount(row) ?? '—'}</TableCell><TableCell className="text-right">{row.totalAmount === null ? '—' : formatStayTotal(row.totalAmount, row.currency, 'en')}</TableCell></TableRow>)}</TableBody></Table>;
}

export function ReservationCard({ row, onSelect }: { row: ReservationRecord; onSelect: () => void }) { return <button type="button" onClick={onSelect} className="border-border bg-card w-full rounded-xl border p-4 text-left"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold">{row.guestName ?? 'Unlinked guest'}</p><p className="text-muted-foreground truncate text-sm">{row.propertyName ?? 'Unnamed property'}</p></div><LifecycleBadge row={row} /></div><p className="text-muted-foreground mt-3 text-sm">{stayRange(row)}{row.channel ? ` · ${row.channel}` : ''}</p>{row.reservationCode && <p className="text-muted-foreground mt-1 text-xs">{row.reservationCode}</p>}</button>; }

function ReservationSheet({ row, onOpenChange }: { row: ReservationRecord | null; onOpenChange: (open: boolean) => void }) {
  if (!row) return null;
  const nights = nightsBetween(row.checkIn, row.checkOut);
  return <Sheet open onOpenChange={onOpenChange}><SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:w-[min(92vw,42rem)] data-[side=right]:sm:max-w-none"><SheetHeader><SheetTitle>{row.propertyName ?? 'Reservation details'}</SheetTitle><SheetDescription>{stayRange(row)}</SheetDescription></SheetHeader><div className="space-y-6 p-4"><Detail title="Reservation" values={[['Reference', row.reservationCode], ['Status', stayStatusLabel(row.status)], ['Provider status', row.providerStatus && row.providerStatus !== row.status ? stayStatusLabel(row.providerStatus) : null], ['Channel', row.channel]]} /><Detail title="Stay" values={[['Property', row.propertyName], ['Check-in', row.checkIn], ['Check-out', row.checkOut], ['Nights', nights === null ? null : String(nights)], ['Guests', guestCount(row)?.toString() ?? null]]} /><Detail title="Guest" values={[['Name', row.guestName], ['Phone', row.guestPhone], ['Email', row.guestEmail]]} />{row.contactId && <Link href={`/contacts?contact=${row.contactId}`} className="text-primary text-sm font-medium hover:underline">Open CRM contact</Link>}<Detail title="Value" values={[['Total', row.totalAmount === null ? null : formatStayTotal(row.totalAmount, row.currency, 'en')], ['Currency', row.currency]]} /><Detail title="Source" values={[['PMS', row.providerName ?? providerLabel(row.provider)], ['Last synced', row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : null]]} /></div></SheetContent></Sheet>;
}

function Detail({ title, values }: { title: string; values: [string, string | null][] }) { const visible = values.filter(([, value]) => value); if (!visible.length) return null; return <section><h3 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase">{title}</h3><dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">{visible.map(([label, value]) => <div key={label}><dt className="text-muted-foreground text-xs">{label}</dt><dd className="break-words text-sm">{value}</dd></div>)}</dl></section>; }
function FilterSelect({ label, value, values, onChange }: { label: string; value: string; values: { value: string; label: string }[]; onChange: (value: string) => void }) { return <div className="space-y-1"><Label className="text-muted-foreground text-xs">{label}</Label><Select value={value} onValueChange={(next) => next && onChange(next)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All {label.toLowerCase()}s</SelectItem>{values.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>; }
function LifecycleBadge({ row }: { row: ReservationRecord }) { const style = row.lifecycle === 'staying_now' ? 'bg-emerald-100 text-emerald-800' : row.lifecycle === 'cancelled' ? 'bg-red-100 text-red-800' : row.lifecycle === 'checked_out' ? 'bg-muted text-muted-foreground' : 'bg-blue-100 text-blue-800'; return <Badge className={style}>{viewLabel(row.lifecycle)}</Badge>; }
export function EmptyState({ connected, syncing, filtered }: { connected: boolean; syncing: boolean; filtered: boolean }) { if (filtered) return <Empty title="No reservations match these filters" body="Adjust or reset the filters to see more stays." />; if (!connected && !syncing) return <Empty title="No PMS connected" body="Connect a property management system in Settings to bring reservation context into CRM." />; if (syncing) return <Empty title="Syncing reservations…" body="Your first reservation sync is still in progress." />; return <Empty title="No reservations found" body="The PMS is connected, but no reservations have been synchronized yet." />; }
function Empty({ title, body }: { title: string; body: string }) { return <div className="border-border rounded-xl border border-dashed px-6 py-14 text-center"><BedDouble className="text-muted-foreground mx-auto mb-3 size-7" /><h2 className="font-semibold">{title}</h2><p className="text-muted-foreground mt-1 text-sm">{body}</p></div>; }
function validView(value: string | null): View { return LIFECYCLES.includes(value as View) ? value as View : 'upcoming'; }
function viewLabel(value: View | ReservationLifecycle) { return ({ upcoming: 'Upcoming', staying_now: 'Staying Now', checked_out: 'Checked Out', cancelled: 'Cancelled', all: 'All' } as const)[value]; }
function stayRange(row: ReservationRecord) { return [row.checkIn ? formatStayDateShort(row.checkIn, 'en') : null, row.checkOut ? formatStayDateShort(row.checkOut, 'en') : null].filter(Boolean).join(' → ') || 'Dates unavailable'; }
function guestCount(row: ReservationRecord) { if (row.occupancyTotal !== null) return row.occupancyTotal; const values = [row.adults, row.children, row.infants].filter((value): value is number => value !== null); return values.length ? values.reduce((sum, value) => sum + value, 0) : null; }
function providerLabel(value: string) { return value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []; }
