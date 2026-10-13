import { Tabs, TabsList, TabsPanel, TabsTab } from '@digdir/designsystemet-react';
import type { ApiClient } from '../api';
import { useT, type PlainKey, type T } from '../i18n';
import { EmptyState } from '../states';
import type { ConfigEntry } from '../types';
import { PageHeader } from '../ui';
import {
  Registry,
  ScopeBar,
  scopeEyebrow,
  useConfigScope,
  type ConfigScope,
} from './config/Registry';

const platformOnly = (e: ConfigEntry) => !e.scope || e.scope === 'platform';

export const gateTemplate = {
  metric: '',
  kind: 'threshold',
  threshold: 0.7,
  maxRegression: 0,
  perTag: false,
  split: 'validation',
};

export const ruleTemplate = {
  kind: 'regex',
  pattern: '',
  stage: 'input',
  action: 'refuse',
  message: 'Forespørselen ble stoppet av en regel.',
};

const describeGate = (e: ConfigEntry, t: T) => {
  const s = e.spec as { metric?: string; kind?: string; threshold?: number };
  return [
    s.metric,
    s.kind === 'threshold'
      ? t('policies.atLeast', { threshold: s.threshold ?? '' })
      : t('policies.noRegression'),
  ]
    .filter(Boolean)
    .join(' · ');
};

const ruleKindLabel: Record<string, PlainKey> = {
  regex: 'policies.kindRegex',
  denylist: 'policies.kindDenylist',
  'llm-judge': 'policies.kindLlmJudge',
  'mcp-check': 'policies.kindMcpCheck',
};

const describeRule = (e: ConfigEntry, t: T) => {
  const s = e.spec as { kind?: string; stage?: string; description?: string };
  const kind = ruleKindLabel[s.kind ?? ''];
  return [kind ? t(kind) : s.kind, s.stage, s.description].filter(Boolean).join(' · ');
};

const PolicyRegistry = ({
  api,
  scope,
  path,
  label,
  template,
  describe,
}: {
  api: ApiClient;
  scope: ConfigScope;
  path: 'gates' | 'guardrail-rules';
  label: string;
  template: Record<string, unknown>;
  describe: (e: ConfigEntry, t: T) => string;
}) => {
  const t = useT();
  if (scope.tenant !== undefined && !scope.view)
    return <EmptyState title={t('policies.chooseTenant')} />;
  const base = scope.view
    ? `/tenants/${encodeURIComponent(scope.view.id)}/${path}`
    : `/operator/${path}`;
  return (
    <Registry
      api={api}
      label={label}
      tenant={scope.view}
      paths={{
        list: base,
        item: (id) => `${base}/${encodeURIComponent(id)}`,
        history: (id) => `${base}/${encodeURIComponent(id)}/versions`,
      }}
      template={template}
      mandatory={!scope.view}
      {...(scope.view ? {} : { filter: platformOnly })}
      describe={(e) => describe(e, t)}
    />
  );
};

export const Policies = ({ api, tab }: { api: ApiClient; tab: string | undefined }) => {
  const t = useT();
  const current = tab === 'guardrails' ? 'guardrails' : 'gates';
  const scope = useConfigScope(api, '/policies', current);
  const eyebrow = scopeEyebrow(scope);
  return (
    <>
      <PageHeader
        title={t('policies.title')}
        {...(eyebrow ? { eyebrow } : {})}
        intro={scope.view ? t('policies.introTenant') : t('policies.introPlatform')}
      />
      <ScopeBar scope={scope} />
      <Tabs value={current} onChange={(v) => scope.go(scope.tenant, v)}>
        <TabsList aria-label={t('policies.title')}>
          <TabsTab value="gates">{t('policies.tabGates')}</TabsTab>
          <TabsTab value="guardrails">{t('policies.tabGuardrails')}</TabsTab>
        </TabsList>
        <TabsPanel value="gates">
          {current === 'gates' ? (
            <PolicyRegistry
              api={api}
              scope={scope}
              path="gates"
              label={t('policies.tabGates')}
              template={gateTemplate}
              describe={describeGate}
            />
          ) : null}
        </TabsPanel>
        <TabsPanel value="guardrails">
          {current === 'guardrails' ? (
            <PolicyRegistry
              api={api}
              scope={scope}
              path="guardrail-rules"
              label={t('policies.tabGuardrails')}
              template={ruleTemplate}
              describe={describeRule}
            />
          ) : null}
        </TabsPanel>
      </Tabs>
    </>
  );
};
