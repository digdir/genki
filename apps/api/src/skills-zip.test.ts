import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readZip } from './skills.js';

interface Central {
  name: string;
  method?: number;
  size: number;
  compressed: number;
  offset: number;
}

const encoder = new TextEncoder();

const localHeader = (name: string, data: Uint8Array) => {
  const nameBytes = encoder.encode(name);
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  header.set(nameBytes, 30);
  return header;
};

const centralEntry = (entry: Central) => {
  const nameBytes = encoder.encode(entry.name);
  const record = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(10, entry.method ?? 0, true);
  view.setUint32(20, entry.compressed, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint32(42, entry.offset, true);
  record.set(nameBytes, 46);
  return record;
};

const zipOf = (
  records: { name: string; data: Uint8Array }[],
  central: (offsets: number[]) => Central[],
) => {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const record of records) {
    offsets.push(at);
    const header = localHeader(record.name, record.data);
    parts.push(header, record.data);
    at += header.length + record.data.length;
  }
  const directory = central(offsets).map(centralEntry);
  const directorySize = directory.reduce((n, d) => n + d.length, 0);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, directory.length, true);
  view.setUint16(10, directory.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, at, true);
  const all = [...parts, ...directory, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of all) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const skillMd = encoder.encode('---\nname: t\n---\nx');
const asset = new Uint8Array(1024).fill(65);

describe('readZip', () => {
  it('reads a well-formed package', () => {
    const zip = zipOf(
      [
        { name: 'SKILL.md', data: skillMd },
        { name: 'assets/a', data: asset },
      ],
      ([skill = 0, a = 0]) => [
        { name: 'SKILL.md', size: skillMd.length, compressed: skillMd.length, offset: skill },
        { name: 'assets/a', size: asset.length, compressed: asset.length, offset: a },
      ],
    );
    expect(readZip(zip).map((e) => [e.name, e.data.length])).toEqual([
      ['SKILL.md', skillMd.length],
      ['assets/a', 1024],
    ]);
  });

  it('counts the bytes it returns, not the sizes the archive declares', () => {
    const zip = zipOf([{ name: 'assets/a', data: asset }], ([a = 0]) => [
      { name: 'assets/a', size: 0, compressed: asset.length, offset: a },
    ]);
    expect(() => readZip(zip)).toThrow(/size mismatch/);
  });

  it('refuses directory entries that point at the same data', () => {
    const zip = zipOf([{ name: 'assets/a', data: asset }], ([a = 0]) =>
      ['assets/a1', 'assets/a2', 'assets/a3'].map((name) => ({
        name,
        size: asset.length,
        compressed: asset.length,
        offset: a,
      })),
    );
    expect(() => readZip(zip)).toThrow(/overlapping/);
  });

  it('refuses a package with more files than the limit', () => {
    const zip = zipOf([{ name: 'assets/a', data: asset }], ([a = 0]) =>
      Array.from({ length: 1001 }, (_, i) => ({
        name: `assets/a${i}`,
        size: asset.length,
        compressed: asset.length,
        offset: a,
      })),
    );
    expect(() => readZip(zip)).toThrow(/too many files/);
  });

  it('refuses an entry whose declared size exceeds what is left of the package budget before inflating it', () => {
    const deflated = deflateRawSync(asset);
    const zip = zipOf([{ name: 'assets/a', data: deflated }], ([a = 0]) => [
      {
        name: 'assets/a',
        method: 8,
        size: 21 * 1024 * 1024,
        compressed: deflated.length,
        offset: a,
      },
    ]);
    expect(() => readZip(zip)).toThrow(/too large/);
  });
});
