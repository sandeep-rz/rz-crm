import { describe, expect, it } from 'vitest';

import { builderInitialFromApiPayload } from './automation-builder';

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
});
