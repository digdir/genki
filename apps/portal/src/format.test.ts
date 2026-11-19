import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format';
import { describeSchedule } from './screens/integrations/Triggers';
import { clock } from './screens/service/dev-format';

describe('clock times in the portal', () => {
  const at = '2026-10-07T12:07:00Z';

  it('read 14:07 in bokmål, with the date as before', () => {
    const nb = createFormat('nb');
    expect(nb.time(at)).toBe('14:07');
    expect(clock(at, nb)).toBe('14:07');
    expect(formatDateTime(at)).toBe('7. okt. 2026, 14:07');
    expect(describeSchedule('7 14 * * *')).toBe('Hver dag kl. 14:07');
  });
});
