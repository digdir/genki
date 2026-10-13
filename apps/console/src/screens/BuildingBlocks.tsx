import {
  Alert,
  Button,
  Chip,
  Details,
  DetailsContent,
  DetailsSummary,
  Dialog,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Link,
  Paragraph,
  Radio,
  Select,
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
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { parse as parseYaml } from 'yaml';
import { useTenantNames } from '../tenant-names';
import { useAsync } from '../hooks';
import { EmptyState, ErrorState, Loading } from '../states';
import type {
  Availability,
  BlockType,
  BuildingBlock,
  BuildingBlocks as Blocks,
  PluginSummary,
  RegistryBlock,
} from '../types';
import { toYaml } from '../yaml';
import { Flash, Kpis, PageHeader, TableRegion, useFlash } from '../ui';
import { reasonProblem } from '../reason';

const availabilityLabel: Record<Availability, [PlainKey, 'success' | 'info' | 'neutral']> = {
  all: ['buildingBlocks.availabilityAll', 'success'],
  selected: ['buildingBlocks.availabilitySelected', 'info'],
  none: ['buildingBlocks.availabilityNone', 'neutral'],
};

const availabilityNow = (availability: Availability, name: string, t: T) =>
  availability === 'all'
    ? t('buildingBlocks.availabilityNowAll', { name })
    : availability === 'selected'
      ? t('buildingBlocks.availabilityNowSelected', { name })
      : t('buildingBlocks.availabilityNowNone', { name });

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
  if (data.registry && data.types)
    return {
      types: data.types,
      blocks: data.registry,
      agencies: data.agencies ?? [...new Set(data.registry.flatMap((b) => b.agencies ?? []))],
    };
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
      agencies: [...new Set(blocks.flatMap((b) => b.agencies ?? []))],
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
    agencies: [...new Set(blocks.flatMap((b) => b.agencies ?? []))],
  };
};

const isNew = (b: RegistryBlock) => Boolean(b.badge && /^Ny/.test(b.badge));
const usage = (b: RegistryBlock, t: T) =>
  b.serviceCount
    ? t('buildingBlocks.usageLine', {
        organisations: t('buildingBlocks.organisationCount', { count: b.agencies?.length ?? 0 }),
        services: t('buildingBlocks.serviceCount', { count: b.serviceCount }),
      })
    : t('buildingBlocks.notInUse');

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

const locations: Record<string, [PlainKey, 'success' | 'info' | 'danger']> = {
  norway: ['buildingBlocks.locationNorway', 'success'],
  eu: ['buildingBlocks.locationEu', 'info'],
  global: ['buildingBlocks.locationGlobal', 'danger'],
};

const locationTag = (location: string, t: T): [string, 'success' | 'info' | 'danger'] => {
  const found = locations[location];
  return found ? [t(found[0]), found[1]] : [location, 'info'];
};

const exampleManifest = `kind: tool-source
id: lovdata-pro
version: 2.0.0
contract: tool-source@1
title: Lovdata Pro
publisher: Lovdata
dataLocation: norway
`;

const problemErrors = (error: unknown, t: T) => {
  if (!(error instanceof ApiError)) return [t('buildingBlocks.registerFailed')];
  const listed = (error.problem?.errors ?? []).map((e) =>
    e.path ? `${e.path}: ${e.message}` : e.message,
  );
  return listed.length ? listed : [error.problem?.title ?? t('buildingBlocks.registerFailedShort')];
};

