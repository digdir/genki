import {
  Button,
  Heading,
  Link,
  Paragraph,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { useTenantNames } from '../tenant-names';
import { useAsync } from '../hooks';
import { ErrorState, Loading } from '../states';
import type {
  Availability,
  BlockType,
  BuildingBlock,
  BlockApprovalRequest,
  BuildingBlocks as Blocks,
  PluginSummary,
  RegistryBlock,
  SkillShareRequest,
} from '../types';
import { toYaml } from '../yaml';
import { Flash, TableRegion, useFlash } from '../ui';
import './platform.css';
import { PageTabs } from '../page-tabs';

const availabilityLabel: Record<Availability, [PlainKey, 'success' | 'info' | 'neutral']> = {
  all: ['buildingBlocks.availabilityAll', 'success'],
  selected: ['buildingBlocks.availabilitySelected', 'info'],
  none: ['buildingBlocks.availabilityNone', 'neutral'],
};

const typeOf = (id: string, name: PlainKey, description: PlainKey, t: T): BlockType => ({
  id,
  name: t(name),
  description: t(description),
});

const fallbackTypes = (t: T): [BlockType, BlockType, BlockType] => [
  typeOf('strategi', 'buildingBlocks.typeStrategies', 'buildingBlocks.typeStrategiesText', t),
  typeOf('steg', 'buildingBlocks.typeSteps', 'buildingBlocks.typeStepsText', t),
  typeOf('verktoy', 'buildingBlocks.typeTools', 'buildingBlocks.typeToolsText', t),
];

const fromRef =
  (type: string) =>
  (b: BuildingBlock): RegistryBlock => {
    const [name = b.ref, version = '–'] = b.ref.split('@');
    return {
      id: b.ref,
      type,
      name: b.description ? `${name} (${b.description})` : name,
      version,
      serviceCount: b.usedBy.length,
      services: b.usedBy.map((u) => {
        const [tenant = '', service = u] = u.split('/');
        return { tenant, service };
      }),
      agencies: [...new Set(b.usedBy.map((u) => u.split('/')[0] ?? ''))],
      ...(b.configSchema ? { configSchema: b.configSchema } : {}),
    };
  };

const pluginTypes = (t: T): BlockType[] => {
  const [strategies, , tools] = fallbackTypes(t);
  return [
    strategies,
    typeOf('model', 'buildingBlocks.typeModel', 'buildingBlocks.typeModelText', t),
    typeOf('embedding', 'buildingBlocks.typeEmbedding', 'buildingBlocks.typeEmbeddingText', t),
    typeOf('rerank', 'buildingBlocks.typeRerank', 'buildingBlocks.typeRerankText', t),
    typeOf('knowledge', 'buildingBlocks.typeKnowledge', 'buildingBlocks.typeKnowledgeText', t),
    typeOf('tool-source', 'buildingBlocks.typeToolSource', 'buildingBlocks.typeToolSourceText', t),
    typeOf('blob', 'buildingBlocks.typeBlob', 'buildingBlocks.typeBlobText', t),
    typeOf('step-block', 'buildingBlocks.typeSteps', 'buildingBlocks.typeStepsText', t),
    typeOf('hook', 'buildingBlocks.typeHook', 'buildingBlocks.typeHookText', t),
    tools,
  ];
};

const when = (iso: string, f: Format) => f.dateTime(iso, 'medium');

const servicesOf = (usedBy: string[]) => ({
  serviceCount: usedBy.length,
  services: usedBy.map((u) => {
    const [tenant = '', service = u] = u.split('/');
    return { tenant, service };
  }),
  agencies: [...new Set(usedBy.map((u) => u.split('/')[0] ?? ''))],
});

const fromPlugin =
  (usage: Map<string, string[]>, f: Format) =>
  (p: PluginSummary): RegistryBlock => {
    const ref = p.kind === 'step-block' ? p.title : p.id;
    const run = p.contractTests;
    return {
      id: p.id,
      type: p.kind,
      name: p.title,
      version: p.version,
      provider: p.publisher === 'digdir' ? 'Digdir' : p.publisher,
      verifiable: p.verifiable,
      origin: p.origin,
      dataLocation: p.dataLocation,
      ...(run
        ? {
            testPassed: run.passed,
            testedAt: when(run.at, f),
            tests: run.results.map((r) => ({
              name: r.name,
              passed: r.status !== 'failed',
              ...(r.status === 'skipped' ? { skipped: true } : {}),
              ...(r.reason ? { reason: r.reason } : {}),
            })),
          }
        : {}),
      ...servicesOf(usage.get(ref) ?? []),
      ...(p.configSchema ? { configSchema: p.configSchema } : {}),
      manifest: toYaml({
        kind: p.kind,
        id: p.id,
        version: p.version,
        contract: p.contract,
        title: p.title,
        description: p.description,
        publisher: p.publisher,
        origin: p.origin,
        capabilities: p.capabilities,
        dataLocation: p.dataLocation,
        secrets: p.secrets,
        hosts: p.hosts,
      }),
    };
  };

export const normalizeBlocks = (data: Blocks, t: T, f: Format) => {
  if (data.registry && data.types) return { types: data.types, blocks: data.registry };
  if (data.plugins) {
    const usage = new Map(data.blocks.map((b) => [b.ref, b.usedBy]));
    const blocks = [
      ...data.strategies.map(fromRef('strategi')),
      ...data.plugins.map(fromPlugin(usage, f)),
      ...data.tools.map(fromRef('verktoy')),
    ];
    return {
      types: pluginTypes(t).filter((type) => blocks.some((b) => b.type === type.id)),
      blocks,
    };
  }
  const blocks = [
    ...data.strategies.map(fromRef('strategi')),
    ...data.blocks.map(fromRef('steg')),
    ...data.tools.map(fromRef('verktoy')),
  ];
  return {
    types: fallbackTypes(t),
    blocks,
  };
};

const TestTag = ({ b, prefixed = false }: { b: RegistryBlock; prefixed?: boolean }) => {
  const t = useT();
  return b.testPassed === undefined ? (
    <Tag data-size="sm" data-color="neutral">
      {t(prefixed ? 'buildingBlocks.contractNotMeasured' : 'buildingBlocks.notMeasured')}
    </Tag>
  ) : (
    <Tag data-size="sm" data-color={b.testPassed ? 'success' : 'danger'}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path d={b.testPassed ? 'M5 12l5 5 9-10' : 'M6 6l12 12M18 6L6 18'} />
      </svg>
      {b.testPassed
        ? t(prefixed ? 'buildingBlocks.contractPassed' : 'buildingBlocks.passed')
        : t(prefixed ? 'buildingBlocks.contractFailed' : 'buildingBlocks.failed')}
    </Tag>
  );
};

type Kind = 'designElement' | 'tool' | 'workInstruction';

const kindLabel: Record<Kind, PlainKey> = {
  designElement: 'buildingBlocks.kindDesignElement',
  tool: 'buildingBlocks.kindTool',
  workInstruction: 'buildingBlocks.kindWorkInstruction',
};

const kinds = Object.keys(kindLabel) as Kind[];

type Status = 'review' | 'everyone' | 'selected' | 'none';

const statusChip: Record<Status, [PlainKey, string]> = {
  review: ['buildingBlocks.statusReview', 'warn'],
  everyone: ['buildingBlocks.statusEveryone', 'ok'],
  selected: ['buildingBlocks.availabilitySelected', 'info'],
  none: ['buildingBlocks.availabilityNone', 'neutral'],
};

interface CatalogRow {
  key: string;
  name: string;
  kind: Kind;
  from: string;
  version: string;
  usedBy: number | undefined;
  status: Status;
  open?: string;
  review?: string;
}

interface ShareReview {
  id: string;
  tenant: string;
  tenantName?: string;
  block: string;
  version: number;
  status: string;
  title: { nb?: string; en?: string };
}

interface CatalogReviews {
  designElements: ShareReview[];
  tools: BlockApprovalRequest[];
  workInstructions: SkillShareRequest[];
}

const isPending = (state: string | undefined) => Boolean(state?.startsWith('pending'));

const settled = <T,>(promise: Promise<T[]>) => promise.catch((): T[] => []);

const loadReviews = async (api: ApiClient, signal?: AbortSignal): Promise<CatalogReviews> => {
  const [designElements, tools, workInstructions] = await Promise.all([
    settled(
      api
        .getJson('/operator/block-share-requests?status=pending', signal)
        .then((r) => (r as { data: ShareReview[] }).data),
    ),
    settled(api.blockApprovalRequests(signal)),
    settled(api.skillShares(signal)),
  ]);
  return {
    designElements: designElements.filter((r) => isPending(r.status)),
    tools: tools.filter((r) => r.block.kind === 'tool' && isPending(r.status ?? r.state)),
    workInstructions: workInstructions.filter((r) => isPending(r.state)),
  };
};

const catalogRows = (
  blocks: RegistryBlock[],
  reviews: CatalogReviews,
  tenantName: (orgNumber: string) => string,
): CatalogRow[] => [
  ...reviews.designElements.map((r): CatalogRow => ({
    key: `design/${r.id}`,
    name: r.title.nb ?? r.title.en ?? r.block,
    kind: 'designElement',
    from: r.tenantName ?? tenantName(r.tenant),
    version: String(r.version),
    usedBy: undefined,
    status: 'review',
    review: '#/block-reviews',
  })),
  ...blocks
    .filter((b) => b.type === 'verktoy' || b.type === 'tool-source')
    .map((b): CatalogRow => ({
      key: `tool/${b.id}`,
      name: b.name,
      kind: 'tool',
      from: b.provider ?? 'genki',
      version: b.version,
      usedBy: b.agencies?.filter(Boolean).length ?? 0,
      status:
        b.availability === 'selected'
          ? 'selected'
          : b.availability === 'none'
            ? 'none'
            : 'everyone',
      open: b.id,
    })),
  ...reviews.tools.map((r): CatalogRow => ({
    key: `tool-request/${r.id}`,
    name: r.block.name ?? r.block.id,
    kind: 'tool',
    from: r.tenantName ?? tenantName(r.tenant),
    version: r.block.version,
    usedBy: undefined,
    status: 'review',
    review: '#/queue',
  })),
  ...reviews.workInstructions.map((r): CatalogRow => ({
    key: `skill/${r.id}`,
    name: r.skillName ?? r.skill,
    kind: 'workInstruction',
    from: r.tenantName ?? tenantName(r.tenant),
    version: String(r.version),
    usedBy: undefined,
    status: 'review',
    review: '#/queue',
  })),
];

const CatalogList = ({
  rows,
  kind,
  setKind,
  onOpen,
}: {
  rows: CatalogRow[];
  kind: Kind | 'all';
  setKind: (kind: Kind | 'all') => void;
  onOpen: (id: string) => void;
}) => {
  const t = useT();
  const shown = rows.filter((r) => kind === 'all' || r.kind === kind);
  return (
    <>
      <h1 className="pf-title">{t('buildingBlocks.title')}</h1>
      <PageTabs />
      <div role="group" aria-label={t('buildingBlocks.type')} className="pf-pills">
        {(['all', ...kinds] as const).map((k) => (
          <button
            key={k}
            type="button"
            className="pf-pill"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >
            {k === 'all' ? t('buildingBlocks.filterAll') : t(kindLabel[k])}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <Paragraph>{t('buildingBlocks.noMatch')}</Paragraph>
      ) : (
        <div
          className="pf-region"
          tabIndex={0}
          role="region"
          aria-label={t('buildingBlocks.title')}
        >
          <table className="pf-table pf-min-860">
            <thead>
              <tr>
                <th scope="col">{t('buildingBlocks.colName')}</th>
                <th scope="col">{t('buildingBlocks.type')}</th>
                <th scope="col">{t('buildingBlocks.colFrom')}</th>
                <th scope="col">{t('buildingBlocks.colEdition')}</th>
                <th scope="col">{t('buildingBlocks.colUsedBy')}</th>
                <th scope="col">{t('buildingBlocks.colStatus')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('buildingBlocks.colAction')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td className="name">
                    {r.open ? (
                      <a
                        className="name"
                        href={`#/building-blocks?block=${encodeURIComponent(r.open)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          if (r.open) onOpen(r.open);
                        }}
                      >
                        {r.name}
                      </a>
                    ) : (
                      r.name
                    )}
                  </td>
                  <td>{t(kindLabel[r.kind])}</td>
                  <td className="muted">{r.from}</td>
                  <td>{r.version}</td>
                  <td>
                    {r.usedBy === undefined
                      ? t('buildingBlocks.usedByUnknown')
                      : t('buildingBlocks.organisationCount', { count: r.usedBy })}
                  </td>
                  <td>
                    <span className="pf-chip" data-tone={statusChip[r.status][1]}>
                      {t(statusChip[r.status][0])}
                    </span>
                  </td>
                  <td className="end">
                    {r.review ? (
                      <a
                        className="action"
                        href={r.review}
                        aria-label={t('buildingBlocks.reviewFor', { name: r.name })}
                      >
                        {t('buildingBlocks.review')}
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

const manifestOf = (b: RegistryBlock) =>
  [
    `type: ${b.type}`,
    `id: ${b.id}`,
    `navn: ${b.name}`,
    `versjon: ${b.version}`,
    `leverandor: ${b.provider ?? 'Digdir'}`,
    `kontrakttester: plattform/kontrakter/${b.type}@1`,
    b.settingsSchema?.length ? 'innstillinger:' : 'innstillinger: []',
    ...(b.settingsSchema ?? []).map(
      (s) =>
        `  ${s.field}:\n    type: ${s.type}\n    standard: ${s.default}\n    tillatt: ${s.allowed}\n    beskrivelse: ${s.description}`,
    ),
  ].join('\n');

const Detail = ({
  api,
  block,
  types,
  onBack,
  onChanged,
}: {
  api: ApiClient;
  block: RegistryBlock;
  types: BlockType[];
  onBack: () => void;
  onChanged: (message: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const tenantName = useTenantNames(api);
  const [tab, setTab] = useState('usage');
  const [testing, setTesting] = useState(false);
  const flash = useFlash();
  const type = types.find((candidate) => candidate.id === block.type);

  const rerun = async () => {
    setTesting(true);
    try {
      const run = await api.rerunContractTests(
        block.id,
        tRef.current('buildingBlocks.rerunReason', { name: block.name }),
      );
      const failed = (run.results ?? []).filter((r) => r.status === 'failed').length;
      onChanged(
        run.passed
          ? tRef.current('buildingBlocks.rerunPassed', {
              name: block.name,
              version: block.version,
            })
          : tRef.current('buildingBlocks.rerunFailed', {
              failed,
              total: run.results?.length ?? 0,
              name: block.name,
            }),
      );
    } catch {
      flash.show(tRef.current('buildingBlocks.rerunError'), 'danger');
    } finally {
      setTesting(false);
    }
  };

  const schema = block.settingsSchema ?? [];
  const log = block.changelog ?? [
    { version: block.version, at: block.testedAt ?? '–', text: t('buildingBlocks.currentVersion') },
  ];

  return (
    <>
      <Link
        href="#/building-blocks"
        onClick={(e) => {
          e.preventDefault();
          onBack();
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
        {t('buildingBlocks.back')}
      </Link>
      <div className="page-header">
        <span className="eyebrow">
          {type?.name ?? block.type} · {block.id}
        </span>
        <div className="name-line">
          <Heading level={1} data-size="md">
            {block.name}
          </Heading>
          <Tag data-color="neutral">{t('buildingBlocks.version', { version: block.version })}</Tag>
          <TestTag b={block} prefixed />
          {block.availability ? (
            <Tag data-color={availabilityLabel[block.availability][1]}>
              {t(availabilityLabel[block.availability][0])}
            </Tag>
          ) : null}
          {block.badge ? <Tag data-color="info">{block.badge}</Tag> : null}
        </div>
        <span className="intro">
          {block.serviceCount
            ? t('buildingBlocks.usedBy', {
                services: t('buildingBlocks.serviceCount', { count: block.serviceCount }),
                organisations: t('buildingBlocks.organisationCount', {
                  count: block.agencies?.length ?? 0,
                }),
              })
            : t('buildingBlocks.notUsedYet')}
        </span>
      </div>
      <Flash message={flash.message} />
      <Tabs value={tab} onChange={setTab}>
        <TabsList>
          <TabsTab value="usage">{t('buildingBlocks.tabUsage')}</TabsTab>
          <TabsTab value="tests">{t('buildingBlocks.tabTests')}</TabsTab>
          <TabsTab value="schema">{t('buildingBlocks.tabSchema')}</TabsTab>
          <TabsTab value="log">{t('buildingBlocks.tabLog')}</TabsTab>
          <TabsTab value="manifest">{t('buildingBlocks.tabManifest')}</TabsTab>
        </TabsList>
        <TabsPanel value="usage">
          {block.services.length === 0 ? (
            <Paragraph>{t('buildingBlocks.noServices')}</Paragraph>
          ) : (
            <>
              <TableRegion label={t('buildingBlocks.servicesUsing')}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">
                        {t('buildingBlocks.columnOrganisation')}
                      </TableHeaderCell>
                      <TableHeaderCell scope="col">
                        {t('buildingBlocks.columnService')}
                      </TableHeaderCell>
                      <TableHeaderCell scope="col">{t('buildingBlocks.columnUse')}</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {block.services.map((s) => (
                      <TableRow key={`${s.tenant}/${s.service}`}>
                        <TableCell>{tenantName(s.tenant)}</TableCell>
                        <TableHeaderCell scope="row" className="row-head">
                          {s.service}
                        </TableHeaderCell>
                        <TableCell>{s.detail ?? t('buildingBlocks.inUse')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableRegion>
              {block.serviceCount > block.services.length ? (
                <Paragraph data-size="sm">
                  {t('buildingBlocks.moreServices', {
                    count: block.serviceCount - block.services.length,
                  })}
                </Paragraph>
              ) : null}
            </>
          )}
        </TabsPanel>
        <TabsPanel value="tests">
          <div className="stack">
            <div className="name-line">
              <span className="sm">
                {t('buildingBlocks.lastRun', { when: block.testedAt ?? t('buildingBlocks.never') })}{' '}
                {block.verifiable
                  ? t('buildingBlocks.runsOnStart')
                  : t('buildingBlocks.runsInBuild')}
              </span>
              {block.verifiable ? (
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-disabled={testing || undefined}
                  onClick={() => void (testing ? undefined : rerun())}
                >
                  {t('buildingBlocks.rerun')}
                </Button>
              ) : null}
              <span role="status">
                {testing ? (
                  <>
                    <Spinner aria-hidden data-size="xs" /> {t('buildingBlocks.running')}
                  </>
                ) : null}
              </span>
            </div>
            {block.tests?.length ? (
              <ul className="plain test-list">
                {block.tests.map((test) => (
                  <li key={test.name} className={test.passed ? undefined : 'failing'}>
                    <Tag
                      data-size="sm"
                      data-color={test.skipped ? 'neutral' : test.passed ? 'success' : 'danger'}
                    >
                      {test.skipped
                        ? t('buildingBlocks.skipped')
                        : test.passed
                          ? t('buildingBlocks.passed')
                          : t('buildingBlocks.failed')}
                    </Tag>
                    <span>{test.name}</span>
                    {test.reason ? <span className="meta">{test.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Paragraph data-size="sm">{t('buildingBlocks.noTests')}</Paragraph>
            )}
          </div>
        </TabsPanel>
        <TabsPanel value="schema">
          <div className="stack">
            <Paragraph data-size="sm">{t('buildingBlocks.schemaNote')}</Paragraph>
            {block.configSchema && !block.settingsSchema ? (
              <pre className="code" tabIndex={0} aria-label={t('buildingBlocks.schemaLabel')}>
                {JSON.stringify(block.configSchema, null, 2)}
              </pre>
            ) : schema.length === 0 ? (
              <Paragraph data-size="sm">{t('buildingBlocks.noSettings')}</Paragraph>
            ) : (
              <TableRegion label={t('buildingBlocks.schemaLabel')}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">
                        {t('buildingBlocks.columnField')}
                      </TableHeaderCell>
                      <TableHeaderCell scope="col">
                        {t('buildingBlocks.columnType')}
                      </TableHeaderCell>
                      <TableHeaderCell scope="col">
                        {t('buildingBlocks.columnDefault')}
                      </TableHeaderCell>
                      <TableHeaderCell scope="col">
                        {t('buildingBlocks.columnAllowed')}
                      </TableHeaderCell>
                      <TableHeaderCell scope="col">
                        {t('buildingBlocks.columnDescription')}
                      </TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {schema.map((s) => (
                      <TableRow key={s.field}>
                        <TableHeaderCell scope="row" className="row-head">
                          {s.field}
                        </TableHeaderCell>
                        <TableCell>{s.type}</TableCell>
                        <TableCell>{s.default}</TableCell>
                        <TableCell>{s.allowed}</TableCell>
                        <TableCell>{s.description}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableRegion>
            )}
          </div>
        </TabsPanel>
        <TabsPanel value="log">
          <ol className="plain log-list">
            {log.map((l) => (
              <li key={`${l.version}-${l.at}`}>
                <span className="label-strong">{l.version}</span>
                <span className="meta">{l.at}</span>
                <span>{l.text}</span>
              </li>
            ))}
          </ol>
        </TabsPanel>
        <TabsPanel value="manifest">
          <div className="stack">
            <Paragraph data-size="sm">{t('buildingBlocks.manifestNote')}</Paragraph>
            <pre className="code" tabIndex={0} aria-label={t('buildingBlocks.manifestLabel')}>
              <code>{block.manifest ?? manifestOf(block)}</code>
            </pre>
          </div>
        </TabsPanel>
      </Tabs>
    </>
  );
};

export const BuildingBlocks = ({
  api,
  initial,
}: {
  api: ApiClient;
  initial?: string | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const tenantName = useTenantNames(api);
  const [state, retry] = useAsync(
    async (signal) => {
      const [blocks, reviews] = await Promise.all([
        api.buildingBlocks(signal),
        loadReviews(api, signal),
      ]);
      return { blocks, reviews };
    },
    [api],
  );
  const [selected, setSelected] = useState<string | undefined>(initial);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [data, setData] = useState<{ blocks: Blocks; reviews: CatalogReviews }>();
  useEffect(() => {
    if (state.status === 'ready') setData(state.data);
  }, [state]);
  const flash = useFlash();
  if (!data && state.status === 'error')
    return (
      <>
        <h1 className="pf-title">{t('buildingBlocks.title')}</h1>
        <PageTabs />
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  if (!data) return <Loading label={t('buildingBlocks.loading')} />;
  const { types, blocks } = normalizeBlocks(data.blocks, t, f);
  const block = blocks.find((b) => b.id === selected);
  return (
    <>
      <Flash message={flash.message} />
      {block ? (
        <Detail
          key={block.id}
          api={api}
          block={block}
          types={types}
          onBack={() => setSelected(undefined)}
          onChanged={(message) => {
            flash.show(message);
            retry();
          }}
        />
      ) : (
        <CatalogList
          rows={catalogRows(blocks, data.reviews, tenantName)}
          kind={kind}
          setKind={setKind}
          onOpen={(id) => {
            flash.clear();
            setSelected(id);
          }}
        />
      )}
    </>
  );
};
