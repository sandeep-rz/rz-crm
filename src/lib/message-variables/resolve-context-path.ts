import type { MessageVariableContext } from './context';

export type ContextPrimitive = string | number | boolean | null;

export type ContextPathResult =
  | { found: true; value: ContextPrimitive }
  | { found: false; reason: 'missing' | 'invalid' };

const SAFE_PATH = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function resolveContextPath(
  context: MessageVariableContext,
  path: string
): ContextPathResult {
  if (!SAFE_PATH.test(path)) return { found: false, reason: 'invalid' };

  const segments = path.split('.');
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    return { found: false, reason: 'invalid' };
  }

  let current: unknown = context;
  for (const segment of segments) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { found: false, reason: 'missing' };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (
    current === null ||
    typeof current === 'string' ||
    typeof current === 'number' ||
    typeof current === 'boolean'
  ) {
    return { found: true, value: current };
  }
  return { found: false, reason: 'invalid' };
}
