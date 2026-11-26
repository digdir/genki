import { blockFixtures } from '@genai/contracts/block-fixtures';
import type {
  BlockDetail,
  BlockEdition,
  BlockOrigin,
  BlockSharing,
  BlockState,
  BlockSummary,
  BlockUse,
  BlockZone,
  RefBlockPayload,
} from '@genai/contracts/blocks';
import { isFromClaude } from '@genai/contracts/blocks';
import type { ImportResult } from '../api/design';
import type { MockHandler, MockRequest } from '../mock';
import { starterDeclarative, type BlockDraft } from '../screens/design/definitions';

const ownTenant = '999888777';
const genki = '991825827';
const publisherNames: Record<string, string> = { [ownTenant]: 'Testetaten', [genki]: 'Digdir' };

interface MockEdition extends BlockEdition {
  definition: BlockDraft;
  files: Record<string, string>;
}

export interface MockBlock {
  publisher: string;
  id: string;
  builtIn?: boolean;
  editions: MockEdition[];
  usedIn?: BlockUse[];
  review?: BlockDetail['review'];
}

const kildeliste = (sharing: BlockSharing, fields: string[]): BlockDraft => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant: ownTenant, id: 'kildeliste-kompakt', name: 'Kildeliste kompakt' },
  spec: {
    tier: 'declarative',
    title: { nb: 'Kildeliste kompakt', en: 'Compact source list' },
    zones: ['main'],
    sharing,
    events: ['open-document'],
    states: ['empty', 'loading', 'error', 'filled'],
    texts: {
      nb: {
        'heading.one': '{count} kilde',
        'heading.other': '{count} kilder',
        open: 'Åpne',
        none: 'Ingen kilder',
        failed: 'Fant ikke kildene. Prøv igjen.',
      },
      en: {
        'heading.one': '{count} source',
        'heading.other': '{count} sources',
        open: 'Open',
        none: 'No sources',
        failed: 'Could not find the sources. Try again.',
      },
    },
    template: {
      version: 1,
      states: {
        empty: {
          type: 'card',
          children: [{ type: 'paragraph', variant: 'subtle', size: 'sm', text: { t: 'none' } }],
        },
        error: { type: 'card', children: [{ type: 'paragraph', text: { t: 'failed' } }] },
      },
      root: {
        type: 'card',
        children: [
          {
            type: 'heading',
            level: 3,
            size: 'xs',
            text: { t: 'heading', args: { count: { count: 'sources' } } },
          },
          {
            type: 'list',
            ordered: true,
            items: [
              {
                type: 'each',
                of: 'sources',
                as: 'source',
                max: 10,
                children: [
                  {
                    type: 'row',
                    children: [
                      {
                        type: 'paragraph',
                        size: 'sm',
                        text: fields.flatMap((f, i) => [
                          ...(i > 0 ? [', '] : []),
                          f === 'publishedAt'
                            ? { bind: `source.${f}`, format: 'date' }
                            : { bind: `source.${f}` },
                        ]),
                      },
                      {
                        type: 'button',
                        variant: 'tertiary',
                        text: { t: 'open' },
                        event: { name: 'open-document', source: 'source.index' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  },
});

const edition = (
  version: number,
  publishedAt: string,
  reason: string,
  definition: BlockDraft,
  files: Record<string, string> = {},
  publishedByName = 'Kari Nordmann',
): MockEdition => ({
  version,
  publishedAt,
  publishedBy: 'employee:mock:kari',
  publishedByName,
  reason,
  sharing: definition.spec.sharing ?? 'private',
  definition,
  files,
});

const figurBundle =
  "genki.onRender(({ data }) => { document.body.textContent = 'Figur: ' + (data.question?.text ?? ''); });\n";

const builtIn = (
  id: string,
  nb: string,
  en: string,
  zones: BlockZone[],
  at: string,
  used: number,
  props?: NonNullable<BlockDraft['spec']['props']>,
): MockBlock => ({
  publisher: genki,
  id,
  builtIn: true,
  editions: [
    edition(
      1,
      at,
      'Fra genki',
      {
        apiVersion: 'genai/v1',
        kind: 'Block',
        metadata: { tenant: genki, id, name: nb },
        spec: {
          tier: 'built-in',
          builtIn: id,
          title: { nb, en },
          zones,
          sharing: 'everyone',
          ...(props ? { props } : {}),
        },
      },
      {},
      'genki',
    ),
  ],
  usedIn: Array.from({ length: used }, (_, i) => ({
    service: `tjeneste-${i + 1}`,
    name: `Tjeneste ${i + 1}`,
    inUse: 1,
  })),
});

export const exampleDesignBlocks = (): MockBlock[] => [
  {
    publisher: ownTenant,
    id: 'kildeliste-kompakt',
    editions: [
      edition(
        1,
        '2026-11-14T09:00:00Z',
        'Første utgave',
        kildeliste('organisation', ['title', 'publisher']),
        {},
        'Claude for Kari Nordmann',
      ),
      edition(
        2,
        '2026-11-17T09:00:00Z',
        'Knappen Åpne',
        kildeliste('everyone', ['title', 'publisher']),
      ),
      edition(
        3,
        '2026-11-21T09:00:00Z',
        'Dato i stedet for utgiver',
        kildeliste('everyone', ['title', 'publishedAt']),
      ),
    ],
    usedIn: [
      { service: 'rapportassistenten', name: 'Rapportassistenten', draft: 2, test: 2, inUse: 2 },
    ],
  },
  {
    publisher: ownTenant,
    id: 'figur-i-svaret',
    editions: [
      edition(
        1,
        '2026-11-20T09:00:00Z',
        'Første utgave',
        {
          apiVersion: 'genai/v1',
          kind: 'Block',
          metadata: { tenant: ownTenant, id: 'figur-i-svaret', name: 'Figur i svaret' },
          spec: {
            tier: 'code',
            title: { nb: 'Figur i svaret', en: 'Figure in the answer' },
            zones: ['main'],
            sharing: 'organisation',
            events: ['notify'],
            states: ['filled'],
            code: {
              sha256: 'a3f1c09b7e2d5c4b8a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b',
              bytes: figurBundle.length,
              reads: ['question.text'],
            },
          },
        },
        { 'block/bundle.js': figurBundle },
      ),
    ],
  },
  {
    publisher: ownTenant,
    id: 'sporsmal-kort',
    editions: [
      edition(
        1,
        '2026-11-18T09:00:00Z',
        'Importert fra Claude: Spørsmålskort',
        starterDeclarative(ownTenant, 'sporsmal-kort', 'Spørsmålskort'),
      ),
    ],
  },
  builtIn('chat', 'Samtale', 'Conversation', ['main'], '2026-11-17T08:00:00Z', 4),
  builtIn(
    'threads',
    'Tidligere samtaler',
    'Earlier conversations',
    ['primary'],
    '2026-11-12T08:00:00Z',
    4,
  ),
  builtIn('filter', 'Filter', 'Filter', ['primary', 'secondary'], '2026-11-12T08:00:00Z', 2),
  builtIn('sources', 'Kilder', 'Sources', ['main', 'secondary'], '2026-11-17T08:00:00Z', 3),
  builtIn('approach', 'Fremgangsmåte', 'Approach', ['main'], '2026-11-17T08:00:00Z', 3, {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: ['standard', 'detailed'],
        default: 'standard',
        'x-label': 'builder.approachLevel',
      },
    },
  } as NonNullable<BlockDraft['spec']['props']>),
  builtIn(
    'document-view',
    'Dokumentvisning',
    'Document view',
    ['secondary'],
    '2026-11-12T08:00:00Z',
    1,
  ),
  builtIn('settings', 'Mine innstillinger', 'My settings', ['primary'], '2026-11-12T08:00:00Z', 2),
  {
    publisher: genki,
    id: 'kudos-dokumentkort',
    editions: [
      edition(1, '2026-11-14T08:00:00Z', 'Første utgave', {
        ...starterDeclarative(genki, 'kudos-dokumentkort', 'Kudos-dokumentkort'),
        spec: {
          ...starterDeclarative(genki, 'kudos-dokumentkort', 'Kudos-dokumentkort').spec,
          zones: ['secondary'],
          sharing: 'everyone',
        },
      }),
    ],
  },
];

export interface DesignMockOptions {
  blocks?: MockBlock[];
  fetch?: typeof fetch;
}

const originOf = (tenant: string, block: MockBlock): BlockOrigin =>
  block.builtIn ? 'built-in' : block.publisher === tenant ? 'own' : 'shared';

const editionOf = ({ definition: _d, files: _f, ...edition }: MockEdition): BlockEdition => edition;

const visible = (tenant: string, block: MockBlock) =>
  block.publisher === tenant || block.builtIn
    ? block.editions
    : block.editions.filter((e) => e.sharing === 'everyone');

const renderOf = (ref: string, publisher: string, d: BlockDraft): RefBlockPayload | undefined =>
  d.spec.tier === 'built-in'
    ? undefined
    : {
        ref,
        tier: d.spec.tier,
        publisher,
        publisherName: publisherNames[publisher] ?? publisher,
        title: d.spec.title,
        zones: d.spec.zones,
        events: d.spec.events ?? [],
        states: d.spec.states ?? [],
        texts: d.spec.texts,
        reads: d.spec.code?.reads ?? [
          'sources',
          'sources.title',
          'sources.publisher',
          'sources.publishedAt',
          'sources.index',
          'question.text',
        ],
        ...(d.spec.template ? { template: d.spec.template } : {}),
      };

const pinKey = /^\/tenants\/([^/]+)\/services\/([^/]+)\/draft\/blocks\/([^/]+)\/([^/]+)$/;

export const designMock = (options: DesignMockOptions = {}): MockHandler => {
  const blocks = structuredClone(options.blocks ?? exampleDesignBlocks());
  const find = (publisher: string, id: string) =>
    blocks.find((b) => b.publisher === publisher && b.id === id);

  const summary = (tenant: string, block: MockBlock): BlockSummary | undefined => {
    const editions = visible(tenant, block);
    const latest = editions.at(-1);
    if (!latest) return undefined;
    return {
      publisher: block.publisher,
      publisherName: publisherNames[block.publisher] ?? block.publisher,
      id: block.id,
      tier: latest.definition.spec.tier,
      origin: originOf(tenant, block),
      title: latest.definition.spec.title,
      zones: latest.definition.spec.zones,
      sharing: latest.sharing,
      latest: {
        version: latest.version,
        publishedAt: latest.publishedAt,
        ...(isFromClaude(latest.reason) ? { fromClaude: true } : {}),
      },
      editions: editions.length,
      usedBy: block.usedIn?.length ?? 0,
    };
  };

  const save = (req: MockRequest) => {
    const body = req.body<{ definition?: BlockDraft; files?: Record<string, string> }>();
    const definition = body.definition;
    if (definition?.kind !== 'Block') return undefined;
    if (!req.reason) return req.reasonMissing();
    if (definition.metadata.tenant !== ownTenant)
      return req.json({ title: 'Ikke din organisasjon', status: 403 }, 403);
    if (definition.spec.tier === 'code' && definition.spec.sharing === 'everyone')
      return req.json(
        {
          title: 'Bare genki kan dele kode med alle',
          status: 403,
          errors: [{ path: 'spec.sharing', message: 'Bare etter gjennomgang' }],
        },
        403,
      );
    let block = find(ownTenant, definition.metadata.id);
    if (!block) {
      block = { publisher: ownTenant, id: definition.metadata.id, editions: [] };
      blocks.unshift(block);
    }
    const version = (block.editions.at(-1)?.version ?? 0) + 1;
    block.editions.push(
      edition(version, new Date().toISOString(), req.reason, definition, body.files ?? {}),
    );
    return req.json({ version, id: definition.metadata.id, kind: 'Block' }, 201);
  };

  const pin = async (req: MockRequest, match: RegExpExecArray) => {
    const [, tenant = '', service = '', publisher = '', id = ''] = match.map(decodeURIComponent);
    if (!req.reason) return req.reasonMissing();
    const self = options.fetch;
    if (!self) return req.notFound();
    const block = find(publisher, id);
    const base = `/api/tenants/${tenant}/services/${service}`;
    const draft = (await (await self(`${base}/draft`)).json()) as {
      definition: Record<string, unknown>;
      files: Record<string, string>;
      revision: number;
    } | null;
    const latest = draft
      ? undefined
      : ((await (await self(`/api/tenants/${tenant}/definitions/services/${service}`)).json()) as {
          latest?: { definition: Record<string, unknown> };
        });
    const definition = structuredClone(draft?.definition ?? latest?.latest?.definition);
    if (!definition) return req.notFound();
    const layout = (
      definition.spec as {
        interface?: { layout?: { zones?: Record<BlockZone, Record<string, unknown>[]> } };
      }
    ).interface?.layout;
    if (!layout?.zones)
      return req.json({ title: 'Tjenesten har ikke noe oppsett ennå', status: 422 }, 422);
    const isPin = (p: Record<string, unknown>) =>
      typeof p.ref === 'string' && p.ref.startsWith(`${publisher}/${id}@`);
    const at = (Object.keys(layout.zones) as BlockZone[]).find((z) =>
      layout.zones?.[z]?.some(isPin),
    );
    for (const zone of Object.keys(layout.zones) as BlockZone[])
      layout.zones[zone] = (layout.zones[zone] ?? []).filter((p) => !isPin(p));
    if (req.method === 'PUT') {
      const body = req.body<{ version: number; zone?: BlockZone }>();
      const chosen = block && visible(tenant, block).find((e) => e.version === body.version);
      if (!block || !chosen) return req.notFound();
      const zone = body.zone ?? at ?? chosen.definition.spec.zones[0] ?? 'main';
      layout.zones[zone] = [
        ...(layout.zones[zone] ?? []),
        { block: 'ref', ref: `${publisher}/${id}@${body.version}` },
      ];
      block.usedIn = [
        ...(block.usedIn ?? []).filter((u) => u.service !== service),
        { service, name: service, draft: body.version },
      ];
    } else if (block) block.usedIn = (block.usedIn ?? []).filter((u) => u.service !== service);
    const saved = await self(`${base}/draft`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'change-reason': encodeURIComponent(req.reason),
      },
      body: JSON.stringify({
        definition,
        files: draft?.files ?? {},
        revision: draft?.revision ?? 0,
      }),
    });
    const written = (await saved.json()) as Record<string, unknown>;
    return req.json(
      { files: {}, baseVersion: null, checks: [], ...written, definition },
      saved.status,
    );
  };

  const importDesign = (req: MockRequest) => {
    const body = req.body<{ html?: string; id?: string; title?: string }>();
    if (!body.html?.trim() || !body.id)
      return req.json({ title: 'Mangler HTML eller id', status: 422 }, 422);
    if (/<(svg|canvas|script)\b/i.test(body.html))
      return req.json(
        { title: 'Designet trenger kode, og det kan ikke gjøres om ennå.', status: 422 },
        422,
      );
    const title = body.title ?? body.id;
    const result: ImportResult = {
      tier: 'declarative',
      definition: starterDeclarative(ownTenant, body.id, title) as unknown as Record<
        string,
        unknown
      >,
      files: {},
      report: [
        {
          kind: 'converted',
          code: 'convertedDeclarative',
          where: 'body',
          message: 'Teksten ble en struktur uten kode.',
        },
        {
          kind: 'dropped',
          code: 'externalAssets',
          where: 'head',
          message: 'Fjernet ekstern skrift.',
        },
      ],
    };
    return req.json(result);
  };

  const connector = (req: MockRequest, rest: string[]) => {
    const { method } = req;
    if (method === 'GET' && rest.length === 0)
      return req.json({ url: 'http://localhost:8080/mcp/design' });
    if (rest[0] === 'requests' && rest[1] === 'gone') return req.notFound();
    if (method === 'GET' && rest[0] === 'requests' && rest[1])
      return req.json({
        client: 'Claude',
        redirect: 'claude.ai',
        scope: 'design',
        startedAt: new Date().toISOString(),
      });
    if (method === 'POST' && rest[0] === 'requests' && rest[1]) {
      if (!req.reason) return req.reasonMissing();
      const { decision } = req.body<{ decision?: string }>();
      return req.json({
        redirect:
          decision === 'allow'
            ? `http://localhost:8080/oauth/design/finish/${encodeURIComponent(rest[1])}`
            : 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s',
      });
    }
    if (method === 'DELETE' && rest[0] === 'grants') return req.json({ ended: 2 });
    return req.notFound();
  };

  return (req) => {
    const { path, method } = req;
    if (method === 'POST' && path === '/definitions') return save(req);
    const connecting = /^\/tenants\/[^/]+\/design-connector(?:\/(.*))?$/.exec(path);
    if (connecting)
      return connector(
        req,
        (connecting[1] ?? '').split('/').filter(Boolean).map(decodeURIComponent),
      );
    const pinned = pinKey.exec(path);
    if (pinned && (method === 'PUT' || method === 'DELETE')) return pin(req, pinned);
    const version = /^\/tenants\/([^/]+)\/definitions\/blocks\/([^/]+)\/versions\/(\d+)$/.exec(
      path,
    );
    if (version && method === 'GET') {
      const found = find(version[1] ?? '', decodeURIComponent(version[2] ?? ''));
      const chosen = found?.editions.find((e) => e.version === Number(version[3]));
      return chosen
        ? req.json({ definition: chosen.definition, files: chosen.files })
        : req.notFound();
    }
    const tenantMatch = /^\/tenants\/([^/]+)\/blocks(?:\/(.*))?$/.exec(path);
    if (!tenantMatch) return undefined;
    const tenant = tenantMatch[1] ?? '';
    const rest = (tenantMatch[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'GET' && rest.length === 0)
      return req.json({ data: blocks.flatMap((b) => summary(tenant, b) ?? []) });
    if (method === 'POST' && rest[0] === 'preview') {
      const body = req.body<{ definition?: BlockDraft; states?: BlockState[] }>();
      const definition = body.definition;
      if (definition?.kind !== 'Block')
        return req.json({ title: 'Ikke en Block', status: 422 }, 422);
      const errors =
        definition.spec.tier === 'declarative' && !definition.spec.texts?.nb
          ? [{ path: 'spec.texts.nb', message: 'mangler bokmål' }]
          : [];
      return req.json({
        valid: errors.length === 0,
        ...(errors.length
          ? { errors }
          : { render: renderOf(`${tenant}/${definition.metadata.id}@0`, tenant, definition) }),
        reads: [],
        fixtures: blockFixtures,
      });
    }
    if (method === 'POST' && rest[0] === 'import') return importDesign(req);
    if (method === 'POST' && rest.length === 2 && rest[1] === 'share-requests') {
      if (!req.reason) return req.reasonMissing();
      const block = find(tenant, rest[0] ?? '');
      if (!block) return req.notFound();
      const { version } = req.body<{ version: number }>();
      const at = new Date().toISOString();
      block.review = { status: 'pending', version, at };
      return req.json({ id: `rid-${block.id}`, status: 'pending', version, at }, 201);
    }
    if (method === 'DELETE' && rest.length === 1) {
      if (!req.reason) return req.reasonMissing();
      const at = blocks.findIndex((b) => b.publisher === tenant && b.id === rest[0] && !b.builtIn);
      const block = blocks[at];
      if (!block) return req.notFound();
      if (block.usedIn?.length)
        return req.json(
          {
            type: 'urn:genai:problem:block-in-use',
            title: 'Klossen er i bruk',
            status: 409,
            errors: block.usedIn.map((u) => ({
              path: 'id',
              message: `Tjenesten ${u.name} bruker den.`,
            })),
            usedBy: block.usedIn.map((u) => u.service),
            otherServices: 0,
          },
          409,
        );
      blocks.splice(at, 1);
      return req.json({ id: block.id, archived: true, version: block.editions.length + 1 });
    }
    if (method === 'GET' && rest.length === 2) {
      const block = find(rest[0] ?? '', rest[1] ?? '');
      const editions = block ? visible(tenant, block) : [];
      const asked = req.url.searchParams.get('version');
      const chosen = asked ? editions.find((e) => String(e.version) === asked) : editions.at(-1);
      const head = block && summary(tenant, block);
      if (!block || !chosen || !head) return req.notFound();
      const { definition } = chosen;
      const render = renderOf(
        `${block.publisher}/${block.id}@${chosen.version}`,
        block.publisher,
        definition,
      );
      const detail: BlockDetail = {
        ...head,
        editions: editions.map(editionOf),
        edition: {
          ...editionOf(chosen),
          definition: definition as unknown as Record<string, unknown>,
          ...(render ? { render } : {}),
        },
        usedIn: block.usedIn ?? [],
        ...(block.review && block.publisher === tenant ? { review: block.review } : {}),
      };
      return req.json(detail);
    }
    return undefined;
  };
};
