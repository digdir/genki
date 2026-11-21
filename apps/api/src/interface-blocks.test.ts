import type { PublishedVersion, ServiceInterface } from '@genai/definitions';
import { describe, expect, it } from 'vitest';
import { resolveInterfaceBlocks } from './interface-blocks.js';

const digdir = '991825827';
const nav = '889640782';

const edition = (
  publisher: string,
  id: string,
  version: number,
  spec: Record<string, unknown>,
): PublishedVersion =>
  ({
    version,
    publishedAt: '2026-11-21T09:00:00.000Z',
    publishedBy: 'employee:test:kari',
    reason: 'utgave',
    files: {},
    definition: {
      apiVersion: 'genai/v1',
      kind: 'Block',
      metadata: { tenant: publisher, id },
      spec: {
        title: { nb: id },
        zones: ['main'],
        events: [],
        states: ['filled'],
        sharing: 'everyone',
        ...spec,
      },
    },
  }) as unknown as PublishedVersion;

const declarative = (sharing = 'everyone') => ({
  tier: 'declarative',
  sharing,
  template: { version: 1, root: { type: 'paragraph' } },
  texts: { nb: { label: 'Spørsmålet ditt:' } },
});
const code = {
  tier: 'code',
  code: { sha256: 'b'.repeat(64), bytes: 80, reads: ['question.text'] },
};

const store = (editions: PublishedVersion[]) => ({
  get: async (_kind: string, tenant: string, id: string, version?: number) =>
    editions.find(
      (e) =>
        e.definition.metadata.tenant === tenant &&
        e.definition.metadata.id === id &&
        e.version === version,
    ),
});

const layout = (main: { block: string; ref?: string }[]): ServiceInterface['layout'] =>
  ({ version: 1, zones: { primary: [], main, secondary: [] } }) as ServiceInterface['layout'];

const noFrame = () => undefined;

describe('the blocks an interface pins, served with it', () => {
  it("serves each ref block's pinned edition with the interface", async () => {
    const editions = [
      edition(digdir, 'kort', 1, declarative()),
      edition(digdir, 'kort', 2, { ...declarative(), title: { nb: 'Nytt kort' } }),
      edition(digdir, 'figur', 1, code),
    ];

    const blocks = await resolveInterfaceBlocks(
      store(editions),
      nav,
      layout([
        { block: 'chat' },
        { block: 'ref', ref: `${digdir}/kort@1` },
        { block: 'ref', ref: `${digdir}/figur@1` },
      ]),
      noFrame,
      async () => 'Digitaliseringsdirektoratet',
    );

    expect(Object.keys(blocks)).toEqual([`${digdir}/kort@1`, `${digdir}/figur@1`]);
    expect(blocks[`${digdir}/kort@1`]).toMatchObject({
      tier: 'declarative',
      publisher: digdir,
      publisherName: 'Digitaliseringsdirektoratet',
      title: { nb: 'kort' },
      template: { version: 1 },
      texts: { nb: { label: 'Spørsmålet ditt:' } },
    });
    expect(blocks[`${digdir}/figur@1`]).toMatchObject({ tier: 'code', reads: ['question.text'] });
  });

  it('serves nothing of a block but its pinned edition', async () => {
    const editions = [
      edition(digdir, 'kort', 1, declarative('organisation')),
      edition(digdir, 'kort', 2, declarative()),
      edition(digdir, 'annet', 1, declarative()),
    ];

    const blocks = await resolveInterfaceBlocks(
      store(editions),
      nav,
      layout([
        { block: 'ref', ref: `${digdir}/kort@1` },
        { block: 'ref', ref: `${digdir}/kort@2` },
        { block: 'ref', ref: `${digdir}/borte@1` },
      ]),
      noFrame,
    );

    expect(Object.keys(blocks)).toEqual([`${digdir}/kort@2`]);
    expect(JSON.stringify(blocks)).not.toContain('annet');
  });

  it("serves an organisation's own edition that it has not shared", async () => {
    const blocks = await resolveInterfaceBlocks(
      store([edition(nav, 'egen', 1, declarative('private'))]),
      nav,
      layout([{ block: 'ref', ref: `${nav}/egen@1` }]),
      noFrame,
    );

    expect(Object.keys(blocks)).toEqual([`${nav}/egen@1`]);
  });

  it("leaves a code block's frame out while no block origin is set", async () => {
    const editions = [edition(digdir, 'figur', 1, code)];
    const ref = `${digdir}/figur@1`;

    const without = await resolveInterfaceBlocks(
      store(editions),
      nav,
      layout([{ block: 'ref', ref }]),
      noFrame,
    );
    const withOrigin = await resolveInterfaceBlocks(
      store(editions),
      nav,
      layout([{ block: 'ref', ref }]),
      (e) => `http://localhost:8090/frame/${e.publisher}/${e.id}/${e.version}/${e.sha256}`,
    );

    expect(without[ref]?.frame).toBeUndefined();
    expect(withOrigin[ref]?.frame).toEqual({
      url: `http://localhost:8090/frame/${digdir}/figur/1/${'b'.repeat(64)}`,
      sha256: 'b'.repeat(64),
    });
  });

  it('serves no blocks for a layout with only built-in blocks', async () => {
    const blocks = await resolveInterfaceBlocks(
      store([]),
      nav,
      layout([{ block: 'chat', ref: `${digdir}/chat@1` }]),
      noFrame,
    );

    expect(blocks).toEqual({});
  });
});
