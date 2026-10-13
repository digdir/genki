import { Heading, Paragraph } from '@digdir/designsystemet-react';
import { Crumbs } from '../../components/Crumbs';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import type { Flash } from './common';
import { ConnectorApproval } from './ConnectorApproval';
import { ConnectorList } from './Connectors';
import { approvalRight, ProposalSection } from './ProposalSection';

export const ConnectorsPage = ({
  api,
  tenant,
  tenantName,
  version,
  onFlash,
}: ScreenProps & { version: number; onFlash: (flash: Flash) => void }) => {
  const { has } = useRights();
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) => {
      const [proposals, connectors] = await Promise.all([
        api.buildingBlocks.proposals(tenant, signal),
        api.buildingBlocks.connectors(tenant, signal),
      ]);
      return { proposals: proposals.filter((p) => p.level === 2), connectors };
    },
    [tenant, version],
  );
  return (
    <div className="stack">
      <Crumbs
        items={[
          { label: t('connectors.pageBlocks'), href: '#/building-blocks' },
          { label: t('connectors.pageCrumb') },
        ]}
      />
      <div className="stack-xs bb-connect-intro">
        <Heading level={1} data-size="md">
          {t('connectors.pageHeading')}
        </Heading>
        <Paragraph className="lead">{t('connectors.pageLead', { tenantName })}</Paragraph>
      </div>
      {state.status === 'loading' ? (
        <Loading label={t('connectors.pageLoading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <>
          {state.data.proposals.map((p) =>
            has(approvalRight(p)) ? (
              <ConnectorApproval
                key={p.id}
                api={api}
                tenant={tenant}
                tenantName={tenantName}
                proposal={p}
                onDone={onFlash}
              />
            ) : (
              <ProposalSection key={p.id} api={api} tenant={tenant} proposal={p} onDone={onFlash} />
            ),
          )}
          <ConnectorList api={api} tenant={tenant} connectors={state.data.connectors} />
        </>
      )}
    </div>
  );
};
