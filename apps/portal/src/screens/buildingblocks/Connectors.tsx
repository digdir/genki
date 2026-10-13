import {
  Alert,
  Button,
  Heading,
  Link,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type {
  ConnectionInput,
  ConnectorCondition,
  ConnectorSource,
  ConnectorStatus,
  ConnectorView,
  HostReach,
  PrivateNetworks,
} from '../../api/building-blocks';
import { useFormat } from '@genai/i18n/react';
import { useT, type Format, type PlainKey, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { ApiCallButton } from './common';

export type TlsMode = 'verify' | 'off';

export interface ConnectionForm {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  tls: TlsMode;
}

export const blankConnection = (source?: ConnectorSource): ConnectionForm => ({
  host: source?.host ?? '',
  port: '5432',
  database: source?.database ?? '',
  user: '',
  password: '',
  tls: 'verify',
});

type ConnectionKey = 'host' | 'port' | 'database' | 'user' | 'password';

export const connectionProblems = (
  f: ConnectionForm,
  t: T,
): Partial<Record<ConnectionKey, string>> => ({
  ...(f.host.trim() ? {} : { host: t('connectors.hostProblem') }),
  ...(/^\d{1,5}$/.test(f.port.trim()) ? {} : { port: t('connectors.portProblem') }),
  ...(f.database.trim() ? {} : { database: t('connectors.databaseProblem') }),
  ...(f.user.trim() ? {} : { user: t('connectors.userProblem') }),
  ...(f.password ? {} : { password: t('connectors.passwordProblem') }),
});

export const connectionInput = (f: ConnectionForm): ConnectionInput => ({
  host: f.host.trim(),
  port: Number(f.port.trim()),
  database: f.database.trim(),
  user: f.user.trim(),
  password: f.password,
  tls: f.tls === 'verify',
});

const operatorKey: Record<ConnectorCondition['op'], PlainKey> = {
  eq: 'connectors.opEq',
  neq: 'connectors.opNeq',
  in: 'connectors.opIn',
  not_in: 'connectors.opNotIn',
  gt: 'connectors.opGt',
  gte: 'connectors.opGte',
  lt: 'connectors.opLt',
  lte: 'connectors.opLte',
  is_null: 'connectors.opIsNull',
  not_null: 'connectors.opNotNull',
};

const valueText = (c: ConnectorCondition) =>
  c.value === undefined ? '' : Array.isArray(c.value) ? c.value.join(', ') : String(c.value);

export const ReadsSummary = ({ source, dataset }: { source: ConnectorSource; dataset: string }) => {
  const t = useT();
  const code = (c: ReactNode) => <code>{c}</code>;
  return (
    <div className="bb-reads">
      <span className="bb-reads-title">{t('connectors.readsTitle')}</span>
      <Paragraph>
        {t.rich('connectors.readsHead', {
          table: source.table,
          title: source.fields.title,
          code,
        })}{' '}
        {source.fields.text.map((field, i) => (
          <Fragment key={field}>
            {i > 0 ? ', ' : null}
            <code>{field}</code>
          </Fragment>
        ))}
        {source.filter?.length ? (
          <>
            {t('connectors.readsWhere')}{' '}
            {source.filter.map((c, i) => (
              <Fragment key={`${c.column}-${i}`}>
                {i > 0 ? ` ${t('connectors.readsAnd')} ` : null}
                <code>{c.column}</code> {t(operatorKey[c.op])}
                {c.value === undefined ? null : ` ${valueText(c)}`}
              </Fragment>
            ))}
          </>
        ) : null}
        {t('connectors.readsEnd', { dataset })}
      </Paragraph>
    </div>
  );
};

export const readOnlyRules = (t: T) => [
  t('connectors.ruleReadOnly'),
  t('connectors.ruleLimits'),
  t('connectors.ruleSync'),
];

export const reachText = (reach: Pick<HostReach, 'network' | 'allowed'>, t: T) =>
  reach.network === 'blocked'
    ? t('connectors.reachBlocked')
    : reach.network === 'private'
      ? reach.allowed
        ? t('connectors.reachPrivateOpen')
        : t('connectors.reachPrivateClosed')
      : undefined;

export const unencryptedWarning = (t: T) => t('connectors.unencrypted');

export const NetworkAlert = ({
  reach,
  tenantName,
}: {
  reach: Pick<HostReach, 'host' | 'network' | 'allowed' | 'message'>;
  tenantName: string;
}) => {
  const t = useT();
  if (reach.network === 'blocked')
    return (
      <Alert data-color="danger">
        <Heading level={3} data-size="2xs">
          {t('connectors.blockedTitle')}
        </Heading>
        <Paragraph>{reach.message ?? t('connectors.blockedText', { host: reach.host })}</Paragraph>
      </Alert>
    );
  if (reach.network !== 'private') return null;
  return reach.allowed ? (
    <Alert data-color="info">
      <Heading level={3} data-size="2xs">
        {t('connectors.privateOpenTitle')}
      </Heading>
      <Paragraph>{t('connectors.privateOpenText', { host: reach.host, tenantName })}</Paragraph>
    </Alert>
  ) : (
    <Alert data-color="warning">
      <Heading level={3} data-size="2xs">
        {t('connectors.privateClosedTitle')}
      </Heading>
      <Paragraph>{t('connectors.privateClosedText', { host: reach.host, tenantName })}</Paragraph>
      <Paragraph>{t('connectors.privateClosedHelp')}</Paragraph>
    </Alert>
  );
};

const statusTag: Record<ConnectorStatus, { key: PlainKey; color: string }> = {
  connected: { key: 'connectors.statusConnected', color: 'success' },
  syncing: { key: 'connectors.statusSyncing', color: 'info' },
  failed: { key: 'connectors.statusFailed', color: 'danger' },
  not_synced: { key: 'connectors.statusNotSynced', color: 'neutral' },
  not_connected: { key: 'connectors.statusNotConnected', color: 'warning' },
};

const lastText = (connector: ConnectorView, t: T, f: Format) => {
  const last = connector.lastSync;
  if (!last) return t('connectors.lastNever');
  if (last.status === 'running') return t('connectors.lastRunning');
  const at = f.dateTime(last.endedAt ?? last.startedAt);
  return last.status === 'failed' ? t('connectors.lastFailed', { at }) : at;
};

const rowsText = (connector: ConnectorView, t: T, f: Format) => {
  const last = connector.lastSync;
  if (last?.status !== 'succeeded') return '–';
  const rows = f.number(last.rows ?? 0);
  return last.skipped
    ? t('connectors.rowsSkipped', { rows, skipped: f.number(last.skipped) })
    : rows;
};

const PasswordChange = ({
  api,
  tenant,
  connector,
  onDone,
  onCancel,
}: {
  api: ApiClient;
  tenant: string;
  connector: ConnectorView;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async () => {
    setTried(true);
    if (!password || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.buildingBlocks.changeConnectorPassword(
        tenant,
        connector.id,
        password,
        tRef.current('connectors.passwordChangeReason', { name: connector.name }),
      );
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      <Textfield
        label={t('connectors.newPassword')}
        type="password"
        autoComplete="new-password"
        description={t('connectors.passwordHelp')}
        value={password}
        error={tried && !password ? t('connectors.newPasswordProblem') : undefined}
        onChange={(e) => setPassword(e.target.value)}
      />
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          <Paragraph data-size="sm">{t('connectors.passwordNotSaved')}</Paragraph>
        </Alert>
      ) : null}
      <div className="actions">
        <Button
          variant="primary"
          data-size="sm"
          onClick={() => void save()}
          aria-disabled={busy || undefined}
        >
          {t('connectors.savePassword')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={onCancel}>
          {t('connectors.cancel')}
        </Button>
      </div>
    </div>
  );
};

const ConnectorCard = ({
  api,
  tenant,
  connector,
  onSynced,
}: {
  api: ApiClient;
  tenant: string;
  connector: ConnectorView;
  onSynced: (view: ConnectorView) => void;
}) => {
  const headingId = useId();
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const { has } = useRights();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  const tag = statusTag[connector.status];
  const last = connector.lastSync;
  const conn = connector.connection;
  const source = connector.source;
  const networkAllowed = conn?.networkAllowed ?? true;
  const network = conn?.network
    ? reachText({ network: conn.network, allowed: networkAllowed }, t)
    : undefined;
  const canChange = has('manage-datasets') && connector.status !== 'not_connected';
  const syncing = connector.status === 'syncing';
  const sync = async () => {
    if (busy || syncing) return;
    setBusy(true);
    setFailed(false);
    setChanged(false);
    try {
      onSynced(
        await api.buildingBlocks.syncConnector(
          tenant,
          connector.id,
          tRef.current('connectors.syncReason', { name: connector.name }),
        ),
      );
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const rows: [string, ReactNode][] = [
    ...(source
      ? ([
          [
            t('connectors.rowTable'),
            conn
              ? t('connectors.tableIn', { table: source.table, database: conn.database })
              : `${source.schema ?? 'public'}.${source.table}`,
          ],
        ] as [string, ReactNode][])
      : []),
    ...(conn
      ? ([
          [
            t('connectors.rowDatabase'),
            t('connectors.databaseDetail', {
              host: conn.host,
              port: String(conn.port),
              user: conn.user,
            }),
          ],
        ] as [string, ReactNode][])
      : []),
    [t('connectors.rowLastSync'), lastText(connector, t, f)],
    [t('connectors.rowRows'), rowsText(connector, t, f)],
    ...(connector.dataset
      ? ([
          [
            t('connectors.rowFills'),
            <a href={`#/datasets/${encodeURIComponent(connector.dataset)}`}>{connector.name}</a>,
          ],
        ] as [string, ReactNode][])
      : []),
  ];
  return (
    <article aria-labelledby={headingId} className="bb-connector">
      <div className="bb-connector-head">
        <Heading level={3} data-size="2xs" id={headingId}>
          {connector.name}
        </Heading>
        <Tag data-color={tag.color as 'success'} data-size="sm">
          {t(tag.key)}
        </Tag>
      </div>
      {conn && (!conn.tls || network) ? (
        <div className="tag-row">
          {!conn.tls ? (
            <Tag data-color="warning" data-size="sm">
              {t('connectors.tagUnencrypted')}
            </Tag>
          ) : null}
          {network ? (
            <Tag data-color={networkAllowed ? 'neutral' : 'danger'} data-size="sm">
              {network}
            </Tag>
          ) : null}
        </div>
      ) : null}
      <dl className="bb-connector-dl">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {conn && !conn.tls ? (
        <Paragraph data-size="sm">
          {t('connectors.tlsOffNote', { warning: unencryptedWarning(t) })}
        </Paragraph>
      ) : null}
      {conn?.network === 'private' && !networkAllowed ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{t('connectors.networkClosedNow')}</Paragraph>
        </Alert>
      ) : null}
      <div aria-live="polite">
        {syncing && last ? (
          <Paragraph data-size="sm">
            {t('connectors.syncingSince', { at: f.dateTime(last.startedAt) })}
          </Paragraph>
        ) : connector.status === 'not_connected' ? (
          <Paragraph data-size="sm">{t('connectors.notConnectedNote')}</Paragraph>
        ) : null}
        {changed ? <Paragraph data-size="sm">{t('connectors.passwordChanged')}</Paragraph> : null}
      </div>
      {last?.status === 'failed' ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{last.error ?? t('connectors.syncFailed')}</Paragraph>
        </Alert>
      ) : null}
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          <Paragraph data-size="sm">{t('connectors.syncNotStarted')}</Paragraph>
        </Alert>
      ) : null}
      {changing ? (
        <PasswordChange
          api={api}
          tenant={tenant}
          connector={connector}
          onCancel={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            setChanged(true);
          }}
        />
      ) : (
        <div className="actions">
          {canChange && !syncing ? (
            <>
              <Button
                variant={connector.status === 'failed' ? 'primary' : 'secondary'}
                data-size="sm"
                onClick={() => void sync()}
                aria-disabled={busy || undefined}
              >
                {connector.status === 'failed' ? t('connectors.retry') : t('connectors.syncNow')}
              </Button>
              <Button
                variant="secondary"
                data-size="sm"
                onClick={() => {
                  setChanged(false);
                  setChanging(true);
                }}
              >
                {t('connectors.changePassword')}
              </Button>
            </>
          ) : null}
          <ApiCallButton
            call={() => ({
              action: t('connectors.syncNow'),
              method: 'POST' as const,
              path: api.buildingBlocks.connectorsPath(
                tenant,
                `/${encodeURIComponent(connector.id)}/sync`,
              ),
              body: {},
              right: t('connectors.rightManageDatasets'),
            })}
          />
        </div>
      )}
    </article>
  );
};

