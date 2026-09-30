'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Eye,
  EyeOff,
  Loader2,
  MapPin,
  Save,
  UserRound,
  Wifi,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  emptyPropertyCommunicationValues,
  PROPERTY_COMMUNICATION_FIELDS,
  type PropertyCommunicationField,
  type PropertyCommunicationValues,
} from '@/lib/properties/communication-settings';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPanelHead } from './settings-panel-head';

interface PropertyOption {
  id: string;
  name: string | null;
}

type Draft = Record<PropertyCommunicationField, string>;

const EMPTY_DRAFT = toDraft(emptyPropertyCommunicationValues());

function toDraft(values: PropertyCommunicationValues): Draft {
  return Object.fromEntries(
    PROPERTY_COMMUNICATION_FIELDS.map((field) => [field, values[field] ?? ''])
  ) as Draft;
}

function TextField({
  field,
  label,
  value,
  onChange,
  disabled,
  type = 'text',
  placeholder,
}: {
  field: PropertyCommunicationField;
  label: string;
  value: string;
  onChange: (field: PropertyCommunicationField, value: string) => void;
  disabled: boolean;
  type?: 'text' | 'url' | 'tel';
  placeholder?: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`property-communication-${field}`}>{label}</Label>
      <Input
        id={`property-communication-${field}`}
        type={type}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
      />
    </div>
  );
}

function TextAreaField({
  field,
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  field: PropertyCommunicationField;
  label: string;
  value: string;
  onChange: (field: PropertyCommunicationField, value: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`property-communication-${field}`}>{label}</Label>
      <Textarea
        id={`property-communication-${field}`}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        rows={3}
      />
    </div>
  );
}

