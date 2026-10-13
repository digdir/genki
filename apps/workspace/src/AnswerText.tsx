import type { ReactNode } from 'react';
import { useT } from './i18n';
import type { Lang, Source } from './types';

export type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; text: string }
  | ListBlock
  | { kind: 'code'; text: string };

export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  start: number;
  items: string[];
  nested?: Record<number, ListBlock>;
}

const bullet = /^\s*[-*+]\s+(.*)$/;
const numbered = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const fence = /^\s*```/;

export const blocksOf = (text: string): Block[] => {
  const blocks: Block[] = [];
  let open: Block | undefined;
  const close = () => {
    if (open) blocks.push(open);
    open = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (open?.kind === 'code') {
      if (fence.test(line)) close();
      else open.text = open.text ? `${open.text}\n${line}` : line;
      continue;
    }
    if (fence.test(line)) {
      close();
      open = { kind: 'code', text: '' };
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const title = heading.exec(line);
    const item = bullet.exec(line);
    const step = item ? undefined : numbered.exec(line);
    if (title) {
      close();
      blocks.push({ kind: 'heading', text: title[1] ?? '' });
    } else if (item || step) {
      const ordered = Boolean(step);
      const content = (item ? item[1] : step?.[2]) ?? '';
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (open?.kind === 'list' && indent >= 2 && open.items.length > 0) {
        const parent = open.items.length - 1;
        const nested = (open.nested ??= {});
        const child = (nested[parent] ??= {
          kind: 'list',
          ordered,
          start: step ? Number(step[1]) : 1,
          items: [],
        });
        child.items.push(content);
        continue;
      }
      if (open?.kind !== 'list' || open.ordered !== ordered) {
        close();
        open = { kind: 'list', ordered, start: step ? Number(step[1]) : 1, items: [] };
      }
      open.items.push(content);
    } else if (open?.kind === 'list' && /^\s/.test(line)) {
      open.items[open.items.length - 1] += ` ${line.trim()}`;
    } else if (open?.kind === 'paragraph') {
      open.lines.push(line);
    } else {
      close();
      open = { kind: 'paragraph', lines: [line] };
    }
  }
  close();
  return blocks;
};

const inlinePattern =
  /(\*\*[^\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\[\d+(?:\s*,\s*\d+)*\]|\*[^*\s][^*\n]*?\*)/;

interface InlineContext {
  sources: Source[];
  anchor: (n: number) => string;
  label: (n: number, source: Source) => string;
}

const citation = (n: number, key: string, ctx: InlineContext): ReactNode => {
  const source = ctx.sources.find((s) => s.index === n);
  if (!source) return `[${n}]`;
  return (
    <a
      key={key}
      className="cite"
      href={source.url ?? `#${ctx.anchor(n)}`}
      {...(source.url ? { target: '_blank', rel: 'noreferrer' } : {})}
      aria-label={ctx.label(n, source)}
    >
      [{n}]
    </a>
  );
};

export const inline = (text: string, ctx: InlineContext, key = 'i'): ReactNode[] =>
  text
    .split(inlinePattern)
    .filter((part) => part !== '')
    .map((part, i): ReactNode => {
      const k = `${key}-${i}`;
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**'))
        return <strong key={k}>{inline(part.slice(2, -2), ctx, k)}</strong>;
      if (part.length > 4 && part.startsWith('__') && part.endsWith('__'))
        return <strong key={k}>{inline(part.slice(2, -2), ctx, k)}</strong>;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`'))
        return <code key={k}>{part.slice(1, -1)}</code>;
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      if (link)
        return (
          <a key={k} href={link[2]} target="_blank" rel="noreferrer">
            {inline(link[1] ?? '', ctx, k)}
          </a>
        );
      const cites = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
      if (cites) {
        const numbers = (cites[1] ?? '').split(',').map((n) => Number(n.trim()));
        return numbers.length === 1 ? (
          citation(numbers[0] ?? 0, k, ctx)
        ) : (
          <span key={k}>
            {numbers.map((n, j) => [j ? ' ' : '', citation(n, `${k}-${j}`, ctx)])}
          </span>
        );
      }
      if (part.length > 2 && part.startsWith('*') && part.endsWith('*'))
        return <em key={k}>{inline(part.slice(1, -1), ctx, k)}</em>;
      return part;
    });

export const sourceAnchor = (prefix: string, n: number) => `${prefix}-source-${n}`;

const renderList = (block: ListBlock, k: string, ctx: InlineContext): ReactNode => {
  const items = block.items.map((item, j) => {
    const child = block.nested?.[j];
    return (
      <li key={j}>
        {inline(item, ctx, `${k}-${j}`)}
        {child ? renderList(child, `${k}-${j}n`, ctx) : null}
      </li>
    );
  });
  return block.ordered ? (
    <ol key={k} {...(block.start === 1 ? {} : { start: block.start })}>
      {items}
    </ol>
  ) : (
    <ul key={k}>{items}</ul>
  );
};

export const AnswerText = ({
  text,
  lang,
  sources,
  anchorPrefix,
}: {
  text: string;
  lang: Lang;
  sources: Source[];
  anchorPrefix: string;
}) => {
  const t = useT();
  const ctx: InlineContext = {
    sources,
    anchor: (n) => sourceAnchor(anchorPrefix, n),
    label: (n, source) => t('answer.cite', { n, title: source.title }),
  };
  return (
    <div lang={lang} className="answer-text">
      {blocksOf(text).map((block, i) => {
        const k = `b${i}`;
        if (block.kind === 'heading')
          return (
            <p key={k} className="answer-heading">
              <strong>{inline(block.text, ctx, k)}</strong>
            </p>
          );
        if (block.kind === 'code')
          return (
            <pre key={k}>
              <code>{block.text}</code>
            </pre>
          );
        if (block.kind === 'list') return renderList(block, k, ctx);
        return (
          <p key={k}>
            {block.lines.map((line, j) => [
              j ? <br key={`${k}-br${j}`} /> : null,
              ...inline(line, ctx, `${k}-${j}`),
            ])}
          </p>
        );
      })}
    </div>
  );
};
