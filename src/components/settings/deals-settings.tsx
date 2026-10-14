'use client';

import { useEffect, useState } from 'react';
import TimezoneSelect from 'react-timezone-select';
import { toast } from 'sonner';
import { Coins, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { CURRENCIES } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Workspace currency and timezone preferences.
 *
 * One currency per account (issue #218): the chosen code seeds new
 * deals and formats every aggregated total. Existing deals keep their
 * own saved currency. Both preferences are stored on `accounts`;
 * the `accounts_update` RLS policy (017) already restricts that to
 * admins+, so non-admins see a disabled, read-only control.
 */
export function DealsSettings() {
  const supabase = createClient();
  const {
    accountId,
    defaultCurrency,
    defaultTimezone,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [selected, setSelected] = useState(defaultCurrency);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [saving, setSaving] = useState(false);
  const t = useTranslations('Settings.deals');

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  useEffect(() => {
    setTimezone(defaultTimezone);
  }, [defaultTimezone]);

  const dirty = selected !== defaultCurrency || timezone !== defaultTimezone;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      .update({ default_currency: selected, default_timezone: timezone })
      .eq('id', accountId);
    if (error) {
      toast.error(t('saveFailed'));
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the deal form
    // and every total pick it up without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success(t('saveSuccess'));
  }

  return (
    <section className="animate-in fade-in-50 max-w-2xl duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card className="overflow-visible">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <Coins className="text-primary size-4" />
            {t('defaultCurrency')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('defaultCurrencyDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">
              {t('currencyLabel')}
            </Label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canEditSettings || profileLoading}
              className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 w-full rounded-lg border px-2.5 text-sm outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </select>
            {!canEditSettings && (
              <p className="text-muted-foreground text-xs">
                {t('adminOnlyHint')}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="workspace-timezone">{t('timezoneLabel')}</Label>
            <TimezoneSelect
              inputId="workspace-timezone"
              instanceId="workspace-timezone"
              value={timezone}
              onChange={(option) => setTimezone(option.value)}
              isDisabled={!canEditSettings || profileLoading || saving}
              isSearchable
              menuPlacement="auto"
              displayValue="UTC"
              placeholder={t('timezoneSearch')}
              noOptionsMessage={() => t('timezoneNoResults')}
              styles={{
                control: (base) => ({
                  ...base,
                  background: 'var(--muted)',
                  borderColor: 'var(--border)',
                  color: 'var(--foreground)',
                }),
                menu: (base) => ({
                  ...base,
                  background: 'var(--popover)',
                  zIndex: 20,
                }),
                singleValue: (base) => ({
                  ...base,
                  color: 'var(--foreground)',
                }),
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
            <p className="text-muted-foreground text-xs">{t('timezoneDesc')}</p>
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('save')
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
