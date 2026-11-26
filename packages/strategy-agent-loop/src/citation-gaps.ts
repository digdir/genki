import { normaliseCitationMarkers, untrustedData } from '@genai/port-model';
import { keepsTheDraft } from './citation-backfill.js';
import {
  documentKey,
  excerptText,
  pageField,
  parseCitations,
  withoutSentenceIds,
  type CitationIndex,
} from './citations.js';
import { citeGapsPrompt } from './prompts.js';
import { skillsSection } from './skills.js';
import type { ToolEnvironment } from './tools.js';
import type { Chunk, Workspace } from './workspace.js';

/** A paragraph, list item or table row of an answer, by its offsets in the text. */
interface Block {
  start: number;
  end: number;
}

const listItem = /^\s{0,8}(?:[-*+•]|\d{1,3}[.)])\s/;
// «|---|:--:|», checked by its characters so a long line of dashes stays linear.
const isTableSeparator = (line: string) => {
  const t = line.trim();
  if (!t.includes('---')) return false;
  for (const ch of t) if (ch !== '|' && ch !== '-' && ch !== ':' && ch !== ' ') return false;
  return true;
};

const ownLine = (line: string) =>
  line.trimStart().startsWith('#') || line.trimStart().startsWith('|') || listItem.test(line);

/** The answer's blocks: a heading or table row is one line; a list item and other lines join the lines after them until a blank line or a line of their own. */
export const answerBlocks = (text: string): Block[] => {
  const blocks: Block[] = [];
  let open: Block | undefined;
  let at = 0;
  while (at <= text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(at, end);
    if (line.trim() === '') open = undefined;
    else if (ownLine(line)) {
      const block = { start: at, end };
      blocks.push(block);
      // A list item's next line that starts no block of its own continues it.
      open = listItem.test(line) ? block : undefined;
    } else if (open) open.end = end;
    else {
      open = { start: at, end };
      blocks.push(open);
    }
    if (nl < 0) break;
    at = nl + 1;
  }
  return blocks;
};

const marker = /\[(\d{1,3})\]/g;
const letter = /\p{L}/u;
// A line that is only bold or italic text, such as «**Strategi og organisering mangler**».
const emphasisOnly = /^[*_]{1,3}[^*_\n]{1,200}[*_]{1,3}:?$/;

/** The text without the bold or italic marks at its end, cut by a loop so long runs stay linear. */
const withoutTrailingEmphasis = (t: string) => {
  let end = t.length;
  while (end > 0 && (t[end - 1] === '*' || t[end - 1] === '_')) end--;
  return t.slice(0, end).trimEnd();
};

/** A lead-in ending in ':' is not a claim, but the lines before it in the same block can be. */
const withoutLeadIn = (block: string) => {
  const t = block.trim();
  if (!withoutTrailingEmphasis(t).endsWith(':')) return t;
  const nl = t.lastIndexOf('\n');
  return nl < 0 ? '' : t.slice(0, nl).trim();
};

const needsCitation = (block: string, nextLine: string | undefined) => {
  const t = withoutLeadIn(block);
  if (!letter.test(t)) return false;
  if (t.startsWith('#') || emphasisOnly.test(t)) return false;
  if (isTableSeparator(t)) return false;
  // A table's header row comes right before its separator.
  if (t.startsWith('|') && nextLine !== undefined && isTableSeparator(nextLine)) return false;
  return true;
};

const cited = (block: string, index: CitationIndex) =>
  [...block.matchAll(marker)].some((m) => index.has(Number(m[1])));

/** The blocks a reader would expect a footnote on that have none. */
export const gapBlocks = (text: string, index: CitationIndex): Block[] =>
  answerBlocks(text).filter((b) => {
    const block = text.slice(b.start, b.end);
    const nextEnd = text.indexOf('\n', b.end + 1);
    const nextLine =
      b.end < text.length ? text.slice(b.end + 1, nextEnd < 0 ? text.length : nextEnd) : undefined;
    return needsCitation(block, nextLine) && !cited(block, index);
  });

// «(s. 25)», «(s. 27–28)», «(s. 4 og 8)», «(side 25)»: the first page counts.
export const pageMention = /\((?:s\.|side|sidene) ?(\d{1,4})[^()\n]{0,40}\)/g;
const citedBefore = /\[\d{1,3}\] ?$/;
const citedAfter = /^[.,;:]? ?\[\d{1,3}\]/;

