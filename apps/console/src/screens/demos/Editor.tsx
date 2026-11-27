import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Paragraph,
  Select,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parse, stringify } from 'yaml';
import {
  ApiError,
  type ApiClient,
  type DemoApp,
  type DemoAudience,
  type DemoSpec,
  type RecorderMode,
} from '../../api';
import { navigate } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { DialogError, ReasonDialog } from '../../ui';
import { commandsText, parseCommands } from './commands';
import {
  appLabel,
  audienceLabel,
  canRecord,
  clock,
  Crumbs,
  demoHref,
  requestRecording,
} from './shared';
import { VoiceSelect } from './VoiceSelect';

const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const estimateSeconds = (spec: Pick<DemoSpec, 'steps'>) =>
  spec.steps.reduce(
    (sum, s) =>
      sum +
      Math.max(1, s.say.trim().split(/\s+/).length / 2.5) +
      (s.hold ?? 0.6) +
      (s.do?.length ?? 0) * 0.5,
    0,
  );

export const slugOf = (title: string) =>
  title
    .toLocaleLowerCase('nb')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

interface Draft {
  spec: DemoSpec;
  commands: string[];
}

const draftOf = (spec: DemoSpec): Draft => ({
  spec,
  commands: spec.steps.map((s) => commandsText(s.do)),
});

const emptySpec = (voice: string, viewport: [number, number]): DemoSpec => ({
  title: '',
  description: '',
  audience: [],
  language: 'nb-NO',
  voice,
  viewport,
  app: 'portal',
  path: '/#/',
  steps: [{ say: '' }],
});

const specOnly = (spec: DemoSpec): DemoSpec => ({
  title: spec.title,
  description: spec.description ?? '',
  audience: spec.audience ?? [],
  language: spec.language,
  voice: spec.voice,
  ...(spec.viewport ? { viewport: spec.viewport } : {}),
  app: spec.app,
  path: spec.path,
  ...(spec.signedIn !== undefined ? { signedIn: spec.signedIn } : {}),
  ...(spec.ready ? { ready: spec.ready } : {}),
  ...(spec.intro ? { intro: spec.intro } : {}),
  ...(spec.outro ? { outro: spec.outro } : {}),
  steps: spec.steps.map((s) => ({
    say: s.say,
    ...(s.do && s.do.length > 0 ? { do: s.do } : {}),
    ...(s.hold !== undefined ? { hold: s.hold } : {}),
    ...(s.chapter ? { chapter: s.chapter } : {}),
    ...(s.focus ? { focus: s.focus } : {}),
  })),
});

type Built = { ok: true; spec: DemoSpec } | { ok: false; message: string };

const build = (draft: Draft, t: ReturnType<typeof useT>): Built => {
  const steps: DemoSpec['steps'] = [];
  for (const [i, step] of draft.spec.steps.entries()) {
    const parsed = parseCommands(draft.commands[i] ?? '');
    if (!parsed.ok)
      return { ok: false, message: t('demos.commandInvalid', { line: parsed.line, step: i + 1 }) };
    steps.push({ ...step, ...(parsed.commands.length ? { do: parsed.commands } : { do: [] }) });
  }
  return { ok: true, spec: specOnly({ ...draft.spec, steps }) };
};

const problemText = (error: unknown, t: ReturnType<typeof useT>) => {
  if (error instanceof ApiError && error.status === 409) return t('demos.saveMoved');
  if (error instanceof ApiError && error.problem?.errors?.length)
    return `${t('demos.saveRefused')} ${error.problem.errors
      .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
      .join('; ')}`;
  return undefined;
};

export interface EditorState {
  id: string | undefined;
  version: number | undefined;
  recorder: RecorderMode;
  initial: DemoSpec;
}

const useEditorState = (api: ApiClient, id: string | undefined) => {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'ready'; data: EditorState }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      try {
        if (id) {
          const demo = await api.demo(id, controller.signal);
          setState({
            status: 'ready',
            data: {
              id,
              version: demo.version,
              recorder: demo.recorder ?? 'workflow',
              initial: specOnly(demo),
            },
          });
        } else {
          const settings = await api.demoSettings(controller.signal);
          setState({
            status: 'ready',
            data: {
              id: undefined,
              version: undefined,
              recorder: settings.recorder,
              initial: emptySpec(settings.voice, settings.viewport),
            },
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: 'error', error });
      }
    })();
    return () => controller.abort();
  }, [api, id, attempt]);
  return [state, () => setAttempt((n) => n + 1)] as const;
};

