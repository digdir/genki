import { describe, expect, it } from 'vitest';
import {
  emptyLayout,
  isAssistantLayout,
  layoutProblems,
  turnOff,
  withLook,
  withProfile,
  type AssistantLayout,
} from './layout.js';
import {
  isHttpsLink,
  isProfileData,
  PROFILE_MAX_BYTES,
  profileLimits,
  profileProblems,
  type ProfileData,
} from './profile.js';
import { changeTemplate, fromTemplate } from './templates.js';

// kunnskapsassistenten's profile, the part of it that is data.
const ka: ProfileData = {
  assistantName: 'Kunnskapsassistenten',
  suggestions: ['Hva handler dokumentene i Kudos om?'],
  followUps: ['Kan du utdype?'],
  corpora: {
    kudos: {
      label: 'Kudos',
      description: 'dokumenter fra kudos.dfo.no',
      fields: [
        { id: 'type', label: 'Dokumenttyper', heading: 'Dokumenttype' },
        { id: 'concerned_years', label: 'År', kind: 'year', years: { first: 1990 } },
      ],
      typeField: 'type',
      typePlurals: { Årsrapport: 'årsrapporter' },
      documentLinks: {
        digits: 'https://kudos.dfo.no/documents/{id}',
        uuid: 'https://kudos.dfo.no/dokument/{id}',
      },
      about: { idField: 'doc_num', fields: ['type', 'concerned_years'] },
    },
  },
  experiments: [
    {
      id: 'filters-right-panel',
      title: 'Filtreringen i høyre panel',
      href: 'https://github.com/digdir/kunnskapsassistenten/issues/84',
      hrefLabel: 'Sak 84',
    },
  ],
  settingsNote: 'Valgene huskes i denne nettleseren.',
};

const withKa = (profile: unknown = ka) => ({ ...emptyLayout, profile }) as AssistantLayout;
const kudos = (corpus: object): ProfileData => ({ corpora: { kudos: corpus } });

