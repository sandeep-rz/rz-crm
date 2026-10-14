'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import Select from 'react-select';

const times = Array.from({ length: 24 * 60 }, (_, minutes) => {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return {
    value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    label: `${hour % 12 || 12}${minute ? ':' + String(minute).padStart(2, '0') : ''} ${hour >= 12 ? 'PM' : 'AM'}`,
  };
});

/** Pick a complete time in one selection, keeping the existing HH:mm contract. */
export function TimePicker({
  value,
  onChange,
  label,
  describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  describedBy?: string;
}) {
  const t = useTranslations('TimePicker');
  const id = useId();
  const [search, setSearch] = useState('');
  const selected = times.find((time) => time.value === value) ?? null;
  // A short list for browsing; searching offers every minute. Always include
  // the saved time so existing values such as 6:07 PM are never rounded.
  const options = search
    ? times
    : times.filter((_, i) => i % 15 === 0 || times[i].value === value);

  return (
    <Select
      instanceId={id}
      inputId={id}
      aria-label={label}
      aria-describedby={describedBy}
      value={selected}
      options={options}
      onChange={(option) => {
        if (option) onChange(option.value);
      }}
      onInputChange={setSearch}
      isSearchable
      placeholder={t('chooseTime')}
      noOptionsMessage={() => t('noTimes')}
      menuPortalTarget={
        typeof document !== 'undefined' ? document.body : undefined
      }
      menuPosition="fixed"
      menuPlacement="auto"
      maxMenuHeight={240}
      filterOption={({ data }, input) => {
        const query = input.toLowerCase().replace(/\s/g, '');
        return (
          data.label.toLowerCase().replace(/\s/g, '').includes(query) ||
          data.value.includes(query)
        );
      }}
      styles={{
        control: (base) => ({
          ...base,
          background: 'var(--muted)',
          borderColor: 'var(--border)',
          borderRadius: 'var(--radius)',
          minHeight: 38,
        }),
        menuPortal: (base) => ({ ...base, zIndex: 100 }),
        menu: (base) => ({ ...base, background: 'var(--popover)' }),
        singleValue: (base) => ({ ...base, color: 'var(--foreground)' }),
        input: (base) => ({ ...base, color: 'var(--foreground)' }),
        option: (base, state) => ({
          ...base,
          background: state.isSelected
            ? 'var(--primary)'
            : state.isFocused
              ? 'var(--muted)'
              : 'transparent',
          color: state.isSelected
            ? 'var(--primary-foreground)'
            : 'var(--foreground)',
        }),
      }}
    />
  );
}

export function TimeRangePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('TimePicker');
  const [from = '', to = ''] = value.split(/[-–—]/).map((part) => part.trim());
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <span className="text-muted-foreground text-xs">{t('from')}</span>
          <TimePicker
            label={t('from')}
            value={from}
            onChange={(next) => onChange(`${next}-${to}`)}
          />
        </div>
        <div className="space-y-1">
          <span className="text-muted-foreground text-xs">{t('to')}</span>
          <TimePicker
            label={t('to')}
            value={to}
            onChange={(next) => onChange(`${from}-${next}`)}
          />
        </div>
      </div>
      {from && to && from > to && (
        <p className="text-muted-foreground text-xs">{t('overnight')}</p>
      )}
      {from && to && from === to && (
        <p className="text-xs text-amber-600 dark:text-amber-300">
          {t('sameTime')}
        </p>
      )}
    </div>
  );
}