const RegisterDialog = ({
  api,
  open,
  onClose,
  onRegistered,
}: {
  api: ApiClient;
  open: boolean;
  onClose: () => void;
  onRegistered: (message: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [text, setText] = useState(exampleManifest);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const register = async () => {
    let manifest: unknown;
    try {
      manifest = parseYaml(text);
    } catch {
      setErrors([t('buildingBlocks.invalidYaml')]);
      return;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      setErrors([t('buildingBlocks.yamlObject')]);
      return;
    }
    const m = manifest as Record<string, unknown>;
    setBusy(true);
    setErrors([]);
    try {
      await api.registerPlugin(m);
      const name = [m.title ?? m.id ?? tRef.current('buildingBlocks.defaultBlockName'), m.version]
        .filter(Boolean)
        .map(String);
      onRegistered(tRef.current('buildingBlocks.registered', { name: name.join(' ') }));
    } catch (e) {
      setErrors(problemErrors(e, tRef.current));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeButton={t('common.close')}
      aria-labelledby="rg-h"
      className="reason-dialog"
    >
      {open ? (
        <div className="stack">
          <Heading level={2} data-size="xs" id="rg-h">
            {t('buildingBlocks.registerTitle')}
          </Heading>
          <div className="field">
            <Label htmlFor="rg-m">{t('buildingBlocks.manifestYaml')}</Label>
            <Textarea
              id="rg-m"
              rows={9}
              value={text}
              aria-invalid={errors.length ? true : undefined}
              onChange={(e) => setText(e.target.value)}
            />
            {errors.map((e) => (
              <ValidationMessage key={e}>{e}</ValidationMessage>
            ))}
          </div>
          <Paragraph data-size="sm">{t('buildingBlocks.registerNote')}</Paragraph>
          <Details>
            <DetailsSummary>{t('common.showApiCall')}</DetailsSummary>
            <DetailsContent>
              <div className="stack">
                <code>POST /operator/plugins</code>
                <pre className="code">{JSON.stringify({ manifest: '…' }, null, 2)}</pre>
              </div>
            </DetailsContent>
          </Details>
          <div className="actions-row">
            <Button loading={busy} onClick={() => void register()}>
              {t('buildingBlocks.registerAndTest')}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
};

type StatusFilter = 'all' | 'failing' | 'new' | 'limited';

const List = ({
  types,
  blocks,
  onOpen,
  onRegister,
}: {
  types: BlockType[];
  blocks: RegistryBlock[];
  onOpen: (id: string) => void;
  onRegister: () => void;
}) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const q = query.trim().toLowerCase();
  const hits = blocks.filter(
    (b) =>
      (type === 'all' || b.type === type) &&
      (!q || `${b.name} ${b.id}`.toLowerCase().includes(q)) &&
      (status === 'all' ||
        (status === 'failing' && b.testPassed === false) ||
        (status === 'new' && isNew(b)) ||
        (status === 'limited' && b.availability !== undefined && b.availability !== 'all')),
  );
  const newest = blocks.find((b) => b.id === 'a2a');
  return (
    <>
      <div className="page-head-row">
        <PageHeader
          eyebrow={t('shell.groupPlatform')}
          title={t('buildingBlocks.title')}
          intro={t('buildingBlocks.intro')}
        />
        <Button variant="secondary" onClick={onRegister}>
          {t('buildingBlocks.registerTitle')}
        </Button>
      </div>
      <div className="callout">
        <span className="two-line">
          <span className="label-strong">{t('buildingBlocks.calloutTitle')}</span>
          <span>
            {t('buildingBlocks.calloutText')}
            {newest ? (
              <>
                {' '}
                {t.rich('buildingBlocks.latestAdded', {
                  name: newest.name,
                  strong: (c) => <strong>{c}</strong>,
                })}
              </>
            ) : null}
          </span>
        </span>
        {newest ? (
          <Button variant="secondary" data-size="sm" onClick={() => onOpen(newest.id)}>
            {t('buildingBlocks.seeA2a')}
          </Button>
        ) : null}
      </div>
      <Kpis
        items={[
          { label: t('buildingBlocks.kpiBlocks'), value: String(blocks.length) },
          { label: t('buildingBlocks.kpiTypes'), value: String(types.length) },
          {
            label: t('buildingBlocks.kpiFailing'),
            value: String(blocks.filter((b) => b.testPassed === false).length),
          },
          { label: t('buildingBlocks.kpiNew'), value: String(blocks.filter(isNew).length) },
        ]}
      />
      <div className="filters">
        <Textfield
          className="search-field"
          label={t('buildingBlocks.search')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="field">
          <Label htmlFor="block-type">{t('buildingBlocks.type')}</Label>
          <Select id="block-type" value={type} onChange={(e) => setType(e.target.value)}>
            <Select.Option value="all">{t('buildingBlocks.allTypes')}</Select.Option>
            {types.map((type) => (
              <Select.Option key={type.id} value={type.id}>
                {type.name} ({blocks.filter((b) => b.type === type.id).length})
              </Select.Option>
            ))}
          </Select>
        </div>
        <Fieldset>
          <FieldsetLegend>{t('buildingBlocks.show')}</FieldsetLegend>
          <div className="chips">
            {(
              [
                ['all', t('buildingBlocks.filterAll')],
                ['failing', t('buildingBlocks.filterFailing')],
                ['new', t('buildingBlocks.filterNew')],
                ['limited', t('buildingBlocks.filterLimited')],
              ] as const
            ).map(([value, label]) => (
              <Chip.Radio
                key={value}
                name="block-status"
                checked={status === value}
                onChange={() => setStatus(value)}
              >
                {label}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
      </div>
      {types
        .map((type) => ({ type, items: hits.filter((b) => b.type === type.id) }))
        .filter((g) => g.items.length)
        .map(({ type, items }) => (
          <section key={type.id} className="group-card" aria-labelledby={`type-${type.id}`}>
            <div className="group-head">
              <h2 id={`type-${type.id}`}>{type.name}</h2>
              <span className="meta">
                {t('buildingBlocks.groupLine', {
                  blocks: t('buildingBlocks.blockCount', { count: items.length }),
                  description: type.description,
                })}
              </span>
            </div>
            <ul className="plain">
              {items.map((b) => (
                <li key={b.id}>
                  <button type="button" className="row-button" onClick={() => onOpen(b.id)}>
                    <span className="two-line grow">
                      <span className="name-line">
                        <span className="label-strong">{b.name}</span>
                        {b.badge ? (
                          <Tag data-size="sm" data-color="info">
                            {b.badge}
                          </Tag>
                        ) : null}
                      </span>
                      <span className="meta">
                        {t('buildingBlocks.versionLine', { id: b.id, version: b.version })}
                      </span>
                    </span>
                    <span className="two-line">
                      <TestTag b={b} />
                      {b.testedAt ? (
                        <span className="meta">
                          {t('buildingBlocks.contractTestAt', { when: b.testedAt })}
                        </span>
                      ) : null}
                    </span>
                    {b.origin ? (
                      <span className="two-line">
                        <span className="sm">
                          {b.origin === 'external'
                            ? t('buildingBlocks.external')
                            : t('buildingBlocks.builtin')}
                        </span>
                        {b.dataLocation ? (
                          <Tag data-size="sm" data-color={locationTag(b.dataLocation, t)[1]}>
                            {locationTag(b.dataLocation, t)[0]}
                          </Tag>
                        ) : null}
                      </span>
                    ) : null}
                    <span className="sm">{usage(b, t)}</span>
                    {b.availability ? (
                      <Tag data-size="sm" data-color={availabilityLabel[b.availability][1]}>
                        {t(availabilityLabel[b.availability][0])}
                      </Tag>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {hits.length === 0 ? (
        <Paragraph>
          {t('buildingBlocks.noMatch')}{' '}
          <Button
            variant="tertiary"
            data-size="sm"
            onClick={() => {
              setQuery('');
              setType('all');
              setStatus('all');
            }}
          >
            {t('buildingBlocks.reset')}
          </Button>
        </Paragraph>
      ) : null}
    </>
  );
};

type PreviewKind = 'availability' | 'release' | 'disable';

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
  agencies,
  onBack,
  onChanged,
  live = false,
}: {
  api: ApiClient;
  live?: boolean;
  block: RegistryBlock;
  types: BlockType[];
  agencies: string[];
  onBack: () => void;
  onChanged: (message: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const tenantName = useTenantNames(api);
  const [draft, setDraft] = useState<Availability>(block.availability ?? 'all');
  const [chosen, setChosen] = useState<string[]>(block.agencies ?? []);
  const [preview, setPreview] = useState<PreviewKind | undefined>();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [tab, setTab] = useState('usage');
  const [testing, setTesting] = useState(false);
  const flash = useFlash();
  const type = types.find((candidate) => candidate.id === block.type);
  const affected = (list: RegistryBlock['services']) =>
    list.map((s) => `${s.service} · ${s.tenant}`);
  const losing = (block.agencies ?? []).filter(
    (a) => draft === 'none' || (draft === 'selected' && !chosen.includes(a)),
  );
  const same =
    draft === (block.availability ?? 'all') &&
    (draft !== 'selected' ||
      [...chosen].sort().join() === [...(block.agencies ?? [])].sort().join());

  useEffect(() => {
    setPreview(undefined);
  }, [draft, chosen]);

  const open = (kind: PreviewKind) => {
    setPreview(kind);
    setReason('');
    setReasonError(undefined);
    setFailed(undefined);
  };

  const pv = (() => {
    if (preview === 'availability') {
      const list = block.services.filter((s) => losing.includes(s.tenant));
      return {
        title: t('buildingBlocks.previewAvailabilityTitle'),
        text:
          draft === 'all'
            ? t('buildingBlocks.previewAllText')
            : losing.length
              ? t('buildingBlocks.previewLosingText', { count: losing.length })
              : t('buildingBlocks.previewNoneLosing'),
        affTitle: t('buildingBlocks.previewStopsWorking'),
        n: list.length,
        color: list.length ? ('danger' as const) : ('neutral' as const),
        items: affected(list),
        confirmLabel: t('buildingBlocks.saveAvailability'),
        run: async (why: string) => {
          const next = draft === 'all' ? agencies : draft === 'none' ? [] : chosen;
          await api.setBlockAvailability(block.id, draft, next, why);
          return availabilityNow(draft, block.name, tRef.current);
        },
      };
    }
    if (preview === 'release' && block.next) {
      const next = block.next;
      const list =
        block.id === 'mcp' ? block.services.filter((s) => s.detail === 'sse') : block.services;
      const blocked = next.testPassed
        ? undefined
        : t('buildingBlocks.releaseBlocked', { version: next.version });
      return {
        title: t('buildingBlocks.previewReleaseTitle', { version: next.version }),
        text: t('buildingBlocks.previewReleaseText', { description: next.description }),
        changes: next.breakingChanges,
        test: next,
        affTitle:
          block.id === 'mcp'
            ? t('buildingBlocks.releaseMustChange')
            : t('buildingBlocks.releaseRunsTests'),
        n: list.length,
        color: 'warning' as const,
        items: affected(list),
        blocked,
        confirmLabel: t('buildingBlocks.makeAvailable', { version: next.version }),
        run: async (why: string) => {
          await api.releaseBlockVersion(block.id, next.version, why);
          return tRef.current('buildingBlocks.released', {
            name: block.name,
            version: next.version,
            count: list.length,
          });
        },
      };
    }
    if (preview === 'disable')
      return {
        title: t('buildingBlocks.previewDisableTitle'),
        text: t('buildingBlocks.previewDisableText'),
        affTitle: t('buildingBlocks.servicesStop'),
        n: block.serviceCount,
        color: 'danger' as const,
        items: [
          ...affected(block.services),
          ...(block.serviceCount > block.services.length
            ? [t('buildingBlocks.andMore', { count: block.serviceCount - block.services.length })]
            : []),
        ],
        confirmLabel: t('buildingBlocks.disable'),
        run: async (why: string) => {
          await api.disableBlock(block.id, why);
          return tRef.current('buildingBlocks.disabled', { name: block.name });
        },
      };
    return undefined;
  })();

  const confirm = async () => {
    if (!pv || ('blocked' in pv && pv.blocked)) return;
    const tooShort = reasonProblem(t, reason);
    if (tooShort) {
      setReasonError(tooShort);
      return;
    }
    try {
      const message = await pv.run(reason.trim());
      setPreview(undefined);
      onChanged(tRef.current('buildingBlocks.loggedInAudit', { message }));
    } catch {
      setFailed(tRef.current('common.saveFailed'));
    }
  };

  const rerun = async () => {
    setTesting(true);
    try {
      const run = await api.rerunContractTests(
        block.id,
        tRef.current('buildingBlocks.rerunReason', { name: block.name }),
      );
      if (!live) {
        flash.show(tRef.current('buildingBlocks.rerunDone', { name: block.name }));
        return;
      }
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
  const blocked = pv && 'blocked' in pv ? pv.blocked : undefined;

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
      {live ? null : (
        <section className="card stack" aria-labelledby="hand-h">
          <Heading level={2} data-size="xs" id="hand-h">
            {t('buildingBlocks.manageTitle')}
          </Heading>
          <Fieldset>
            <FieldsetLegend>{t('buildingBlocks.availableFor')}</FieldsetLegend>
            {(
              [
                ['all', t('buildingBlocks.availabilityAll')],
                ['selected', t('buildingBlocks.availabilitySelected')],
                ['none', t('buildingBlocks.availabilityOptionNone')],
              ] as const
            ).map(([value, label]) => (
              <Radio
                key={value}
                name="avail"
                label={label}
                value={value}
                checked={draft === value}
                onChange={() => setDraft(value)}
              />
            ))}
          </Fieldset>
          {draft === 'selected' ? (
            <Fieldset data-size="sm">
              <FieldsetLegend>{t('buildingBlocks.organisations')}</FieldsetLegend>
              <div className="chips">
                {agencies.map((a) => (
                  <Chip.Checkbox
                    key={a}
                    data-size="sm"
                    checked={chosen.includes(a)}
                    onChange={() =>
                      setChosen((c) => (c.includes(a) ? c.filter((x) => x !== a) : [...c, a]))
                    }
                  >
                    {a}
                  </Chip.Checkbox>
                ))}
              </div>
            </Fieldset>
          ) : null}
          <div className="actions-row">
            <Button
              variant="secondary"
              data-size="sm"
              aria-disabled={same || undefined}
              onClick={() => {
                if (!same) open('availability');
              }}
            >
              {t('buildingBlocks.previewChange')}
            </Button>
            {block.next ? (
              <Button variant="secondary" data-size="sm" onClick={() => open('release')}>
                {t('buildingBlocks.makeAvailable', { version: block.next.version })}
              </Button>
            ) : null}
            <Button
              variant="tertiary"
              data-size="sm"
              data-color="danger"
              onClick={() => open('disable')}
            >
              {t('buildingBlocks.disable')}
            </Button>
          </div>
          {pv ? (
            <div className="preview" aria-labelledby="pv-block-h">
              <h3 id="pv-block-h">{t('buildingBlocks.previewTitle', { title: pv.title })}</h3>
              <Paragraph>{pv.text}</Paragraph>
              {'changes' in pv && pv.changes?.length ? (
                <div>
                  <span className="label-strong">{t('buildingBlocks.breaking')}</span>
                  <ul>
                    {pv.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {'test' in pv && pv.test ? (
                <span className="name-line">
                  <Tag data-size="sm" data-color={pv.test.testPassed ? 'success' : 'danger'}>
                    {pv.test.testPassed ? t('buildingBlocks.passed') : t('buildingBlocks.failed')}
                  </Tag>
                  {t('buildingBlocks.testsFor', {
                    version: pv.test.version,
                    when: pv.test.testedAt ?? '',
                  })}
                </span>
              ) : null}
              <div>
                <span className="name-line">
                  <Tag data-size="sm" data-color={pv.color}>
                    {String(pv.n)}
                  </Tag>{' '}
                  {pv.affTitle}
                </span>
                {pv.items.length === 0 ? (
                  <Paragraph data-size="sm">{t('buildingBlocks.noneAffected')}</Paragraph>
                ) : (
                  <ul>
                    {pv.items.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                )}
              </div>
              {blocked ? (
                <Alert data-color="danger" data-size="sm">
                  {blocked}
                </Alert>
              ) : null}
              {failed ? (
                <Alert data-color="danger" data-size="sm" role="alert">
                  {failed}
                </Alert>
              ) : null}
              <div className="field">
                <Label htmlFor="block-reason">{t('common.reason')}</Label>
                <Textarea
                  id="block-reason"
                  rows={2}
                  value={reason}
                  aria-invalid={reasonError ? true : undefined}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setReasonError(undefined);
                  }}
                />
                {reasonError ? <ValidationMessage>{reasonError}</ValidationMessage> : null}
              </div>
              <div className="actions-row">
                <Button aria-disabled={blocked ? true : undefined} onClick={() => void confirm()}>
                  {pv.confirmLabel}
                </Button>
                <Button variant="secondary" onClick={() => setPreview(undefined)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      )}
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
                {live
                  ? block.verifiable
                    ? t('buildingBlocks.runsOnStart')
                    : t('buildingBlocks.runsInBuild')
                  : t('buildingBlocks.runsNightly')}
              </span>
              {live && !block.verifiable ? null : (
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-disabled={testing || undefined}
                  onClick={() => void (testing ? undefined : rerun())}
                >
                  {t('buildingBlocks.rerun')}
                </Button>
              )}
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
  live = false,
}: {
  api: ApiClient;
  initial?: string | undefined;
  live?: boolean;
}) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.buildingBlocks(signal), [api]);
  const [selected, setSelected] = useState<string | undefined>(initial);
  const [registering, setRegistering] = useState(false);
  const flash = useFlash();
  if (state.status === 'loading') return <Loading label={t('buildingBlocks.loading')} />;
  if (state.status === 'error')
    return (
      <>
        <PageHeader title={t('buildingBlocks.title')} />
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const { types, blocks, agencies } = normalizeBlocks(state.data, t, f);
  if (blocks.length === 0)
    return (
      <>
        <PageHeader title={t('buildingBlocks.title')} />
        <EmptyState title={t('buildingBlocks.empty')} />
      </>
    );
  const block = blocks.find((b) => b.id === selected);
  return (
    <>
      <Flash message={flash.message} />
      {block ? (
        <Detail
          key={block.id}
          api={api}
          live={live}
          block={block}
          types={types}
          agencies={agencies}
          onBack={() => setSelected(undefined)}
          onChanged={(message) => {
            flash.show(message);
            retry();
          }}
        />
      ) : (
        <List
          types={types}
          blocks={blocks}
          onOpen={(id) => {
            flash.clear();
            setSelected(id);
          }}
          onRegister={() => {
            flash.clear();
            setRegistering(true);
          }}
        />
      )}
      <RegisterDialog
        api={api}
        open={registering}
        onClose={() => setRegistering(false)}
        onRegistered={(message) => {
          setRegistering(false);
          flash.show(message);
          retry();
        }}
      />
    </>
  );
};
