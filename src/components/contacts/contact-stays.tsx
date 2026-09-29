'use client';

import { ChevronRight, Hotel, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  formatStayDate,
  formatStayDateShort,
  formatStayMonth,
  formatStayTotal,
  formatSyncedAt,
  groupStays,
  mostRelevantStay,
  stayPresentationStatus,
  stayStatusLabel,
  type ContactStay,
  type StayPresentationStatus,
} from '@/lib/contacts/pms-stays';
import { cn } from '@/lib/utils';

export interface StayGuest {
  name: string | null;
  phone: string | null;
  email: string | null;
}

const TONE_CLASS: Record<StayPresentationStatus, string> = {
  inHouse: 'bg-brand-accent text-brand-accent-foreground',
  upcoming: 'bg-stay-confirmed-bg text-stay-confirmed',
  confirmed: 'bg-stay-confirmed-bg text-stay-confirmed',
  completed: 'bg-stay-completed-bg text-stay-completed',
  cancelled: 'bg-stay-cancelled-bg text-stay-cancelled',
  pending: 'bg-stay-pending-bg text-stay-pending',
  default: 'bg-stay-default-bg text-stay-default',
};

export function ContactStaySummary({
  stays,
  loading = false,
  error = false,
  onOpenStay,
  onViewAll,
}: {
  stays: ContactStay[];
  loading?: boolean;
  error?: boolean;
  onOpenStay: (reservationId: string) => void;
  onViewAll: () => void;
}) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();

  if (loading) {
    return (
      <div className="bg-muted/45 rounded-xl p-4">
        <Loader2
          className="text-primary size-4 animate-spin"
          aria-label={t('staysTab.loading')}
        />
      </div>
    );
  }

  if (error) {
    return (
      <p className="bg-muted/45 text-muted-foreground rounded-xl p-4 text-xs">
        {t('staysTab.loadError')}
      </p>
    );
  }

  if (stays.length === 0) return null;

  const relevant = mostRelevantStay(stays);
  const upcomingCount = stays.filter(
    (stay) => stay.timing === 'upcoming'
  ).length;
  const firstCheckIn = stays
    .filter((stay) => stay.timing !== 'cancelled' && stay.checkIn)
    .map((stay) => stay.checkIn as string)
    .sort()[0];

  return (
    <section aria-labelledby="stay-summary-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p
          id="stay-summary-title"
          className="text-muted-foreground text-[11px] font-semibold tracking-[0.16em] uppercase"
        >
          {t('staysTab.summary')}
        </p>
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span className="text-foreground font-medium">
            {t('staysTab.stayCount', { count: stays.length })}
          </span>
          <span>{t('staysTab.upcomingCount', { count: upcomingCount })}</span>
        </div>
      </div>

      {firstCheckIn && (
        <p className="text-muted-foreground text-xs">
          {t('staysTab.guestSince', {
            date: formatStayMonth(firstCheckIn, locale),
          })}
        </p>
      )}

      {relevant && (
        <StayRow
          stay={relevant}
          locale={locale}
          emphasized
          onOpen={() => onOpenStay(relevant.id)}
        />
      )}

      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 text-xs"
        onClick={onViewAll}
      >
        {t('staysTab.viewAll', { count: stays.length })}
        <ChevronRight className="size-3.5" />
      </Button>
    </section>
  );
}

export function ContactStays({
  stays,
  error = false,
  onOpenStay,
}: {
  stays: ContactStay[];
  error?: boolean;
  onOpenStay: (reservationId: string) => void;
}) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();

  if (error) {
    return (
      <p className="bg-muted/45 text-muted-foreground rounded-xl p-4 text-sm">
        {t('staysTab.loadError')}
      </p>
    );
  }

  if (stays.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-5 py-8 text-center">
        <Hotel className="text-muted-foreground mx-auto mb-3 size-5" />
        <p className="text-sm font-medium">{t('staysTab.empty')}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {t('staysTab.emptyHint')}
        </p>
      </div>
    );
  }

  const groups = groupStays(stays);
  const sections = [
    { id: 'current', title: t('staysTab.currentGroup'), items: groups.current },
    {
      id: 'upcoming',
      title: t('staysTab.upcomingGroup'),
      items: groups.upcoming,
    },
    { id: 'past', title: t('staysTab.past'), items: groups.past },
    {
      id: 'cancelled',
      title: t('staysTab.cancelled'),
      items: groups.cancelled,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {sections.map((section) =>
        section.items.length === 0 ? null : (
          <section key={section.id} className="space-y-2">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.16em] uppercase">
              {section.title}
            </p>
            <div className="divide-border/60 border-border/70 bg-card divide-y overflow-hidden rounded-xl border">
              {section.items.map((stay) => (
                <StayRow
                  key={stay.id}
                  stay={stay}
                  locale={locale}
                  onOpen={() => onOpenStay(stay.id)}
                />
              ))}
            </div>
          </section>
        )
      )}
    </div>
  );
}

