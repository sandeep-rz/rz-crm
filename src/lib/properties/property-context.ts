export interface PropertySourceRow {
  id: string;
  account_id: string;
  pms_integration_id: string;
  name: string | null;
  status: string;
  initial_sync_status: string;
}

export interface PropertyIntegrationRow {
  id: string;
  account_id: string;
  display_name: string | null;
  provider: string;
}

export interface PropertyOption {
  id: string;
  name: string;
  secondaryLabel: string | null;
  status: string;
  initialSyncStatus: string;
}

export function buildPropertyOptions(
  accountId: string,
  properties: PropertySourceRow[],
  integrations: PropertyIntegrationRow[]
): PropertyOption[] {
  const scopedIntegrations = new Map(
    integrations
      .filter((row) => row.account_id === accountId)
      .map((row) => [row.id, row])
  );
  const scoped = properties.filter(
    (row) => row.account_id === accountId && row.id.trim().length > 0
  );
  const counts = new Map<string, number>();
  for (const row of scoped) {
    const name = cleanName(row.name);
    counts.set(
      name.toLocaleLowerCase(),
      (counts.get(name.toLocaleLowerCase()) ?? 0) + 1
    );
  }

  return scoped
    .map((row) => {
      const name = cleanName(row.name);
      const integration = scopedIntegrations.get(row.pms_integration_id);
      const duplicate = (counts.get(name.toLocaleLowerCase()) ?? 0) > 1;
      const integrationLabel = integration
        ? cleanOptional(integration.display_name) ||
          providerLabel(integration.provider)
        : null;
      const statusLabel =
        row.status === 'active' ? null : titleCase(row.status);
      return {
        id: row.id,
        name,
        secondaryLabel:
          [duplicate ? integrationLabel : null, statusLabel]
            .filter(Boolean)
            .join(' · ') || null,
        status: row.status,
        initialSyncStatus: row.initial_sync_status,
      };
    })
    .sort((a, b) => {
      const activeOrder =
        Number(a.status !== 'active') - Number(b.status !== 'active');
      return (
        activeOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      );
    });
}

export function selectedProperty(
  options: PropertyOption[],
  propertyId: string | null
): PropertyOption | null {
  if (!propertyId) return null;
  return options.find((option) => option.id === propertyId) ?? null;
}

export function contactPropertyNames(
  stays: { propertyName: string | null }[]
): string[] {
  return [
    ...new Set(
      stays.map((stay) => cleanName(stay.propertyName)).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function cleanName(value: string | null): string {
  return value?.trim() || 'Unnamed property';
}

function cleanOptional(value: string | null): string | null {
  return value?.trim() || null;
}

function providerLabel(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
