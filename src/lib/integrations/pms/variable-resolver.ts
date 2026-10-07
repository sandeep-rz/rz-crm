import 'server-only';
import type { PmsIntegrationContext } from './provider';

/** Context is discovered by the CRM service, never accepted from messaging callers. */
export interface ConnectedVariableContext extends PmsIntegrationContext {
  externalPropertyId: string;
  externalReservationId: string;
  sourceType: string;
}
export type ConnectedVariableValue =
  | { status: 'resolved'; value: string }
  | { status: 'missing' | 'unsupported'; value: null };
export interface ConnectedSystemVariableResolver {
  resolveVariables(input: {
    context: ConnectedVariableContext;
    variableKeys: string[];
  }): Promise<Record<string, ConnectedVariableValue>>;
}
