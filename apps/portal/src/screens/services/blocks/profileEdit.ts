// The «Tekster» panel's edits of a layout's profile, as data. The panel keeps what the person
// types; the try view draws it cleaned, so an empty text draws nothing rather than an empty one.
import type {
  DatasetFilter,
  DocumentIdPattern,
  ProfileCorpus,
  ProfileData,
  ProfileField,
  ProfileProblem,
} from '@genai/ui-blocks/builder';

/** One collection the draft searches: its key, as `/v1/models` names it, and its filter fields. */
export interface Collection {
  key: string;
  fields: readonly DatasetFilter[];
}

/** The collections of a draft's datasets, by key, with their multiselect fields once known. */
export const collectionsOf = (
  datasets: readonly string[],
  filtersOf: (dataset: string) => readonly DatasetFilter[] | undefined,
): Collection[] =>
  datasets.map((id) => ({
    key: id.slice(id.lastIndexOf('/') + 1),
    fields: (filtersOf(id) ?? []).filter((f) => f.kinds?.includes('multiselect')),
  }));

const blank = (value: string | undefined) => value === undefined || value.trim() === '';

/** The object without one of its keys. */
const omit = <V extends object>(value: V, key: string): V =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)) as V;

/** The profile with nothing left in it as nothing, so the layout carries no empty profile. */
const settled = (profile: ProfileData): ProfileData | undefined =>
  Object.values(profile).some((value) => value !== undefined) ? profile : undefined;

/** A text of the profile set, or taken away when it is empty. */
export const withText = (
  profile: ProfileData | undefined,
  key: 'assistantName' | 'settingsNote',
  value: string,
): ProfileData | undefined => {
  return settled(blank(value) ? omit({ ...profile }, key) : { ...profile, [key]: value });
};

/** The suggestions as typed; none at all takes the list away. */
export const withSuggestions = (
  profile: ProfileData | undefined,
  suggestions: readonly string[],
): ProfileData | undefined => {
  const next: ProfileData = { ...profile };
  if (suggestions.length === 0) delete next.suggestions;
  else next.suggestions = suggestions;
  return settled(next);
};

/** A collection's words, changed by `change`; a collection left with no words is taken away. */
export const withCorpus = (
  profile: ProfileData | undefined,
  key: string,
  change: (corpus: ProfileCorpus) => ProfileCorpus | undefined,
): ProfileData | undefined => {
  const all = { ...profile?.corpora };
  const own = Object.hasOwn(all, key) ? all[key] : undefined;
  const changed = change({ ...own });
  const kept =
    changed && Object.values(changed).some((value) => value !== undefined) ? changed : undefined;
  const corpora = kept ? { ...all, [key]: kept } : omit(all, key);
  const next: ProfileData = { ...profile };
  if (Object.keys(corpora).length > 0) next.corpora = corpora;
  else delete next.corpora;
  return settled(next);
};

/** A corpus text set, or taken away when it is empty. */
export const corpusText = (
  corpus: ProfileCorpus,
  key: 'label' | 'description' | 'typeField',
  value: string,
): ProfileCorpus => {
  return blank(value) ? omit(corpus, key) : { ...corpus, [key]: value };
};

/** A link template for one kind of document number set, or taken away when it is empty. */
export const corpusLink = (
  corpus: ProfileCorpus,
  pattern: DocumentIdPattern,
  value: string,
): ProfileCorpus => {
  const all = { ...corpus.documentLinks };
  const links = blank(value) ? omit(all, pattern) : { ...all, [pattern]: value };
  const next = { ...corpus };
  if (Object.keys(links).length > 0) next.documentLinks = links;
  else delete next.documentLinks;
  return next;
};

/**
 * The fields the filter offers: the profile's, or without them every field the dataset declares,
 * named as the dataset names it.
 */
export const fieldsIn = (
  corpus: ProfileCorpus | undefined,
  declared: readonly DatasetFilter[],
): readonly ProfileField[] =>
  corpus?.fields ?? declared.map((f) => ({ id: f.field, label: f.field }));

/**
 * One field changed, or taken in or out of the filter. The fields stay in the dataset's order, and
 * a field the profile names that the dataset does not declare stays after them.
 */
export const withField = (
  corpus: ProfileCorpus,
  declared: readonly DatasetFilter[],
  id: string,
  change: (field: ProfileField) => ProfileField | undefined,
): ProfileCorpus => {
  const current = fieldsIn(corpus, declared);
  const found = current.find((f) => f.id === id);
  const changed = change(found ?? { id, label: id });
  const order = declared.map((f) => f.field);
  const others = current.filter((f) => f.id !== id);
  const fields = [...others, ...(changed ? [changed] : [])].sort((a, b) => {
    const at = (f: ProfileField) => (order.includes(f.id) ? order.indexOf(f.id) : order.length);
    return at(a) - at(b);
  });
  return { ...corpus, fields };
};

/** The plurals as rows, in the order they were written. */
export const pluralRows = (corpus: ProfileCorpus | undefined): [string, string][] =>
  Object.entries(corpus?.typePlurals ?? {});

/** The plurals from rows; a later row of the same type wins, and none takes them away. */
export const withPlurals = (
  corpus: ProfileCorpus,
  rows: readonly (readonly [string, string])[],
): ProfileCorpus => {
  const next = { ...corpus };
  if (rows.length === 0) delete next.typePlurals;
  else next.typePlurals = Object.fromEntries(rows);
  return next;
};

/** The profile as the try view draws it: an empty text draws nothing, an empty label the id. */
export const drawnProfile = (profile: ProfileData): ProfileData => ({
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

/** The profile's problems by the path they concern, the whole profile's under `profile`. */
export const problemsByPath = (problems: readonly ProfileProblem[]) => {
  const byPath = new Map<string, ProfileProblem[]>();
  for (const problem of problems) {
    const path = 'path' in problem ? problem.path : 'profile';
    byPath.set(path, [...(byPath.get(path) ?? []), problem]);
  }
  return byPath;
};
