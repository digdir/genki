import {
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Radio,
  Select,
  Switch,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useLocale } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { variantSlug, type ModelChoice } from '../../data/services';
import type { StrategyRef, VariantSpec } from '../../data/service-definition';
import { strategiesFor, strategyFor } from '../../data/strategies';
import { useT } from '../../i18n';
import { WayOfWorkingEditor } from '../service/StrategyPanel';
import { SelectField } from '../stepflows/fields';
import { RecipeWay } from './RecipeWay';
import { WayDiagram, type Way } from './WayDiagram';
import './sections.css';

interface Props {
  serviceId: string;
  publicName: string;
  variants: VariantSpec[];
  models: ModelChoice[];
  service: Way;
  model: string;
  onChange: (variants: VariantSpec[]) => void;
  api?: ApiClient | undefined;
  tenant?: string | undefined;
  dataset?: string | undefined;
}

const blank = (id: string): VariantSpec => ({ id });

const titled = (v: VariantSpec, title: { nb: string; en: string }): VariantSpec =>
  title.nb || title.en ? { ...v, title } : without(v, 'title');

const without = (v: VariantSpec, key: keyof VariantSpec): VariantSpec =>
  Object.fromEntries(Object.entries(v).filter(([k]) => k !== key)) as VariantSpec;

