import {
  Button,
  Details,
  Field,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Switch,
  Tag,
  ToggleGroup,
} from '@digdir/designsystemet-react';
import { blockFixtures } from '@genai/contracts/block-fixtures';
import type { BlockDetail, BlockEvent, BlockState, RefBlockPayload } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { RefBlock } from '@genai/ui-assembly';
import '@genai/ui-assembly/styles.css';
import type { Look } from '@genai/ui-blocks/builder';
import '@genai/ui-blocks/styles.css';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { FieldProblem } from '../../api/design';
import { BusyButton } from '../../components/BusyButton';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { BuiltInPreview } from './BuiltInPreview';
import { StudioActionsFor } from './StudioActions';
import { CodeUpload } from './CodeUpload';
import { measure, type Measured } from './contrast';
import {
  asBlockDraft,
  bundlePath,
  sourcePrefix,
  type BlockDraft,
  type Bundle,
} from './definitions';
import { dayOf, titleOf, versionName, versionsPath } from './naming';
import { BlockTags, Crumbs, Panel, Summary, Toast } from './parts';
import { Problems } from './Problems';
import {
  choicesOf,
  coreIssueLink,
  defaultsOf,
  labelOf,
  missingFields,
  propsOf,
  withDefaults,
  type PropValue,
} from './props';
import { StructureEditor } from './StructureEditor';

const stateKey: Record<BlockState, PlainKey> = {
  filled: 'design.stateFilled',
  empty: 'design.stateEmpty',
  loading: 'design.stateLoading',
  error: 'design.stateError',
  partial: 'design.statePartial',
  disabled: 'design.stateDisabled',
};

const builtInStates: BlockState[] = ['filled', 'empty', 'loading', 'error'];
const stateOrder: BlockState[] = ['filled', 'empty', 'loading', 'error', 'partial', 'disabled'];

/** The states the stage offers: «Innhold» first, then each the block declares. */
export const stagesOf = (detail: Pick<BlockDetail, 'tier'>, declared: readonly BlockState[]) =>
  detail.tier === 'built-in'
    ? builtInStates
    : stateOrder.filter((s) => s === 'filled' || declared.includes(s));

interface Stage {
  state: BlockState;
  dark: boolean;
  size: 'sm' | 'md';
  look: Look;
}

interface Saved {
  kind: 'own' | 'pin';
  version?: number;
  service?: { id: string; name: string };
}

