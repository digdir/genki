import { Chip, Details, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient, ConfigEntry } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { Loading } from '../../states';
import { PageEmpty, PageError, PageLead } from './PageStates';

type Filter = 'all' | 'required' | 'optional';

interface RuleSpec {
  kind?: string;
  name?: string;
  stage?: 'input' | 'output' | 'both';
  action?: 'refuse' | 'mask';
  mask?: string;
  message?: string;
  description?: string;
}

export interface SharedRule {
  id: string;
  name: string;
  required: boolean;
  spec: RuleSpec;
  usedBy: { id: string; name: string }[];
}

const ruleIdOf = (entry: ConfigEntry) => entry.id.replace(/^\d{9}\//, '');

export const sharedRules = (
  entries: ConfigEntry[],
  blocks: { id: string; usedBy: { id: string; name: string }[] }[],
): SharedRule[] =>
  entries
    .filter((e) => !e.builtin)
    .map((e) => {
      const spec = e.spec as RuleSpec;
      const id = ruleIdOf(e);
      return {
        id,
        name: spec.name ?? id,
        required: e.mandatory === true,
        spec,
        usedBy: blocks.find((b) => b.id === `custom-rules/${id}`)?.usedBy ?? [],
      };
    })
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));

export const whenItFires = (t: T, spec: RuleSpec) => {
  const where = t(
    spec.stage === 'output'
      ? 'devGuardrails.onAnswer'
      : spec.stage === 'both'
        ? 'devGuardrails.onBoth'
        : 'devGuardrails.onQuestion',
  );
  return spec.action === 'mask'
    ? t('devGuardrails.thenMask', { where, mask: spec.mask ?? '[fjernet]' })
    : spec.message
      ? t('devGuardrails.thenRefuseWith', { where, message: spec.message })
      : t('devGuardrails.thenRefuse', { where });
};

/** Felles sikkerhetsfiltre: the guardrails every service, or the services that chose them, run. */
export const Guardrails = ({
  api,
  tenant,
  tenantName,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('all');
  const [state, retry] = useAsync(
    async (signal) => {
      const [rules, blocks] = await Promise.all([
        api.configList(`/tenants/${encodeURIComponent(tenant)}/guardrail-rules`, signal),
        api.buildingBlocks.list(tenant, { kind: 'guardrail' }, signal).then(
          (r) => r.data,
          () => [],
        ),
      ]);
      return sharedRules(rules.data, blocks);
    },
    [api, tenant],
  );
  const lead = <PageLead text={t('devGuardrails.lead', { tenant: tenantName })} />;
  if (state.status === 'loading')
    return (
      <>
        {lead}
        <Loading label={t('devGuardrails.loading')} shape="list" onRetry={retry} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {lead}
        <PageError
          error={state.error}
          title={t('devGuardrails.errorTitle')}
          text={t('devGuardrails.errorText')}
          onRetry={retry}
        />
      </>
    );
  const rules = state.data;
  if (rules.length === 0)
    return (
      <>
        {lead}
        <PageEmpty title={t('devGuardrails.emptyTitle')} text={t('devGuardrails.emptyText')}>
          <a href="#/building-blocks/catalogue?type=guardrail">{t('devGuardrails.seeBlocks')}</a>
        </PageEmpty>
      </>
    );
  const counts: Record<Filter, number> = {
    all: rules.length,
    required: rules.filter((r) => r.required).length,
    optional: rules.filter((r) => !r.required).length,
  };
  const shown = rules.filter((r) =>
    filter === 'all' ? true : filter === 'required' ? r.required : !r.required,
  );
  return (
    <>
      {lead}
      <div className="tag-row" role="group" aria-label={t('devGuardrails.filter')}>
        {(['all', 'required', 'optional'] as const).map((key) => (
          <Chip.Radio
            key={key}
            name="guardrail-filter"
            checked={filter === key}
            onChange={() => setFilter(key)}
          >
            {t(
              key === 'all'
                ? 'devGuardrails.all'
                : key === 'required'
                  ? 'devGuardrails.required'
                  : 'devGuardrails.optional',
              { count: counts[key] },
            )}
          </Chip.Radio>
        ))}
      </div>
      <ul className="plain-list stack-sm">
        {shown.map((r) => (
          <li key={r.id}>
            <Details className="dev-rule">
              <Details.Summary>
                <span className="dev-rule-summary">
                  <span className="int-row-name">{r.name}</span>
                  <Tag data-size="sm" data-color={r.required ? 'info' : 'neutral'}>
                    {t(r.required ? 'devGuardrails.requiredTag' : 'devGuardrails.optionalTag')}
                  </Tag>
                  <span className="meta">
                    {r.required
                      ? t('devGuardrails.allServices')
                      : t('devGuardrails.services', { count: r.usedBy.length })}
                  </span>
                </span>
              </Details.Summary>
              <Details.Content>
                <div className="stack-sm">
                  {r.spec.description ? <Paragraph>{r.spec.description}</Paragraph> : null}
                  <Paragraph>
                    <strong>{t('devGuardrails.whenFires')}</strong> {whenItFires(t, r.spec)}
                  </Paragraph>
                  {r.usedBy.length > 0 ? (
                    <Paragraph>
                      {t('devGuardrails.usedBy')}{' '}
                      {r.usedBy.map((s, i) => (
                        <span key={s.id}>
                          {i > 0 ? ', ' : null}
                          <a href={`#/services/${encodeURIComponent(s.id)}`}>{s.name}</a>
                        </span>
                      ))}
                    </Paragraph>
                  ) : null}
                </div>
              </Details.Content>
            </Details>
          </li>
        ))}
      </ul>
    </>
  );
};
