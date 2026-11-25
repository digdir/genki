import { describe, expect, it } from 'vitest';
import type { AuditRow } from '../../api';
import { translator } from '../../i18n';
import {
  actorOf,
  areaOf,
  auditActionsWithLabels,
  changeParts,
  changeText,
  collapseRepeats,
} from './changes';

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
      'publiserte utgave 4 av kunnskapsassistenten',
    );
    expect(
      changeText(row('platform.testset.save', 'test-set:991825827/ka-kudos-utkast@11'), en),
    ).toBe('saved the test set ka-kudos-utkast, edition 11');
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

describe('change rows', () => {
  const nb = translator('nb');

  it('names a service by its name and points at it, from every service target form', () => {
    const names = (id: string) => (id === 'smoke-throwaway' ? 'Røyktest' : undefined);
    for (const target of [
      'service:991825827/smoke-throwaway',
      'Service:smoke-throwaway@3',
      'service-draft:smoke-throwaway',
    ]) {
      const parts = changeParts(row('platform.service.lifecycle', target), nb, names);
      expect(parts.target?.service, target).toBe('smoke-throwaway');
      expect(parts.target?.text, target).toMatch(/^Røyktest/);
    }
  });

  it('never shows a bare target kind such as definition', () => {
    expect(changeText({ ...row('platform.service.publish', 'definition') }, nb)).not.toMatch(
      /definition/,
    );
  });

  it('says in words that a rejected change was rejected', () => {
    expect(
      changeText({ ...row('platform.service.publish', 'definition'), outcome: 'rejected' }, nb),
    ).toBe('publiserte, men det ble avvist');
  });

  it('names an API key actor as a key by its name, never as an employee', () => {
    const entry = {
      ...row('platform.service.lifecycle'),
      actor: 'agency-system:urn:genai:legacy-api-key:k1',
    };
    expect(actorOf(entry, nb, (id) => (id === 'k1' ? 'deploy-smoke' : undefined))).toBe(
      'API-nøkkel deploy-smoke',
    );
    expect(actorOf(entry, nb)).toBe('API-nøkkel');
  });

  it('names a person by the remembered name and falls back to an employee', () => {
    const entry = { ...row('platform.service.publish'), actor: 'employee:ap:123' };
    expect(actorOf({ ...entry, actorName: 'Kari Nordmann' }, nb)).toBe('Kari Nordmann');
    expect(actorOf(entry, nb)).toBe('Ansatt i virksomheten');
  });

  it('collapses the same change repeated within minutes into one row', () => {
    const at = (time: string) => ({
      ...row('platform.service.lifecycle', 'service:991825827/x'),
      at: `2026-10-12T${time}Z`,
    });
    expect(
      collapseRepeats([at('08:15:30'), at('08:15:00'), at('06:00:00')]).map((e) => e.at),
    ).toEqual(['2026-10-12T08:15:30Z', '2026-10-12T06:00:00Z']);
  });

  it('sorts each action into an area of the design', () => {
    expect(areaOf('platform.service.publish')).toBe('services');
    expect(areaOf('platform.pipeline.execute')).toBe('datasets');
    expect(areaOf('platform.support.open')).toBe('access');
    expect(areaOf('platform.setting.set')).toBe('settings');
  });

  it('files quota requests and incidents under settings, not services', () => {
    expect(areaOf('platform.quota.request')).toBe('settings');
    expect(areaOf('platform.quota.decide')).toBe('settings');
    expect(areaOf('platform.incident.save')).toBe('settings');
    expect(areaOf('platform.incident.resolve')).toBe('settings');
  });
});

describe('service copies and tool withdrawals', () => {
  it('labels copying a service and withdrawing a tool approval, both under Tjenester', () => {
    const nb = translator('nb');
    const en = translator('en');
    expect(changeParts(row('platform.service.copy'), nb).label).toBe('kopierte tjenesten');
    expect(changeParts(row('platform.service.copy'), en).label).toBe('copied the service');
    expect(changeParts(row('platform.tools.revoke'), nb).label).toBe(
      'trakk tilbake godkjenningen av et verktøy',
    );
    expect(changeParts(row('platform.tools.revoke'), en).label).toBe(
      'withdrew approval for a tool',
    );
    expect(areaOf('platform.service.copy')).toBe('services');
    expect(areaOf('platform.tools.revoke')).toBe(areaOf('platform.tools.approve'));
  });
});

describe('feature flag changes', () => {
  const nb = translator('nb');
  const en = translator('en');
  const personTarget = 'flag:blockStudio:person:https://test.ansattporten.no:kari@digdir.no';
  const flagRow = (
    action: 'platform.flag.person' | 'platform.flag.tenant',
    flag?: AuditRow['flag'],
    target = action === 'platform.flag.person' ? personTarget : 'flag:blockStudio',
  ): AuditRow => ({ ...row(action, target), ...(flag ? { flag } : {}) });
  const sentence = (entry: AuditRow, t = nb) => changeText(entry, t, 'Digdir');

  it('says switched on for oneself when a person turned the feature on for themselves', () => {
    const entry = flagRow('platform.flag.person', {
      key: 'blockStudio',
      on: true,
      person: { self: true },
    });
    expect(sentence(entry)).toBe('slo på «Ny utforming» for seg selv');
    expect(sentence(entry, en)).toBe('switched on «New design tools» for themselves');
  });

  it('says switched off for the whole organisation by name on a tenant switch', () => {
    const entry = flagRow('platform.flag.tenant', { key: 'blockStudio', on: false });
    expect(sentence(entry)).toBe('slo av «Ny utforming» for hele Digdir');
    expect(sentence(entry, en)).toBe('switched off «New design tools» for all of Digdir');
  });

  it('says the person followed the organisation when a personal choice is removed', () => {
    const entry = flagRow('platform.flag.person', {
      key: 'blockStudio',
      on: null,
      person: { self: true },
    });
    expect(sentence(entry)).toBe('fulgte virksomhetens valg for «Ny utforming»');
  });

  it('names the other person when someone changed another person’s setting', () => {
    const entry = flagRow('platform.flag.person', {
      key: 'blockStudio',
      on: true,
      person: { self: false, name: 'Ingrid Berg' },
    });
    expect(sentence(entry)).toBe('slo på «Ny utforming» for Ingrid Berg');
  });

  it('leaves the person out when another person’s name is not known', () => {
    const entry = flagRow('platform.flag.person', {
      key: 'blockStudio',
      on: true,
      person: { self: false },
    });
    expect(sentence(entry)).toBe('slo på «Ny utforming»');
  });

  it('reads an old flag entry without on or off as a neutral change that still names the feature', () => {
    expect(sentence(flagRow('platform.flag.tenant'))).toBe('endret «Ny utforming» for hele Digdir');
    expect(sentence(flagRow('platform.flag.person'))).toBe('endret «Ny utforming»');
  });

  it('never shows the raw flag entry id or the issuer', () => {
    for (const entry of [
      flagRow('platform.flag.person'),
      flagRow('platform.flag.person', { key: 'blockStudio', on: true, person: { self: true } }),
      flagRow('platform.flag.tenant', { key: 'blockStudio', on: false }),
    ])
      for (const t of [nb, en]) expect(sentence(entry, t)).not.toMatch(/ansattporten|flag:|@|:/);
  });

  it('falls back to the feature key when the feature has no name in the catalogue', () => {
    const entry = flagRow('platform.flag.tenant', { key: 'newThing', on: true }, 'flag:newThing');
    expect(sentence(entry)).toBe('slo på «newThing» for hele Digdir');
  });
});