/** Block Studio for one block: the live stage on the left, props, a11y, changelog and users on the right. */
export const BlockStudio = ({
  api,
  tenant,
  publisher,
  id,
}: ScreenProps & { publisher: string; id: string }) => {
  const t = useT();
  const { locale } = useLocale();
  const [stage, setStage] = useState<Stage>({
    state: 'filled',
    dark: false,
    size: 'sm',
    look: 'current',
  });
  const [saved, setSaved] = useState<Saved | undefined>(undefined);
  const [state, retry] = useAsync(
    (signal) => api.design.detail(tenant, publisher, id, undefined, signal),
    [api, tenant, publisher, id],
    { keepPreviousFor: `${tenant}/${publisher}/${id}` },
  );
  const crumbs = (name?: string) => (
    <Crumbs
      items={[{ label: t('design.title'), href: '#/design' }, ...(name ? [{ label: name }] : [])]}
    />
  );
  if (state.status === 'loading')
    return (
      <div className="design-page">
        {crumbs()}
        <Loading label={t('design.loading')} shape="detail" onRetry={retry} />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="design-page">
        {crumbs()}
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  const detail = state.data;
  const name = titleOf(detail.title, locale);
  return (
    <div className="design-page">
      <div className="stack-xs">
        {crumbs(name)}
        <div className="design-head">
          <div className="stack-xs">
            <Heading level={1} data-size="lg">
              {name}
            </Heading>
            <div className="design-lead">
              <Summary detail={detail} />
              <BlockTags detail={detail} />
            </div>
          </div>
          <StudioActionsFor
            prompt={t('design.claudeBlockPrompt', {
              ref: `${detail.publisher}/${detail.id}@${detail.edition.version}`,
            })}
            versions={`#${versionsPath(detail.publisher, detail.id)}`}
          />
        </div>
      </div>
      <Studio
        key={detail.edition.version}
        api={api}
        tenant={tenant}
        detail={detail}
        stage={stage}
        onStage={setStage}
        saved={saved}
        onSaved={(next) => {
          setSaved(next);
          retry();
        }}
      />
    </div>
  );
};

const Studio = ({
  api,
  tenant,
  detail,
  stage,
  onStage,
  saved,
  onSaved,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
  stage: Stage;
  onStage: (stage: Stage) => void;
  saved: Saved | undefined;
  onSaved: (saved: Saved) => void;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const manage = useRights().has('manage-services');
  const base = useMemo(() => asBlockDraft(detail.edition.definition), [detail]);
  const props = useMemo(() => propsOf(detail.edition.definition), [detail]);
  const defaults = useMemo(() => defaultsOf(props), [props]);
  const [values, setValues] = useState(defaults);
  const [structure, setStructure] = useState<BlockDraft | 'not-yaml' | undefined>(undefined);
  const [bundle, setBundle] = useState<CodeEdit | undefined>(undefined);
  const [live, setLive] = useState<{ render?: RefBlockPayload; errors: FieldProblem[] }>({
    errors: [],
  });
  const own = detail.origin === 'own' && detail.tier !== 'built-in' && manage;
  const newest = detail.edition.version === detail.latest.version;
  const changedProps = Object.keys(values).filter((k) => values[k] !== defaults[k]);
  const name = titleOf(detail.title, locale);

  const edited = useMemo((): BlockDraft | undefined => {
    if (!own) return undefined;
    const from = structure && structure !== 'not-yaml' ? structure : base;
    return {
      ...from,
      spec: {
        ...from.spec,
        ...(Object.keys(props).length
          ? {
              props: {
                ...from.spec.props,
                type: 'object',
                properties: withDefaults(props, values),
              } as NonNullable<BlockDraft['spec']['props']>,
            }
          : {}),
      },
    };
  }, [own, structure, base, props, values]);

  useEffect(() => {
    if (!own || !structure || structure === 'not-yaml' || !edited) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.design
        .preview(tenant, edited as unknown as Record<string, unknown>)
        .then((result) => {
          if (!alive) return;
          setLive({
            ...(result.render ? { render: result.render } : {}),
            errors: result.valid ? [] : (result.errors ?? []),
          });
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, tenant, own, structure, edited]);

  const missing = missingFields(live.errors);
  const changes = [
    ...changedProps.map((k) => labelOf(k, props[k] ?? {}, locale)),
    ...(structure ? [t('design.structure')] : []),
    ...(bundle?.bundle ? [t('design.newBundle')] : []),
  ];
  const lane: 'none' | 'draft' | 'core' = missing.length
    ? 'core'
    : changes.length
      ? 'draft'
      : 'none';
  const payload = live.render ?? detail.edition.render;
  const states = stagesOf(detail, payload?.states ?? []);
  const shown = states.includes(stage.state) ? stage.state : 'filled';
  const settingsKey = JSON.stringify(changedProps.map((k) => [k, values[k]]));
  const settings = useMemo(
    () => Object.fromEntries(JSON.parse(settingsKey) as [string, PropValue][]),
    [settingsKey],
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const measured = useMeasure(stageRef, [
    shown,
    stage.dark,
    stage.size,
    stage.look,
    values,
    payload,
  ]);

  return (
    <div className="design-studio">
      <div className="design-stage-col">
        <div className="design-stage-tools">
          <Tool label={t('design.stateLabel')}>
            <ToggleGroup
              data-size="sm"
              variant="secondary"
              aria-label={t('design.stateLabel')}
              value={shown}
              onChange={(v) => onStage({ ...stage, state: v as BlockState })}
            >
              {states.map((s) => (
                <ToggleGroup.Item key={s} value={s}>
                  {t(stateKey[s])}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup>
          </Tool>
          <Tool label={t('design.themeLabel')}>
            <ToggleGroup
              data-size="sm"
              variant="secondary"
              aria-label={t('design.themeLabel')}
              value={stage.dark ? 'dark' : 'light'}
              onChange={(v) => onStage({ ...stage, dark: v === 'dark' })}
            >
              <ToggleGroup.Item value="light">{t('design.light')}</ToggleGroup.Item>
              <ToggleGroup.Item value="dark">{t('design.dark')}</ToggleGroup.Item>
            </ToggleGroup>
          </Tool>
          <Tool label={t('design.sizeLabel')}>
            <ToggleGroup
              data-size="sm"
              variant="secondary"
              aria-label={t('design.sizeLabel')}
              value={stage.size}
              onChange={(v) => onStage({ ...stage, size: v as Stage['size'] })}
            >
              <ToggleGroup.Item value="sm">{t('design.sizeSmall')}</ToggleGroup.Item>
              <ToggleGroup.Item value="md">{t('design.sizeMedium')}</ToggleGroup.Item>
            </ToggleGroup>
          </Tool>
          {detail.tier === 'built-in' ? (
            <Tool label={t('design.lookLabel')} row>
              <ToggleGroup
                data-size="sm"
                variant="secondary"
                aria-label={t('design.lookLabel')}
                value={stage.look}
                onChange={(v) => onStage({ ...stage, look: v as Look })}
              >
                <ToggleGroup.Item value="next">{t('design.lookNext')}</ToggleGroup.Item>
                <ToggleGroup.Item value="current">{t('design.lookCurrent')}</ToggleGroup.Item>
              </ToggleGroup>
            </Tool>
          ) : null}
        </div>
        <div className="design-stage">
          <div
            ref={stageRef}
            className="design-stage-inner"
            data-color-scheme={stage.dark ? 'dark' : 'light'}
            data-size={stage.size}
            data-tier={detail.tier}
          >
            {detail.tier === 'built-in' ? (
              <BuiltInPreview
                block={(base.spec as { builtIn?: string }).builtIn ?? detail.id}
                zone={detail.zones[0] ?? 'main'}
                settings={settings}
                look={stage.look}
                state={shown}
              />
            ) : payload ? (
              <RefBlock
                payload={payload}
                data={blockFixtures[shown] ?? {}}
                state={shown}
                settings={values}
                locale={locale}
                level={2}
              />
            ) : (
              <Paragraph>{t('design.noPreview')}</Paragraph>
            )}
          </div>
        </div>
        <Paragraph data-size="sm" className="meta">
          {t('design.fixtures')}
        </Paragraph>
        {own && newest && detail.tier === 'declarative' ? (
          <Details className="design-more">
            <Details.Summary>{t('design.structure')}</Details.Summary>
            <Details.Content>
              <StructureEditor base={base} errors={live.errors} onChange={setStructure} />
            </Details.Content>
          </Details>
        ) : null}
        {own && newest && detail.tier === 'code' ? (
          <Details className="design-more">
            <Details.Summary>{t('design.newBundle')}</Details.Summary>
            <Details.Content>
              <CodeEditor base={base} onChange={setBundle} />
            </Details.Content>
          </Details>
        ) : null}
      </div>
      <div className="design-side">
        <Panel
          title={t('design.props')}
          aside={
            <Tag
              data-size="sm"
              data-color={lane === 'none' ? 'neutral' : 'warning'}
              className={lane === 'draft' ? 'design-pill-filled' : undefined}
            >
              {t(
                lane === 'core'
                  ? 'design.laneCore'
                  : lane === 'draft'
                    ? 'design.laneDraft'
                    : 'design.laneNone',
              )}
            </Tag>
          }
        >
          <PropControls props={props} values={values} onChange={setValues} readOnly={!manage} />
          {manage ? (
            <SaveDraft
              api={api}
              tenant={tenant}
              detail={detail}
              own={own}
              newest={newest}
              lane={lane}
              missing={missing}
              changes={changes}
              edited={edited}
              structureBroken={structure === 'not-yaml' || live.errors.length > 0}
              bundle={bundle}
              settings={settings}
              saved={saved}
              onSaved={onSaved}
              onReset={() => setValues(defaults)}
              name={name}
            />
          ) : null}
        </Panel>
        <A11yPanel measured={measured} state={shown} />
        <Panel title={t('design.changelog')}>
          <ul className="design-log">
            {[...detail.editions].reverse().map((e) => (
              <li key={e.version}>
                <time dateTime={e.publishedAt}>{dayOf(e.publishedAt, locale)}</time>
                {versionName(t, e.version)}: {e.reason}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('design.usedBy')}>
          {detail.usedIn.length ? (
            <ul className="design-log">
              {detail.usedIn.map((u) => (
                <li key={u.service}>
                  <a href={`#/services/${encodeURIComponent(u.service)}/interface`}>{u.name}</a>
                  <span className="meta">
                    {t('design.usedLine', {
                      test: versionName(t, u.draft ?? u.test) || t('design.notInUse'),
                      prod: versionName(t, u.inUse) || t('design.notInUse'),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Paragraph data-size="sm" className="meta">
              {t('design.usedNone')}
            </Paragraph>
          )}
        </Panel>
      </div>
    </div>
  );
};

const Tool = ({
  label,
  row = false,
  children,
}: {
  label: string;
  row?: boolean;
  children: ReactNode;
}) => (
  <div className={row ? 'design-tool design-tool-row' : 'design-tool'}>
    <span className="design-tool-label" aria-hidden="true">
      {label}
    </span>
    {children}
  </div>
);

const PropControls = ({
  props,
  values,
  onChange,
  readOnly,
}: {
  props: Record<string, Record<string, unknown>>;
  values: Record<string, PropValue>;
  onChange: (values: Record<string, PropValue>) => void;
  readOnly: boolean;
}) => {
  const t = useT();
  const { locale } = useLocale();
  const ids = useId();
  const entries = Object.entries(props);
  if (entries.length === 0)
    return (
      <Paragraph data-size="sm" className="meta">
        {t('design.noProps')}
      </Paragraph>
    );
  const set = (key: string, value: PropValue) => onChange({ ...values, [key]: value });
  return (
    <div className="design-props">
      {entries.map(([key, schema]) => {
        const label = labelOf(key, schema, locale);
        const choices = choicesOf(schema);
        const value = values[key];
        if (schema.type === 'boolean')
          return (
            <div className="design-prop" key={key}>
              <Switch
                label={label}
                position="end"
                checked={value === true}
                aria-disabled={readOnly || undefined}
                onChange={() => !readOnly && set(key, value !== true)}
              />
            </div>
          );
        if (choices)
          return (
            <div className="design-prop" key={key}>
              <span id={`${ids}-${key}`}>{label}</span>
              <ToggleGroup
                data-size="sm"
                variant="secondary"
                aria-labelledby={`${ids}-${key}`}
                value={String(value ?? '')}
                onChange={(v) => !readOnly && set(key, v)}
              >
                {choices.map((c) => (
                  <ToggleGroup.Item key={c} value={c}>
                    {labelOf(key, schema, locale, c)}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup>
            </div>
          );
        return (
          <Field className="design-prop" key={key}>
            <Label htmlFor={`${ids}-${key}`}>{label}</Label>
            <Input
              id={`${ids}-${key}`}
              data-size="sm"
              value={String(value ?? '')}
              readOnly={readOnly}
              onChange={(e) => set(key, e.target.value)}
            />
          </Field>
        );
      })}
    </div>
  );
};

const SaveDraft = ({
  api,
  tenant,
  detail,
  own,
  newest,
  lane,
  missing,
  changes,
  edited,
  structureBroken,
  bundle,
  settings,
  saved,
  onSaved,
  onReset,
  name,
}: {
  api: ApiClient;
  tenant: string;
  detail: BlockDetail;
  own: boolean;
  newest: boolean;
  lane: 'none' | 'draft' | 'core';
  missing: string[];
  changes: string[];
  edited: BlockDraft | undefined;
  structureBroken: boolean;
  bundle: CodeEdit | undefined;
  settings: Record<string, PropValue>;
  saved: Saved | undefined;
  onSaved: (saved: Saved) => void;
  onReset: () => void;
  name: string;
}) => {
  const t = useT();
  const selectId = useId();
  const [service, setService] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [services] = useAsync(
    async (signal) => (own ? [] : (await api.services(tenant, signal)).data),
    [api, tenant, own],
  );
  const list = services.status === 'ready' ? services.data : [];
  const blocked = lane !== 'draft' || structureBroken || (own && !newest) || (!own && !service);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (own && edited) {
        const carried = await api.design.files(tenant, detail.id, detail.edition.version);
        const files = bundle?.bundle
          ? {
              ...Object.fromEntries(
                Object.entries(carried).filter(([p]) => !p.startsWith(sourcePrefix)),
              ),
              [bundlePath]: bundle.bundle.text,
              ...Object.fromEntries(
                Object.entries(bundle.sources).map(([n, v]) => [`${sourcePrefix}${n}`, v]),
              ),
            }
          : carried;
        const reviewed =
          edited.spec.tier === 'code' && edited.spec.sharing === 'everyone'
            ? { ...edited, spec: { ...edited.spec, sharing: 'organisation' as const } }
            : edited;
        const definition = bundle?.bundle
          ? {
              ...reviewed,
              spec: {
                ...reviewed.spec,
                events: bundle.events,
                code: {
                  ...reviewed.spec.code,
                  sha256: bundle.bundle.sha256,
                  bytes: bundle.bundle.bytes,
                  reads: bundle.reads,
                },
              },
            }
          : reviewed;
        const result = await api.design.save(
          definition as unknown as Record<string, unknown>,
          files,
          t('design.savedReason', { changes: changes.join(', ') }),
        );
        onSaved({ kind: 'own', version: result.version });
      } else {
        const chosen = list.find((s) => s.id === service);
        await api.design.pin(
          tenant,
          service,
          { publisher: detail.publisher, id: detail.id },
          { version: detail.latest.version, settings },
          t('design.pinSettingsReason', { name }),
        );
        onSaved({ kind: 'pin', service: { id: service, name: chosen?.name ?? service } });
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm design-save">
      <Paragraph data-size="sm" className="meta">
        {own
          ? lane === 'draft'
            ? t('design.laneChangedOwn', { version: detail.latest.version + 1 })
            : t('design.laneHelpOwn')
          : t('design.laneHelpPin')}
      </Paragraph>
      {missing.length ? (
        <div className="design-core" role="note">
          <Paragraph data-size="sm">
            <strong>{t('design.coreTitle')}</strong>{' '}
            {t('design.coreBody', { fields: missing.join(', ') })}
          </Paragraph>
          <a
            className="ds-button"
            data-variant="secondary"
            data-size="sm"
            href={coreIssueLink(t('design.coreIssueTitle', { name }), missing.join('\n'))}
            target="_blank"
            rel="noreferrer"
          >
            {t('design.coreIssue')}
          </a>
        </div>
      ) : null}
      {!own ? (
        <Field data-size="sm">
          <Label htmlFor={selectId}>{t('design.service')}</Label>
          <Select id={selectId} value={service} onChange={(e) => setService(e.target.value)}>
            <Select.Option value="" disabled>
              {t('design.chooseService')}
            </Select.Option>
            {list.map((s) => (
              <Select.Option key={s.id} value={s.id}>
                {s.name}
              </Select.Option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="design-actions">
        <BusyButton
          data-size="sm"
          busy={busy}
          busyLabel={t('design.saving')}
          aria-disabled={blocked || undefined}
          onClick={() => !blocked && void save()}
        >
          {t('design.saveDraft')}
        </BusyButton>
        <Button variant="tertiary" data-size="sm" onClick={onReset}>
          {t('design.reset')}
        </Button>
      </div>
      {saved ? (
        <Toast>
          {saved.kind === 'own' ? (
            <>
              {t('design.savedOwn', { version: saved.version ?? 0 })}{' '}
              <a href={`#${versionsPath(detail.publisher, detail.id)}`}>
                {t('design.seeVersions')}
              </a>
            </>
          ) : (
            <>
              {t('design.savedPin', { service: saved.service?.name ?? '' })}{' '}
              <a href={`#/services/${encodeURIComponent(saved.service?.id ?? '')}/interface`}>
                {t('design.seeOnTest')}
              </a>
            </>
          )}
        </Toast>
      ) : null}
      {error ? <Problems error={error} /> : null}
    </div>
  );
};

/** Re-measures the stage whenever what it draws changes, including after the host finishes drawing. */
const useMeasure = (ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) => {
  const [measured, setMeasured] = useState<Measured | undefined>(undefined);
  const run = useCallback(() => {
    if (!ref.current) return;
    const next = measure(ref.current);
    setMeasured((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
  }, [ref]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let timer = setTimeout(run, 150);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 150);
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [run, ...deps]);
  return measured;
};

const Check = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
  <li>
    <span className="design-check" data-ok={ok} aria-hidden="true">
      {ok ? '✓' : '!'}
    </span>
    <span>{children}</span>
  </li>
);

const A11yPanel = ({ measured, state }: { measured: Measured | undefined; state: BlockState }) => {
  const t = useT();
  const ratio = (n: number) => n.toFixed(1);
  return (
    <Panel title={t('design.a11y')}>
      {measured ? (
        <ul className="design-checks-list">
          {measured.text !== undefined ? (
            <Check ok={measured.text >= 4.5}>
              {t('design.a11yText', { ratio: ratio(measured.text) })}
            </Check>
          ) : null}
          {measured.subtle !== undefined ? (
            <Check ok={measured.subtle >= 4.5}>
              {t('design.a11ySubtle', { ratio: ratio(measured.subtle) })}
            </Check>
          ) : null}
          {measured.accent !== undefined ? (
            <Check ok={measured.accent >= 3}>
              {t('design.a11yAccent', { ratio: ratio(measured.accent) })}
            </Check>
          ) : null}
          <Check ok={measured.iconsHidden}>{t('design.a11yIconHidden')}</Check>
          {state === 'loading' ? <Check ok={measured.live}>{t('design.a11yLive')}</Check> : null}
          {state === 'error' ? <Check ok={measured.alert}>{t('design.a11yAlert')}</Check> : null}
        </ul>
      ) : null}
    </Panel>
  );
};

interface CodeEdit {
  bundle: Bundle | undefined;
  reads: string[];
  events: BlockEvent[];
  sources: Record<string, string>;
}

const CodeEditor = ({
  base,
  onChange,
}: {
  base: BlockDraft;
  onChange: (edit: CodeEdit) => void;
}) => {
  const [edit, setEdit] = useState<CodeEdit>({
    bundle: undefined,
    reads: base.spec.code?.reads ?? [],
    events: base.spec.events ?? [],
    sources: {},
  });
  const update = (next: Partial<CodeEdit>) => {
    const merged = { ...edit, ...next };
    setEdit(merged);
    onChange(merged);
  };
  return (
    <CodeUpload
      bundle={edit.bundle}
      reads={edit.reads}
      events={edit.events}
      sources={edit.sources}
      onBundle={(bundle) => update({ bundle })}
      onReads={(reads) => update({ reads })}
      onEvents={(events) => update({ events })}
      onSources={(sources) => update({ sources })}
    />
  );
};
