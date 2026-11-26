/** Pure dry-run planner. No deletion, writes, sends or contact reassignment.
 * Input aliases MUST come from an authenticated PMS property-scoped export,
 * never from matching booking codes, phone numbers or guest names.
 */
export type Scope = { accountId: string; integrationId: string; propertyId: string };
export type ExistingReservation = Scope & { id: string; externalId: string; contactId: string | null };
export type ParentIdentity = Scope & { parentId: string; childIds: readonly string[] };
export type ReconciliationPlan =
  | { kind: "insert"; parentId: string }
  | { kind: "keep" | "rekey"; parentId: string; internalId: string; contactId: string | null }
  | { kind: "conflict"; parentId: string; internalIds: string[]; reason: string };

export function planReservationReconciliation(parent: ParentIdentity, rows: readonly ExistingReservation[]): ReconciliationPlan {
  const aliases = new Set([parent.parentId, ...parent.childIds]);
  const matches = rows.filter(row =>
    row.accountId === parent.accountId && row.integrationId === parent.integrationId &&
    aliases.has(row.externalId));
  const conflict = (reason: string): ReconciliationPlan => ({
    kind: "conflict", parentId: parent.parentId, internalIds: matches.map(r => r.id).sort(), reason
  });
  if (matches.some(row => row.propertyId !== parent.propertyId)) return conflict("property_mismatch");
  if (matches.length > 1) return conflict("multiple_existing_records");
  if (!matches.length) return {kind:"insert",parentId:parent.parentId};
  const row=matches[0];
  return {kind:row.externalId===parent.parentId?"keep":"rekey",parentId:parent.parentId,
    internalId:row.id,contactId:row.contactId};
}
