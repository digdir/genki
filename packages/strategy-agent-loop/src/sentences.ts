/** Sentence ids for an excerpt the model reads (#971); offsets are into the text «Kilder» shows. */
export interface Unit {
  start: number;
  end: number;
}

export interface TextQuote {
  type: 'TextQuoteSelector';
  exact: string;
  prefix: string;
  suffix: string;
}

const segmenter = new Intl.Segmenter('nb', { granularity: 'sentence' });

// Never end a sentence.
const alwaysGlue = new Set([
  'jf.',
  'jfr.',
  'bl.a.',
  'f.eks.',
  'ca.',
  'dvs.',
  'kap.',
  'nr.',
  'mv.',
  'm.m.',
  'inkl.',
  'evt.',
  'ev.',
  'ifm.',
  'iht.',
  'pkt.',
  's.',
  'mill.',
  'mrd.',
  'mnd.',
  'kl.',
  'osv.',
  'etc.',
  'tlf.',
  'prof.',
  'dr.',
  'avd.',
  'adm.',
  'st.prp.',
  'innst.',
  'prop.',
  'meld.',
  'st.',
]);
// End a sentence unless the next piece starts in lower case or with a digit.
const glueBeforeLower = new Set(['pst.', 'kr.', 'år.', 'mio.', 'tab.', 'fig.', 'ref.']);

const lastWord = (s: string) => {
  const trimmed = s.trimEnd();
  const space = trimmed.lastIndexOf(' ');
  return trimmed
    .slice(space + 1)
    .replace(/^[(«"]+/, '')
    .toLowerCase();
};

const continues = (s: string) => /^[\p{Ll}\d]/u.test(s.trimStart());

const isSeparator = (line: string) => {
  const t = line.trim();
  if (!t.includes('---')) return false;
  for (const ch of t) if (ch !== '|' && ch !== '-' && ch !== ':' && ch !== ' ') return false;
  return true;
};

const isBlock = (line: string) => {
  const t = line.trimStart();
  return t.startsWith('#') || t.startsWith('|') || /^(?:[-*+•]|\d{1,3}[.)])\s/.test(t);
};

const trimmed = (text: string, start: number, end: number): Unit | undefined => {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text.charAt(s))) s++;
  while (e > s && /\s/.test(text.charAt(e - 1))) e--;
  return s < e ? { start: s, end: e } : undefined;
};

const paragraphUnits = (text: string, start: number, end: number): Unit[] => {
  const units: Unit[] = [];
  for (const seg of segmenter.segment(text.slice(start, end))) {
    const unit = trimmed(text, start + seg.index, start + seg.index + seg.segment.length);
    if (!unit) continue;
    const prev = units.at(-1);
    if (prev) {
      // The end of the sentence so far is enough, and keeps a long run of pieces linear.
      const before = text.slice(Math.max(prev.start, prev.end - 40), prev.end);
      const word = lastWord(before);
      const piece = text.slice(unit.start, unit.end);
      if (
        alwaysGlue.has(word) ||
        (glueBeforeLower.has(word) && continues(piece)) ||
        (!/[.!?:…»"]$/.test(before) && continues(piece)) ||
        /^\p{Ll}/u.test(piece)
      ) {
        prev.end = unit.end;
        continue;
      }
    }
    units.push(unit);
  }
  return units;
};

export const sentenceUnits = (text: string): Unit[] => {
  const units: Unit[] = [];
  let paragraph: Unit | undefined;
  const flush = () => {
    if (paragraph) units.push(...paragraphUnits(text, paragraph.start, paragraph.end));
    paragraph = undefined;
  };
  let at = 0;
  while (at <= text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(at, end);
    if (line.trim() === '' || isSeparator(line)) flush();
    else if (isBlock(line)) {
      flush();
      const unit = trimmed(text, at, end);
      if (unit) units.push(unit);
    } else if (paragraph) paragraph.end = end;
    else paragraph = { start: at, end };
    if (nl < 0) break;
    at = nl + 1;
  }
  flush();
  return units;
};

export const sentenceMark = (n: number) => `⟨${n}⟩`;

/** The excerpt as the model reads it: each unit with its id in front, the text otherwise as is. */
export const numberSentences = (text: string): string => {
  let out = '';
  let at = 0;
  sentenceUnits(text).forEach((u, i) => {
    out += `${text.slice(at, u.start)}${sentenceMark(i + 1)} `;
    at = u.start;
  });
  return out + text.slice(at);
};

const context = 32;

/** Units `from` to `to` (1-based, inclusive) as a W3C TextQuoteSelector, or none when the excerpt has no such units. */
export const quoteOf = (text: string, from: number, to: number): TextQuote | undefined => {
  const units = sentenceUnits(text);
  const first = units[from - 1];
  const last = units[to - 1];
  if (from < 1 || to < from || !first || !last) return undefined;
  return {
    type: 'TextQuoteSelector',
    exact: text.slice(first.start, last.end),
    prefix: text.slice(Math.max(0, first.start - context), first.start),
    suffix: text.slice(last.end, last.end + context),
  };
};
