export type DiffOp = 'same' | 'add' | 'remove';

export type DiffRow = { op: DiffOp; text: string } | { op: 'change'; parts: [DiffOp, string][] };

const sequenceDiff = (a: string[], b: string[]): [DiffOp, string][] => {
  const width = b.length + 1;
  const lcs = new Array<number>((a.length + 1) * width).fill(0);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: [DiffOp, string][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) {
      out.push(['same', left]);
      i += 1;
      j += 1;
    } else if (left !== undefined && (right === undefined || at(i + 1, j) >= at(i, j + 1))) {
      out.push(['remove', left]);
      i += 1;
    } else if (right !== undefined) {
      out.push(['add', right]);
      j += 1;
    }
  }
  return out;
};

export const lineDiff = (before: string, after: string): [DiffOp, string][] =>
  sequenceDiff(before.split('\n'), after.split('\n')).filter(
    ([op, text]) => op !== 'same' || text.trim() !== '',
  );

export const wordDiff = (before: string, after: string): [DiffOp, string][] => {
  const merged: [DiffOp, string][] = [];
  for (const [op, text] of sequenceDiff(before.split(/(\s+)/), after.split(/(\s+)/))) {
    if (!text) continue;
    const last = merged.at(-1);
    if (last && last[0] === op) last[1] += text;
    else merged.push([op, text]);
  }
  return merged;
};

export const diffRows = (before: string, after: string): DiffRow[] => {
  const lines = lineDiff(before, after);
  const rows: DiffRow[] = [];
  let k = 0;
  while (k < lines.length) {
    const removed: string[] = [];
    const added: string[] = [];
    while (lines[k]?.[0] === 'remove') removed.push(lines[k++]?.[1] ?? '');
    while (lines[k]?.[0] === 'add') added.push(lines[k++]?.[1] ?? '');
    if (removed.length === 0 && added.length === 0) {
      const [op, text] = lines[k++] ?? ['same', ''];
      rows.push({ op, text });
      continue;
    }
    const paired = Math.min(removed.length, added.length);
    for (let n = 0; n < paired; n += 1)
      rows.push({ op: 'change', parts: wordDiff(removed[n] ?? '', added[n] ?? '') });
    for (const text of removed.slice(paired)) rows.push({ op: 'remove', text });
    for (const text of added.slice(paired)) rows.push({ op: 'add', text });
  }
  return rows;
};