/** The excerpts behind the answer: the ones the answer step saw, then the read chunks it never saw. */
const readChunks = (workspace: Workspace): Chunk[] => {
  const read = workspace.readChunkIds();
  const seen = new Set(workspace.sourceOrder.map((c) => c.chunkId));
  const unseen = [...workspace.chunks.values()].filter(
    (c) => read.has(c.chunkId) && !seen.has(c.chunkId),
  );
  return [
    ...workspace.sourceOrder.map((c) => workspace.chunks.get(c.chunkId) ?? c),
    ...unseen.filter((c) => !workspace.nonSupporting.has(c.chunkId)),
    ...unseen.filter((c) => workspace.nonSupporting.has(c.chunkId)),
  ];
};

/**
 * Numbers for the excerpts: the answer's own markers first, the rest after them. A marker that
 * quotes a sentence (#971) is never reused, since its footnote highlights that sentence; such an
 * excerpt gets a fresh number. A new number comes after every number in the index and the text,
 * so a marker that leads nowhere never becomes one.
 */
const numbering = (workspace: Workspace, text: string, quoted: ReadonlySet<number>) => {
  const chunkOf = (id: string) =>
    workspace.chunks.get(id) ?? workspace.sourceOrder.find((c) => c.chunkId === id);
  const byNumber = new Map<number, Chunk>();
  const numberOf = new Map<string, number>();
  for (const [n, id] of workspace.citationIndex) {
    const c = chunkOf(id);
    if (!c) continue;
    byNumber.set(n, c);
    if (!quoted.has(n) && !numberOf.has(id)) numberOf.set(id, n);
  }
  let next = 1;
  for (const n of workspace.citationIndex.keys()) next = Math.max(next, n + 1);
  for (const m of text.matchAll(marker)) next = Math.max(next, Number(m[1]) + 1);
  const add = (c: Chunk) => {
    const known = numberOf.get(c.chunkId);
    if (known !== undefined) return known;
    const n = next++;
    byNumber.set(n, c);
    numberOf.set(c.chunkId, n);
    return n;
  };
  /** The numbers a new marker may use: one per excerpt, none that quotes a sentence. */
  const offered = () => new Set(numberOf.values());
  return { byNumber, numberOf, add, offered };
};

const coversPage = (c: Chunk, page: number) =>
  c.page !== undefined && c.page <= page && page <= (c.pageEnd ?? c.page);

/** «(s. P)» with no [N] gets the [N] of the one read excerpt of a cited document that covers page P. */
const citePages = (
  text: string,
  workspace: Workspace,
  numbers: ReturnType<typeof numbering>,
): string => {
  const citedDocuments = new Set(
    parseCitations(text, workspace.citationIndex).flatMap((c) => {
      const chunk = numbers.byNumber.get(c.index);
      return chunk ? [documentKey(chunk)] : [];
    }),
  );
  if (citedDocuments.size === 0) return text;
  const candidates = readChunks(workspace).filter((c) => citedDocuments.has(documentKey(c)));
  return text.replace(pageMention, (whole, page: string, offset: number) => {
    if (citedBefore.test(text.slice(Math.max(0, offset - 8), offset))) return whole;
    if (citedAfter.test(text.slice(offset + whole.length, offset + whole.length + 8))) return whole;
    const covering = candidates.filter((c) => coversPage(c, Number(page)));
    if (covering.length !== 1) return whole;
    return `[${numbers.add(covering[0] as Chunk)}] ${whole}`;
  });
};

const excerptContext = (numbers: ReturnType<typeof numbering>) =>
  [...numbers.offered()]
    .map((n) => [n, numbers.byNumber.get(n) as Chunk] as const)
    .sort(([a], [b]) => a - b)
    .map(([n, c]) => {
      const page = pageField(c);
      return `[${n}] ${untrustedData('source', excerptText(c.content), {
        id: documentKey(c),
        title: c.title,
        publisher: c.publisher,
        ...(page ? { [page[0]]: page[1] } : {}),
      })}`;
    })
    .join('\n\n');

