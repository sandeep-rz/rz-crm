export interface PmsIntegrationContext {
  integrationId: string;
  accountId: string;
  provider: string;
  externalAccountId: string;
}

export interface PmsProperty {
  externalId: string;
  name: string;
  status: string;
  active: boolean;
  timezone: string | null;
  address: Record<string, string | null>;
  currency: string | null;
  createdAt: string | null;
}

export interface PmsReservation {
  externalId: string;
  sourceType: string;
  externalPropertyId: string;
  externalListingId: string;
  reservationCode: string;

  status: 'pending' | 'confirmed' | 'cancelled';

  /**
   * Original reservation status reported by the PMS/provider.
   *
   * Examples:
   * RZ native: pending / confirmed / cancelled
   * Channex/PMS: new / modified / cancelled
   */
  providerStatus: string;

  checkIn: string | null;
  checkOut: string | null;

  guest: {
    externalId: string | null;
    fullName: string | null;
    email: string | null;
    phone: string | null;
  };

  occupancy: {
    adults: number | null;
    children: number | null;
    infants: number | null;
    pets: number | null;
    total: number | null;
  };

  channel: {
    code: string | null;
    name: string | null;
  };

  financial: {
    totalAmount: number | null;
    paidAmount: number | null;
    balanceDue: number | null;
    currency: string | null;
    paymentStatus: string | null;
  };

  createdAt: string | null;
  updatedAt: string | null;
}

export interface PmsReservationPage {
  items: PmsReservation[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type PmsProviderErrorCode =
  | 'configuration'
  | 'authentication'
  | 'access_denied'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_temporary'
  | 'invalid_response';

export class PmsProviderError extends Error {
  constructor(
    public readonly code: PmsProviderErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'PmsProviderError';
  }
}

export interface PmsProvider {
  readonly provider: string;
  getProperty(input: {
    integration: PmsIntegrationContext;
    externalPropertyId: string;
  }): Promise<PmsProperty>;
  listReservations(input: {
    integration: PmsIntegrationContext;
    externalPropertyId: string;
    limit?: number;
    cursor?: string | null;
    updatedSince?: string | null;
  }): Promise<PmsReservationPage>;
  getReservation(input: {
    integration: PmsIntegrationContext;
    externalPropertyId: string;
    externalReservationId: string;
  }): Promise<PmsReservation>;
}
