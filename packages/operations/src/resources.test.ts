import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryProviderObjects } from '@genai/kernel';
import { memoryLedger } from './contract.js';
import { parseDescriptor } from './descriptor.js';
import { deleteProviderObject } from './executor.js';
import { call, json, refused } from './kit.test-utils.js';

const testdata = join(import.meta.dirname, 'testdata', 'descriptors', 'example');
const yamlOf = (name: string) => readFileSync(join(testdata, `${name}.yaml`), 'utf8');
const summarize = () => parseDescriptor(yamlOf('summarize-file@1'));
const text = (s: string) => ({ mediaType: 'text/plain', data: Buffer.from(s).toString('base64') });
const input = { document: text('Hello there'), filename: 'notes.txt' };
const errorOf = (outcome: unknown) => (outcome as { error: Error }).error;
const upload = json({ id: 'file-a1' });
const summary = json({ text: 'A greeting.' });
const deleted = json({ deleted: true });

const at = new Date('2026-11-06T10:00:00Z');
const endpointWith = (ledger: ReturnType<typeof memoryLedger>['ledger']) => ({
  ledger,
  connection: 'lab',
  tenant: '999888777',
  run: 't1',
  now: () => at,
});

describe('objects left at the provider (C)', () => {
  it('writes an issued object to the ledger with its delete-by time and strikes it when the delete step runs', async () => {
    const kept = memoryLedger();
    const { outcome } = await call(summarize(), input, [upload, summary, deleted], {
      endpoint: endpointWith(kept.ledger),
    });
    expect(outcome).toMatchObject({ result: { summary: 'A greeting.' } });
    expect(kept.all).toEqual([
      expect.objectContaining({
        objectId: 'file-a1',
        connection: 'lab',
        tenant: '999888777',
        run: 't1',
        step: 'upload',
        field: 'file',
        deletable: true,
        deleteBy: '2026-11-06T11:00:00.000Z',
      }),
    ]);
    expect(kept.open.size).toBe(0);
  });

  it('leaves the object open in the ledger when the provider will not delete it, and the answer still returns', async () => {
    const kept = memoryLedger();
    const { outcome } = await call(
      summarize(),
      input,
      [upload, summary, json({ error: 'busy' }, 500)],
      { endpoint: endpointWith(kept.ledger) },
    );
    expect(outcome).toMatchObject({ result: { summary: 'A greeting.' } });
    expect([...kept.open.keys()]).toEqual(['file-a1']);
  });

  it('deletes the object even when a later step fails', async () => {
    const kept = memoryLedger();
    const { outcome, sent } = await call(
      summarize(),
      input,
      [upload, json({ error: 'no' }, 500), deleted],
      { endpoint: endpointWith(kept.ledger) },
    );
    expect(errorOf(outcome)).toBeDefined();
    expect(sent.at(-1)?.init?.method).toBe('DELETE');
    expect(kept.open.size).toBe(0);
  });

  it('a descriptor that leaves objects at the provider fails as processor when the call has no ledger', async () => {
    const { outcome, sent } = await call(summarize(), input, [upload, summary, deleted]);
    expect(errorOf(outcome).message).toMatch(
      /keeps objects at the provider and the call has no ledger/,
    );
    expect(sent).toEqual([]);
  });

  it('a sweep deletes a leftover object by running the delete step alone', async () => {
    const descriptor = summarize();
    const sent: string[] = [];
    await deleteProviderObject(
      descriptor,
      descriptor.resources[0] as never,
      {
        baseURL: 'https://provider.example.test/base',
        credential: { kind: 'api-key', key: async () => 'connection-key' },
        fetch: async (url, init) => {
          sent.push(`${init?.method} ${new URL(String(url)).pathname}`);
          return Response.json({ deleted: true });
        },
      },
      { objectId: 'file-a1', deployment: 'model-1' },
    );
    expect(sent).toEqual(['DELETE /base/files/file-a1']);
  });

  it('a sweep refuses an id outside the pattern its descriptor issues', async () => {
    const descriptor = summarize();
    await expect(
      deleteProviderObject(
        descriptor,
        descriptor.resources[0] as never,
        {
          baseURL: 'https://provider.example.test/base',
          credential: { kind: 'api-key', key: async () => 'connection-key' },
          fetch: async () => Response.json({ deleted: true }),
        },
        { objectId: '../../account', deployment: 'model-1' },
      ),
    ).rejects.toThrow();
  });

  it('a resource that names no delete step is recorded as retained, never as due', async () => {
    const yaml = yamlOf('summarize-file@1')
      .replace(
        '{ id: upload.file, delete: remove_file, longestSeconds: 3600 }',
        '{ id: upload.file, longestSeconds: 3600 }',
      )
      .replace(/finally:[\s\S]*?(?=result:)/, '');
    const store = new InMemoryProviderObjects(() => at);
    const { outcome } = await call(parseDescriptor(yaml), input, [upload, summary], {
      endpoint: endpointWith(store),
    });
    expect(outcome).toMatchObject({ result: { summary: 'A greeting.' } });
    expect((await store.list('999888777'))[0]).toMatchObject({ state: 'retained' });
    expect(await store.due(new Date('2099-01-01'), 10)).toEqual([]);
  });
});

describe('hostile resource declarations (C)', () => {
  it('a resource must be an id an earlier step binds as issued', () => {
    expect(
      refused(yamlOf('summarize-file@1').replace('id: upload.file', 'id: upload.other')),
    ).toMatch(/resources: upload.other must be an id an earlier step binds as issued/);
  });

  it('the step that deletes a resource is a DELETE step', () => {
    expect(refused(yamlOf('summarize-file@1').replace('method: DELETE', 'method: POST'))).toMatch(
      /must be a DELETE step/,
    );
  });

  it('the step that deletes a resource reads only the id, since a sweep runs it alone', () => {
    const yaml = yamlOf('summarize-file@1')
      .replace(
        '    usage:\n      request: 1',
        '    bind:\n      said: { from: $response.text, class: plain }\n    usage:\n      request: 1',
      )
      .replace(
        'path: /files/{steps.upload.file}',
        'path: /files/{steps.upload.file}\n      query:\n        said: $steps.run.said',
      )
      .replace(
        '    wire:\n      response:\n        object:\n          deleted: boolean',
        '    wire:\n      query:\n        object:\n          said: plain\n      response:\n        object:\n          deleted: boolean',
      );
    expect(refused(yaml)).toMatch(/may read only the id upload.file, since a sweep runs it alone/);
  });

  it('a descriptor that does not declare resources may not use a kept-out path such as /files', () => {
    const yaml = yamlOf('summarize-file@1')
      .replace(/resources:\n.*\n/, '')
      .replace('        model: plain\n', '        model: plain\n          store: boolean\n');
    expect(refused(yaml)).toMatch(/request.path \/files is kept out of descriptors/);
  });
});
