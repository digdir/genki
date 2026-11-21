import { interfaceLimits, PROFILE_MAX_BYTES, serviceInterface } from '@genai/definitions';
import {
  fromTemplate,
  PROFILE_MAX_BYTES as BUILDER_PROFILE_MAX_BYTES,
  profileLimits,
  templateIds,
  type ProfileData,
} from '@genai/ui-blocks/builder';
import { describe, expect, it } from 'vitest';

const fullProfile: ProfileData = {
  assistantName: 'Kunnskapsassistenten',
  suggestions: ['Hva handler dokumentene om?'],
  followUps: ['Fortell mer'],
  corpora: {
    kudos: {
      label: 'Kudos',
      description: 'Dokumenter fra kudos.dfo.no',
      fields: [
        { id: 'type', label: 'Dokumenttyper', heading: 'Dokumenttype' },
        { id: 'year', label: 'År', kind: 'year', years: { first: 1990, last: 2026 } },
      ],
      typePlurals: { Årsrapport: 'årsrapporter' },
      typeField: 'type',
      documentLinks: { digits: 'https://kudos.dfo.no/documents/{id}' },
      about: { idField: 'doc_num', fields: ['type'] },
    },
  },
  experiments: [
    {
      id: 'ny',
      title: 'Nytt søk',
      description: 'Prøv det nye søket',
      href: 'https://github.com/digdir/genki/issues/1',
      hrefLabel: 'Saken',
    },
  ],
  settingsNote: 'Valgene huskes i denne nettleseren.',
};

describe('the layout the portal builder saves in the draft', () => {
  it.each(templateIds)(
    'is a valid spec.interface for the template %s with a full profile',
    (id) => {
      const layout = { ...fromTemplate(id).layout, profile: fullProfile };
      const parsed = serviceInterface.safeParse({ layout });
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.data).toEqual({ layout });
    },
  );

  it('has the same text limits in the definition as in the builder', () => {
    expect(interfaceLimits).toMatchObject(profileLimits);
    expect(PROFILE_MAX_BYTES).toBe(BUILDER_PROFILE_MAX_BYTES);
  });
});