describe('the profile as data in a layout', () => {
  it('reads a stored layout with a profile, and one without, as before', () => {
    expect(isAssistantLayout(withKa())).toBe(true);
    expect(isAssistantLayout(JSON.parse(JSON.stringify(withKa())))).toBe(true);
    expect(isAssistantLayout(emptyLayout)).toBe(true);
  });

  it('refuses a profile that is not plain data of the right shape', () => {
    const broken: unknown[] = [
      'Kunnskapsassistenten',
      [],
      { assistantName: 7 },
      { suggestions: 'Hva er fast?' },
      { suggestions: [1] },
      { corpora: [] },
      kudos({ label: { nb: 'Kudos', en: 'Kudos' } }),
      kudos({ fields: [{ id: 'type' }] }),
      kudos({ typePlurals: { Årsrapport: 1 } }),
      kudos({ about: { idField: 'doc_num' } }),
      { experiments: [{ id: 'x' }] },
      { settingsNote: null },
    ];
    for (const profile of broken) {
      expect(isProfileData(profile)).toBe(false);
      expect(isAssistantLayout(withKa(profile))).toBe(false);
    }
  });

  it('refuses a field of a kind it does not know, and a link for a kind of number it does not know', () => {
    expect(
      isAssistantLayout(withKa(kudos({ fields: [{ id: 'd', label: 'D', kind: 'date' }] }))),
    ).toBe(false);
    expect(
      isAssistantLayout(withKa(kudos({ documentLinks: { isbn: 'https://example.no/{id}' } }))),
    ).toBe(false);
  });

  it('refuses years that are not whole numbers', () => {
    const years = (bounds: object) =>
      withKa(kudos({ fields: [{ id: 'y', label: 'År', kind: 'year', years: bounds }] }));
    expect(isAssistantLayout(years({ first: 1990, last: 2026 }))).toBe(true);
    expect(isAssistantLayout(years({ first: '1990' }))).toBe(false);
    expect(isAssistantLayout(years({ last: 2026.5 }))).toBe(false);
  });

  it('finds nothing wrong with kunnskapsassistenten’s profile as data', () => {
    expect(layoutProblems(withKa())).toEqual([]);
  });

  it('finds a profile larger than 32 KiB, counted as UTF-8', () => {
    const note = 'æ'.repeat(PROFILE_MAX_BYTES / 2);
    const problems = layoutProblems(withKa({ settingsNote: note }));
    expect(problems).toContainEqual({
      rule: 'profile-too-large',
      bytes: PROFILE_MAX_BYTES + '{"settingsNote":""}'.length,
      max: PROFILE_MAX_BYTES,
    });
  });

  it('finds each text longer than its limit, with its path and the limit', () => {
    const long = (n: number) => 'a'.repeat(n + 1);
    const problems = profileProblems({
      assistantName: long(profileLimits.name),
      suggestions: ['Hva er fast?', long(profileLimits.question)],
      settingsNote: long(profileLimits.settingsNote),
      corpora: {
        kudos: {
          description: long(profileLimits.description),
          fields: [{ id: 'type', label: long(profileLimits.name) }],
        },
      },
      experiments: [{ id: 'x', title: long(profileLimits.name) }],
    });
    expect(problems).toEqual([
      { rule: 'text-too-long', path: 'profile.assistantName', max: 80 },
      { rule: 'text-too-long', path: 'profile.suggestions[1]', max: 200 },
      { rule: 'text-too-long', path: 'profile.settingsNote', max: 1_000 },
      { rule: 'text-too-long', path: 'profile.corpora.kudos.description', max: 500 },
      { rule: 'text-too-long', path: 'profile.corpora.kudos.fields[0].label', max: 80 },
      { rule: 'text-too-long', path: 'profile.experiments[0].title', max: 80 },
    ]);
  });

  it('finds a list with more entries than its limit', () => {
    const many = <T>(n: number, entry: (i: number) => T) =>
      Array.from({ length: n + 1 }, (_, i) => entry(i));
    const problems = profileProblems({
      suggestions: many(profileLimits.questions, (i) => `Spørsmål ${i}`),
      corpora: {
        kudos: { fields: many(profileLimits.fields, (i) => ({ id: `f${i}`, label: `F${i}` })) },
      },
    });
    expect(problems).toEqual([
      { rule: 'too-many', path: 'profile.suggestions', max: 6 },
      { rule: 'too-many', path: 'profile.corpora.kudos.fields', max: 30 },
    ]);
  });

  it('finds a link template that is not https, or whose number could change the host', () => {
    const links = {
      digits: 'http://kudos.dfo.no/documents/{id}',
      uuid: 'https://{id}.kudos.dfo.no/',
      any: 'javascript:alert({id})',
    };
    expect(profileProblems(kudos({ documentLinks: links }))).toEqual([
      { rule: 'link-not-https', path: 'profile.corpora.kudos.documentLinks.digits' },
      { rule: 'link-not-https', path: 'profile.corpora.kudos.documentLinks.uuid' },
      { rule: 'link-not-https', path: 'profile.corpora.kudos.documentLinks.any' },
    ]);
    expect(
      profileProblems({ experiments: [{ id: 'x', title: 'X', href: 'http://x.no/' }] }),
    ).toEqual([{ rule: 'link-not-https', path: 'profile.experiments[0].href' }]);
  });

  it('takes an https link with its host before the number, and nothing else', () => {
    expect(isHttpsLink('https://kudos.dfo.no/documents/{id}')).toBe(true);
    expect(isHttpsLink('https://kudos.dfo.no/sok?q={id}')).toBe(true);
    expect(isHttpsLink('https://kudos.dfo.no')).toBe(true);
    expect(isHttpsLink('HTTPS://kudos.dfo.no/{id}')).toBe(false);
    expect(isHttpsLink('https://kudos.dfo.no{id}')).toBe(false);
    expect(isHttpsLink('https://kudos.dfo.no@example.com/{id}')).toBe(false);
    expect(isHttpsLink('https:///{id}')).toBe(false);
    expect(isHttpsLink('//kudos.dfo.no/{id}')).toBe(false);
  });

  it('finds a field of a kind it does not know, though the type allows none', () => {
    const profile = JSON.parse(
      '{"corpora":{"kudos":{"fields":[{"id":"d","label":"D","kind":"date"}]}}}',
    ) as ProfileData;
    expect(layoutProblems(withKa(profile))).toEqual([
      { rule: 'unknown-kind', path: 'profile.corpora.kudos.fields[0].kind', kind: 'date' },
    ]);
  });
});

describe('the profile in the builder', () => {
  it('sets a profile and takes it away again, the blocks and the look as they were', () => {
    const start = fromTemplate('knowledge-assistant-next');
    const set = withProfile(start, ka);
    expect(set.layout.profile).toBe(ka);
    expect(set.layout.zones).toBe(start.layout.zones);
    expect(set.layout.look).toBe('next');
    expect(withProfile(set, undefined).layout).toEqual(start.layout);
    expect('profile' in withProfile(set, undefined).layout).toBe(false);
  });

  it('keeps the profile through a change of template, of look and of blocks', () => {
    const state = withProfile(fromTemplate('knowledge-assistant'), ka);
    expect(changeTemplate(state, 'chat-only').layout.profile).toBe(ka);
    expect(changeTemplate(state, 'knowledge-assistant-next').layout.profile).toBe(ka);
    expect(withLook(state, 'next').layout.profile).toBe(ka);
    expect(turnOff(state, 'filter').layout.profile).toBe(ka);
  });

  it('starts a template with no profile', () => {
    expect(fromTemplate('knowledge-assistant').layout.profile).toBeUndefined();
  });
});
