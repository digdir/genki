import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/error';
import { translator } from '../../i18n';
import { problemTitle, testSetId } from './shared';

describe('problemTitle', () => {
  it('shows the field messages of a 400 in the screen language instead of only the generic title', () => {
    const error = new ApiError(400, {
      type: 'about:blank',
      title: 'Ugyldig forespørsel',
      status: 400,
      errors: [{ path: 'id', message: 'ikke en gyldig id' }],
    });
    expect(problemTitle(error, translator('nb'))).toBe(
      'Plattformen godtok ikke endringen: ikke en gyldig id',
    );
    expect(problemTitle(error, translator('en'))).toBe(
      'The platform did not accept the change: ikke en gyldig id',
    );
  });

  it('falls back to the problem title when a 400 has no field messages', () => {
    const error = new ApiError(400, {
      type: 'about:blank',
      title: 'Ugyldig forespørsel',
      status: 400,
    });
    expect(problemTitle(error, translator('nb'))).toBe('Ugyldig forespørsel');
  });
});

describe('testSetId', () => {
  it('prefixes the service and avoids ids already taken', () => {
    expect(testSetId('ka', 'Kudos utkast', [])).toBe('ka-kudos-utkast');
    expect(testSetId('ka', 'Kudos utkast', ['ka-kudos-utkast'])).toBe('ka-kudos-utkast-2');
  });
});
