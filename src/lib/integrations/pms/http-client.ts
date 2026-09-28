import { PmsProviderError } from './provider';

export interface PmsHttpClientOptions {
  baseUrl?: string;
  keyId?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PmsHttpClient {
  private readonly baseUrl: string;
  private readonly keyId: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PmsHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.RZ_PMS_API_BASE_URL ?? '')
      .trim()
      .replace(/\/$/, '');
    this.keyId = (options.keyId ?? process.env.RZ_PMS_API_KEY_ID ?? '').trim();
    this.secret = (
      options.secret ??
      process.env.RZ_PMS_API_SECRET ??
      ''
    ).trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!this.baseUrl || !this.keyId || !this.secret) {
      throw new PmsProviderError(
        'configuration',
        'RZ PMS API credentials are not configured.'
      );
    }
    try {
      const url = new URL(this.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('protocol');
    } catch {
      throw new PmsProviderError(
        'configuration',
        'RZ_PMS_API_BASE_URL is invalid.'
      );
    }
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = new URL(
      `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    );
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== '')
        url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.secret}`,
          'x-rz-key-id': this.keyId,
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new PmsProviderError(
        'upstream_temporary',
        'RZ PMS API request failed.',
        error
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401)
      throw new PmsProviderError(
        'authentication',
        'RZ PMS API authentication failed.'
      );
    if (response.status === 403)
      throw new PmsProviderError(
        'access_denied',
        'RZ PMS API access was denied.'
      );
    if (response.status === 404)
      throw new PmsProviderError('not_found', 'RZ PMS resource was not found.');
    if (response.status === 429)
      throw new PmsProviderError(
        'rate_limited',
        'RZ PMS API rate limit reached.'
      );
    if (response.status >= 500)
      throw new PmsProviderError(
        'upstream_temporary',
        'RZ PMS API is temporarily unavailable.'
      );
    if (!response.ok)
      throw new PmsProviderError(
        'access_denied',
        'RZ PMS API rejected the request.'
      );
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new PmsProviderError(
        'invalid_response',
        'RZ PMS API returned invalid JSON.',
        error
      );
    }
  }
}
