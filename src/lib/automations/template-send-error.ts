/** Safe execution diagnostics: never retain provider bodies or resolved values. */
export class AutomationTemplateSendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    /** Only set with proof that no Meta request was made. */
    readonly failedBeforeMetaRequest = false
  ) {
    super(code);
    this.name = 'AutomationTemplateSendError';
  }
}
