import {
  Alert,
  Button,
  Chip,
  Dialog,
  Heading,
  Link,
  Paragraph,
  Search,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import { intlLocale, type Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import { ApiError } from '../../api/error';
import { reasonProblem, ReasonField } from '../../components/ReasonField';
import type { CatalogItem } from '../../api/building-blocks';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import { EmptyState, ErrorState, Loading } from '../../states';
import { isStepType, stepFlowHref } from '../buildingblocks/block-types';
import '../stepflows.css';

type From = 'all' | 'own' | 'digdir' | 'shared';

const currentVersion = (flow: CatalogItem) => flow.latestVersion ?? flow.version;

const currentVersionAt = (flow: CatalogItem) =>
  flow.latestVersion ? flow.update?.availableFrom : flow.versionAt;

const dayMonth = (f: Format, iso: string) =>
  new Intl.DateTimeFormat(intlLocale(f.locale), {
    timeZone: 'Europe/Oslo',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));

export const stepCount = (t: ReturnType<typeof useT>, count: number) => {
  const words = t('stepFlowHome.numberWords').split(',');
  return count > 1 && count <= words.length
    ? t('stepFlowHome.stepsWords', { words: words[count - 1] ?? String(count) })
    : t('stepFlowHome.steps', { count });
};

const ArchiveFlow = ({
  api,
  tenant,
  flow,
  onClose,
  onArchived,
}: {
  api: ApiClient;
  tenant: string;
  flow: CatalogItem;
  onClose: () => void;
  onArchived: () => void;
}) => {
  const t = useT();
  const headingId = useId();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const confirm = async () => {
    setTried(true);
    if (busy || reasonProblem(reason, t)) return;
    setBusy(true);
    setFailure('');
    try {
      await api.buildingBlocks.archiveFlow(tenant, flow.id, reason.trim());
      onArchived();
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.status === 409
          ? t('stepFlowHome.archiveInUse')
          : t('stepFlowHome.archiveFailed'),
      );
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      modal
      onClose={onClose}
      aria-labelledby={headingId}
      closeButton={t('common.close')}
    >
      <div className="stack-sm">
        <Heading level={2} data-size="xs" id={headingId}>
          {t('stepFlowHome.archiveTitle', { name: flow.name })}
        </Heading>
        <Paragraph>{t('stepFlowHome.archiveText')}</Paragraph>
        <ReasonField value={reason} onChange={setReason} showError={tried} rows={1} />
        <div aria-live="polite">
          {failure ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              {failure}
            </Alert>
          ) : null}
        </div>
        <div className="actions">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-color="danger"
            aria-disabled={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy ? t('stepFlowHome.archiving') : t('stepFlowHome.archive')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

const FlowRow = ({
  flow,
  onArchive,
}: {
  flow: CatalogItem;
  onArchive: ((flow: CatalogItem) => void) | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const current = currentVersion(flow);
  const at = currentVersionAt(flow);
  const steps = flow.capabilities.length;
  const from =
    flow.publisher.type === 'own'
      ? flow.publisher.name
      : t('stepFlowHome.fromPublisher', { publisher: flow.publisher.name });
  return (
    <Table.Row>
      <Table.HeaderCell scope="row">
        <span className="sf-cell-stack">
          <Link href={stepFlowHref(flow.id)}>{flow.name}</Link>
          <span className="meta">{steps ? `${from} · ${stepCount(t, steps)}` : from}</span>
        </span>
      </Table.HeaderCell>
      <Table.Cell>
        {at
          ? t('stepFlowHome.versionDate', { version: current, date: dayMonth(f, at) })
          : t('stepFlowHome.version', { version: current })}
      </Table.Cell>
      <Table.Cell>
        {flow.usedBy.length ? (
          <ul className="sf-users">
            {flow.usedBy.map((user) => (
              <li key={user.id}>
                <Link href={`#/services/${encodeURIComponent(user.id)}`}>{user.name}</Link>
                {user.version === undefined ? null : String(user.version) === current ? (
                  <Tag data-size="sm" data-color="success">
                    {t('stepFlowHome.version', { version: user.version })}
                  </Tag>
                ) : (
                  <Tag data-size="sm" data-color="warning">
                    {t('stepFlowHome.olderVersion', { version: user.version })}
                  </Tag>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="sf-cell-stack">
            <span className="sf-none">{t('stepFlowHome.noServices')}</span>
            {onArchive && flow.publisher.type === 'own' ? (
              <Button
                variant="tertiary"
                data-size="sm"
                className="align-start"
                aria-label={t('stepFlowHome.archiveLabel', { name: flow.name })}
                onClick={() => onArchive(flow)}
              >
                {t('stepFlowHome.archive')}
              </Button>
            ) : null}
          </span>
        )}
      </Table.Cell>
    </Table.Row>
  );
};

const columns = (t: ReturnType<typeof useT>) => [
  t('stepFlowHome.colFlow'),
  t('stepFlowHome.colVersion'),
  t('stepFlowHome.colUsedBy'),
];

export const StepFlowsHome = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const ids = { heading: useId(), search: useId(), where: useId() };
  const canCreate = useRights().has('manage-services');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState<From>('all');
  const [archiving, setArchiving] = useState<CatalogItem | undefined>();
  const [archivedName, setArchivedName] = useState('');
  const [state, retry, pending] = useAsync(
    async (signal) =>
      (await api.buildingBlocks.list(tenant, { kind: 'step_flow' }, signal)).data.filter(
        (b) => b.kind === 'step_flow' && !isStepType(b),
      ),
    [api, tenant],
    { keepPreviousFor: tenant },
  );
  const head = (
    <div className="sf-home-head">
      <div className="stack-xs">
        <Heading level={2} data-size="md" id={ids.heading}>
          {t('stepFlowHome.title')}
        </Heading>
        <Paragraph className="sf-home-lead">{t('stepFlowHome.lead')}</Paragraph>
      </div>
      {canCreate ? (
        <Button asChild>
          <a href="#/developer/step-flows/new">{t('stepFlowHome.newFlow')}</a>
        </Button>
      ) : null}
    </div>
  );
  if (state.status === 'loading')
    return (
      <div className="stack">
        {head}
        <Loading
          label={t('stepFlowHome.loading')}
          shape="table"
          columns={columns(t)}
          onRetry={retry}
        />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="stack">
        {head}
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  const flows = state.data;
  const fromOf = (flow: CatalogItem): From => flow.publisher.type;
  const q = query.trim().toLowerCase();
  const matching = flows.filter((flow) =>
    `${flow.name} ${flow.description}`.toLowerCase().includes(q),
  );
  const shown = matching.filter((flow) => from === 'all' || fromOf(flow) === from);
  const choices: { key: From; label: string }[] = [
    { key: 'all', label: t('stepFlowHome.all', { count: flows.length }) },
    {
      key: 'own',
      label: t('stepFlowHome.own', { count: flows.filter((x) => fromOf(x) === 'own').length }),
    },
    {
      key: 'digdir',
      label: t('stepFlowHome.digdir', {
        count: flows.filter((x) => fromOf(x) === 'digdir').length,
      }),
    },
    ...(flows.some((x) => fromOf(x) === 'shared')
      ? [
          {
            key: 'shared' as const,
            label: t('stepFlowHome.shared', {
              count: flows.filter((x) => fromOf(x) === 'shared').length,
            }),
          },
        ]
      : []),
  ];
  return (
    <div className="stack">
      {head}
      <div aria-live="polite">
        {archivedName ? (
          <Alert data-color="success" data-size="sm">
            {t('stepFlowHome.archived', { name: archivedName })}
          </Alert>
        ) : null}
      </div>
      {archiving ? (
        <ArchiveFlow
          api={api}
          tenant={tenant}
          flow={archiving}
          onClose={() => setArchiving(undefined)}
          onArchived={() => {
            setArchivedName(archiving.name);
            setArchiving(undefined);
            retry();
          }}
        />
      ) : null}
      {flows.length === 0 ? (
        <EmptyState title={t('stepFlowHome.emptyTitle')}>
          <Paragraph>{t('stepFlowHome.emptyBody')}</Paragraph>
        </EmptyState>
      ) : (
        <>
          <div className="sf-home-tools">
            <div role="search" className="sf-home-search">
              <label htmlFor={ids.search} className="visually-hidden">
                {t('stepFlowHome.search')}
              </label>
              <Search>
                <Search.Input
                  id={ids.search}
                  placeholder={t('stepFlowHome.searchPlaceholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Search.Clear onClick={() => setQuery('')} />
              </Search>
            </div>
            <div role="group" aria-label={t('stepFlowHome.fromLabel')} className="tag-row sf-chips">
              {choices.map((choice) => (
                <Chip.Button
                  key={choice.key}
                  aria-pressed={from === choice.key}
                  onClick={() => setFrom(choice.key)}
                >
                  {choice.label}
                </Chip.Button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <div className="stack-sm">
              <Paragraph>{t('stepFlowHome.noMatch')}</Paragraph>
              <Button
                variant="secondary"
                data-size="sm"
                className="sf-start"
                onClick={() => {
                  setQuery('');
                  setFrom('all');
                }}
              >
                {t('stepFlowHome.reset')}
              </Button>
            </div>
          ) : (
            <div className="sf-table-box">
              <Table aria-labelledby={ids.heading} aria-busy={pending || undefined}>
                <Table.Head>
                  <Table.Row>
                    {columns(t).map((column) => (
                      <Table.HeaderCell key={column} scope="col">
                        {column}
                      </Table.HeaderCell>
                    ))}
                  </Table.Row>
                </Table.Head>
                <Table.Body>
                  {shown.map((flow) => (
                    <FlowRow
                      key={flow.id}
                      flow={flow}
                      onArchive={canCreate ? setArchiving : undefined}
                    />
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
        </>
      )}
      <section aria-labelledby={ids.where} className="sf-elsewhere stack-xs">
        <Heading level={3} data-size="2xs" id={ids.where}>
          {t('stepFlowHome.elsewhereHeading')}
        </Heading>
        <ul>
          <li>{t('stepFlowHome.elsewhereBlocks')}</li>
          <li>{t('stepFlowHome.elsewhereService')}</li>
          <li>{t('stepFlowHome.elsewhereStepTypes')}</li>
        </ul>
      </section>
    </div>
  );
};
