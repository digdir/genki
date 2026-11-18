import { Alert, Button, Chip, Heading, Tag } from '@digdir/designsystemet-react';
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api';
import { BackLink } from '../../components/BackLink';
import { strategies, type Flow, type Strategy } from '../../data/stepflows';
import { NotAvailable } from '../../components/NotAvailable';
import { useT } from '../../i18n';
import { ErrorState } from '../../states';
import { FlowEditor, type Flash } from './FlowEditor';
import { StrategyView } from './StrategyView';
import { UseInService } from './UseInService';

export interface WorkspaceProps {
  api: ApiClient;
  tenant: string;
  flows: Record<string, Flow>;
  setFlows: (update: (flows: Record<string, Flow>) => Record<string, Flow>) => void;
  liveError?: { error: unknown; retry: () => void } | undefined;
  service?: { id: string; name: string } | undefined;
  initialFlow: string;
  live?: boolean;
  initialStrategy: Strategy['id'];
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
  initialStrategy,
  initialTab,
  initialOverlay,
  live = false,
}: WorkspaceProps) => {
  const t = useT();
  const [fid, setFid] = useState(initialFlow);
  const [strategy, setStrategy] = useState(initialStrategy);
  const [flash, setFlash] = useState<Flash>();
  const [using, setUsing] = useState(false);
  useEffect(() => setFid(initialFlow), [initialFlow]);
  const flow = flows[fid] ?? Object.values(flows)[0];
  const current = useMemo(
    () => strategies.find((s) => s.id === strategy) ?? strategies[0],
    [strategy],
  );

  const flashArea = (
    <div aria-live="polite" className="flash-area">
      {flash ? (
        <Alert data-color={flash.color} data-size="sm">
          {flash.text}
        </Alert>
      ) : null}
    </div>
  );
  const flowView = (
    <>
      {flow && current ? (
        <div className="stack-md">
          {service ? (
            <BackLink
              label={t('stepFlowHome.backToService', { service: service.name })}
              href={`#/services/${encodeURIComponent(service.id)}`}
            />
          ) : (
            <BackLink label={t('stepflows.crumbFlows')} href="#/developer/step-flows" />
          )}
          <div className="sf-home-head">
            <Heading level={1} data-size="md" id="strategi-h">
              {t('stepflows.strategyTitle')}
            </Heading>
            {!flow.unsaved ? (
              <Button variant="secondary" onClick={() => setUsing(true)}>
                {service ? t('stepFlowHome.pinHere') : t('stepFlowHome.useInService')}
              </Button>
            ) : null}
          </div>
          <div className="stack-xs">
            <div role="radiogroup" aria-labelledby="strategi-h" className="tag-row">
              {strategies
                .filter((s) => !live || s.id === 'stegflyt')
                .map((s) => (
                  <Chip.Radio
                    key={s.id}
                    name="strategi"
                    value={s.id}
                    checked={strategy === s.id}
                    onChange={() => {
                      setStrategy(s.id);
                      setFlash(undefined);
                    }}
                  >
                    {s.name}
                    {s.isNew ? ' ' : null}
                    {s.isNew ? (
                      <Tag data-size="sm" data-color="info" className="chip-tag">
                        {t('stepflows.isNew')}
                      </Tag>
                    ) : null}
                  </Chip.Radio>
                ))}
            </div>
            <p className="meta">{t('stepflows.strategyNote')}</p>
          </div>
          {current.id === 'stegflyt' ? (
            <FlowEditor
              key={flow.id}
              api={api}
              tenant={tenant}
              flows={flows}
              flow={flow}
              {...(service ? { serviceName: service.name, serviceId: service.id } : {})}
              showPicker
              initialTab={initialTab}
              initialOverlay={initialOverlay}
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
          ) : live ? null : (
            <StrategyView
              key={current.id}
              strategy={current}
              onFlash={setFlash}
              onUse={(id) => setStrategy(id)}
            />
          )}
        </div>
      ) : null}
      {!flow ? (
        <div className="stack-md">
          <Heading level={1} data-size="md">
            {t('stepflows.strategyTitle')}
          </Heading>
          <NotAvailable>
            {service
              ? t('stepflows.noFlowForService', { name: service.name })
              : t('stepflows.noFlows')}
          </NotAvailable>
        </div>
      ) : null}
    </>
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
