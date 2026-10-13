import { describe, expect, it } from 'vitest';
import type { AuditRow } from '../../api';
import { translator } from '../../i18n';
import { auditActionsWithLabels, changeText } from './changes';

const apiSources = import.meta.glob<string>(
  ['../../../../api/src/**/*.ts', '!../../../../api/src/**/*.test.ts'],
  { query: '?raw', import: 'default', eager: true },
);

const apiActions = [
  ...new Set(
    Object.values(apiSources).flatMap((source) =>
      [...source.matchAll(/'(platform\.[a-z0-9.-]+)'/g)].map((m) => m[1] ?? ''),
    ),
  ),
].sort();

const row = (action: string, target = ''): AuditRow => ({
  task: 't1',
  tenant: '991825827',
  action,
  actor: 'kari',
  at: '2026-10-12T08:00:00Z',
  outcome: 'applied',
  target,
  reason: '',
});

describe('change texts', () => {
  it('every audit action the API can write has a bokmål and an English label', () => {
    expect(apiActions.length).toBeGreaterThan(50);
    expect(apiActions.filter((a) => !auditActionsWithLabels.includes(a))).toEqual([]);
    for (const locale of ['nb', 'en'] as const) {
      const t = translator(locale);
      for (const action of apiActions) {
        const text = changeText(row(action), t);
        expect(text, action).not.toMatch(/platform\.|changes\./);
        expect(text.trim(), action).not.toBe('');
      }
    }
  });

  it('shows the object name and version instead of raw target codes', () => {
    const nb = translator('nb');
    const en = translator('en');
    expect(changeText(row('platform.service.publish', 'Service:kunnskapsassistenten@4'), nb)).toBe(
      'publiserte kunnskapsassistenten, versjon 4',
    );
    expect(
      changeText(row('platform.testset.save', 'test-set:991825827/ka-kudos-utkast@11'), en),
    ).toBe('saved the test set ka-kudos-utkast, version 11');
    expect(changeText(row('platform.audit.export', 'audit:export'), nb)).toBe(
      'eksporterte endringsloggen',
    );
    expect(changeText(row('platform.support.end', 'support:6de2a1'), nb)).toBe(
      'avsluttet støttetilgangen',
    );
  });

  it('an unknown action reads as a plain sentence, never as its code', () => {
    expect(changeText(row('platform.something.new'), translator('nb'))).toBe('gjorde en endring');
    expect(changeText(row('platform.something.new'), translator('en'))).toBe('made a change');
  });
});
