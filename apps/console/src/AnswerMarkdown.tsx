import type { ReactNode } from 'react';

export type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; text: string };

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

export type CiteRenderer = (n: number, key: string) => ReactNode | undefined;

const citation = (n: number, key: string, cite: CiteRenderer): ReactNode =>
  cite(n, key) ?? `[${n}]`;

export const inline = (text: string, cite: CiteRenderer, key = 'i'): ReactNode[] =>
  text
    .split(inlinePattern)
    .filter((part) => part !== '')
    .map((part, i): ReactNode => {
      const k = `${key}-${i}`;
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**'))
        return <strong key={k}>{inline(part.slice(2, -2), cite, k)}</strong>;
      if (part.length > 4 && part.startsWith('__') && part.endsWith('__'))
        return <strong key={k}>{inline(part.slice(2, -2), cite, k)}</strong>;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`'))
        return <code key={k}>{part.slice(1, -1)}</code>;
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      if (link)
        return (
          <a key={k} href={link[2]} target="_blank" rel="noreferrer">
            {inline(link[1] ?? '', cite, k)}
          </a>
        );
      const cites = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
      if (cites) {
        const numbers = (cites[1] ?? '').split(',').map((n) => Number(n.trim()));
        return numbers.length === 1 ? (
          citation(numbers[0] ?? 0, k, cite)
        ) : (
          <span key={k}>
            {numbers.map((n, j) => [j ? ' ' : '', citation(n, `${k}-${j}`, cite)])}
          </span>
        );
      }
      if (part.length > 2 && part.startsWith('*') && part.endsWith('*'))
        return <em key={k}>{inline(part.slice(1, -1), cite, k)}</em>;
      return part;
    });

export const AnswerMarkdown = ({ text, cite }: { text: string; cite: CiteRenderer }) => {
  return (
    <div className="answer-markdown">
      {blocksOf(text).map((block, i) => {
        const k = `b${i}`;
        if (block.kind === 'heading')
          return (
            <p key={k} className="answer-heading">
              <strong>{inline(block.text, cite, k)}</strong>
            </p>
          );
        if (block.kind === 'code')
          return (
            <pre key={k}>
              <code>{block.text}</code>
            </pre>
          );
        if (block.kind === 'list') {
          const items = block.items.map((item, j) => (
            <li key={j}>{inline(item, cite, `${k}-${j}`)}</li>
          ));
          return block.ordered ? (
            <ol key={k} {...(block.start === 1 ? {} : { start: block.start })}>
              {items}
            </ol>
          ) : (
            <ul key={k}>{items}</ul>
          );
        }
        return (
          <p key={k}>
            {block.lines.map((line, j) => [
              j ? <br key={`${k}-br${j}`} /> : null,
              ...inline(line, cite, `${k}-${j}`),
            ])}
          </p>
        );
      })}
    </div>
  );
};
