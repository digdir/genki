import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import type { SettingRow } from '../../data/settings';
import { translator } from '../../i18n';
import { allowedText, parseDraft } from './model';

const row = (extra: Partial<SettingRow>): SettingRow => ({
  id: 'search.retrieveTopK',
  cat: 'Søk',
  label: 'Treff',
  desc: '',
  type: 'int',
  sens: 'Lav',
  scope: ['virksomhet'],
  P: 10,
  V: null,
  svc: {},
  ds: {},
  ...extra,
});

describe('allowed range of a number setting', () => {
  it('says there is no upper limit instead of showing the largest safe integer', () => {
    const open = row({ min: 1, max: Number.MAX_SAFE_INTEGER });
    expect(allowedText(open, translator('nb'), createFormat('nb'))).toBe(
      'Fra 1, ingen øvre grense',
    );
    expect(allowedText(open, translator('en'), createFormat('en'))).toBe('From 1, no upper limit');
    const err = parseDraft(open, '0', translator('nb'), createFormat('nb'));
    expect(err).toEqual({ err: 'Verdien må være minst 1.' });
  });

  it('still names both ends when the setting has a real maximum', () => {
    expect(allowedText(row({ min: 1, max: 50 }), translator('nb'), createFormat('nb'))).toBe(
      'Fra 1 til 50',
    );
  });
});
