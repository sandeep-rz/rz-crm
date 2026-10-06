export interface MessageVariableContextCapabilities {
  contact: boolean;
  reservation: boolean;
  property: boolean;
  listing: false;
  host: false;
  workspace: true;
}

/**
 * Provider-neutral capability shape used by every semantic-variable picker.
 * A reservation always supplies its canonical property relationship.
 */
export function createMessageVariableContextCapabilities(input: {
  contact?: boolean;
  reservation?: boolean;
  property?: boolean;
}): MessageVariableContextCapabilities {
  const reservation = Boolean(input.reservation);
  return {
    contact: Boolean(input.contact),
    reservation,
    property: Boolean(input.property) || reservation,
    // Vocabulary exists; these contexts have no resolver in Contract v1.
    listing: false,
    host: false,
    workspace: true,
  };
}
