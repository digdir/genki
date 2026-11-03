import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractFailures, fixturesFor, operationContract } from './contract.js';
import { parseDescriptor } from './descriptor.js';
import { bundledDescriptorDir, descriptorFiles, loadDescriptors } from './registry.js';

const fixtureDir = join(import.meta.dirname, '..', 'fixtures');
const registered = loadDescriptors();

describe('operation@1 for every registered descriptor', () => {
  it('finds every descriptor file in the descriptor folder', () => {
    expect(registered.list().length).toBe(descriptorFiles(bundledDescriptorDir).length);
    expect(registered.list().length).toBeGreaterThan(0);
  });

  for (const descriptor of registered.list())
    it(`${descriptor.id} passes operation@1 against its recorded fixtures`, async () => {
      const results = await operationContract(descriptor, fixturesFor(fixtureDir, descriptor.id));
      expect(contractFailures(results)).toEqual([]);
    });

  it('every fixture folder belongs to a registered descriptor', () => {
    const folders = readdirSync(fixtureDir).flatMap((provider) =>
      readdirSync(join(fixtureDir, provider)).map((name) => `${provider}/${name}`),
    );
    expect(folders.filter((id) => !registered.get(id))).toEqual([]);
  });
});

describe('the operation@1 suite', () => {
  const embed = registered.get('openai/embed@1');
  if (!embed) throw new Error('the embed descriptor is missing');
  const fixtures = fixturesFor(fixtureDir, embed.id);

  it('a descriptor without fixtures fails the operation@1 suite', async () => {
    expect(existsSync(join(fixtureDir, 'nobody', 'thing@1'))).toBe(false);
    const results = await operationContract(embed, fixturesFor(fixtureDir, 'nobody/thing@1'));
    expect(contractFailures(results)).toEqual([
      { check: 'has recorded fixtures', problems: ['openai/embed@1 has no fixtures'] },
    ]);
  });

  it('a descriptor whose request differs from the recorded one fails', async () => {
    const changed = { ...embed, request: { ...embed.request, path: '/embedding' } };
    const failed = contractFailures(await operationContract(changed, fixtures));
    expect(failed.map((f) => f.check)).toContain(
      'one-text: the request built from the typed input is the recorded wire request',
    );
  });

  it('a descriptor whose result mapping differs from the recorded result fails', async () => {
    const changed = {
      ...embed,
      result: {
        vectors: { $each: '$response.data', $map: '$item.embedding' },
        usage: { inputTokens: 0 },
      },
    };
    const failed = contractFailures(await operationContract(changed, fixtures));
    expect(failed.map((f) => f.check)).toContain(
      'unordered-with-unknown-fields: the recorded response maps to the typed result',
    );
  });

  it('a descriptor that puts a non-text input value into a wire text field fails', async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8');
    const leaking = parseDescriptor(
      yaml.replaceAll('instructions: plain\n', 'instructions: text\n'),
    );
    const failed = contractFailures(
      await operationContract(leaking, fixturesFor(fixtureDir, leaking.id)),
    );
    expect(failed.map((f) => f.check)).toContain(
      'predicate: only input text reaches a text field on the wire',
    );
  });
});
