/** Languages a pipeline can set or detect for documents whose URL and frontmatter give none. */
export const documentLanguages = ['nb', 'nn', 'en'] as const;
export type DocumentLanguage = (typeof documentLanguages)[number];

// Common words of each language that the others do not use as words.
const english = new Set(
  'the and of to is in that it with as are be this you by not or an on at from can which have has will your if must when should was were these their they them than also into'.split(
    ' ',
  ),
);
const norwegian = new Set(
  'og er det som på til av med ikke ikkje å den har kan skal må ved fra frå eller når hvis viss om at seg sin sitt sine vi du dere også òg'.split(
    ' ',
  ),
);
// Word pairs where bokmål and nynorsk differ.
const bokmal = new Set(
  'ikke fra hva hvordan hvis jeg noe noen mye være bare hele sammen disse hvor hvilke også en et'.split(
    ' ',
  ),
);
const nynorsk = new Set(
  'ikkje frå kva korleis viss eg noko nokon mykje vere berre heile saman desse kvar òg dei ho vart eit ein'.split(
    ' ',
  ),
);
/** A word in both sets counts for neither. */
const disjoint = (a: Set<string>, b: Set<string>) => {
  for (const w of [...a])
    if (b.has(w)) {
      a.delete(w);
      b.delete(w);
    }
};
disjoint(english, norwegian);
disjoint(bokmal, nynorsk);

const anyNorwegian = new Set([...norwegian, ...bokmal, ...nynorsk]);

/** How many marker words a text needs before a guess is made. */
export const minimumLanguageSignal = 5;

const words = (text: string) =>
  text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
    .match(/[a-zæøåò]+/g) ?? [];

const count = (tokens: string[], set: Set<string>) => tokens.filter((t) => set.has(t)).length;

/**
 * A deterministic guess at a Markdown document's language: Norwegian or English by common words,
 * then bokmål or nynorsk by the words where they differ. Code blocks, inline code and URLs are
 * ignored. Returns undefined when there are fewer than `minimumLanguageSignal` marker words, or
 * when bokmål and nynorsk cannot be told apart.
 */
export const detectLanguage = (text: string): DocumentLanguage | undefined => {
  const tokens = words(text);
  const en = count(tokens, english);
  const no = count(tokens, anyNorwegian);
  if (en + no < minimumLanguageSignal) return undefined;
  if (en > no) return 'en';
  const nb = count(tokens, bokmal);
  const nn = count(tokens, nynorsk);
  if (nb === nn) return nb === 0 ? 'nb' : undefined;
  return nn > nb ? 'nn' : 'nb';
};