export const DemoEditor = ({
  api,
  id,
  step,
  aside,
}: {
  api: ApiClient;
  id?: string | undefined;
  step?: number | undefined;
  aside?: (props: AsideProps) => ReactNode;
}) => {
  const t = useT();
  const [state, retry] = useEditorState(api, id);
  const crumbs = <Crumbs title={id} {...(id ? { href: demoHref(id) } : {})} />;
  if (state.status === 'loading')
    return (
      <>
        {crumbs}
        <Loading label={t('demos.loading')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {crumbs}
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  return (
    <EditorForm
      key={`${state.data.id ?? 'new'}-${state.data.version ?? 0}`}
      api={api}
      loaded={state.data}
      focus={step}
      aside={aside}
    />
  );
};

export interface AsideProps {
  draft: DemoSpec;
  propose: (spec: DemoSpec) => void;
}

const EditorForm = ({
  api,
  loaded,
  focus,
  aside,
}: {
  api: ApiClient;
  loaded: EditorState;
  focus: number | undefined;
  aside: ((props: AsideProps) => ReactNode) | undefined;
}) => {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => draftOf(loaded.initial));
  const [newId, setNewId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [yaml, setYaml] = useState<string | undefined>();
  const [yamlError, setYamlError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [trying, setTrying] = useState<number | undefined>();
  const id = loaded.id ?? (idTouched ? newId : slugOf(draft.spec.title));
  const built = useMemo(() => build(draft, t), [draft, t]);
  const dirty =
    loaded.id === undefined ||
    !built.ok ||
    JSON.stringify(built.spec) !== JSON.stringify(loaded.initial);

  useEffect(() => {
    if (!focus) return;
    const field = document.getElementById(`demo-step-${focus}-say`);
    field?.scrollIntoView?.({ block: 'center' });
    field?.focus();
  }, [focus]);

  const setSpec = (change: Partial<DemoSpec>) =>
    setDraft((d) => ({ ...d, spec: { ...d.spec, ...change } }));
  const setReady = (ready: string) =>
    setDraft((d) => {
      const spec = { ...d.spec };
      delete spec.ready;
      return { ...d, spec: ready ? { ...spec, ready } : spec };
    });
  const setHold = (i: number, value: string) =>
    setDraft((d) => ({
      ...d,
      spec: {
        ...d.spec,
        steps: d.spec.steps.map((s, j) => {
          if (j !== i) return s;
          const step = { ...s };
          delete step.hold;
          return value === '' ? step : { ...step, hold: Number(value) };
        }),
      },
    }));
  const setStep = (i: number, change: Partial<DemoSpec['steps'][number]>) =>
    setDraft((d) => ({
      ...d,
      spec: { ...d.spec, steps: d.spec.steps.map((s, j) => (j === i ? { ...s, ...change } : s)) },
    }));
  const setCommands = (i: number, text: string) =>
    setDraft((d) => ({ ...d, commands: d.commands.map((c, j) => (j === i ? text : c)) }));
  const move = (i: number, by: number) =>
    setDraft((d) => {
      const steps = [...d.spec.steps];
      const commands = [...d.commands];
      const j = i + by;
      if (j < 0 || j >= steps.length) return d;
      [steps[i], steps[j]] = [
        steps[j] as (typeof steps)[number],
        steps[i] as (typeof steps)[number],
      ];
      [commands[i], commands[j]] = [commands[j] ?? '', commands[i] ?? ''];
      return { spec: { ...d.spec, steps }, commands };
    });
  const remove = (i: number) =>
    setDraft((d) => ({
      spec: { ...d.spec, steps: d.spec.steps.filter((_, j) => j !== i) },
      commands: d.commands.filter((_, j) => j !== i),
    }));
  const add = () =>
    setDraft((d) => ({
      spec: { ...d.spec, steps: [...d.spec.steps, { say: '' }] },
      commands: [...d.commands, ''],
    }));
  const toggleAudience = (a: DemoAudience) =>
    setSpec({
      audience: draft.spec.audience.includes(a)
        ? draft.spec.audience.filter((x) => x !== a)
        : [...draft.spec.audience, a],
    });

  const showYaml = () => {
    setYaml(stringify(built.ok ? built.spec : draft.spec));
    setYamlError(undefined);
  };
  const editYaml = (text: string) => {
    setYaml(text);
    try {
      const value = parse(text) as DemoSpec;
      if (!value || typeof value !== 'object' || !Array.isArray(value.steps))
        throw new Error('steps');
      setDraft(draftOf(specOnly(value)));
      setYamlError(undefined);
    } catch (error) {
      setYamlError(
        t('demos.yamlInvalid', { message: (error as Error).message.split('\n')[0] ?? '' }),
      );
    }
  };

  const saveWith = async (reason: string) => {
    if (!built.ok) throw new DialogError(built.message);
    if (!idPattern.test(id)) throw new DialogError(t('demos.fieldIdHelp'));
    try {
      return await api.saveDemo(id, built.spec, reason, loaded.version ?? 0);
    } catch (error) {
      if (loaded.id === undefined && error instanceof ApiError && error.status === 409)
        throw new DialogError(t('demos.idTaken'));
      const text = problemText(error, t);
      if (text) throw new DialogError(text);
      throw error;
    }
  };

  const steps = draft.spec.steps;
  return (
    <>
      <Crumbs
        title={loaded.id ? loaded.initial.title : undefined}
        {...(loaded.id ? { href: demoHref(loaded.id) } : {})}
      />
      <div className="page-header">
        <Heading level={1} data-size="lg">
          {loaded.id
            ? t('demos.editorEditTitle', { title: loaded.initial.title })
            : t('demos.editorNewTitle')}
        </Heading>
        {built.ok ? (
          <p className="intro">
            {t('demos.estimate', { length: clock(estimateSeconds(built.spec)) })}
          </p>
        ) : null}
      </div>
      <div className="actions-row demo-editor-actions">
        <Button data-size="sm" onClick={() => setSaving(true)} disabled={!dirty}>
          {t('demos.save')}
        </Button>
        <Button
          data-size="sm"
          variant="secondary"
          aria-pressed={yaml !== undefined}
          onClick={() => (yaml === undefined ? showYaml() : setYaml(undefined))}
        >
          {yaml === undefined ? t('demos.showYaml') : t('demos.showForm')}
        </Button>
        <Button asChild data-size="sm" variant="tertiary">
          <a href={loaded.id ? demoHref(loaded.id) : '#/demos'}>{t('demos.discard')}</a>
        </Button>
      </div>
      {!built.ok && yaml === undefined ? <Alert data-color="warning">{built.message}</Alert> : null}
      <ReasonDialog
        open={saving}
        title={t('demos.saveTitle')}
        text={t('demos.saveText')}
        confirmLabel={t('demos.save')}
        onClose={() => setSaving(false)}
        onConfirm={async (reason) => {
          const saved = await saveWith(reason);
          navigate('/demos', { demo: saved.id });
        }}
      />
      <ReasonDialog
        open={trying !== undefined}
        title={t('demos.tryStepTitle', { n: trying ?? 0 })}
        text={`${t('demos.tryStepText', { n: trying ?? 0 })}${dirty ? ` ${t('demos.tryStepSaveText')}` : ''}`}
        confirmLabel={dirty ? t('demos.tryStepConfirm') : t('demos.tryStepConfirmSaved')}
        onClose={() => setTrying(undefined)}
        onConfirm={async (reason) => {
          const n = trying ?? 1;
          const saved = dirty ? await saveWith(reason) : undefined;
          const started = await requestRecording(api, saved?.id ?? id, reason, t, n);
          navigate('/demos', { recording: started.id });
        }}
      />
      <div className="demo-editor">
        <div className="stack">
          {aside
            ? aside({
                draft: built.ok ? built.spec : draft.spec,
                propose: (spec) => setDraft(draftOf(spec)),
              })
            : null}
          <section aria-labelledby="demo-about-form" className="card stack">
            <Heading level={2} data-size="sm" id="demo-about-form">
              {t('demos.aboutDemo')}
            </Heading>
            <Textfield
              label={t('demos.fieldTitle')}
              value={draft.spec.title}
              onChange={(e) => setSpec({ title: e.target.value })}
            />
            {loaded.id ? null : (
              <Textfield
                label={t('demos.fieldId')}
                description={t('demos.fieldIdHelp')}
                value={id}
                error={id && !idPattern.test(id) ? t('demos.fieldIdHelp') : undefined}
                onChange={(e) => {
                  setIdTouched(true);
                  setNewId(e.target.value);
                }}
              />
            )}
            <Textfield
              label={t('demos.fieldDescription')}
              multiline
              rows={2}
              value={draft.spec.description}
              onChange={(e) => setSpec({ description: e.target.value })}
            />
            <div className="field">
              <Label htmlFor="demo-app">{t('demos.fieldApp')}</Label>
              <Select
                id="demo-app"
                value={draft.spec.app}
                onChange={(e) => setSpec({ app: e.target.value as DemoApp })}
              >
                {(Object.keys(appLabel) as DemoApp[]).map((a) => (
                  <Select.Option key={a} value={a}>
                    {t(appLabel[a])}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <Textfield
              label={t('demos.fieldPath')}
              description={t('demos.fieldPathHelp')}
              value={draft.spec.path}
              onChange={(e) => setSpec({ path: e.target.value })}
            />
            <Textfield
              label={t('demos.fieldReady')}
              description={t('demos.fieldReadyHelp')}
              value={draft.spec.ready ?? ''}
              onChange={(e) => setReady(e.target.value)}
            />
            <Checkbox
              label={t('demos.fieldSignedIn')}
              checked={draft.spec.signedIn ?? false}
              onChange={(e) => setSpec({ signedIn: e.target.checked })}
            />
            <Fieldset>
              <FieldsetLegend>{t('demos.audience')}</FieldsetLegend>
              {(Object.keys(audienceLabel) as DemoAudience[]).map((a) => (
                <Checkbox
                  key={a}
                  label={t(audienceLabel[a])}
                  checked={draft.spec.audience.includes(a)}
                  onChange={() => toggleAudience(a)}
                />
              ))}
            </Fieldset>
            <VoiceSelect
              label={t('demos.fieldVoice')}
              description={t('demos.fieldVoiceHelp')}
              value={draft.spec.voice}
              onChange={(voice, known) =>
                setSpec({
                  voice,
                  language:
                    known?.language ??
                    (voice === loaded.initial.voice
                      ? loaded.initial.language
                      : draft.spec.language),
                })
              }
            />
          </section>
        </div>
        <section aria-labelledby="demo-steps-form" className="stack">
          <Heading level={2} data-size="sm" id="demo-steps-form">
            {t('demos.stepsHeading')}
          </Heading>
          {yaml !== undefined ? (
            <>
              <Textarea
                aria-label={t('demos.yamlLabel')}
                className="demo-yaml"
                rows={24}
                value={yaml}
                aria-invalid={yamlError ? true : undefined}
                onChange={(e) => editYaml(e.target.value)}
              />
              {yamlError ? <Alert data-color="danger">{yamlError}</Alert> : null}
            </>
          ) : (
            <>
              <Paragraph data-size="sm" className="muted">
                {t('demos.stepsHelp')}
              </Paragraph>
              <ol className="demo-step-list">
                {steps.map((s, i) => {
                  const n = i + 1;
                  return (
                    <li
                      key={i}
                      className={`card stack demo-step-card${focus === n ? ' is-focused' : ''}`}
                    >
                      <div className="demo-step-head">
                        <Heading level={3} data-size="2xs">
                          {t('demos.stepHeading', { n })}
                        </Heading>
                        <div className="actions-row">
                          <Button
                            data-size="sm"
                            variant="tertiary"
                            icon
                            aria-label={t('demos.moveUp', { n })}
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            data-size="sm"
                            variant="tertiary"
                            icon
                            aria-label={t('demos.moveDown', { n })}
                            disabled={i === steps.length - 1}
                            onClick={() => move(i, 1)}
                          >
                            ↓
                          </Button>
                          <Button
                            data-size="sm"
                            variant="tertiary"
                            data-color="danger"
                            aria-label={t('demos.removeStep', { n })}
                            disabled={steps.length === 1}
                            onClick={() => remove(i)}
                          >
                            ✕
                          </Button>
                        </div>
                      </div>
                      <Textfield
                        id={`demo-step-${n}-say`}
                        label={t('demos.stepSay')}
                        multiline
                        rows={2}
                        value={s.say}
                        onChange={(e) => setStep(i, { say: e.target.value })}
                      />
                      <Textfield
                        label={t('demos.stepDo')}
                        description={t('demos.stepDoHelp')}
                        multiline
                        rows={Math.max(2, (draft.commands[i] ?? '').split('\n').length)}
                        className="demo-commands"
                        value={draft.commands[i] ?? ''}
                        onChange={(e) => setCommands(i, e.target.value)}
                      />
                      <Textfield
                        label={t('demos.stepHold')}
                        type="number"
                        min={0}
                        max={10}
                        step={0.1}
                        value={s.hold ?? ''}
                        onChange={(e) => setHold(i, e.target.value)}
                      />
                      <div className="actions-row">
                        <Button
                          data-size="sm"
                          variant="secondary"
                          disabled={!canRecord(loaded.recorder) || !built.ok}
                          onClick={() => setTrying(n)}
                        >
                          {t('demos.tryStep')}
                        </Button>
                        {!canRecord(loaded.recorder) ? (
                          <Paragraph data-size="sm" className="muted">
                            {t('demos.tryNeedsJob')}
                          </Paragraph>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div>
                <Button data-size="sm" variant="secondary" onClick={add}>
                  {t('demos.addStep')}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
};
