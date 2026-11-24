const fileSearchMarker = /【 ?(\d+)(?::\d+)?(?:†[^】\n]{0,200})? ?】/g;

// A bracket's text is short, so each bracket is read at most once and within a bound.
const bracket = /\[([^[\]\n]{1,80})\]/g;
// One source with its pages, in the forms answers in test have used: `1, s. 63`, `1 s. 61`,
// `1, s. 61–62`, `1, s. 5, 34 og 42`.
const sourcePage =
  /^ ?(\d{1,3}),? (s\. ?\d{1,5}(?: ?[-–] ?\d{1,5})?(?:(?:, | og )\d{1,5}(?: ?[-–] ?\d{1,5})?)*) ?$/;

/**
 * Rewrites the citation markers a model writes in other forms as the contract's `[N]`:
 * OpenAI file search's `【N†…】`, and a page written inside the bracket, `[1, s. 63]`,
 * as `[1] s. 63`. A bracket is rewritten only when every number in it is a source
 * (`isSource`), so `validateCitations` stays the judge of what is a citation.
 */
export const normaliseCitationMarkers = (
  text: string,
  isSource: (n: number) => boolean = () => true,
): string =>
  text.replace(fileSearchMarker, '[$1]').replace(bracket, (whole, inside: string) => {
    const cited: string[] = [];
    for (const one of inside.split(';')) {
      const m = sourcePage.exec(one);
      if (!m || !isSource(Number(m[1]))) return whole;
      cited.push(`[${m[1]}] ${m[2]}`);
    }
    return cited.join('; ');
  });
