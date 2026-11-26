// A layout's profile as the builder reads it: the plurals «Lim inn oppsett» names, and the profile
// the try view draws, cleaned so an empty text draws nothing rather than an empty one.
import type { DrawnProfile, ProfileCorpus, ProfileText } from '@genai/ui-blocks/builder';

const blank = (value: string | undefined) => value === undefined || value.trim() === '';

/** The plurals as rows, in the order they were written. */
export const pluralRows = (corpus: ProfileCorpus | undefined): [string, ProfileText][] =>
  Object.entries(corpus?.typePlurals ?? {});

/** The profile as the try view draws it: an empty text draws nothing, an empty label the id. */
export const drawnProfile = (profile: DrawnProfile): DrawnProfile => ({
  ...profile,
  ...(profile.suggestions ? { suggestions: profile.suggestions.filter((s) => !blank(s)) } : {}),
  ...(profile.corpora
    ? {
        corpora: Object.fromEntries(
          Object.entries(profile.corpora).map(([key, corpus]) => [
            key,
            {
              ...corpus,
              ...(corpus.fields
                ? {
                    fields: corpus.fields.map((f) => ({
                      ...f,
                      label: blank(f.label) ? f.id : f.label,
                      ...(blank(f.heading) ? { heading: undefined } : {}),
                    })),
                  }
                : {}),
              ...(corpus.typePlurals
                ? {
                    typePlurals: Object.fromEntries(
                      Object.entries(corpus.typePlurals).filter(
                        ([type, plural]) => !blank(type) && !blank(plural),
                      ),
                    ),
                  }
                : {}),
            },
          ]),
        ),
      }
    : {}),
});