/** The read chunks the gap call may cite, the answer step's own first, within twice the read budget. */
const gapCandidates = (workspace: Workspace, numbers: ReturnType<typeof numbering>) => {
  let room = 2 * workspace.limits.readChars;
  for (const c of readChunks(workspace)) {
    if (numbers.numberOf.has(c.chunkId)) continue;
    const length = Math.max(1, c.content.length);
    if (length > room) continue;
    room -= length;
    numbers.add(c);
  }
};

const replaceBlocks = (text: string, blocks: Block[], replacement: (b: Block) => string) => {
  let out = '';
  let at = 0;
  for (const b of blocks) {
    out += text.slice(at, b.start) + replacement(b);
    at = b.end;
  }
  return out + text.slice(at);
};

const plain = (text: string) =>
  text
    .replace(/ ?\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// A marker between two letters or digits, such as «Turn[2]over», splits a word.
const insideWord = /[\p{L}\p{N}]\[\d{1,3}\][\p{L}\p{N}]/u;

/** One model call that cites the gap blocks; only those blocks change, and only by markers. */
const citeGapsByModel = async (
  env: ToolEnvironment,
  text: string,
  numbers: ReturnType<typeof numbering>,
): Promise<string | undefined> => {
  const gaps = gapBlocks(text, env.workspace.citationIndex);
  const written = await env.synthesize(
    env.systemPrompt + skillsSection([...env.workspace.loadedSkills.values()]),
    citeGapsPrompt(
      excerptContext(numbers),
      untrustedData('answer', text),
      untrustedData('uncited', gaps.map((b) => text.slice(b.start, b.end)).join('\n')),
    ),
  );
  if (written === undefined) return undefined;
  const reply = normaliseCitationMarkers(withoutSentenceIds(written), (n) =>
    numbers.byNumber.has(n),
  ).replace(/ ?\[(\d{1,3})\]/g, (whole, n: string) =>
    numbers.byNumber.has(Number(n)) ? whole : '',
  );
  if (!keepsTheDraft(reply, text)) return undefined;
  const replyBlocks = answerBlocks(reply);
  const ownBlocks = answerBlocks(text);
  if (replyBlocks.length !== ownBlocks.length) return undefined;
  const replyOf = new Map(ownBlocks.map((b, i) => [b.start, replyBlocks[i] as Block]));
  const offered = numbers.offered();
  return replaceBlocks(text, gaps, (b) => {
    const own = text.slice(b.start, b.end);
    const r = replyOf.get(b.start);
    // A gap gets only the numbers offered to it, never one that quotes another sentence.
    const theirs = (r ? reply.slice(r.start, r.end) : own).replace(
      / ?\[(\d{1,3})\]/g,
      (whole, n: string) => (offered.has(Number(n)) ? whole : ''),
    );
    return plain(theirs) === plain(own) && !insideWord.test(theirs) ? theirs : own;
  });
};

export interface FilledGaps {
  text: string;
  /** Blocks still without a citation after the page rule and the gap call. */
  uncited: number;
}

/**
 * With excerpt citations only the cited excerpts are published, so every factual block needs its
 * own [N]. Pages first, then one model call for the blocks still uncited (#1051).
 */
export const citeGaps = async (env: ToolEnvironment, answer: string): Promise<FilledGaps> => {
  const { workspace } = env;
  const quoted =
    answer === workspace.quotedText ? new Set(workspace.citationQuotes.keys()) : new Set<number>();
  const numbers = numbering(workspace, answer, quoted);
  let text = citePages(answer, workspace, numbers);
  const adopt = (next: string) => {
    for (const [n, c] of numbers.byNumber) {
      if (workspace.citationIndex.has(n) || !next.includes(`[${n}]`)) continue;
      workspace.citationIndex.set(n, c.chunkId);
      if (!workspace.chunks.has(c.chunkId)) workspace.chunks.set(c.chunkId, c);
      if (!workspace.sourceOrder.some((s) => s.chunkId === c.chunkId))
        workspace.sourceOrder = [...workspace.sourceOrder, c];
    }
  };
  adopt(text);
  if (gapBlocks(text, workspace.citationIndex).length > 0) {
    gapCandidates(workspace, numbers);
    try {
      const filled = await citeGapsByModel(env, text, numbers);
      if (filled !== undefined) {
        text = filled;
        adopt(text);
      }
    } catch (error) {
      if (env.signal.aborted) throw error;
    }
  }
  return { text, uncited: gapBlocks(text, workspace.citationIndex).length };
};