function StayRow({
  stay,
  locale,
  emphasized = false,
  onOpen,
}: {
  stay: ContactStay;
  locale: string;
  emphasized?: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('Contacts.detailView');
  const guests = guestCount(stay);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group hover:bg-muted/55 focus-visible:ring-ring flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
        emphasized &&
          'border-primary/15 bg-primary-soft/70 rounded-xl border py-3.5'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="text-foreground truncate text-sm font-semibold">
            {stay.propertyName ?? t('staysTab.property')}
          </p>
          <StayStatusBadge stay={stay} />
        </div>

        {(stay.checkIn || stay.checkOut || stay.nights !== null) && (
          <p className="text-muted-foreground mt-1 text-xs">
            {stay.checkIn ? formatStayDateShort(stay.checkIn, locale) : ''}
            {stay.checkIn && stay.checkOut ? ' → ' : ''}
            {stay.checkOut ? formatStayDateShort(stay.checkOut, locale) : ''}
            {stay.nights !== null
              ? ` · ${t('staysTab.nights', { count: stay.nights })}`
              : ''}
          </p>
        )}

        {(guests !== null || stay.channel || stay.totalAmount !== null) && (
          <p className="text-muted-foreground mt-1 truncate text-xs">
            {[
              guests !== null ? t('staysTab.guests', { count: guests }) : null,
              stay.channel,
              stay.totalAmount !== null
                ? formatStayTotal(stay.totalAmount, stay.currency, locale)
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}

        {stay.reservationCode && (
          <p className="text-muted-foreground/80 mt-1 truncate text-[11px]">
            {t('staysTab.bookingReference', {
              reference: stay.reservationCode,
            })}
          </p>
        )}
      </div>
      <ChevronRight className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

export function ReservationDetailSheet({
  open,
  onOpenChange,
  stay,
  guest,
  loading = false,
  error = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stay: ContactStay | null;
  guest: StayGuest;
  loading?: boolean;
  error?: boolean;
}) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="border-border bg-popover w-full gap-0 overflow-y-auto p-0 sm:max-w-lg"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-primary size-5 animate-spin" />
          </div>
        ) : error || !stay ? (
          <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center text-sm">
            {t('staysTab.detailLoadError')}
          </div>
        ) : (
          <>
            <SheetHeader className="sr-only">
              <SheetTitle>{t('staysTab.reservationDetails')}</SheetTitle>
              <SheetDescription>
                {stay.propertyName ?? t('staysTab.property')}
              </SheetDescription>
            </SheetHeader>
            <ReservationDetails stay={stay} guest={guest} locale={locale} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function ReservationDetails({
  stay,
  guest,
  locale,
}: {
  stay: ContactStay;
  guest: StayGuest;
  locale: string;
}) {
  const t = useTranslations('Contacts.detailView');
  const synced = stay.lastSyncedAt
    ? formatSyncedAt(stay.lastSyncedAt, locale)
    : null;
  const hasBooking = Boolean(
    stay.reservationCode || stay.channel || stay.status || stay.providerStatus
  );
  const hasGuest = Boolean(guest.name || guest.phone || guest.email);

  return (
    <div className="min-h-full">
      <header className="border-border/60 bg-muted/30 border-b px-5 py-5 pr-14">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground mb-1 text-[11px] font-semibold tracking-[0.16em] uppercase">
              {t('staysTab.reservationDetails')}
            </p>
            <h2 className="truncate text-lg font-semibold">
              {stay.propertyName ?? t('staysTab.property')}
            </h2>
          </div>
          <StayStatusBadge stay={stay} />
        </div>
        <p className="text-muted-foreground text-xs">
          {stay.checkIn ? formatStayDate(stay.checkIn, locale) : ''}
          {stay.checkIn && stay.checkOut ? ' → ' : ''}
          {stay.checkOut ? formatStayDate(stay.checkOut, locale) : ''}
          {stay.nights !== null
            ? ` · ${t('staysTab.nights', { count: stay.nights })}`
            : ''}
        </p>
      </header>

      <div className="px-5 py-1">
        <DetailSection title={t('staysTab.stay')}>
          <DetailField
            label={t('staysTab.checkIn')}
            value={stay.checkIn ? formatStayDate(stay.checkIn, locale) : null}
          />
          <DetailField
            label={t('staysTab.checkOut')}
            value={stay.checkOut ? formatStayDate(stay.checkOut, locale) : null}
          />
          <DetailField
            label={t('staysTab.nightsLabel')}
            value={
              stay.nights !== null
                ? t('staysTab.nights', { count: stay.nights })
                : null
            }
          />
          <DetailField
            label={t('staysTab.adultsLabel')}
            value={
              stay.adults !== null
                ? t('staysTab.adults', { count: stay.adults })
                : null
            }
          />
          <DetailField
            label={t('staysTab.childrenLabel')}
            value={
              stay.children !== null
                ? t('staysTab.children', { count: stay.children })
                : null
            }
          />
          <DetailField
            label={t('staysTab.infantsLabel')}
            value={
              stay.infants !== null
                ? t('staysTab.infants', { count: stay.infants })
                : null
            }
          />
          <DetailField
            label={t('staysTab.petsLabel')}
            value={
              stay.pets !== null
                ? t('staysTab.pets', { count: stay.pets })
                : null
            }
          />
        </DetailSection>

        {hasBooking && (
          <DetailSection title={t('staysTab.booking')}>
            <DetailField
              label={t('staysTab.reference')}
              value={stay.reservationCode}
            />
            <DetailField label={t('staysTab.channel')} value={stay.channel} />
            <DetailField
              label={t('staysTab.status')}
              value={stayStatusLabel(stay.status)}
            />
            <DetailField
              label={t('staysTab.providerStatus')}
              value={
                stay.providerStatus
                  ? stayStatusLabel(stay.providerStatus)
                  : null
              }
            />
          </DetailSection>
        )}

        {hasGuest && (
          <DetailSection title={t('staysTab.guest')}>
            <DetailField label={t('name')} value={guest.name} />
            <DetailField label={t('phone')} value={guest.phone} />
            <DetailField label={t('email')} value={guest.email} />
          </DetailSection>
        )}

        {stay.totalAmount !== null && (
          <DetailSection title={t('staysTab.payment')}>
            <DetailField
              label={t('staysTab.total')}
              value={formatStayTotal(stay.totalAmount, stay.currency, locale)}
            />
            <DetailField label={t('staysTab.currency')} value={stay.currency} />
          </DetailSection>
        )}

        {stay.propertyName && (
          <DetailSection title={t('staysTab.property')}>
            <DetailField
              label={t('staysTab.propertyName')}
              value={stay.propertyName}
            />
          </DetailSection>
        )}

        {synced && (
          <DetailSection title={t('staysTab.system')}>
            <DetailField label={t('staysTab.lastSynced')} value={synced} />
          </DetailSection>
        )}
      </div>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border/60 border-b py-5 last:border-b-0">
      <p className="text-muted-foreground mb-3 text-[11px] font-semibold tracking-[0.16em] uppercase">
        {title}
      </p>
      <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
        {children}
      </div>
    </section>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <Label className="text-muted-foreground text-[11px]">{label}</Label>
      <p className="text-foreground mt-0.5 text-sm break-words">{value}</p>
    </div>
  );
}

export function StayStatusBadge({ stay }: { stay: ContactStay }) {
  const t = useTranslations('Contacts.detailView');
  const presentation = stayPresentationStatus(stay);
  return (
    <Badge
      variant="outline"
      className={cn(
        'shrink-0 border-transparent text-[10px] font-semibold',
        TONE_CLASS[presentation]
      )}
    >
      {presentation === 'default'
        ? stayStatusLabel(stay.status)
        : t(`staysTab.presentation.${presentation}`)}
    </Badge>
  );
}

function guestCount(stay: ContactStay): number | null {
  if (stay.adults === null && stay.children === null) return null;
  return (stay.adults ?? 0) + (stay.children ?? 0);
}