export const connectorPollMs = 1500;

export const ConnectorList = ({
  api,
  tenant,
  connectors,
}: {
  api: ApiClient;
  tenant: string;
  connectors: ConnectorView[];
}) => {
  const headingId = useId();
  const t = useT();
  const [live, setLive] = useState(connectors);
  const [networks, setNetworks] = useState<PrivateNetworks>();
  const syncing = live.some((c) => c.status === 'syncing');

  useEffect(() => setLive(connectors), [connectors]);

  useEffect(() => {
    const controller = new AbortController();
    api.buildingBlocks.privateNetworks(tenant, controller.signal).then(
      (next) => !controller.signal.aborted && setNetworks(next),
      () => undefined,
    );
    return () => controller.abort();
  }, [api, tenant]);

  useEffect(() => {
    if (!syncing) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.buildingBlocks.connectors(tenant, controller.signal).then(
        (next) => !controller.signal.aborted && setLive(next),
        () => undefined,
      );
    }, connectorPollMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, tenant, syncing, live]);

  return (
    <section aria-labelledby={headingId} className="stack-sm">
      <Heading level={2} data-size="sm" id={headingId}>
        {t('connectors.listHeading')}
      </Heading>
      <Paragraph data-size="sm">
        {networks?.entries.length
          ? t('connectors.networksOpen', { networks: networks.entries.join(', ') })
          : t('connectors.networksNone')}
      </Paragraph>
      {live.length === 0 ? (
        <Paragraph>{t('connectors.listEmpty')}</Paragraph>
      ) : (
        <div className="bb-connector-grid">
          {live.map((c) => (
            <ConnectorCard
              key={c.id}
              api={api}
              tenant={tenant}
              connector={c}
              onSynced={(view) => setLive((all) => all.map((x) => (x.id === view.id ? view : x)))}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export const ConnectorsSummary = ({
  pending,
  connectors,
}: {
  pending: number;
  connectors: ConnectorView[];
}) => {
  const headingId = useId();
  const t = useT();
  if (pending === 0 && connectors.length === 0) return null;
  const failed = connectors.filter((c) => c.status === 'failed').length;
  const parts = [
    ...(pending ? [t('connectors.summaryPending', { count: pending })] : []),
    ...(connectors.length
      ? [
          failed
            ? t('connectors.summaryActiveFailed', { count: connectors.length, failed })
            : t('connectors.summaryActive', { count: connectors.length }),
        ]
      : []),
  ];
  return (
    <section aria-labelledby={headingId} className={pending ? 'bb-proposal' : 'bb-connector'}>
      <Heading level={2} data-size="xs" id={headingId}>
        {t('connectors.summaryHeading')}
      </Heading>
      <Paragraph data-size="sm">{parts.join(' ')}</Paragraph>
      <Link href="#/building-blocks/connectors">
        {pending ? t('connectors.summaryLinkPending') : t('connectors.summaryLink')}
      </Link>
    </section>
  );
};
