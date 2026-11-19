import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { uploadDocumentId, uploadPrefix } from '@genai/ingest';
import { InMemoryBlobStore } from '@genai/port-blob';
import { documentOriginals } from './document-originals.js';

const digdir = '991825827';
const other = '889640782';
const dataset = `${digdir}/filer`;

const person = (tenant: string, confinedTo?: Principal['confinedTo']): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject: `person-${tenant}`,
  tenant,
  ...(confinedTo ? { confinedTo } : {}),
});

const setup = async () => {
  const blobs = new InMemoryBlobStore();
  const path = `${uploadPrefix(dataset, digdir)}veileder.pdf`;
  await blobs.put({ tenant: digdir, path }, new Uint8Array([37, 80, 68, 70]), 'application/pdf');
  const read = documentOriginals(blobs, (id) => (id === dataset ? digdir : undefined));
  return { read, doc: uploadDocumentId(digdir, path) };
};

describe('the uploaded original of a document', () => {
  it('is read by a caller of the organisation that owns the dataset', async () => {
    const { read, doc } = await setup();

    expect(await read(person(digdir), dataset, doc)).toEqual({
      name: 'veileder.pdf',
      type: 'application/pdf',
      body: new Uint8Array([37, 80, 68, 70]),
    });
  });

  it("is read through a frontend of the owner's service, whatever organisation the person is from", async () => {
    const { read, doc } = await setup();
    const throughFrontend = person(other, { tenant: digdir, service: 'ka', client: 'ka-web' });

    expect((await read(throughFrontend, dataset, doc))?.name).toBe('veileder.pdf');
  });

  it('is never read by another organisation, nor through a frontend of its service', async () => {
    const { read, doc } = await setup();
    const otherFrontend = person(digdir, { tenant: other, service: 'nav', client: 'nav-web' });

    expect(await read(person(other), dataset, doc)).toBeUndefined();
    expect(await read(otherFrontend, dataset, doc)).toBeUndefined();
  });

  it('is nothing for a document that was not uploaded, or a dataset with no owner', async () => {
    const { read, doc } = await setup();

    expect(await read(person(digdir), dataset, 'remote-4711')).toBeUndefined();
    expect(await read(person(digdir), 'digdir/felles', doc)).toBeUndefined();
  });
});
