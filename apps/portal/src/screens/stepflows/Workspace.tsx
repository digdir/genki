import { Alert, Button, Heading } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api';
import { BackLink } from '../../components/BackLink';
import type { Flow } from '../../data/stepflows';
import { NotAvailable } from '../../components/NotAvailable';
import { useT } from '../../i18n';
import { ErrorState } from '../../states';
import { FlowEditor, type Flash } from './FlowEditor';
import { FlowVersions } from './FlowVersions';
import { flowName } from './model';
import { UseInService } from './UseInService';

export interface WorkspaceProps {
  api: ApiClient;
  tenant: string;
  flows: Record<string, Flow>;
  setFlows: (update: (flows: Record<string, Flow>) => Record<string, Flow>) => void;
  liveError?: { error: unknown; retry: () => void } | undefined;
  service?: { id: string; name: string } | undefined;
  initialFlow: string;
  initialTab: 'diagram' | 'yaml';
  initialOverlay: boolean;
}

export const blankFlow = (id: string, changed: string): Flow => ({
  id,
  name: '',
  desc: '',
  version: 1,
  draft: true,
  unsaved: true,
  changed,
  usedBy: [],
  input: [['sporsmal', 'tekst']],
  steps: [],
});

export const Workspace = ({
  api,
  tenant,
  flows,
  setFlows,
  liveError,
  service,
  initialFlow,
  initialTab,
  initialOverlay,
}: WorkspaceProps) => {
  const t = useT();
  const [fid, setFid] = useState(initialFlow);
  const [flash, setFlash] = useState<Flash>();
  const [using, setUsing] = useState(false);
  useEffect(() => setFid(initialFlow), [initialFlow]);
  const flow = flows[fid] ?? Object.values(flows)[0];

  const flashArea = (
    <div aria-live="polite" className="flash-area">
      {flash ? (
        <Alert data-color={flash.color} data-size="sm">
          {flash.text}
        </Alert>
      ) : null}
    </div>
  );
  const back = service ? (
    <BackLink
      label={t('stepFlowHome.backToService', { service: service.name })}
      href={`#/services/${encodeURIComponent(service.id)}`}
    />
  ) : (
    <BackLink label={t('stepflows.crumbFlows')} href="#/developer/step-flows" />
  );
  const flowView = flow ? (
    <div className="stack-md">
      <div className="stack-sm">
        {back}
        <div className="sf-home-head">
          <Heading level={1} data-size="lg">
            {flow.unsaved ? t('stepFlowHome.newFlow') : flowName(flow, t)}
          </Heading>
          {!flow.unsaved ? (
            <Button onClick={() => setUsing(true)}>
              {service ? t('stepFlowHome.pinHere') : t('stepFlowHome.useInService')}
            </Button>
          ) : null}
        </div>
      </div>
      <FlowEditor
        key={flow.id}
        api={api}
        tenant={tenant}
        flows={flows}
        flow={flow}
        {...(service ? { serviceName: service.name, serviceId: service.id } : {})}
        showPicker={false}
        initialTab={initialTab}
        initialOverlay={initialOverlay}
        {...(flow.unsaved
          ? {}
          : {
              versions: (
                <FlowVersions api={api} tenant={tenant} id={flow.id} name={flowName(flow, t)} />
              ),
            })}
        onPickFlow={setFid}
        onChange={(next, previousId) => {
          const renamed = previousId && previousId !== next.id ? previousId : undefined;
          setFlows((all) => ({
            ...Object.fromEntries(Object.entries(all).filter(([id]) => id !== renamed)),
            [next.id]: next,
          }));
          if (renamed) setFid(next.id);
        }}
        onFlash={setFlash}
      />
    </div>
  ) : (
    <div className="stack-md">
      {back}
      <Heading level={1} data-size="lg">
        {t('stepFlowHome.title')}
      </Heading>
      <NotAvailable>
        {service ? t('stepflows.noFlowForService', { name: service.name }) : t('stepflows.noFlows')}
      </NotAvailable>
    </div>
  );
  const useDialog =
    using && flow ? (
      <UseInService
        api={api}
        tenant={tenant}
        flow={flow}
        {...(service ? { service: service.id } : {})}
        onClose={() => setUsing(false)}
      />
    ) : null;

  return (
    <div className="stack-md stepflows">
      {flashArea}
      {liveError ? <ErrorState error={liveError.error} onRetry={liveError.retry} /> : null}
      {flowView}
      {useDialog}
    </div>
  );
};
