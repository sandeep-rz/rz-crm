import { describe, expect, it } from 'vitest';

import { builderInitialFromApiPayload, toApiSteps } from './automation-builder';

describe('automation builder server-state refresh', () => {
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

  it('preserves semantic mappings through save and reload shapes', () => {
    const variable_mappings = [
      {
        component: 'body',
        position: 1,
        source_type: 'catalog_variable',
        variable_key: 'contact.first_name',
      },
    ];
    const saved = toApiSteps([
      {
        cid: 'step-1',
        step_type: 'send_template',
        step_config: {
          template_name: 'welcome',
          language: 'en',
          variable_mappings,
        },
      },
    ]);
    const reloaded = builderInitialFromApiPayload({
      automation: {
        id: 'automation-1',
        trigger_type: 'new_contact_created',
      },
      steps: [
        {
          id: 'step-1',
          step_type: 'send_template',
          step_config: saved[0].step_config,
          branches: { yes: [], no: [] },
        },
      ],
    });
    expect(reloaded.steps[0].step_config.variable_mappings).toEqual(
      variable_mappings
    );
  });

  it('preserves legacy Send Template variables on reload', () => {
    const legacy = builderInitialFromApiPayload({
      automation: {
        id: 'automation-1',
        trigger_type: 'new_message_received',
      },
      steps: [
        {
          id: 'step-1',
          step_type: 'send_template',
          step_config: {
            template_name: 'legacy',
            variables: { '1': '{{ vars.guest_name }}' },
          },
          branches: { yes: [], no: [] },
        },
      ],
    });
    expect(legacy.steps[0].step_config).toMatchObject({
      template_name: 'legacy',
      variables: { '1': '{{ vars.guest_name }}' },
    });
    expect(legacy.steps[0].step_config.variable_mappings).toBeUndefined();
  });
});
