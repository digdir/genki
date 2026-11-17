import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { blockDefFromSchema } from '../../data/step-blocks';
import { registerBlocks } from '../../data/stepflows';
import { formatDate } from '../../format';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { toYaml } from '../../yaml';
import { Diagram } from '../stepflows/Diagram';
import { analyse, fromDefinition } from '../stepflows/model';
import '../stepflows.css';

export const StepFlowView = ({
  api,
  tenant,
  id,
  view,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  view: 'diagram' | 'yaml';
}) => {
  const t = useT();
  const f = useFormat();
  const [subOpen, setSubOpen] = useState<Record<string, boolean>>({});
  const [state, retry] = useAsync(
    async (signal) => {
      const [catalog, found] = await Promise.all([
        api.listStepBlocks(tenant, signal).catch(() => []),
        api.getDefinition(tenant, 'StepFlow', id, signal),
      ]);
      registerBlocks(
        Object.fromEntries(
          (Array.isArray(catalog) ? catalog : []).map((b) => [b.name, blockDefFromSchema(b, t)]),
        ),
      );
      const flow = fromDefinition(
        found.latest.definition,
        {
          version: found.latest.version,
          changed: formatDate(found.latest.publishedAt, f),
          usedBy: [],
        },
        t,
      );
      return { flow, yaml: toYaml(found.latest.definition) };
    },
    [api, tenant, id, t, f],
  );
  if (state.status === 'loading') return <Loading label={t('blocks.flowLoading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const { flow, yaml } = state.data;
  if (view === 'yaml')
    return (
      <div className="stack-sm">
        <p className="bb-measure">{t('blocks.yamlLead')}</p>
        <pre className="bb-yaml" tabIndex={0} role="region" aria-label={t('blocks.yamlRegion')}>
          <code>{yaml}</code>
        </pre>
        <div className="actions">
          <CopyButton text={yaml} />
        </div>
      </div>
    );
  return (
    <Diagram
      flow={flow}
      analysis={analyse(flow, { [flow.id]: flow }, subOpen, t)}
      overlay={false}
      subOpen={subOpen}
      onToggleSub={(step) => setSubOpen((open) => ({ ...open, [step]: !open[step] }))}
      onOpen={() => undefined}
      onAdd={() => undefined}
      readOnly
    />
  );
};
