import { Alert, Badge, Heading, Tabs, Tag } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { Crumbs } from '../components/Crumbs';
import type { CaseDetail, FeedbackDetail } from '../data/quality';
import { proposals } from '../data/quality';
import { useAsync } from '../hooks';
import type { PlainKey } from '../i18n';
import { usePortalFormat } from '../format';
import { useInServicePage } from './service/context';
import type { ServiceScreenProps } from '../screen';
import { ErrorState, Loading } from '../states';
import { FeedbackTab, feedbackFrom } from './quality/FeedbackTab';
import { PreviewTab } from './quality/PreviewTab';
import { ProposalsTab } from './quality/ProposalsTab';
import { PublishTab } from './quality/PublishTab';
import {
  problemTitle,
  type Decision,
  type Flash,
  type NewCase,
  type SetFlash,
} from './quality/shared';
import { TenantGates } from './config/TenantGates';
import { Improvements } from './quality/Improvements';
import { LiveTestSets } from './quality/LiveTestSets';
import { TestSetsTab } from './quality/TestSetsTab';
import './quality.css';

const tabs = ['testsets', 'gates', 'feedback', 'proposals', 'publish', 'preview'] as const;
type Tab = (typeof tabs)[number];
const aliases: Record<string, Tab> = {
  ts: 'testsets',
  fb: 'feedback',
  fs: 'proposals',
  pub: 'publish',
  chat: 'preview',
};
const tabLabel: Record<Tab, PlainKey> = {
  testsets: 'quality.tabTestsets',
  gates: 'quality.tabGates',
  feedback: 'quality.tabFeedback',
  proposals: 'quality.tabProposals',
  publish: 'quality.tabPublish',
  preview: 'quality.tabPreview',
};

const liveTabs: readonly Tab[] = ['testsets', 'gates', 'feedback', 'proposals', 'preview'];

const tabFrom = (value: string | null, live = false): Tab => {
  const found = !value
    ? 'testsets'
    : (tabs as readonly string[]).includes(value)
      ? (value as Tab)
      : (aliases[value] ?? 'testsets');
  if (found === 'gates' && !live) return 'testsets';
  return live && !liveTabs.includes(found) ? 'testsets' : found;
};

const riskTag = {
  high: { text: 'quality.riskHigh', color: 'danger' },
  limited: { text: 'quality.riskLimited', color: 'warning' },
  minimal: { text: 'quality.riskMinimal', color: 'neutral' },
} as const;

