export const MESSAGE_VARIABLE_COMPONENTS = ['body', 'header'] as const;

export type MessageVariableComponent =
  (typeof MESSAGE_VARIABLE_COMPONENTS)[number];

interface BaseMessageVariableMapping {
  component: MessageVariableComponent;
  position: number;
  fallback?: string | null;
}

export interface CatalogVariableMapping extends BaseMessageVariableMapping {
  source_type: 'catalog_variable';
  variable_key: string;
}

export interface StaticVariableMapping extends BaseMessageVariableMapping {
  source_type: 'static';
  static_value: string;
}

export interface CustomFieldVariableMapping extends BaseMessageVariableMapping {
  source_type: 'custom_field';
  custom_field_id: string;
}

export type MessageVariableMapping =
  CatalogVariableMapping | StaticVariableMapping | CustomFieldVariableMapping;

export type MessageVariableMappingErrorCode =
  | 'INVALID_ACCOUNT'
  | 'CONTEXT_ACCOUNT_MISMATCH'
  | 'INVALID_MAPPING_SHAPE'
  | 'UNSUPPORTED_COMPONENT'
  | 'INVALID_POSITION'
  | 'DUPLICATE_POSITION'
  | 'UNKNOWN_SOURCE_TYPE'
  | 'VARIABLE_KEY_REQUIRED'
  | 'STATIC_VALUE_REQUIRED'
  | 'CUSTOM_FIELD_ID_REQUIRED'
  | 'UNKNOWN_CATALOG_VARIABLE'
  | 'INACTIVE_CATALOG_VARIABLE'
  | 'CUSTOM_FIELD_NOT_FOUND';

export interface MessageVariableMappingError {
  code: MessageVariableMappingErrorCode;
  mapping_index: number;
  component?: string;
  position?: number;
  variable_key?: string;
  custom_field_id?: string;
}

export interface MessageVariableMappingShapeResult {
  mappings: MessageVariableMapping[];
  errors: MessageVariableMappingError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Runtime validation for mapping JSON read from persisted step/broadcast data.
 * It deliberately does not validate catalog/custom-field existence; that is
 * performed by the account-aware resolver.
 */
export function validateMessageVariableMappingShape(
  input: unknown
): MessageVariableMappingShapeResult {
  if (!Array.isArray(input)) {
    return {
      mappings: [],
      errors: [{ code: 'INVALID_MAPPING_SHAPE', mapping_index: -1 }],
    };
  }

  const mappings: MessageVariableMapping[] = [];
  const errors: MessageVariableMappingError[] = [];
  const positions = new Map<string, number>();

  input.forEach((candidate, mappingIndex) => {
    if (!isRecord(candidate)) {
      errors.push({
        code: 'INVALID_MAPPING_SHAPE',
        mapping_index: mappingIndex,
      });
      return;
    }

    const component = candidate.component;
    const position = candidate.position;
    const sourceType = candidate.source_type;
    const diagnostic = {
      mapping_index: mappingIndex,
      ...(typeof component === 'string' ? { component } : {}),
      ...(typeof position === 'number' ? { position } : {}),
    };

    if (
      typeof component !== 'string' ||
      !MESSAGE_VARIABLE_COMPONENTS.includes(
        component as MessageVariableComponent
      )
    ) {
      errors.push({ code: 'UNSUPPORTED_COMPONENT', ...diagnostic });
      return;
    }
    const validComponent = component as MessageVariableComponent;
    if (!Number.isInteger(position) || (position as number) <= 0) {
      errors.push({ code: 'INVALID_POSITION', ...diagnostic });
      return;
    }

    const positionKey = `${component}:${position}`;
    if (positions.has(positionKey)) {
      errors.push({ code: 'DUPLICATE_POSITION', ...diagnostic });
      return;
    }
    positions.set(positionKey, mappingIndex);

    const fallback =
      candidate.fallback == null
        ? candidate.fallback
        : typeof candidate.fallback === 'string'
          ? candidate.fallback
          : undefined;
    if (
      candidate.fallback !== undefined &&
      candidate.fallback !== null &&
      typeof candidate.fallback !== 'string'
    ) {
      errors.push({ code: 'INVALID_MAPPING_SHAPE', ...diagnostic });
      return;
    }

    if (sourceType === 'catalog_variable') {
      if (!nonBlank(candidate.variable_key)) {
        errors.push({ code: 'VARIABLE_KEY_REQUIRED', ...diagnostic });
        return;
      }
      mappings.push({
        component: validComponent,
        position: position as number,
        source_type: sourceType,
        variable_key: candidate.variable_key.trim(),
        ...(fallback !== undefined ? { fallback } : {}),
      });
      return;
    }

    if (sourceType === 'static') {
      if (!nonBlank(candidate.static_value)) {
        errors.push({ code: 'STATIC_VALUE_REQUIRED', ...diagnostic });
        return;
      }
      mappings.push({
        component: validComponent,
        position: position as number,
        source_type: sourceType,
        static_value: candidate.static_value.trim(),
        ...(fallback !== undefined ? { fallback } : {}),
      });
      return;
    }

    if (sourceType === 'custom_field') {
      if (!nonBlank(candidate.custom_field_id)) {
        errors.push({ code: 'CUSTOM_FIELD_ID_REQUIRED', ...diagnostic });
        return;
      }
      mappings.push({
        component: validComponent,
        position: position as number,
        source_type: sourceType,
        custom_field_id: candidate.custom_field_id.trim(),
        ...(fallback !== undefined ? { fallback } : {}),
      });
      return;
    }

    errors.push({ code: 'UNKNOWN_SOURCE_TYPE', ...diagnostic });
  });

  return { mappings, errors };
}
