/** Minimal normalization for Meta template text parameters, never canonical content. */
export function normalizeMetaTemplateTextParameter(value: string): string {
  if (!/[\r\n\t]| {5,}/.test(value)) return value;
  return value.replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ');
}
