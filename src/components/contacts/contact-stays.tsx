'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  formatStayDate,
  formatStayTotal,
  formatSyncedAt,
  groupStays,
  stayStatusLabel,
  stayStatusTone,
  type ContactStay,
  type StayStatusTone,
} from '@/lib/contacts/pms-stays';
import { cn } from '@/lib/utils';

export interface StayGuest {
  name: string | null;
  phone: string | null;
  email: string | null;
}

const TONE_CLASS: Record<StayStatusTone, string> = {
  confirmed: 'bg-stay-confirmed-bg text-stay-confirmed',
  completed: 'bg-stay-completed-bg text-stay-completed',
  cancelled: 'bg-stay-cancelled-bg text-stay-cancelled',
  pending: 'bg-stay-pending-bg text-stay-pending',
  default: 'bg-stay-default-bg text-stay-default',
};

export function ContactStays({
  stays,
  guest,
  error = false,
  initialSelectedId = null,
}: {
  stays: ContactStay[];
  guest: StayGuest;
  error?: boolean;
  initialSelectedId?: string | null;
}) {
  const t = useTranslations('Contacts.detailView');
  const locale = useLocale();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId
  );
  const selected = stays.find((stay) => stay.id === selectedId) ?? null;

  if (error) {
    return (
      <Card size="sm">
        <CardContent>
          <CardDescription>{t('staysTab.loadError')}</CardDescription>
        </CardContent>
      </Card>
    );
  }

  if (selected) {
    return (
      <StayDetail
        stay={selected}
        guest={guest}
        locale={locale}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  if (stays.length === 0) {
    return (
      <Card size="sm" className="border-dashed text-center">
        <CardHeader>
          <CardTitle>{t('staysTab.empty')}</CardTitle>
          <CardDescription>{t('staysTab.emptyHint')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const groups = groupStays(stays);
  const sections = [
    {
      id: 'upcoming',
      title: t('staysTab.upcomingCurrent'),
      items: groups.upcomingCurrent,
    },
    { id: 'past', title: t('staysTab.past'), items: groups.past },
    {
      id: 'cancelled',
      title: t('staysTab.cancelled'),
      items: groups.cancelled,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section) =>
        section.items.length === 0 ? null : (
          <section key={section.id} className="flex flex-col gap-2">
            <CardTitle className="text-muted-foreground text-xs">
              {section.title}
            </CardTitle>
            <div className="flex flex-col gap-2">
              {section.items.map((stay) => (
                <StayCard
                  key={stay.id}
                  stay={stay}
                  locale={locale}
                  onOpen={() => setSelectedId(stay.id)}
                />
              ))}
            </div>
          </section>
        )
      )}
    </div>
  );
}

function StayCard({
  stay,
  locale,
  onOpen,
}: {
  stay: ContactStay;
  locale: string;
  onOpen: () => void;
}) {
  const t = useTranslations('Contacts.detailView');
  const occupancy = occupancyLabel(stay, t);
  return (
    <Card size="sm" className="py-0">
      <Button
        type="button"
        variant="ghost"
        onClick={onOpen}
        className="h-auto w-full flex-col items-stretch gap-2 whitespace-normal px-3 py-3 text-left sm:px-4"
      >
        <CardHeader className="w-full px-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {stay.propertyName && (
              <CardTitle className="truncate">{stay.propertyName}</CardTitle>
            )}
            {stay.reservationCode && (
              <CardDescription>{stay.reservationCode}</CardDescription>
            )}
          </div>
          <CardAction className="static row-auto justify-self-start sm:justify-self-end">
            <StatusBadge status={stay.status} />
          </CardAction>
        </CardHeader>
        <CardContent className="text-muted-foreground flex w-full flex-col gap-1 px-0 text-xs sm:flex-row sm:flex-wrap sm:gap-x-3">
          {stay.timing === 'current' && <span>{t('staysTab.current')}</span>}
          {stay.timing === 'upcoming' && <span>{t('staysTab.upcoming')}</span>}
          {(stay.checkIn || stay.checkOut) && (
            <span>
              {stay.checkIn ? formatStayDate(stay.checkIn, locale) : ''}
              {stay.checkIn && stay.checkOut ? ' – ' : ''}
              {stay.checkOut ? formatStayDate(stay.checkOut, locale) : ''}
            </span>
          )}
          {stay.nights !== null && (
            <span>{t('staysTab.nights', { count: stay.nights })}</span>
          )}
          {occupancy && <span>{occupancy}</span>}
          {stay.channel && <span>{stay.channel}</span>}
          {stay.totalAmount !== null && (
            <span>
              {formatStayTotal(stay.totalAmount, stay.currency, locale)}
            </span>
          )}
        </CardContent>
      </Button>
    </Card>
  );
}

