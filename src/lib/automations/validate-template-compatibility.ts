import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { listMessageVariableDefinitions } from '@/lib/message-variables/catalog';
import { variableRequiresReservation } from '@/lib/message-variables/contract';
import { validatePreparationMapping } from '@/lib/message-preparation/mapping';
import { semanticTemplateIsUsable } from './semantic-template-action';
import { isPmsAutomationTrigger } from './pms-trigger-schema';
import type { BuilderStepInput } from './steps-tree';
import { validateTemplateActions, type ValidationIssue } from './validate';

/** Save-time checks only: never resolve runtime values or infer a reservation. */
export async function validateAutomationTemplateCompatibility(
  db: SupabaseClient,
  accountId: string,
  triggerType: string,
  steps: BuilderStepInput[]
): Promise<ValidationIssue[]> {
  const shapeIssues = validateTemplateActions(steps);
  if (shapeIssues.length) return shapeIssues;
  const actions: { templateId: string; path: string }[] = [];
  function walk(nodes: BuilderStepInput[], prefix = '') {
    nodes.forEach((step, index) => {
      const path = `${prefix}steps[${index}]`;
      if (step.step_type === 'send_template')
        actions.push({
          templateId: step.step_config.template_id as string,
          path: `${path}.template_id`,
        });
      if (step.step_type === 'condition') {
        walk(step.branches?.yes ?? [], `${path}.yes.`);
        walk(step.branches?.no ?? [], `${path}.no.`);
      }
    });
  }
  walk(steps);
  if (!actions.length) return [];
  const unavailable = [
    {
      path: 'steps',
      message: 'Template compatibility could not be verified. Try again.',
    },
  ];
  try {
    const { data, error } = await db
      .from('message_templates')
      .select(
        'id,account_id,whatsapp_config_id,status,meta_template_id,language,template_origin,semantic_content,semantic_variable_mapping,variable_configuration_status,body_text,header_type,header_content,footer_text,buttons'
      )
      .eq('account_id', accountId)
      .in('id', [...new Set(actions.map((action) => action.templateId))]);
    if (error) return unavailable;
    const templates = new Map(
      (data ?? []).map((row) => [row.id, row as MessageTemplate])
    );
    const issues: ValidationIssue[] = [];
    const mappings = new Map<
      string,
      ReturnType<typeof validatePreparationMapping>
    >();
    for (const action of actions) {
      const template = templates.get(action.templateId);
      if (!template || template.account_id !== accountId) {
        issues.push({
          path: action.path,
          message: 'Selected template is unavailable for this workspace.',
        });
        continue;
      }
      if (!semanticTemplateIsUsable(template, template.whatsapp_config_id)) {
        issues.push({
          path: action.path,
          message:
            'Selected template must be approved and have configured semantic variables.',
        });
        continue;
      }
      try {
        mappings.set(action.templateId, validatePreparationMapping(template));
      } catch {
        issues.push({
          path: action.path,
          message:
            'Selected template has invalid semantic variable configuration.',
        });
      }
    }
    if (issues.length) return issues;
    const catalog = [...mappings.values()].some((mapping) => mapping.length)
      ? await listMessageVariableDefinitions({ db })
      : [];
    const definitions = new Map(
      catalog.map((definition) => [definition.variableKey, definition])
    );
    for (const action of actions) {
      const mapping = mappings.get(action.templateId) ?? [];
      if (mapping.some((entry) => !definitions.has(entry.variable_key))) {
        issues.push({
          path: action.path,
          message:
            'Selected template contains an unavailable semantic variable.',
        });
      } else if (
        !isPmsAutomationTrigger(triggerType) &&
        mapping.some((entry) =>
          variableRequiresReservation(definitions.get(entry.variable_key))
        )
      ) {
        issues.push({
          path: action.path,
          message:
            'This template requires reservation context and cannot be used with this automation trigger.',
        });
      }
    }
    return issues;
  } catch {
    return unavailable;
  }
}
