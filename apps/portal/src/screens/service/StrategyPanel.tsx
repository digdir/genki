import { Alert, Heading, Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import { Fragment } from 'react';
import type { ApiClient } from '../../api';
import type { ServiceDefinition, SpecEdit } from '../../data/service-definition';
import { withStrategy } from '../../data/service-form';
import {
  strategiesFor,
  readPath,
  strategyFor,
  writePath,
  type PlatformStrategy,
} from '../../data/strategies';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import type { Format } from '@genai/i18n';
import { SelectField } from '../stepflows/fields';
import { SchemaForm, undescribedPaths, type Value, type WidgetRenderer } from '@genai/schema-forms';
import { useMemo } from 'react';
import { useStrategySchema } from './strategy-schema';

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (t: T, f: Format, v: unknown): string =>
  Array.isArray(v)
    ? v.map((x) => show(t, f, x)).join(', ')
    : isRaw(v)
      ? Object.entries(v)
          .map(([k, x]) => `${k}: ${show(t, f, x)}`)
          .join(', ')
      : typeof v === 'boolean'
        ? v
          ? t('serviceStrategy.on')
          : t('serviceStrategy.off')
        : typeof v === 'number'
          ? f.number(v)
          : String(v);

const leafPaths = (config: Raw, prefix: string[] = []): string[][] =>
  Object.entries(config).flatMap(([k, v]) =>
    isRaw(v) && Object.keys(v).length ? leafPaths(v, [...prefix, k]) : [[...prefix, k]],
  );

const shownElsewhere = new Set(['instructions', 'examples']);

const flowId = (ref: unknown) => (typeof ref === 'string' ? ref.replace(/@[\d.]+$/, '') : '');

const FlowPicker = ({
  api,
  tenant,
  id,
  value,
  onSet,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  value: unknown;
  onSet: (value: unknown) => void;
}) => {
  const t = useT();
  const [state] = useAsync(
    async (signal) =>
      (await api.listDefinitions(tenant, signal))
        .filter((d) => d.kind === 'StepFlow')
        .map((d) => ({
          value: `${d.id}@${d.latestVersion}`,
          label: t('serviceStrategy.flowOption', { id: d.id, version: d.latestVersion }),
        })),
    [api, tenant],
  );
  const current = typeof value === 'string' ? value : '';
  const published = state.status === 'ready' ? state.data : [];
  const options =
    current && !published.some((o) => o.value === current)
      ? [
          { value: current, label: t('serviceStrategy.flowUnpublished', { flow: current }) },
          ...published,
        ]
      : published;
  const chosen = flowId(current);
  return (
    <div className="stack-xs">
      <SelectField
        id={id}
        label={t('serviceStrategy.flow')}
        description={
          state.status === 'loading'
            ? t('serviceStrategy.flowsLoading')
            : published.length === 0
              ? t('serviceStrategy.flowsNone')
              : t('serviceStrategy.flowsPick')
        }
        value={current}
        placeholder={t('serviceStrategy.flowPlaceholder')}
        options={options}
        {...(current ? {} : { error: t('serviceStrategy.flowRequired') })}
        onChange={(v) => onSet(v || undefined)}
      />
      <Link href={chosen ? `#/step-flows/${encodeURIComponent(chosen)}` : '#/step-flows'}>
        {t('serviceStrategy.openEditor')}
      </Link>
    </div>
  );
};

interface FlowStep {
  id: string;
  name: string;
  what: string;
}

const flowSteps = (t: T, raw: unknown): FlowStep[] =>
  (Array.isArray(raw) ? raw : []).filter(isRaw).map((s) => {
    const nested = (k: string) => (isRaw(s[k]) && Array.isArray(s[k].steps) ? s[k].steps : []);
    const what =
      typeof s.block === 'string'
        ? t('serviceStrategy.block', { block: s.block })
        : isRaw(s.repeat)
          ? t('serviceStrategy.repeats', { count: nested('repeat').length })
          : isRaw(s.forEach)
            ? t('serviceStrategy.forEach', { count: nested('forEach').length })
            : s.switchOn !== undefined
              ? t('serviceStrategy.chooses')
              : typeof s.subflow === 'string'
                ? t('serviceStrategy.subflow', { flow: s.subflow })
                : '';
    const id = String(s.id ?? '');
    return { id, name: typeof s.name === 'string' ? s.name : id, what };
  });

const FlowSummary = ({ api, tenant, flow }: { api: ApiClient; tenant: string; flow: string }) => {
  const t = useT();
  const [state] = useAsync(
    async (signal) => {
      const def = await api.getDefinition(tenant, 'StepFlow', flow, signal);
      const spec = (def.latest.definition.spec ?? {}) as Raw;
      return {
        version: def.latest.version,
        purpose: typeof spec.purpose === 'string' ? spec.purpose : '',
        steps: flowSteps(t, spec.steps),
      };
    },
    [api, tenant, flow],
  );
  const link = (
    <Link href={`#/step-flows/${encodeURIComponent(flow)}`}>
      {t('serviceStrategy.openFlow', { flow })}
    </Link>
  );
  if (state.status === 'loading') return <p className="meta">{t('serviceStrategy.flowLoading')}</p>;
  if (state.status === 'error')
    return (
      <p className="body-sm">
        {t('serviceStrategy.flowMissing', { flow })} {link}
      </p>
    );
  return (
    <div className="stack-sm">
      <Heading level={3} data-size="2xs">
        {t('serviceStrategy.stepsIn', { flow, version: state.data.version })}
      </Heading>
      {state.data.purpose ? <p className="body-sm">{state.data.purpose}</p> : null}
      <ol className="strategy-steps" aria-label={t('serviceStrategy.stepsLabel', { flow })}>
        {state.data.steps.map((s) => (
          <li key={s.id}>
            <strong>{s.name}</strong>
            {s.what ? <span className="meta">{s.what}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
};

export interface WayOfWorkingProps {
  api: ApiClient;
  tenant: string;
  raw: string;
  sid: string;
  config: Raw;
  model?: string | undefined;
  onPick: (id: string) => void;
  onConfig: (config: Raw) => void;
  idPrefix?: string;
  showSteps?: boolean;
  label?: string;
}

export const WayOfWorkingEditor = ({
  api,
  tenant,
  raw,
  sid,
  config,
  model,
  onPick,
  onConfig,
  idPrefix = 'strategi',
  showSteps = true,
  label,
}: WayOfWorkingProps) => {
  const t = useT();
  const fmt = useFormat();
  const strategy = strategyFor(sid, t);
  const unknown = raw && !strategyFor(raw, t) ? raw : '';
  const { schema, loading: schemaLoading } = useStrategySchema(api, sid);
  const rest = (
    schema
      ? undescribedPaths(schema, config).map((p) => p.split('.'))
      : leafPaths(config).filter((p) => !(sid === 'step-flow' && p.join('.') === 'flow'))
  ).filter((p) => !shownElsewhere.has(p[0] ?? ''));
  const setValue = (path: string[], value: unknown) => onConfig(writePath(config, path, value));
  const flow = flowId(readPath(config, ['flow']));
  const [available] = useAsync((signal) => api.listModels({}, signal), [api]);
  const modelOf =
    available.status === 'ready' ? available.data.find((m) => m.id === model) : undefined;
  const formSchema = useMemo(
    () =>
      schema?.properties
        ? {
            ...schema,
            properties: Object.fromEntries(
              Object.entries(schema.properties).filter(([key]) => !shownElsewhere.has(key)),
            ),
          }
        : schema,
    [schema],
  );
  const flowWidget = useMemo<WidgetRenderer>(
    () => (p) => (
      <FlowPicker
        api={api}
        tenant={tenant}
        id={`${idPrefix}-flow`}
        value={p.value}
        onSet={p.onChange}
      />
    ),
    [api, tenant, idPrefix],
  );
  const temperatureNote = (path: string) => {
    const rule = modelOf?.parameters?.temperature;
    if (!rule || !/temperature$/i.test(path)) return null;
    return (
      <p className="meta">
        {rule.mode === 'unsupported'
          ? t('serviceStrategy.temperatureIgnored')
          : t('serviceStrategy.temperatureFixed', { value: String(rule.value) })}
      </p>
    );
  };

  return (
    <div className="strategy-panel stack-sm">
      <SelectField
        id={`${idPrefix}-velg`}
        label={label ?? t('serviceStrategy.way')}
        description={t('serviceStrategy.wayDescription')}
        value={sid}
        options={strategiesFor(t).map((s) => ({ value: s.id, label: s.name }))}
        onChange={(v) => strategyFor(v, t) && onPick(v)}
      />
      {unknown ? (
        <Alert data-color="warning" data-size="sm">
          {t.rich('serviceStrategy.unknown', {
            unknown,
            code: (c) => <code>{c}</code>,
          })}
        </Alert>
      ) : null}
      {strategy && showSteps ? (
        <section aria-labelledby={`${idPrefix}-h`} className="stack-sm">
          <div className="row-wrap">
            <Heading level={3} data-size="2xs" id={`${idPrefix}-h`}>
              {strategy.name}
            </Heading>
            <Tag data-size="sm" data-color="neutral">
              {strategy.id}@1
            </Tag>
          </div>
          <Paragraph data-size="sm">{strategy.description}</Paragraph>
          <PipelineSteps steps={strategy.pipeline} />
        </section>
      ) : null}
      {strategy ? (
        <section aria-labelledby={`${idPrefix}-innst-h`} className="stack-sm">
          <Heading level={3} data-size="2xs" id={`${idPrefix}-innst-h`}>
            {t('serviceStrategy.settings')}
          </Heading>
          <div className="strategy-fields">
            {formSchema ? (
              <SchemaForm
                key={sid}
                schema={formSchema}
                value={config as Value}
                onChange={(next) => onConfig(next as Raw)}
                fetchJson={api.getJson}
                routeParams={{ tenant }}
                showErrors
                summary={false}
                idPrefix={idPrefix}
                widgets={sid === 'step-flow' ? { flow: flowWidget } : {}}
                after={temperatureNote}
              />
            ) : sid === 'step-flow' && !schemaLoading ? (
              <FlowPicker
                key={`${sid}-flow`}
                api={api}
                tenant={tenant}
                id={`${idPrefix}-flow`}
                value={readPath(config, ['flow'])}
                onSet={(v) => setValue(['flow'], v)}
              />
            ) : (
              <p className="meta">{t('serviceStrategy.settingsLoading')}</p>
            )}
          </div>
          {rest.length ? (
            <div className="stack-xs">
              <span className="ds-label">{t('serviceStrategy.otherValues')}</span>
              <dl className="kv">
                {rest.map((p) => (
                  <Fragment key={p.join('.')}>
                    <dt>
                      <code>{p.join('.')}</code>
                    </dt>
                    <dd>{show(t, fmt, readPath(config, p))}</dd>
                  </Fragment>
                ))}
              </dl>
              <p className="meta">{t('serviceStrategy.editInYaml')}</p>
            </div>
          ) : null}
        </section>
      ) : null}
      {showSteps && sid === 'step-flow' && flow ? (
        <FlowSummary api={api} tenant={tenant} flow={flow} />
      ) : null}
    </div>
  );
};

export const PipelineSteps = ({ steps }: { steps: PlatformStrategy['pipeline'] }) => {
  const t = useT();
  return steps.length ? (
    <ol className="strategy-steps" aria-label={t('serviceStrategy.pipelineLabel')}>
      {steps.map(([title, text, repeats]) => (
        <li key={title} className={repeats ? 'repeats' : undefined}>
          <strong>{title}</strong>
          <span className="meta">{text}</span>
        </li>
      ))}
    </ol>
  ) : null;
};

export const StrategyPanel = ({
  api,
  tenant,
  definition: d,
  patch,
}: {
  api: ApiClient;
  tenant: string;
  definition: ServiceDefinition;
  patch: (edit: SpecEdit) => void;
}) => (
  <WayOfWorkingEditor
    api={api}
    tenant={tenant}
    raw={d.spec.strategy.id}
    sid={d.spec.strategy.id}
    config={d.spec.strategy.config}
    model={d.spec.model.primary}
    onPick={(id) => patch((cur) => withStrategy(cur.spec, id))}
    onConfig={(config) => patch((cur) => ({ strategy: { ...cur.spec.strategy, config } }))}
  />
);