function StayDetail({
  stay,
  guest,
  locale,
  onBack,
}: {
  stay: ContactStay;
  guest: StayGuest;
  locale: string;
  onBack: () => void;
}) {
  const t = useTranslations('Contacts.detailView');
  const synced = stay.lastSyncedAt
    ? formatSyncedAt(stay.lastSyncedAt, locale)
    : null;
  const occupancy = occupancyParts(stay, t);
  const hasBooking = Boolean(
    stay.reservationCode || stay.channel || stay.providerStatus
  );
  const hasGuest = Boolean(guest.name || guest.phone || guest.email);
  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit px-2"
        onClick={onBack}
      >
        <ArrowLeft className="size-3.5" />
        {t('staysTab.back')}
      </Button>
      <StaySection title={t('staysTab.stay')}>
        <DetailField
          label={t('staysTab.property')}
          value={stay.propertyName}
        />
        <DetailField
          label={t('staysTab.status')}
          value={stayStatusLabel(stay.status)}
        />
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
        {occupancy.map((part) => (
          <DetailField key={part.label} label={part.label} value={part.value} />
        ))}
      </StaySection>
      {hasBooking && (
        <StaySection title={t('staysTab.booking')}>
          <DetailField
            label={t('staysTab.reference')}
            value={stay.reservationCode}
          />
          <DetailField label={t('staysTab.channel')} value={stay.channel} />
          <DetailField
            label={t('staysTab.providerStatus')}
            value={
              stay.providerStatus ? stayStatusLabel(stay.providerStatus) : null
            }
          />
        </StaySection>
      )}
      {hasGuest && (
        <StaySection title={t('staysTab.guest')}>
          <DetailField label={t('name')} value={guest.name} />
          <DetailField label={t('phone')} value={guest.phone} />
          <DetailField label={t('email')} value={guest.email} />
        </StaySection>
      )}
      {stay.totalAmount !== null && (
        <StaySection title={t('staysTab.financial')}>
          <DetailField
            label={t('staysTab.total')}
            value={formatStayTotal(stay.totalAmount, null, locale)}
          />
          <DetailField label={t('staysTab.currency')} value={stay.currency} />
        </StaySection>
      )}
      {synced && (
        <StaySection title={t('staysTab.sync')}>
          <DetailField label={t('staysTab.lastSynced')} value={synced} />
        </StaySection>
      )}
    </div>
  );
}

function StaySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-muted-foreground text-xs">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {children}
      </CardContent>
    </Card>
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
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <CardDescription className="text-foreground mt-0.5 text-sm">
        {value}
      </CardDescription>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent', TONE_CLASS[stayStatusTone(status)])}
    >
      {stayStatusLabel(status)}
    </Badge>
  );
}

function occupancyLabel(
  stay: ContactStay,
  t: ReturnType<typeof useTranslations<'Contacts.detailView'>>
): string | null {
  return (
    occupancyParts(stay, t)
      .map((part) => part.value)
      .join(' · ') || null
  );
}

function occupancyParts(
  stay: ContactStay,
  t: ReturnType<typeof useTranslations<'Contacts.detailView'>>
): { label: string; value: string }[] {
  const parts: { label: string; value: string }[] = [];
  if (stay.adults !== null) {
    parts.push({
      label: t('staysTab.adultsLabel'),
      value: t('staysTab.adults', { count: stay.adults }),
    });
  }
  if (stay.children !== null) {
    parts.push({
      label: t('staysTab.childrenLabel'),
      value: t('staysTab.children', { count: stay.children }),
    });
  }
  if (stay.infants !== null) {
    parts.push({
      label: t('staysTab.infantsLabel'),
      value: t('staysTab.infants', { count: stay.infants }),
    });
  }
  if (stay.pets !== null) {
    parts.push({
      label: t('staysTab.petsLabel'),
      value: t('staysTab.pets', { count: stay.pets }),
    });
  }
  return parts;
}
