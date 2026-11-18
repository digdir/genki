import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { blockDefFromSchema } from '../../data/step-blocks';
import { registerBlocks } from '../../data/stepflows';
import { formatDate } from '../../format';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { Loading } from '../../states';
import { toYaml } from '../../yaml';
import { Diagram } from '../stepflows/Diagram';
import { analyse, fromDefinition } from '../stepflows/model';
import '../stepflows.css';

export const StepFlowView = ({
  api,
  tenant,
  id,
  own,
  view,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  own: boolean;
  view: 'diagram' | 'yaml';
}) => {
  const t = useT();
  const f = useFormat();
  const [subOpen, setSubOpen] = useState<Record<string, boolean>>({});
  const [state, retry] = useAsync(
    async (signal) => {
      const [catalog, found] = await Promise.all([
        api.listStepBlocks(tenant, signal).catch(() => []),
        own
          ? api.getDefinition(tenant, 'StepFlow', id, signal).then((d) => ({
              definition: d.latest.definition,
              version: d.latest.version,
              publishedAt: d.latest.publishedAt,
            }))
          : api.blocks.flowDefinition(tenant, id, signal),
      ]);
      registerBlocks(
        Object.fromEntries(
          (Array.isArray(catalog) ? catalog : []).map((b) => [b.name, blockDefFromSchema(b, t)]),
        ),
      );
      const flow = fromDefinition(
        found.definition,
        {
          version: found.version,
          changed: formatDate(found.publishedAt, f),
          usedBy: [],
        },
        t,
      );
      return { flow, yaml: toYaml(found.definition) };
    },
    [api, tenant, id, own, t, f],
  );
  if (state.status === 'loading') return <Loading label={t('blocks.flowLoading')} />;
  if (
    state.status === 'error' &&
    !own &&
    state.error instanceof ApiError &&
    state.error.status === 404
  )
    return (
      <Alert data-color="info">
        <Paragraph>{t('blockFlow.notShared')}</Paragraph>
      </Alert>
    );
  if (state.status === 'error')
    return (
      <Alert data-color="danger" role="alert">
        <Heading level={2} data-size="xs">
          {t('blockFlow.errorTitle')}
        </Heading>
        <Paragraph>{t('blockFlow.errorBody')}</Paragraph>
        <Button variant="secondary" data-size="sm" onClick={retry}>
          {t('common.tryAgain')}
        </Button>
      </Alert>
    );
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
