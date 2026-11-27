import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maxRunJsonBytes,
  readJsonIfThere,
  runFileName,
  writeRunFile,
  writeRunJson,
} from './demo-files.ts';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('run files', () => {
  it('writes a file only by a plain name inside the run folder', () => {
    const parent = mkdtempSync(join(tmpdir(), 'genki-run-'));
    const dir = join(parent, 'run');
    writeRunJson(parent, 'marker.json', {});
    for (const name of ['../x.json', 'a/b.json', '.hidden', '..', '', `${'a'.repeat(81)}`])
      expect(() => writeRunFile(parent, name, 'x', 10)).toThrow(/not a file name/);
    expect(() => writeRunJson(dir, '../escape.json', {})).toThrow(/not a file name/);
    expect(readdirSync(parent)).toEqual(['marker.json']);
  });

  it('refuses to write more than the bytes allowed for the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genki-run-'));
    expect(() => writeRunFile(dir, 'clip.mp3', new Uint8Array(11), 10)).toThrow(/more than/);
    expect(() => writeRunJson(dir, 'edl.json', 'x'.repeat(maxRunJsonBytes))).toThrow(/more than/);
    expect(readdirSync(dir)).toEqual([]);
    writeRunFile(dir, 'clip.mp3', new Uint8Array(10), 10);
    expect(readFileSync(join(dir, 'clip.mp3'))).toHaveLength(10);
  });

  it('reads a file that is there and gives undefined for one that is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genki-run-'));
    writeFileSync(join(dir, 'edl.json'), '{"a":1}');
    expect(readJsonIfThere(join(dir, 'edl.json'))).toEqual({ a: 1 });
    expect(readJsonIfThere(join(dir, 'none.json'))).toBeUndefined();
  });

  it('checks a run file name in linear time on long adversarial input', () => {
    expect(quickly(() => runFileName.test(`a${'.-'.repeat(100_000)}/`))).toBeLessThan(1000);
  });
});
