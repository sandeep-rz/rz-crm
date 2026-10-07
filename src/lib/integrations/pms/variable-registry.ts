import 'server-only';
import { PmsProviderError } from './provider';
import { RUKIYE_ZARA_PROVIDER } from './types';
import { RukiyeZaraVariableResolver } from './providers/rukiye-zara-variables';
import type { ConnectedSystemVariableResolver } from './variable-resolver';

export function createConnectedVariableResolver(
  provider: string
): ConnectedSystemVariableResolver {
  if (provider === RUKIYE_ZARA_PROVIDER)
    return new RukiyeZaraVariableResolver();
  throw new PmsProviderError(
    'configuration',
    'Connected system has no variable resolver.'
  );
}
