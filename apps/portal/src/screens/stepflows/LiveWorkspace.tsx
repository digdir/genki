import { useFormat } from '@genai/i18n/react';
import { SchemaFormProvider } from '@genai/schema-forms';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api';
import type { CatalogItem } from '../../api/building-blocks';
import {
  exampleFlows,
  flowQueryIds,
  registerBlocks,
  serviceOfFlow,
  strategies,
  type Flow,
  type Strategy,
} from '../../data/stepflows';
import { blockDefFromSchema } from '../../data/step-blocks';
import { formatDate } from '../../format';
import type { Format, T } from '../../i18n';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { Loading } from '../../states';
import { fromDefinition } from './model';
import { Workspace } from './Workspace';
import '../stepflows.css';

const designFlows = () => Object.fromEntries(exampleFlows.map((f) => [f.id, structuredClone(f)]));

const loadLiveFlows = async (
  api: ApiClient,
  tenant: string,
  live: boolean,
  f: Format,
  t: T,
  signal: AbortSignal,
) => {
  const catalog = await api
    .listStepBlocks(tenant, signal)
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => []);
  registerBlocks(Object.fromEntries(catalog.map((b) => [b.name, blockDefFromSchema(b, t)])));
  const list = (await api.listDefinitions(tenant, signal)).filter((d) => d.kind === 'StepFlow');
  const loaded = await Promise.all(
    list.map(async (d) => {
      const full = await api.getDefinition(tenant, 'StepFlow', d.id, signal);
      const base = live ? undefined : exampleFlows.find((f) => f.id === d.id);
      try {
        return fromDefinition(full.latest.definition, {
          ...base,
          version: full.latest.version,
          changed: formatDate(full.latest.publishedAt, f),
          usedBy: base?.usedBy ?? [],
        });
      } catch {
        return undefined;
      }
    }),
  );
  const blocks = await api.buildingBlocks
    .list(tenant, { kind: 'step_flow' }, signal)
    .then((l) => l.data)
    .catch(() => []);
  return loaded.filter((f): f is Flow => !!f).map((flow) => withCatalogText(flow, blocks));
};

export const withCatalogText = (
  flow: Flow,
  blocks: Pick<CatalogItem, 'id' | 'kind' | 'name' | 'description' | 'usedBy'>[],
): Flow => {
  const block = blocks.find((b) => b.kind === 'step_flow' && b.id === flow.id);
  if (!block) return flow;
  return {
    ...flow,
    name: block.name || flow.name,
    desc: block.description || flow.desc,
    usedBy: block.usedBy.length ? block.usedBy.map((u) => u.name) : flow.usedBy,
  };
};

const strategyIds = strategies.map((s) => s.id);

export interface LiveWorkspaceProps {
  api: ApiClient;
  tenant: string;
  query: URLSearchParams;
  flowId?: string | undefined;
  service?: { id: string; name: string } | undefined;
  library: boolean;
  live?: boolean;
}

export const LiveWorkspace = ({
  api,
  tenant,
  query,
  flowId,
  service,
  library,
  live = false,
}: LiveWorkspaceProps) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync(
    (signal) => loadLiveFlows(api, tenant, live, f, t, signal),
    [api, tenant, live, f, t],
  );
  const [flows, setFlows] = useState<Record<string, Flow>>(() => (live ? {} : designFlows()));

  useEffect(() => {
    if (state.status !== 'ready') return;
    setFlows((all) => ({ ...all, ...Object.fromEntries(state.data.map((f) => [f.id, f])) }));
  }, [state]);

  if (state.status === 'loading') return <Loading label={t('stepflows.loading')} />;

  const flyt = query.get('flyt') ?? '';
  const byService =
    service && !live
      ? Object.keys(serviceOfFlow).find((id) => serviceOfFlow[id] === service.name)
      : undefined;
  const initialFlow =
    flowQueryIds[flyt] ||
    (flowId && (flowQueryIds[flowId] ?? flowId)) ||
    byService ||
    'svar-med-kilder';
  const strategi = query.get('strategi') ?? '';
  const visning = query.get('visning');

  return (
    <SchemaFormProvider fetchJson={api.getJson} routeParams={{ tenant }}>
      <Workspace
        api={api}
        tenant={tenant}
        flows={flows}
        setFlows={setFlows}
        liveError={state.status === 'error' ? { error: state.error, retry } : undefined}
        service={service}
        live={live}
        initialView={visning === 'bibliotek' || (library && !visning) ? 'lib' : 'flow'}
        initialFlow={initialFlow}
        initialStrategy={
          strategyIds.includes(strategi as Strategy['id'])
            ? (strategi as Strategy['id'])
            : 'stegflyt'
        }
        initialTab={visning === 'yaml' ? 'yaml' : 'diagram'}
        initialOverlay={query.get('testkjoring') === 'true' || query.get('testkjoring') === '1'}
      />
    </SchemaFormProvider>
  );
};
