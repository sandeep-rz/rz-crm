import { getTimezone } from 'countries-and-timezones';
import { CURRENCIES } from './currency';

const countryCurrencies: Record<string, string> = {
  US: 'USD',
  GB: 'GBP',
  IN: 'INR',
  AU: 'AUD',
  CA: 'CAD',
  BR: 'BRL',
  JP: 'JPY',
  CN: 'CNY',
  AE: 'AED',
  ZA: 'ZAR',
  NG: 'NGN',
  SG: 'SGD',
  MX: 'MXN',
  CO: 'COP',
  AT: 'EUR',
  BE: 'EUR',
  CY: 'EUR',
  DE: 'EUR',
  EE: 'EUR',
  ES: 'EUR',
  FI: 'EUR',
  FR: 'EUR',
  GR: 'EUR',
  HR: 'EUR',
  IE: 'EUR',
  IT: 'EUR',
  LT: 'EUR',
  LU: 'EUR',
  LV: 'EUR',
  MT: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  SI: 'EUR',
  SK: 'EUR',
  BG: 'EUR',
};

export function isTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Seed new workspaces only. Never update existing workspace preferences. */
export function workspaceDefaults(timezone?: string, currency?: string) {
  const zone = isTimezone(timezone) ? timezone : 'UTC';
  const country = getTimezone(zone)?.countries[0];
  return {
    default_timezone: zone,
    default_currency: CURRENCIES.some((c) => c.code === currency)
      ? currency!
      : (country && countryCurrencies[country]) || 'USD',
  };
}

export function browserWorkspaceDefaults() {
  return workspaceDefaults(Intl.DateTimeFormat().resolvedOptions().timeZone);
}
