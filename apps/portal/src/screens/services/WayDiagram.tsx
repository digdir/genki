import type { ApiClient } from '../../api';
import type { Recipe } from '../../api/recipes';
import { blockDefFromSchema } from '../../data/step-blocks';
import { registerBlocks } from '../../data/stepflows';
import { strategyFor } from '../../data/strategies';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { PipelineSteps } from '../service/StrategyPanel';
import { Diagram } from '../stepflows/Diagram';
import { analyse, fromDefinition } from '../stepflows/model';
import '../stepflows.css';

export interface Way {
  strategy: string;
  config: Record<string, unknown>;
}

const noop = () => undefined;

interface Loaded {
  definition: unknown;
  version: number;
}

const LoadedDiagram = ({
  api,
  tenant,
  id,
  missing,
  load,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  missing: string;
  load: (signal: AbortSignal) => Promise<Loaded>;
}) => {
  const t = useT();
  const [state] = useAsync(
    async (signal) => {
      const catalog = await api.listStepBlocks(tenant, signal).catch(() => []);
      registerBlocks(Object.fromEntries(catalog.map((b) => [b.name, blockDefFromSchema(b, t)])));
      const found = await load(signal);
      return fromDefinition(found.definition, { version: found.version }, t);
    },
    [api, tenant, id],
  );
  if (state.status === 'loading') return <p className="meta">{t('setup.variantFlowLoading')}</p>;
  if (state.status === 'error') return <p className="meta">{missing}</p>;
  const loaded = state.data;
  return (
    <Diagram
      flow={loaded}
      analysis={analyse(loaded, { [loaded.id]: loaded }, {}, t)}
      overlay={false}
      subOpen={{}}
      onToggleSub={noop}
      onOpen={noop}
      onAdd={noop}
      readOnly
    />
  );
};

const FlowDiagram = ({ api, tenant, flow }: { api: ApiClient; tenant: string; flow: string }) => {
  const t = useT();
  return (
    <LoadedDiagram
      api={api}
      tenant={tenant}
      id={flow}
      missing={t('setup.variantFlowMissing', { flow })}
      load={async (signal) => {
        const def = await api.getDefinition(tenant, 'StepFlow', flow, signal);
        return { definition: def.latest.definition, version: def.latest.version };
      }}
    />
  );
};

export const RecipeDiagram = ({
  api,
  tenant,
  recipe,
}: {
  api: ApiClient;
  tenant: string;
  recipe: Recipe;
}) => {
  const t = useT();
  return (
    <LoadedDiagram
      api={api}
      tenant={tenant}
      id={recipe.ref}
      missing={t('setup.variantFlowMissing', { flow: recipe.ref })}
      load={async () => ({
        definition: {
          apiVersion: 'genai/v1',
          kind: 'StepFlow',
          metadata: { tenant, id: recipe.id, ...(recipe.name ? { name: recipe.name } : {}) },
          spec: { purpose: recipe.purpose, steps: recipe.steps },
        },
        version: recipe.version,
      })}
    />
  );
};

export const WayDiagram = ({
  way,
  api,
  tenant,
}: {
  way: Way;
  api?: ApiClient | undefined;
  tenant?: string | undefined;
}) => {
  const t = useT();
  if (way.strategy === 'step-flow') {
    const ref = typeof way.config.flow === 'string' ? way.config.flow : '';
    const id = ref.replace(/@[\d.]+$/, '');
    if (!id) return <p className="meta">{t('setup.variantFlowNone')}</p>;
    return api && tenant ? (
      <FlowDiagram api={api} tenant={tenant} flow={id} />
    ) : (
      <p className="meta">
        <code>{ref}</code>
      </p>
    );
  }
  const strategy = strategyFor(way.strategy, t);
  return strategy ? <PipelineSteps steps={strategy.pipeline} /> : null;
};
