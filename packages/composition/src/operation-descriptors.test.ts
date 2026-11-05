import { describe, expect, it } from 'vitest';
import { loadDescriptors } from '@genai/operations';
import { appendVersion, InMemoryConfigEntryStore, platformScope } from './config-store.js';
import {
  checkDescriptorUpload,
  descriptorEntryKind,
  liveDescriptors,
  type UploadedDescriptor,
} from './operation-descriptors.js';

const classify = `
id: example/classify@1
operation: classify
status: review
summary: A made-up classification API.
api:
  family: openai
  version: 2026-10-01
request:
  method: POST
  path: /classifications
  body:
    model: $deployment
    text: $input.text
input:
  object:
    text: text
output:
  object:
    label: plain
wire:
  request:
    object:
      model: plain
      text: text
  response:
    object:
      label: plain
result:
  label: $response.label
usage:
  requests: 1
stream: none
`;

const fixture = {
  name: 'billing',
  deployment: 'small',
  input: { text: 'Jeg vil endre fakturaen' },
  request: {
    method: 'POST',
    path: '/classifications',
    body: { model: 'small', text: 'Jeg vil endre fakturaen' },
  },
  response: { body: { label: 'billing' } },
  result: { label: 'billing' },
  usage: { requests: 1 },
};

const store = async () => {
  const checked = await checkDescriptorUpload('example/classify@1', {
    descriptor: classify,
    fixtures: [fixture],
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  const entries = new InMemoryConfigEntryStore();
  const write = (spec: UploadedDescriptor, deleted = false, id = 'example/classify@1') =>
    appendVersion<UploadedDescriptor>(entries, {
      kind: descriptorEntryKind,
      scope: platformScope,
      id,
      spec,
      deleted,
      by: 'operator:test:drift',
      reason: 'Laster opp et nytt API',
    });
  return { entries, write, upload: checked.upload };
};

describe('the live descriptor registry', () => {
  it('another process sees an upload, a status change and a withdrawal at its next refresh', async () => {
    const { entries, write, upload } = await store();
    const worker = liveDescriptors(loadDescriptors(), entries);
    await worker.refresh();
    expect(worker.get('example/classify@1')).toBeUndefined();
    await write(upload);
    await worker.refresh();
    expect(worker.get('example/classify@1')?.status).toBe('review');
    expect(worker.list().map((d) => d.operation)).toContain('classify');
    await write({ ...upload, status: 'described' });
    await worker.refresh();
    expect(worker.get('example/classify@1')?.status).toBe('described');
    await write(upload, true);
    await worker.refresh();
    expect(worker.get('example/classify@1')).toBeUndefined();
  });

  it('an upload never shadows a bundled descriptor', async () => {
    const { entries, write, upload } = await store();
    await write(upload, false, 'openai/embed@1');
    const registry = liveDescriptors(loadDescriptors(), entries);
    await registry.refresh();
    expect(registry.get('openai/embed@1')?.status).toBe('typed');
    expect(registry.list().filter((d) => d.id === 'openai/embed@1')).toHaveLength(1);
  });

  it('a stored upload that no longer passes the loader rules is left out', async () => {
    const { entries, write, upload } = await store();
    await write({ ...upload, document: { ...upload.document, stream: { events: {} } } });
    const registry = liveDescriptors(loadDescriptors(), entries);
    await registry.refresh();
    expect(registry.get('example/classify@1')).toBeUndefined();
  });
});
