import { Heading } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import '../buildingblocks.css';

export const FlowVersions = ({
  api,
  tenant,
  id,
  name,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
}) => {
  const t = useT();
  const f = useFormat();
  const heading = useId();
  const [state, retry] = useAsync(
    async (signal) =>
      (await api.buildingBlocks.versions(tenant, { kind: 'step_flow', id }, signal))
        .filter((v) => v.source === 'publisher')
        .sort((a, b) => Number(b.version) - Number(a.version)),
    [api, tenant, id],
  );
  return (
    <section aria-labelledby={heading} className="stack-sm">
      <Heading level={2} data-size="xs" id={heading}>
        {t('stepFlowHome.versionsHeading', { name })}
      </Heading>
      {state.status === 'loading' ? (
        <Loading label={t('stepFlowHome.versionsHeading', { name })} shape="list" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} headingLevel={3} />
      ) : state.data.length === 0 ? (
        <p className="meta">{t('stepFlowHome.noVersions')}</p>
      ) : (
        <ol className="bb-versions">
          {state.data.map((v) => (
            <li key={v.version}>
              <span className="bb-version">
                {t('stepFlowHome.version', { version: v.version })}
              </span>
              <span className="bb-version-date">{v.at ? f.date(v.at) : ''}</span>
              <span className="bb-version-notes">{v.reason ?? ''}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
