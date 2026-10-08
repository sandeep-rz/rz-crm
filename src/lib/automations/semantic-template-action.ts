import type { MessageTemplate } from '@/types';
import { validateTemplateActions } from './validate';

/** Current template identity, never a second occurrence/variable mapping. */
export function selectSemanticTemplateAction(
  config: Record<string, unknown>,
  template: MessageTemplate | undefined
): Record<string, unknown> {
  const {
    variable_mappings: _mapping,
    variables: _variables,
    ...rest
  } = config;
  void _mapping;
  void _variables;
  return {
    ...rest,
    template_id: template?.id ?? '',
    template_name: template?.name ?? '',
    language: template?.language ?? '',
  };
}

/** Only a selected semantic action can be saved. */
export function serializeTemplateAction(
  config: Record<string, unknown>
): Record<string, unknown> {
  const {
    variable_mappings: _mapping,
    variables: _variables,
    ...rest
  } = config;
  void _mapping;
  void _variables;
  const issues = validateTemplateActions([
    { step_type: 'send_template', step_config: rest },
  ]);
  if (issues.length) throw new Error(issues[0].message);
  return rest;
}

export function semanticTemplateIsUsable(
  template: MessageTemplate,
  connectionId: string | null | undefined
): boolean {
  return Boolean(
    connectionId &&
    template.whatsapp_config_id === connectionId &&
    template.status === 'APPROVED' &&
    template.variable_configuration_status === 'configured' &&
    template.semantic_content &&
    typeof template.semantic_content.body_text === 'string' &&
    Array.isArray(template.semantic_variable_mapping) &&
    template.meta_template_id &&
    template.language
  );
}