export const VariantsEditor = ({
  serviceId,
  publicName,
  variants,
  models,
  service,
  model,
  onChange,
  api,
  tenant,
  dataset,
}: Props) => {
  const t = useT();
  const locale = useLocale().locale;
  const [newId, setNewId] = useState('');
  const list = variants?.length ? variants : [blank('default')];
  const replace = (index: number, next: VariantSpec) =>
    onChange(list.map((v, i) => (i === index ? next : v)));
  const set = (index: number, patch: Partial<VariantSpec>) =>
    replace(index, { ...(list[index] as VariantSpec), ...patch });
  const setStrategy = (index: number, strategy: StrategyRef) => set(index, { strategy });
  const problem = !newId
    ? ''
    : !variantSlug.test(newId)
      ? t('setup.variantIdInvalid')
      : list.some((v) => v.id === newId)
        ? t('setup.variantIdTaken')
        : '';
  const add = () => {
    if (!newId || problem) return;
    onChange([...list, blank(newId)]);
    setNewId('');
  };
  const serviceName = strategyFor(service.strategy, t)?.name ?? service.strategy;
  return (
    <div className="stack-sm">
      <Paragraph data-size="sm" className="meta">
        {t('setup.variantsHelp')}
      </Paragraph>
      <ul className="plain-list stack-sm">
        {list.map((v, i) => {
          const names = v.title ?? { nb: '', en: '' };
          const title = locale === 'en' ? names.en || names.nb : names.nb || names.en;
          const name = i === 0 ? t('setup.variantDefault') : title || v.id;
          const own = v.strategy;
          const prefix = `variant-${v.id}`;
          const way: Way = own ? { strategy: own.id, config: own.config } : service;
          const diagram = (
            <section aria-labelledby={`${prefix}-diagram-h`} className="stack-xs">
              <Heading level={4} data-size="2xs" id={`${prefix}-diagram-h`}>
                {t('setup.variantDiagram', { name })}
              </Heading>
              <WayDiagram way={way} api={api} tenant={tenant} />
            </section>
          );
          return (
            <li key={v.id} className="variant-card stack-sm" aria-labelledby={`${prefix}-h`}>
              <div className="row-wrap">
                <Heading level={3} data-size="2xs" id={`${prefix}-h`}>
                  {name}
                </Heading>
                <Tag data-size="sm" data-color="neutral">
                  {v.id}
                </Tag>
              </div>
              <div className="variant-fields">
                <Textfield
                  data-size="sm"
                  label={t('setup.variantNameNb')}
                  value={names.nb}
                  onChange={(e) => replace(i, titled(v, { ...names, nb: e.target.value }))}
                />
                <Textfield
                  data-size="sm"
                  label={t('setup.variantNameEn')}
                  value={names.en}
                  onChange={(e) => replace(i, titled(v, { ...names, en: e.target.value }))}
                />
                {i > 0 ? (
                  <Textfield
                    data-size="sm"
                    label={t('setup.variantPublicName')}
                    description={t('setup.variantPublicNameHelp', {
                      name: `${serviceId}__${v.id}`,
                    })}
                    value={v.publicName ?? ''}
                    onChange={(e) =>
                      replace(
                        i,
                        e.target.value
                          ? { ...v, publicName: e.target.value }
                          : without(v, 'publicName'),
                      )
                    }
                  />
                ) : null}
                {i > 0 ? (
                  <Field data-size="sm">
                    <Label>{t('setup.variantModel')}</Label>
                    <Select
                      value={v.model ?? ''}
                      onChange={(e) =>
                        replace(
                          i,
                          e.target.value ? { ...v, model: e.target.value } : without(v, 'model'),
                        )
                      }
                    >
                      <Select.Option value="">{t('setup.variantModelSame')}</Select.Option>
                      {models.map((m) => (
                        <Select.Option key={m.id} value={m.id}>
                          {m.name}
                        </Select.Option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
              </div>
              {i === 0 ? (
                <p className="meta">
                  {t.rich('setup.variantPublicNameDefault', {
                    name: publicName || `${serviceId}__default`,
                    code: (c) => <code>{c}</code>,
                  })}
                </p>
              ) : null}
              {i > 0 || own ? (
                <fieldset className="plain-fieldset stack-xs">
                  <legend className="ds-label">{t('setup.variantWay')}</legend>
                  <Radio
                    name={`${prefix}-way`}
                    label={t('setup.variantWaySame')}
                    description={t('setup.variantWaySameDesc', { name: serviceName })}
                    checked={!own}
                    onChange={() => replace(i, without(v, 'strategy'))}
                  />
                  <Radio
                    name={`${prefix}-way`}
                    label={t('setup.variantWayOwn')}
                    description={t('setup.variantWayOwnDesc')}
                    checked={!!own}
                    onChange={() =>
                      own || setStrategy(i, { id: service.strategy, version: 1, config: {} })
                    }
                  />
                </fieldset>
              ) : (
                <p className="meta">{t('setup.variantWayDefault')}</p>
              )}
              {i > 0 ? (
                <Switch
                  data-size="sm"
                  label={t('setup.variantChat')}
                  description={t('setup.variantChatHelp')}
                  checked={v.chat !== false}
                  onChange={(e) =>
                    replace(i, e.target.checked ? without(v, 'chat') : { ...v, chat: false })
                  }
                />
              ) : (
                <p className="meta">{t('setup.variantChatDefault')}</p>
              )}
              {own && api && tenant ? (
                <RecipeWay
                  api={api}
                  tenant={tenant}
                  prefix={prefix}
                  name={name}
                  strategy={own}
                  dataset={dataset}
                  onChange={(strategy) => setStrategy(i, strategy)}
                  custom={
                    <>
                      <WayOfWorkingEditor
                        api={api}
                        tenant={tenant}
                        raw={own.id}
                        sid={strategyFor(own.id) ? own.id : service.strategy}
                        config={own.config}
                        model={v.model ?? model}
                        idPrefix={`${prefix}-strategi`}
                        label={t('setup.variantWayPick', { name })}
                        showSteps={false}
                        onPick={(id) => setStrategy(i, { id, version: 1, config: {} })}
                        onConfig={(config) => setStrategy(i, { ...own, config })}
                      />
                      {diagram}
                    </>
                  }
                />
              ) : own ? (
                <>
                  <SelectField
                    id={`${prefix}-strategi-velg`}
                    label={t('setup.variantWayPick', { name })}
                    value={own.id}
                    options={strategiesFor(t).map((s) => ({ value: s.id, label: s.name }))}
                    onChange={(id) => setStrategy(i, { id, version: 1, config: {} })}
                  />
                  {diagram}
                </>
              ) : (
                diagram
              )}
              {i > 0 ? (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  className="align-start"
                  aria-label={t('setup.variantRemove', { id: v.id })}
                  onClick={() => onChange(list.filter((_, j) => j !== i))}
                >
                  {t('common.remove')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="variant-add">
        <Textfield
          data-size="sm"
          label={t('setup.variantNewId')}
          value={newId}
          error={problem || undefined}
          onChange={(e) => setNewId(e.target.value)}
        />
        <Button
          variant="secondary"
          data-size="sm"
          aria-disabled={!newId || !!problem || undefined}
          onClick={add}
        >
          {t('setup.variantAdd')}
        </Button>
      </div>
    </div>
  );
};
