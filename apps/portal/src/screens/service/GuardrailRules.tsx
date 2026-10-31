import { Paragraph } from '@digdir/designsystemet-react';
import type { ApiClient, ConfigEntry } from '../../api';
import { translator, useT, type PlainKey, type T } from '../../i18n';
import { Registry } from '../config/Registry';

export const ruleTemplate = {
  kind: 'regex',
  pattern: '',
  stage: 'input',
  action: 'refuse',
  message: translator('nb')('serviceGuardrails.defaultMessage'),
};

const kindLabel: Record<string, PlainKey> = {
  regex: 'serviceGuardrails.kindRegex',
  denylist: 'serviceGuardrails.kindDenylist',
  'llm-judge': 'serviceGuardrails.kindJudge',
  'mcp-check': 'serviceGuardrails.kindMcp',
};

const describe = (t: T, e: ConfigEntry) => {
  const s = e.spec as { kind?: string; stage?: string; description?: string };
  const key = kindLabel[s.kind ?? ''];
  return [key ? t(key) : s.kind, s.stage, s.description].filter(Boolean).join(' · ');
};

export const GuardrailRules = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const base = `/tenants/${encodeURIComponent(tenant)}/guardrail-rules`;
  return (
    <div className="stack-sm">
      <Paragraph data-size="sm">{t('serviceGuardrails.intro')}</Paragraph>
      <Registry
        api={api}
        scope={tenant}
        label={t('serviceGuardrails.label')}
        paths={{
          list: base,
          item: (id) => `${base}/${encodeURIComponent(id)}`,
          history: (id) => `${base}/${encodeURIComponent(id)}/versions`,
        }}
        template={ruleTemplate}
        mandatory
        headingLevel={4}
        describe={(e) => describe(t, e)}
      />
    </div>
  );
};
