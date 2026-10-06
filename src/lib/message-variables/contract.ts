export type MessageVariableDataType =
  'text' | 'phone' | 'email' | 'date' | 'time' | 'number' | 'currency' | 'url';

/** RGCRM Canonical Variable Contract v1: keys are stable API identifiers. */
export const MESSAGE_VARIABLE_CATEGORIES = [
  'contact',
  'reservation',
  'property',
  'listing',
  'host',
  'workspace',
] as const;
export type MessageVariableSourceScope =
  (typeof MESSAGE_VARIABLE_CATEGORIES)[number];
export type MessageVariableResolutionSource =
  'crm' | 'provider' | 'derived' | 'context';

export const MESSAGE_VARIABLE_CATEGORY_LABELS: Record<
  MessageVariableSourceScope,
  string
> = {
  contact: 'Contact',
  reservation: 'Reservation',
  property: 'Property',
  listing: 'Listing',
  host: 'Host',
  workspace: 'Workspace',
};
