import { Button, Heading, Paragraph, Radio, Tag } from '@digdir/designsystemet-react';
import { useLocale } from '@genai/i18n/react';
import { defaultsOf, SchemaForm, type Value } from '@genai/schema-forms';
import { useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { Recipe } from '../../api/recipes';
import type { StrategyRef } from '../../data/service-definition';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { RecipeDiagram } from './WayDiagram';

interface Props {
  api: ApiClient;
  tenant: string;
  prefix: string;
  name: string;
  strategy: StrategyRef;
  dataset?: string | undefined;
  onChange: (strategy: StrategyRef) => void;
  custom: ReactNode;
}

const settingsOf = (strategy: StrategyRef): Value => {
  const settings = strategy.config.settings;
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Value)
    : {};
};

export const pinnedOf = (strategy: StrategyRef) => {
  const flow = strategy.config.flow;
  if (strategy.id !== 'step-flow' || typeof flow !== 'string') return undefined;
  const at = flow.lastIndexOf('@');
  const version = Number(flow.slice(at + 1));
  return at > 0 && Number.isInteger(version) ? { id: flow.slice(0, at), version } : undefined;
};

export const settingParams = (
  tenant: string,
  dataset: string | undefined,
  settings: Value,
): Record<string, string> => {
  const slash = dataset?.indexOf('/') ?? -1;
  return {
    ...Object.fromEntries(
      Object.entries(settings).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ),
    tenant,
    ...(dataset
      ? {
          dataset,
          datasetOwner: slash > 0 ? dataset.slice(0, slash) : tenant,
          datasetKey: slash > 0 ? dataset.slice(slash + 1) : dataset,
        }
      : {}),
  };
};

export const RecipeWay = ({
  api,
  tenant,
  prefix,
  name,
  strategy,
  dataset,
  onChange,
  custom,
}: Props) => {
  const t = useT();
  const { locale } = useLocale();
  const [state] = useAsync((signal) => api.recipes.list(tenant, signal), [api, tenant]);
  const pin = pinnedOf(strategy);
  const [pinnedState] = useAsync(
    (signal) =>
      pin
        ? api.recipes.version(tenant, pin.id, pin.version, signal).catch(() => undefined)
        : Promise.resolve(undefined),
    [api, tenant, pin?.id, pin?.version],
  );
  const [mode, setMode] = useState<'recipe' | 'custom'>();
  if (state.status === 'loading') return <p className="meta">{t('setup.recipeLoading')}</p>;
  const recipes = state.status === 'ready' ? state.data : [];
  const latest = pin ? recipes.find((r) => r.id === pin.id) : undefined;
  const pinned = pinnedState.status === 'ready' ? pinnedState.data : undefined;
  const chosen = pinned ?? (latest && latest.version === pin?.version ? latest : undefined);
  const fresh = Object.keys(strategy.config).length === 0;
  const current = mode ?? (chosen || latest || (fresh && recipes.length > 0) ? 'recipe' : 'custom');
  const settings = settingsOf(strategy);
  const pick = (recipe: Recipe) =>
    onChange({
      id: 'step-flow',
      version: 1,
      config: { flow: recipe.ref, settings: defaultsOf(recipe.settings) },
    });
  const update = (recipe: Recipe) => {
    const known = Object.keys(recipe.settings.properties ?? {});
    onChange({
      ...strategy,
      config: {
        ...strategy.config,
        flow: recipe.ref,
        settings: {
          ...defaultsOf(recipe.settings),
          ...Object.fromEntries(Object.entries(settings).filter(([k]) => known.includes(k))),
        },
      },
    });
  };

  return (
    <div className="stack-sm">
      {state.status === 'error' ? <p className="meta">{t('setup.recipeFailed')}</p> : null}
      {recipes.length === 0 && state.status === 'ready' ? (
        <p className="meta">{t('setup.recipeNone')}</p>
      ) : null}
      {recipes.length > 0 ? (
        <fieldset className="plain-fieldset stack-xs">
          <legend className="ds-label">{t('setup.variantWayHow')}</legend>
          <Radio
            name={`${prefix}-how`}
            label={t('setup.variantWayRecipe')}
            description={t('setup.variantWayRecipeDesc')}
            checked={current === 'recipe'}
            onChange={() => setMode('recipe')}
          />
          <Radio
            name={`${prefix}-how`}
            label={t('setup.variantWayCustom')}
            description={t('setup.variantWayCustomDesc')}
            checked={current === 'custom'}
            onChange={() => setMode('custom')}
          />
        </fieldset>
      ) : null}
      {current === 'recipe' && recipes.length > 0 ? (
        <>
          <fieldset className="plain-fieldset stack-xs">
            <legend className="ds-label">{t('setup.recipePick', { name })}</legend>
            {recipes.map((r) => (
              <Radio
                key={r.ref}
                name={`${prefix}-recipe`}
                label={r.title[locale]}
                description={
                  r.origin === 'shared'
                    ? `${r.summary[locale]} ${t('setup.recipeSharedByDigdir')}`
                    : r.summary[locale]
                }
                checked={pin?.id === r.id}
                onChange={() => pick(r)}
              />
            ))}
          </fieldset>
          {pin && (chosen || latest) ? (
            <div className="row-wrap">
              <Tag data-size="sm" data-color="neutral">
                {t('setup.recipeVersion', { version: pin.version })}
              </Tag>
              {latest && latest.version > pin.version ? (
                <Button variant="secondary" data-size="sm" onClick={() => update(latest)}>
                  {t('setup.recipeUpdate', { version: latest.version })}
                </Button>
              ) : null}
            </div>
          ) : null}
          {chosen ? (
            <section aria-labelledby={`${prefix}-recipe-settings-h`} className="stack-xs">
              <Heading level={4} data-size="2xs" id={`${prefix}-recipe-settings-h`}>
                {t('setup.recipeSettings', { name })}
              </Heading>
              {Object.keys(chosen.settings.properties ?? {}).length > 0 ? (
                <SchemaForm
                  key={chosen.ref}
                  schema={chosen.settings}
                  value={settings}
                  onChange={(next) =>
                    onChange({ ...strategy, config: { ...strategy.config, settings: next } })
                  }
                  fetchJson={api.getJson}
                  routeParams={settingParams(tenant, dataset, settings)}
                  showErrors
                  summary={false}
                  idPrefix={`${prefix}-recipe`}
                />
              ) : (
                <Paragraph data-size="sm" className="meta">
                  {t('setup.recipeNoSettings')}
                </Paragraph>
              )}
            </section>
          ) : null}
          {chosen ? (
            <section aria-labelledby={`${prefix}-diagram-h`} className="stack-xs">
              <Heading level={4} data-size="2xs" id={`${prefix}-diagram-h`}>
                {t('setup.variantDiagram', { name })}
              </Heading>
              <RecipeDiagram api={api} tenant={tenant} recipe={chosen} />
            </section>
          ) : null}
        </>
      ) : (
        custom
      )}
    </div>
  );
};