export const Quality = ({ api, tenant, tenantName, route, id, live }: ServiceScreenProps) => {
  const { t, f } = usePortalFormat();
  const [tab, setTab] = useState<Tab>(() => tabFrom(route.query.get('tab'), live));
  const [scoped, setScoped] = useState<{ tab: Tab; flash: Flash }>();
  const setFlash: SetFlash = (next) => setScoped(next ? { tab, flash: next } : undefined);
  const flash = scoped?.tab === tab ? scoped.flash : undefined;
  const [extraCases, setExtraCases] = useState<CaseDetail[]>([]);
  const [added, setAdded] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState('F-12');
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const queryTab = route.query.get('tab');
  useEffect(() => setTab(tabFrom(queryTab, live)), [queryTab, live]);

  const [state, retry] = useAsync(
    async (signal) => {
      const [definition, sets, runs, feedback] = await Promise.all([
        api.getDefinition(tenant, 'Service', id, signal),
        live ? [] : api.listTestSets(tenant, id, signal),
        live ? [] : api.listEvalRuns(tenant, id, signal),
        api.listFeedback(tenant, id, signal),
      ]);
      return { definition, sets, runs, feedback: feedbackFrom(feedback, live, f) };
    },
    [api, tenant, id, live, f],
  );

  const embedded = useInServicePage();
  if (state.status === 'loading') return <Loading label={t('quality.loading')} />;
  if (state.status === 'error')
    return (
      <>
        <Crumbs
          items={[{ label: t('quality.crumbServices'), href: '#/services' }, { label: id }]}
        />
        <Heading level={embedded ? 2 : 1} data-size="md">
          {t('quality.title')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );

  const { definition, sets, runs, feedback } = state.data;
  const latest = definition.latest;
  const meta = latest.definition.metadata as { name?: string } | undefined;
  const spec = latest.definition.spec as { riskClass?: string } | undefined;
  const name = meta?.name ?? id;
  const riskQuery = route.query.get('risk');
  const risk =
    riskQuery === 'hoy'
      ? 'high'
      : riskQuery === 'begrenset'
        ? 'limited'
        : spec?.riskClass === 'high' || spec?.riskClass === 'minimal'
          ? spec.riskClass
          : 'limited';
  const high = risk === 'high';

  const choose = (next: Tab) => {
    setTab(next);
    setFlash(undefined);
    window.history.replaceState(
      null,
      '',
      `#/services/${encodeURIComponent(id)}/quality?tab=${next}`,
    );
  };

  const addCase = (c: NewCase) => {
    const caseId = `T-${String(149 + extraCases.length).padStart(3, '0')}`;
    setExtraCases((all) => [{ id: caseId, ...c, last: 'Ikke kjørt' }, ...all]);
    return caseId;
  };

  const badges: Partial<Record<Tab, { n: number; color: 'danger' | 'info' }>> = {
    feedback: {
      n: feedback.filter((f) => !added[f.id] && f.type !== 'Tommel opp').length,
      color: 'danger',
    },
    proposals: {
      n: live
        ? 0
        : proposals.filter((p) => !decisions[p.id] || decisions[p.id]?.state === 'pending').length,
      color: 'info',
    },
  };

  return (
    <div className="quality">
      <Crumbs
        items={[
          { label: t('quality.crumbServices'), href: '#/services' },
          { label: name, href: `#/services/${encodeURIComponent(id)}` },
        ]}
      />
      {embedded ? null : (
        <div className="row-wrap">
          <Heading level={1} data-size="md">
            {name}
          </Heading>
          <Tag data-color="success">{t('quality.inUse', { version: String(latest.version) })}</Tag>
          <Tag data-color={riskTag[risk].color}>{t(riskTag[risk].text)}</Tag>
        </div>
      )}
      <Tabs value={tab} onChange={(v) => choose(tabFrom(v, live))}>
        <Tabs.List aria-label={t('quality.title')}>
          {(live ? liveTabs : tabs.filter((x) => x !== 'gates')).map((x) => {
            const b = badges[x];
            return (
              <Tabs.Tab key={x} value={x}>
                {t(tabLabel[x])}
                {b && b.n > 0 ? (
                  <>
                    <Badge data-color={b.color} count={b.n} aria-hidden="true" />
                    <span className="visually-hidden">{t('quality.newCount', { count: b.n })}</span>
                  </>
                ) : null}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
        <div aria-live="polite" className="quality-flash">
          {flash ? (
            <Alert data-color={flash.color} data-size="sm">
              {flash.text}
            </Alert>
          ) : null}
        </div>
        <Tabs.Panel value="testsets">
          {tab === 'testsets' && live ? (
            <LiveTestSets api={api} tenant={tenant} serviceId={id} setFlash={setFlash} />
          ) : tab === 'testsets' ? (
            <TestSetsTab
              sets={sets}
              runs={runs}
              live={live}
              extraCases={extraCases}
              onAddCase={addCase}
              setFlash={setFlash}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="gates">
          {tab === 'gates' && live ? <TenantGates api={api} tenant={tenant} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="feedback">
          {tab === 'feedback' ? (
            <FeedbackTab
              feedback={feedback}
              added={added}
              onAdded={(f, c) => setAdded((a) => ({ ...a, [f]: c }))}
              onAddCase={addCase}
              onShowProposal={(p) => {
                setSelected(p);
                choose('proposals');
              }}
              {...(live
                ? {
                    onPropose: async (f: FeedbackDetail, input: string, expected: string) => {
                      try {
                        await api.quality.proposeCandidate(
                          tenant,
                          {
                            service: id,
                            input,
                            expected,
                            origin: 'feedback',
                            ...(f.run ? { task: f.run } : {}),
                          },
                          t('quality.proposeReason'),
                        );
                        return true;
                      } catch (error) {
                        setFlash({ text: problemTitle(error, t), color: 'danger' });
                        return false;
                      }
                    },
                  }
                : {})}
              setFlash={setFlash}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="proposals">
          {tab === 'proposals' && live ? (
            <Improvements api={api} tenant={tenant} serviceId={id} setFlash={setFlash} />
          ) : tab === 'proposals' ? (
            <ProposalsTab
              high={high}
              selected={selected}
              onSelect={setSelected}
              decisions={decisions}
              onDecide={(p, d) => setDecisions((all) => ({ ...all, [p]: d }))}
              setFlash={setFlash}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="publish">
          {tab === 'publish' && !live ? (
            <PublishTab
              tenantName={tenantName}
              currentVersion={latest.version}
              approvers={decisions['F-12']?.approvers ?? []}
              setFlash={setFlash}
              onPublish={async (reason) => {
                await api.publishDefinition(latest.definition, latest.files ?? {}, reason);
              }}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="preview">{tab === 'preview' ? <PreviewTab /> : null}</Tabs.Panel>
      </Tabs>
    </div>
  );
};
