/** Safe execution diagnostics: never retain provider bodies or resolved values. */
export class AutomationTemplateSendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'AutomationTemplateSendError';
  }
}