export function PropertyCommunicationSettingsPanel() {
  const supabase = useMemo(() => createClient(), []);
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [propertyId, setPropertyId] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saved, setSaved] = useState<Draft>(EMPTY_DRAFT);
  const [loadingProperties, setLoadingProperties] = useState(true);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showWifiPassword, setShowWifiPassword] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadProperties() {
      if (!accountId) {
        setProperties([]);
        setPropertyId('');
        setLoadingProperties(false);
        return;
      }
      setLoadingProperties(true);
      const { data, error } = await supabase
        .from('pms_properties')
        .select('id, name')
        .eq('account_id', accountId)
        .order('name', { ascending: true });
      if (!active) return;
      setLoadingProperties(false);
      if (error) {
        toast.error('Could not load properties.');
        setProperties([]);
        return;
      }
      const next = (data ?? []) as PropertyOption[];
      setProperties(next);
      setPropertyId((current) =>
        next.some((property) => property.id === current)
          ? current
          : (next[0]?.id ?? '')
      );
    }
    void loadProperties();
    return () => {
      active = false;
    };
  }, [accountId, supabase]);

  useEffect(() => {
    let active = true;
    async function loadSettings() {
      if (!propertyId) {
        setDraft(EMPTY_DRAFT);
        setSaved(EMPTY_DRAFT);
        return;
      }
      setLoadingSettings(true);
      setDraft(EMPTY_DRAFT);
      setSaved(EMPTY_DRAFT);
      setShowWifiPassword(false);
      try {
        const response = await fetch(
          `/api/properties/${encodeURIComponent(propertyId)}/communication-settings`,
          { cache: 'no-store' }
        );
        const body = (await response.json()) as {
          settings?: PropertyCommunicationValues;
          error?: string;
        };
        if (!response.ok || !body.settings) {
          throw new Error(
            body.error ?? 'Could not load communication settings.'
          );
        }
        if (!active) return;
        const next = toDraft(body.settings);
        setDraft(next);
        setSaved(next);
      } catch {
        if (active) toast.error('Could not load communication settings.');
      } finally {
        if (active) setLoadingSettings(false);
      }
    }
    void loadSettings();
    return () => {
      active = false;
    };
  }, [propertyId]);

  const dirtyFields = PROPERTY_COMMUNICATION_FIELDS.filter(
    (field) => draft[field] !== saved[field]
  );
  const disabled =
    profileLoading || loadingSettings || saving || !canEditSettings;

  function updateField(field: PropertyCommunicationField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    if (!propertyId || dirtyFields.length === 0 || !canEditSettings) return;
    const patch = Object.fromEntries(
      dirtyFields.map((field) => [field, draft[field]])
    );
    setSaving(true);
    try {
      const response = await fetch(
        `/api/properties/${encodeURIComponent(propertyId)}/communication-settings`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }
      );
      const body = (await response.json()) as {
        settings?: PropertyCommunicationValues;
        error?: string;
      };
      if (!response.ok || !body.settings) {
        throw new Error(body.error ?? 'Could not save communication settings.');
      }
      const next = toDraft(body.settings);
      setDraft(next);
      setSaved(next);
      toast.success('Communication settings saved.');
    } catch {
      toast.error('Could not save communication settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 max-w-4xl duration-200">
      <SettingsPanelHead
        title="Communication settings"
        description="Manage the guest-facing arrival, contact, Wi-Fi and house information owned by CRM for each property."
        action={
          <Button
            onClick={save}
            disabled={disabled || dirtyFields.length === 0 || !propertyId}
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />

      <Card className="mb-5">
        <CardContent className="grid gap-2 sm:max-w-md">
          <Label htmlFor="communication-property">Property</Label>
          <select
            id="communication-property"
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
            disabled={loadingProperties || properties.length === 0}
            className="border-border bg-background text-foreground focus:border-primary focus:ring-primary h-9 w-full rounded-lg border px-3 text-sm outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {properties.length === 0 ? (
              <option value="">
                {loadingProperties
                  ? 'Loading properties…'
                  : 'No properties available'}
              </option>
            ) : (
              properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name?.trim() || 'Unnamed property'}
                </option>
              ))
            )}
          </select>
          {!canEditSettings && !profileLoading ? (
            <p className="text-muted-foreground text-xs">
              You can view these settings. An admin or owner can edit them.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {propertyId ? (
        <div className="grid gap-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="text-primary size-4" /> Arrival
              </CardTitle>
              <CardDescription>
                Exact location and practical instructions guests need to arrive.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TextField
                field="map_url"
                label="Exact location / Google Maps URL"
                type="url"
                value={draft.map_url}
                onChange={updateField}
                disabled={disabled}
                placeholder="https://maps.google.com/…"
              />
              <TextField
                field="checkin_method"
                label="Check-in method"
                value={draft.checkin_method}
                onChange={updateField}
                disabled={disabled}
                placeholder="Self check-in, front desk…"
              />
              <TextField
                field="nearby_landmark"
                label="Nearby landmark"
                value={draft.nearby_landmark}
                onChange={updateField}
                disabled={disabled}
              />
              <TextAreaField
                field="directions"
                label="Directions"
                value={draft.directions}
                onChange={updateField}
                disabled={disabled}
              />
              <TextAreaField
                field="parking_instructions"
                label="Parking instructions"
                value={draft.parking_instructions}
                onChange={updateField}
                disabled={disabled}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserRound className="text-primary size-4" /> Guest contact
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TextField
                field="caretaker_name"
                label="Caretaker name"
                value={draft.caretaker_name}
                onChange={updateField}
                disabled={disabled}
              />
              <TextField
                field="caretaker_phone"
                label="Caretaker phone"
                type="tel"
                value={draft.caretaker_phone}
                onChange={updateField}
                disabled={disabled}
              />
              <TextField
                field="emergency_phone"
                label="Emergency phone"
                type="tel"
                value={draft.emergency_phone}
                onChange={updateField}
                disabled={disabled}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wifi className="text-primary size-4" /> Wi-Fi
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TextField
                field="wifi_name"
                label="Wi-Fi name"
                value={draft.wifi_name}
                onChange={updateField}
                disabled={disabled}
              />
              <div className="grid gap-2">
                <Label htmlFor="property-communication-wifi_password">
                  Wi-Fi password
                </Label>
                <div className="relative">
                  <Input
                    id="property-communication-wifi_password"
                    type={showWifiPassword ? 'text' : 'password'}
                    value={draft.wifi_password}
                    onChange={(event) =>
                      updateField('wifi_password', event.target.value)
                    }
                    disabled={disabled}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowWifiPassword((current) => !current)}
                    disabled={disabled}
                    aria-label={
                      showWifiPassword
                        ? 'Hide Wi-Fi password'
                        : 'Show Wi-Fi password'
                    }
                    className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center disabled:opacity-50"
                  >
                    {showWifiPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="text-primary size-4" /> Instructions
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TextAreaField
                field="house_manual"
                label="House manual"
                value={draft.house_manual}
                onChange={updateField}
                disabled={disabled}
              />
              <TextAreaField
                field="checkout_instructions"
                label="Checkout instructions"
                value={draft.checkout_instructions}
                onChange={updateField}
                disabled={disabled}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </section>
  );
}
