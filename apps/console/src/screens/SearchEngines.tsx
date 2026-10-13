import { Button, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useRef, useState, type ComponentProps } from 'react';
import type { ApiClient } from '../api';
import { useT, type PlainKey, type T } from '../i18n';
import { splitRoute, useAsync, useHashRoute } from '../hooks';
import { ErrorState, Loading } from '../states';
import type { EndpointStatus, KnowledgeEndpoint, KnowledgeEngine } from '../types';
import { useTenantNames } from '../tenant-names';
import {
  DialogError,
  Flash,
  inUseOf,
  InUseList,
  PageHeader,
  ReasonDialog,
  TableRegion,
  useFlash,
  VisuallyHidden,
  type InUse,
} from '../ui';
import { ApiCallPanel, type ApiCall } from './search-engines/ApiCallPanel';
import { capabilitySummary, dataLocationText } from './search-engines/capabilities';
import { CodeIcon, EndpointEditor } from './search-engines/EndpointEditor';
import './search-engines/search-engines.css';

const statusLabels: Record<EndpointStatus, [PlainKey, 'success' | 'danger' | 'neutral']> = {
  ok: ['searchEngines.statusOk', 'success'],
  unused: ['searchEngines.statusUnused', 'neutral'],
  skipped: ['searchEngines.statusSkipped', 'danger'],
};

const runsAtText = (endpoint: KnowledgeEndpoint, engine: KnowledgeEngine | undefined, t: T) =>
  endpoint.runsAt === 'platform'
    ? t('searchEngines.runsAtPlatform')
    : endpoint.runsAt === 'unknown'
      ? (engine?.tech ?? '')
      : endpoint.runsAt;

