import { describe, expect, it } from 'vitest';

import {
  builderInitialFromApiPayload,
  toApiSteps,
  findTemplateMappingIssue,
} from './automation-builder';

describe('automation builder server-state refresh', () => {
  it('never serializes obsolete mapping/value state on a selected semantic action', () => {
    expect(
      toApiSteps([
        {
          cid: 's1',
          step_type: 'send_template',
          step_config: {
            template_id: '11111111-1111-1111-1111-111111111111',
            template_name: 'welcome',
            language: 'en',
            variable_mappings: [],
            variables: { '1': 'WRONG' },
            unrelated: 'keep',
          },
        },
      ])[0].step_config
    ).toEqual({
      template_id: '11111111-1111-1111-1111-111111111111',
      template_name: 'welcome',
      language: 'en',
      unrelated: 'keep',
    });
  });

  it('applies the backend paused state after a failed lifecycle mutation', () => {
    expect(
      builderInitialFromApiPayload({
        automation: {
          id: 'automation-1',
          name: 'Arrival reminder',
          trigger_type: 'checkin_day',
          trigger_config: { local_time: '11:00' },
          is_active: false,
          whatsapp_config_id: null,
        },
        steps: [
          {
            id: 'step-1',
            step_type: 'add_tag',
            step_config: { tag_id: 'tag-1' },
            branches: { yes: [], no: [] },
          },
        ],
      })
    ).toMatchObject({
      id: 'automation-1',
      is_active: false,
      whatsapp_config_id: null,
      steps: [{ step_type: 'add_tag' }],
    });
  });

  it.each([
    { template_name: 'welcome' },
    { template_name: 'welcome', variable_mappings: [] },
    { template_name: 'welcome', variables: { '1': 'old' } },
    { template_id: '' },
  ])(
    'blocks incomplete or obsolete loaded actions from saving: %j',
    (step_config) => {
      const loaded = builderInitialFromApiPayload({
        automation: { id: 'automation-1', trigger_type: 'new_contact_created' },
        steps: [
          {
            id: 'step-1',
            step_type: 'send_template',
            step_config,
            branches: { yes: [], no: [] },
          },
        ],
      });
      expect(findTemplateMappingIssue(loaded.steps, [], null)).toBe(
        'valid template id is required'
      );
      expect(() => toApiSteps(loaded.steps)).toThrow(
        'valid template id is required'
      );
    }
  );
  it('blocks invalid nested actions before saving', () => {
    const steps = [
      {
        cid: 'parent',
        step_type: 'condition' as const,
        step_config: {},
        branches: {
          yes: [],
          no: [
            {
              cid: 'child',
              step_type: 'send_template' as const,
              step_config: { template_id: '' },
            },
          ],
        },
      },
    ];
    expect(findTemplateMappingIssue(steps, [], null)).toBe(
      'valid template id is required'
    );
    expect(() => toApiSteps(steps)).toThrow('valid template id is required');
  });
});
