import { Alert, Button, Chip, Heading, Paragraph, Tabs, Tag } from '@digdir/designsystemet-react';
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api';
import { Crumbs } from '../../components/Crumbs';
import { serviceOfFlow, strategies, type Flow, type Strategy } from '../../data/stepflows';
import { NotAvailable } from '../../components/NotAvailable';
import { useT } from '../../i18n';
import { EmptyState, ErrorState } from '../../states';
import { FlowEditor, type Flash } from './FlowEditor';
import { analyse, countSteps, versionLabel } from './model';
import { StrategyView } from './StrategyView';

export interface WorkspaceProps {
  api: ApiClient;
  tenant: string;
  flows: Record<string, Flow>;
  setFlows: (update: (flows: Record<string, Flow>) => Record<string, Flow>) => void;
  liveError?: { error: unknown; retry: () => void } | undefined;
  service?: { id: string; name: string } | undefined;
  initialView: 'flow' | 'lib';
  initialFlow: string;
  live?: boolean;
  initialStrategy: Strategy['id'];
  initialTab: 'diagram' | 'yaml';
  initialOverlay: boolean;
}

const Library = ({
  flows,
  liveError,
  onOpen,
  onNew,
  onFlash,
}: {
  flows: Record<string, Flow>;
  liveError: WorkspaceProps['liveError'];
  onOpen: (id: string) => void;
  onNew: () => void;
  onFlash: (flash: Flash) => void;
}) => {
  const t = useT();
  return (
    <div className="stack-md">
      <div className="page-head">
        <div className="stack-xs">
          <Heading level={1} data-size="md">
            {t('stepflows.libraryTitle')}
          </Heading>
          <p className="lead">{t('stepflows.libraryLead')}</p>
        </div>
        <Button onClick={onNew}>{t('stepflows.newFlow')}</Button>
      </div>
      {liveError ? <ErrorState error={liveError.error} onRetry={liveError.retry} /> : null}
      {Object.keys(flows).length === 0 && !liveError ? (
        <EmptyState title={t('stepflows.emptyTitle')}>
          <Paragraph>{t('stepflows.emptyText')}</Paragraph>
        </EmptyState>
      ) : null}
      <ul className="flow-library">
        {Object.values(flows).map((f) => {
          const errors = analyse(f, flows, {}, t).errors.size;
          return (
            <li key={f.id}>
              <div className="row-wrap spread">
                <Heading level={2} data-size="2xs">
                  {f.name}
                </Heading>
                <span className="tag-row">
                  {f.sub ? (
                    <Tag data-size="sm" data-color="neutral">
                      {t('stepflows.controlSub')}
                    </Tag>
                  ) : null}
                  <Tag data-size="sm" data-color={errors ? 'danger' : 'success'}>
                    {errors ? t('stepflows.withErrors', { count: errors }) : t('stepflows.valid')}
                  </Tag>
                </span>
              </div>
              <p className="small">{f.desc}</p>
              <dl className="kv small-kv">
                <dt>{t('stepflows.dtVersion')}</dt>
                <dd>
                  {t('stepflows.versionChanged', {
                    version: versionLabel(f, t),
                    changed: f.changed,
                  })}
                </dd>
                <dt>{t('stepflows.dtSteps')}</dt>
                <dd>{t('stepflows.stepCount', { count: countSteps(f.steps) })}</dd>
                <dt>{t('stepflows.usedBy')}</dt>
                <dd>{f.usedBy.join(', ') || t('stepflows.usedByNone')}</dd>
              </dl>
              <div className="actions push-down">
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-label={t('stepflows.openLabel', { name: f.name })}
                  onClick={() => onOpen(f.id)}
                >
                  {t('stepflows.open')}
                </Button>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('stepflows.useLabel', { name: f.name })}
                  onClick={() =>
                    onFlash({
                      text: t('stepflows.useFlash', { name: f.name, version: versionLabel(f, t) }),
                      color: 'info',
                    })
                  }
                >
                  {t('stepflows.useInService')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const Workspace = ({
  api,
  tenant,
  flows,
  setFlows,
  liveError,
  service,
  initialView,
  initialFlow,
  initialStrategy,
  initialTab,
  initialOverlay,
  live = false,
}: WorkspaceProps) => {
  const t = useT();
  const [view, setView] = useState(initialView);
  const [fid, setFid] = useState(initialFlow);
  const [strategy, setStrategy] = useState(initialStrategy);
  const [flash, setFlash] = useState<Flash>();
  const [editorKey, setEditorKey] = useState(0);
  useEffect(() => setFid(initialFlow), [initialFlow]);
  const flow = flows[fid] ?? Object.values(flows)[0];
  const serviceName =
    service?.name ?? (flow ? serviceOfFlow[flow.id] : undefined) ?? t('stepflows.newService');
  const current = useMemo(
    () => strategies.find((s) => s.id === strategy) ?? strategies[0],
    [strategy],
  );

  const openFlow = (id: string) => {
    setFid(id);
    setView('flow');
    setEditorKey((k) => k + 1);
  };

  return (
    <div className="stack-md stepflows">
      <Tabs
        value={view}
        onChange={(v) => {
          setView(v as 'flow' | 'lib');
          setFlash(undefined);
        }}
      >
        <Tabs.List aria-label={t('stepflows.viewLabel')}>
          <Tabs.Tab value="flow">{t('stepflows.tabInService')}</Tabs.Tab>
          <Tabs.Tab value="lib">{t('stepflows.tabLibrary')}</Tabs.Tab>
        </Tabs.List>
        <div aria-live="polite" className="flash-area">
          {flash ? (
            <Alert data-color={flash.color} data-size="sm">
              {flash.text}
            </Alert>
          ) : null}
        </div>
        <Tabs.Panel value="lib">
          {view === 'lib' ? (
            <Library
              flows={flows}
              liveError={liveError}
              onOpen={openFlow}
              onFlash={setFlash}
              onNew={() => {
                const id = `ny-flyt-${Object.keys(flows).length}`;
                setFlows((all) => ({
                  ...all,
                  [id]: {
                    id,
                    name: t('stepflows.newFlow'),
                    desc: t('stepflows.newFlowDesc'),
                    version: 1,
                    draft: true,
                    changed: t('stepflows.newFlowChanged'),
                    usedBy: [],
                    input: [['sporsmal', 'tekst']],
                    steps: [],
                  },
                }));
                openFlow(id);
              }}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="flow">
          {view === 'flow' && flow && current ? (
            <div className="stack-md">
              <Crumbs
                items={[
                  { label: t('stepflows.crumbServices'), href: '#/services' },
                  {
                    label: serviceName,
                    href: service ? `#/services/${encodeURIComponent(service.id)}` : '#/services',
                  },
                  { label: t('stepflows.strategyTitle') },
                ]}
              />
              <div className="stack-xs">
                <Heading level={1} data-size="md" id="strategi-h">
                  {t('stepflows.strategyTitle')}
                </Heading>
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
                  key={`${flow.id}-${editorKey}`}
                  api={api}
                  tenant={tenant}
                  flows={flows}
                  flow={flow}
                  {...(service ? { serviceName: service.name } : {})}
                  showPicker
                  initialTab={initialTab}
                  initialOverlay={initialOverlay}
                  onPickFlow={setFid}
                  onChange={(next) => setFlows((all) => ({ ...all, [next.id]: next }))}
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
          {view === 'flow' && !flow ? (
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
        </Tabs.Panel>
      </Tabs>
    </div>
  );
};