const EndpointTable = ({
  endpoints,
  engines,
  onOpen,
  onRemove,
}: {
  endpoints: KnowledgeEndpoint[];
  engines: KnowledgeEngine[];
  onOpen: (id: string) => void;
  onRemove: (endpoint: KnowledgeEndpoint) => void;
}) => {
  const t = useT();
  return (
    <TableRegion label={t('searchEngines.tableLabel')}>
      <table className="ds-table endpoint-table">
        <thead>
          <tr>
            <th scope="col">{t('searchEngines.columnEndpoint')}</th>
            <th scope="col">{t('searchEngines.columnEngine')}</th>
            <th scope="col">{t('searchEngines.columnRuns')}</th>
            <th scope="col">{t('searchEngines.columnCapabilities')}</th>
            <th scope="col">{t('searchEngines.columnDatasets')}</th>
            <th scope="col">{t('searchEngines.columnStatus')}</th>
            <th scope="col">
              <VisuallyHidden>{t('searchEngines.columnActions')}</VisuallyHidden>
            </th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((p) => {
            const e = engines.find((x) => x.engine === p.engine);
            const [label, color] = statusLabels[p.status] ?? statusLabels.unused;
            const location = p.dataLocation ?? e?.dataLocation;
            return (
              <tr key={p.id}>
                <th scope="row" className="endpoint-cell-name">
                  <a
                    className="ds-link"
                    href={`#/search-engines?endpoint=${encodeURIComponent(p.id)}`}
                    onClick={(ev) => {
                      ev.preventDefault();
                      onOpen(p.id);
                    }}
                  >
                    {p.name}
                  </a>
                </th>
                <td>{e?.title ?? p.title}</td>
                <td>
                  <span className="two-line">
                    {runsAtText(p, e, t)}
                    {location ? (
                      <span className="meta">{dataLocationText(location, t)}</span>
                    ) : null}
                  </span>
                </td>
                <td>{e ? capabilitySummary(e, t) : ''}</td>
                <td>{t('searchEngines.datasetCount', { count: p.datasetCount })}</td>
                <td>
                  <Tag data-size="sm" data-color={color}>
                    {t(label)}
                  </Tag>
                </td>
                <td>
                  {p.builtin ? null : (
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-label={t('searchEngines.removeNamed', { name: p.name })}
                      onClick={() => onRemove(p)}
                    >
                      {t('searchEngines.remove')}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableRegion>
  );
};

const StoredEndpoint = (
  props: Omit<ComponentProps<typeof EndpointEditor>, 'spec'> & { endpoint: KnowledgeEndpoint },
) => {
  const { api, endpoint } = props;
  const t = useT();
  const [state, retry] = useAsync(
    (signal) => api.knowledgeEndpoint(endpoint.id, signal),
    [api, endpoint.id],
  );
  if (state.status === 'loading') return <Loading label={t('searchEngines.loadingEndpoint')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return <EndpointEditor {...props} spec={state.data.spec} />;
};

const Loaded = ({
  api,
  engines,
  secrets,
  initialEndpoints,
  initialOpen,
}: {
  api: ApiClient;
  engines: KnowledgeEngine[];
  secrets: Awaited<ReturnType<ApiClient['knowledgeSecrets']>>;
  initialEndpoints: KnowledgeEndpoint[];
  initialOpen: string | undefined;
}) => {
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [open, setOpen] = useState<string | undefined>(initialOpen);
  const [call, setCall] = useState<ApiCall | undefined>();
  const [removing, setRemoving] = useState<KnowledgeEndpoint | undefined>();
  const [inUse, setInUse] = useState<InUse[] | undefined>();
  const flash = useFlash();
  const tenantName = useTenantNames(api);
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

  const remove = async (reason: string) => {
    if (!removing) return;
    try {
      await api.deleteKnowledgeEndpoint(removing.id, reason);
    } catch (error) {
      const used = inUseOf(error, 'datasets');
      if (used) {
        setInUse(used);
        throw new DialogError(tRef.current('searchEngines.stillInUse'));
      }
      throw error;
    }
    setEndpoints((all) => all.filter((e) => e.id !== removing.id));
    flash.show(tRef.current('searchEngines.removed', { name: removing.name }));
  };

  const show = (id: string | undefined) => {
    flash.clear();
    setOpen(id);
    window.scrollTo?.(0, 0);
  };

  if (open) {
    const endpoint = open === 'new' ? undefined : endpoints.find((e) => e.id === open);
    const props = {
      api,
      engines,
      secrets,
      onCancel: () => show(undefined),
      onSaved: (name: string) => {
        show(undefined);
        flash.show(tRef.current('searchEngines.saved', { name }));
        void api.knowledgeEndpoints().then(setEndpoints, () => undefined);
      },
    };
    return endpoint ? (
      <StoredEndpoint key={open} endpoint={endpoint} {...props} />
    ) : (
      <EndpointEditor key={open} {...props} />
    );
  }

  return (
    <div className="stack">
      <Flash message={flash.message} />
      <div className="page-head-row">
        <PageHeader title={t('searchEngines.title')} intro={t('searchEngines.intro')} />
        <div className="actions-row">
          <Button
            variant="tertiary"
            data-size="sm"
            onClick={() =>
              setCall({
                title: t('searchEngines.title'),
                method: 'GET',
                path: '/operator/knowledge/engines',
              })
            }
          >
            <CodeIcon />
            {t('common.showApiCall')}
          </Button>
          <Button onClick={() => show('new')}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t('searchEngines.newEndpoint')}
          </Button>
        </div>
      </div>
      {endpoints.length ? (
        <EndpointTable
          endpoints={endpoints}
          engines={engines}
          onOpen={show}
          onRemove={(endpoint) => {
            flash.clear();
            setInUse(undefined);
            setRemoving(endpoint);
          }}
        />
      ) : (
        <Paragraph>{t('searchEngines.none')}</Paragraph>
      )}
      {call ? <ApiCallPanel call={call} onClose={() => setCall(undefined)} /> : null}
      <ReasonDialog
        open={Boolean(removing)}
        title={removing ? t('searchEngines.removeNamed', { name: removing.name }) : ''}
        text={t('searchEngines.removeText')}
        confirmLabel={t('searchEngines.remove')}
        onClose={() => setRemoving(undefined)}
        onConfirm={remove}
      >
        {inUse?.length ? (
          <div className="stack-sm">
            <span className="label-strong">
              {t('searchEngines.usingDatasets', { count: inUse.length })}
            </span>
            <InUseList items={inUse} tenantName={tenantName} />
          </div>
        ) : null}
      </ReasonDialog>
    </div>
  );
};

export const SearchEngines = ({ api }: { api?: ApiClient }) => {
  const t = useT();
  const { params } = splitRoute(useHashRoute());
  const [state, retry] = useAsync(
    async (signal) =>
      api
        ? Promise.all([
            api.knowledgeEngines(signal),
            api.knowledgeEndpoints(signal),
            api.knowledgeSecrets(signal).catch(() => []),
          ])
        : undefined,
    [api],
  );
  if (!api)
    return (
      <>
        <PageHeader title={t('searchEngines.title')} intro={t('searchEngines.intro')} />
        <Paragraph>{t('searchEngines.comingSoon')}</Paragraph>
      </>
    );
  if (state.status === 'loading') return <Loading label={t('searchEngines.loadingEngines')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (!state.data) return null;
  const [engines, endpoints, secrets] = state.data;
  const initialOpen = params.get('new') ? 'new' : (params.get('endpoint') ?? undefined);
  return (
    <Loaded
      api={api}
      engines={engines}
      secrets={secrets}
      initialEndpoints={endpoints}
      initialOpen={initialOpen}
    />
  );
};
