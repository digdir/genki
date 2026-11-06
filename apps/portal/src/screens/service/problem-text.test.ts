import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api';
import type { T } from '../../i18n';
import { problemText } from './ServiceKeys';

const t = ((key: string) => key) as unknown as T;

describe('problemText', () => {
  it('shows the problem title when a refusal lists no field errors', () => {
    const refused = new ApiError(403, {
      type: 'about:blank',
      title: 'API-nøkler lages av virksomheten selv',
      status: 403,
      errors: [],
    });

    expect(problemText(refused, t)).toBe('API-nøkler lages av virksomheten selv');
  });

  it('shows the field errors when the problem lists them', () => {
    const refused = new ApiError(400, {
      type: 'about:blank',
      title: 'Invalid request',
      status: 400,
      errors: [{ path: 'name', message: 'a name is required' }],
    });

    expect(problemText(refused, t)).toBe('a name is required');
  });
});
