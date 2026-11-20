import { describe, expect, it } from 'vitest';
import { kudosPage, parseTestSet, renameKudosSources, type SourceRef } from './index.js';

const uuid = 'kudos:de77ffc7-1a57-456a-af49-167e699a4e6e';

const draft = (...sources: SourceRef[]) =>
  parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant: '991825827', id: 'ka-kudos-draft', name: 'Kudos', version: 1 },
    spec: {
      corpus: 'digdir/kudos',
      provenance: { status: 'draft', sourceIdentity: 'document + position' },
      cases: sources.map((source, i) => ({
        id: `ka-kudos-00${i + 1}-factual`,
        split: 'train',
        input: 'Hvorfor var forbruket lavt?',
        expected: { sources: [source] },
      })),
    },
  });

const sourcesOf = (result: ReturnType<typeof renameKudosSources>) =>
  result.set.spec.cases.map((c) => c.expected.sources);

const map = 'packages/contracts/src/kudos-earlier-ids.json';

describe('renaming the Kudos test set to kudos: ids', () => {
  it('a Kudos source is rewritten to its kudos: id with its old number as the earlier id', () => {
    const result = renameKudosSources(
      draft({ chunkId: 'f0932e68f724', document: '377252', position: 437 }),
      { earlierIds: new Map([[uuid, ['377252']]]), map, mappedOn: '2026-11-20' },
    );

    expect(sourcesOf(result)).toEqual([
      [{ document: uuid, earlierDocument: '377252', position: 437 }],
    ]);
    expect(result.renamed).toBe(1);
    expect(result.listed).toEqual([]);
    expect(result.set.metadata.version).toBe(2);
    expect(result.set.spec.provenance?.mapping).toBe(
      `renamed to kudos: ids with ${map} on 2026-11-20`,
    );
  });

  it('a source whose number has no UUID is listed and left as it is', () => {
    const gone = { chunkId: 'a1b2c3d4e5f6', document: '413459', position: 12 };
    const result = renameKudosSources(draft(gone), {
      earlierIds: new Map([[uuid, ['377252']]]),
      unresolved: { '413459': 'HTTP 404 without a document to redirect to' },
      map,
      mappedOn: '2026-11-20',
    });

    expect(sourcesOf(result)).toEqual([[gone]]);
    expect(result.renamed).toBe(0);
    expect(result.listed).toEqual([
      {
        case: 'ka-kudos-001-factual',
        document: '413459',
        position: 12,
        reason: 'HTTP 404 without a document to redirect to',
      },
    ]);
    expect(result.set.spec.provenance?.listedSources).toEqual(result.listed);
  });

  it('a source on a number that was not copied for its UUID is listed', () => {
    const lower = { chunkId: 'a1b2c3d4e5f6', document: '377251', position: 3 };
    const result = renameKudosSources(draft(lower), {
      earlierIds: new Map([[uuid, ['377251', '377252']]]),
      map,
      mappedOn: '2026-11-20',
    });

    expect(sourcesOf(result)).toEqual([[lower]]);
    expect(result.listed).toEqual([
      {
        case: 'ka-kudos-001-factual',
        document: '377251',
        position: 3,
        reason: `the copy takes 377252 for ${uuid}, so this number's text may differ`,
      },
    ]);
  });

  it("a Kudos source gets the Docling page that holds most of its old chunk's words", () => {
    const chunk = 'Regnskapet for 2024 ble avsluttet 12. desember, mot 20. januar tidligere år.';
    const pages = [
      'Innledning og sammendrag av året.',
      'Regnskapet ble avsluttet 12. desember 2024, mot 20. januar tidligere år.',
      'Vedlegg med tabeller for 2024.',
    ];
    const result = renameKudosSources(draft({ document: '377252', position: 437 }), {
      earlierIds: new Map([[uuid, ['377252']]]),
      pageOf: () => kudosPage(chunk, [pages], 1),
      map,
      pages: 'from Docling',
      mappedOn: '2026-11-20',
    });

    expect(kudosPage(chunk, [pages], 1)).toEqual({ page: 2, from: 'docling' });
    expect(sourcesOf(result)).toEqual([
      [{ document: uuid, earlierDocument: '377252', position: 437, page: 2 }],
    ]);
    expect(result.listed).toEqual([]);
    expect(result.set.spec.provenance?.mapping).toBe(
      `renamed to kudos: ids with ${map} on 2026-11-20; pages from Docling`,
    );
  });

  it("a source with no Docling page holding half its old chunk's words keeps Marker's page and is listed", () => {
    const chunk = 'Tabellen viser departementets tildeling i 2024 i 1000 kroner.';
    const elsewhere = ['Statens vegvesen og arealregnskap.', 'Departementets mål for 2025.'];
    const result = renameKudosSources(
      draft({ document: '377252', position: 437 }, { document: '377253', position: 2 }),
      {
        earlierIds: new Map([
          [uuid, ['377252']],
          ['kudos:0b1c2d3e-0000-4000-8000-000000000001', ['377253']],
        ]),
        pageOf: (source) =>
          source.document === '377252'
            ? kudosPage(chunk, [elsewhere], 251)
            : kudosPage(chunk, [], 7),
        map,
        mappedOn: '2026-11-20',
      },
    );

    expect(sourcesOf(result)).toEqual([
      [{ document: uuid, earlierDocument: '377252', position: 437, page: 251 }],
      [
        {
          document: 'kudos:0b1c2d3e-0000-4000-8000-000000000001',
          earlierDocument: '377253',
          position: 2,
          page: 7,
        },
      ],
    ]);
    expect(result.renamed).toBe(2);
    expect(result.listed).toEqual([
      {
        case: 'ka-kudos-001-factual',
        document: '377252',
        position: 437,
        reason: "Marker's page: no Docling page holds half its words (best page 2, 14 %)",
      },
      {
        case: 'ka-kudos-002-factual',
        document: '377253',
        position: 2,
        reason: "Marker's page: no Docling conversion of its file",
      },
    ]);
  });
});
