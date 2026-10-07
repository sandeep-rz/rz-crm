import type { RuntimeVariableFailure } from '@/lib/message-variables/runtime-resolver';

export type TemplatePreparationErrorCode =
  | 'invalid_input'
  | 'template_not_found'
  | 'template_not_owned'
  | 'template_lookup_failed'
  | 'template_connection_invalid'
  | 'template_not_sendable'
  | 'template_not_configured'
  | 'invalid_semantic_mapping'
  | 'variable_missing'
  | 'variable_unsupported'
  | 'runtime_provider_failure'
  | 'runtime_resolution_failure'
  | 'unsupported_template_component'
  | 'provider_payload_invalid';

/** No raw exceptions, template text, approval samples, or resolved values. */
export class TemplatePreparationError extends Error {
  constructor(
    readonly code: TemplatePreparationErrorCode,
    readonly diagnostics: {
      variableKey?: string;
      runtimeFailures?: RuntimeVariableFailure[];
    } = {},
    readonly retryable = false
  ) {
    super(code);
    this.name = 'TemplatePreparationError';
  }
}
