import { PmsProviderError, type PmsProvider } from './provider';
import { RUKIYE_ZARA_PROVIDER } from './types';
import { RukiyeZaraPmsProvider } from './providers/rukiye-zara';

export function createPmsProvider(provider: string): PmsProvider {
  if (provider === RUKIYE_ZARA_PROVIDER) return new RukiyeZaraPmsProvider();
  throw new PmsProviderError(
    'configuration',
    `Unsupported PMS provider: ${provider}`
  );
}
