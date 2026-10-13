import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { translator } from './i18n';
import { formatValue, parseDraft, settingErrorText } from './settings-model';
import type { GridSetting } from './types';

const t = translator('nb');

describe('setting errors', () => {
  it('turns the API reasons for a refused value into Norwegian', () => {
    expect(settingErrorText('Too big: expected number to be <=10000000', t)).toBe(
      'Verdien kan ikke være over 10000000.',
    );
    expect(settingErrorText('a reason is required', t)).toBe('Skriv en begrunnelse.');
    expect(settingErrorText('Invalid input: expected number, received string', t)).toBe(
      'Verdien har feil type.',
    );
    expect(settingErrorText('Noe annet', t)).toBe('Noe annet');
  });

  it('turns the API reasons into English', () => {
    expect(settingErrorText('Too big: expected number to be <=10', translator('en'))).toBe(
      'The value cannot be above 10.',
    );
    expect(settingErrorText('a reason is required', translator('en'))).toBe('Write a reason.');
  });

  it('formats values and drafts in English', () => {
    const en = translator('en');
    const f = createFormat('en');
    const s = { type: 'int', min: 1, max: 5, unit: '' } as unknown as GridSetting;
    expect(formatValue({ ...s, type: 'bool' }, true, en, f)).toBe('On');
    expect(formatValue(s, 12345, en, f)).toBe('12,345');
    expect(parseDraft(s, '9', {}, en, f)).toEqual({ error: 'Must be between 1 and 5.' });
  });
});
