import { Alert, Button, Heading, Paragraph, Tag, Textfield } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ValidationProblem } from '../../types';
import { ErrorState, Loading } from '../../states';
import { Registry } from './Registry';

export const pipelineTemplate = {
  name: '',
  source: { kind: 'website', sitemap: 'https://', include: [], exclude: [] },
  chunking: { strategy: { kind: 'header-based' } },
  parallelism: 2,
  enabled: true,
};

const Run = ({ api, base, id }: { api: ApiClient; base: string; id: string }) => {
  const t = useT();
  const [reason, setReason] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'blocked'; reason: string }
    | { kind: 'started' }
    | { kind: 'failed' }
  >({ kind: 'idle' });
  const run = async () => {
    try {
      await api.configPost(
        `${base}/${encodeURIComponent(id)}/execute`,
        reason || t('config.ingestionDefaultReason'),
      );
      setState({ kind: 'started' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        setState({
          kind: 'blocked',
          reason:
            (error.problem as ValidationProblem | undefined)?.errors
              ?.map((e) => e.message)
              .join(' ') ?? '',
        });
      else setState({ kind: 'failed' });
    }
  };
  return (
    <div className="stack-sm">
      <Textfield
        label={t('config.ingestionReasonLabel')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button variant="secondary" data-size="sm" className="align-start" onClick={() => void run()}>
        {t('config.run')}
      </Button>
      {state.kind === 'blocked' ? (
        <Alert data-color="info" data-size="sm" role="status">
          <Heading level={5} data-size="2xs">
            {t('config.writeKeyNotice')}
          </Heading>
          <Paragraph data-size="sm">
            {t('config.ingestionBlocked')}
            {state.reason ? ` (${state.reason})` : ''}
          </Paragraph>
        </Alert>
      ) : null}
      {state.kind === 'started' ? (
        <Alert data-color="success" data-size="sm" role="status">
          {t('config.ingestionStarted')}
        </Alert>
      ) : null}
      {state.kind === 'failed' ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {t('config.ingestionFailed')}
        </Alert>
      ) : null}
    </div>
  );
};

export const Pipelines = ({ api, base }: { api: ApiClient; base: string }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.configList(base, signal), [api, base]);
  if (state.status === 'loading') return <Loading label={t('config.loadingPipelines')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const backend = state.data.backend;
  return (
    <section className="stack-sm" aria-label={t('config.ingestion')}>
      <Heading level={4} data-size="2xs">
        {t('config.ingestion')}
      </Heading>
      {backend && !backend.available ? (
        <Paragraph data-size="sm">
          <Tag data-size="sm" data-color="info">
            {t('config.writeKeyNotice')}
          </Tag>
        </Paragraph>
      ) : null}
      <Registry
        api={api}
        label={t('config.pipelines')}
        paths={{
          list: base,
          create: base,
          item: (id) => `${base}/${encodeURIComponent(id)}`,
          history: (id) => `${base}/${encodeURIComponent(id)}/versions`,
        }}
        template={pipelineTemplate}
        describe={(p) => String((p.spec as { name?: string }).name ?? '')}
        detail={(p) => <Run api={api} base={base} id={p.id} />}
      />
    </section>
  );
};
