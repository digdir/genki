import {
  Button,
  Heading,
  Label,
  Paragraph,
  Select,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import {
  demoTemplates,
  demoVoiceOf,
  pageProblem,
  sceneProblem,
  type DemoScene,
  type DemoTemplate,
} from '@genai/contracts';
import { useFormat } from '@genai/i18n/react';
import { useId, type ReactNode } from 'react';
import type { DemoDetail, DemoRecording } from '../../api';
import { useT } from '../../i18n';
import {
  chapterCardSeconds,
  type Chapter,
  type Scene,
  type SceneStep,
  type Timeline,
} from './film';
import { clock, scoreOf, toneOf } from './shared';
import { sceneKindLabel, type Selection } from './StudioTimeline';

const Section = ({ children }: { children: ReactNode }) => (
  <div className="insp-section">{children}</div>
);

const Facts = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="insp-facts">
    {rows.map(([k, v]) => (
      <div key={k}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </div>
    ))}
  </dl>
);

export const soundHref = (id: string) => `#/demos?demo=${encodeURIComponent(id)}&sound=1`;

type Look = SceneStep & { page?: string | undefined };

type SceneField = 'title' | 'subtitle' | 'question' | 'address' | 'definition';

const fieldsOf: Record<DemoTemplate, readonly SceneField[]> = {
  title: ['title', 'subtitle'],
  screen: ['title', 'question'],
  board: ['title'],
  code: ['title', 'definition'],
  close: ['question', 'address'],
};

const fieldLabel = {
  title: 'studio.sceneFieldTitle',
  subtitle: 'studio.sceneFieldSubtitle',
  question: 'studio.sceneFieldQuestion',
  address: 'studio.sceneFieldAddress',
  definition: 'studio.sceneFieldDefinition',
} as const;

const keptFields: Record<DemoTemplate, readonly string[]> = {
  title: ['title', 'logo', 'subtitle', 'centre', 'items', 'base'],
  screen: ['title', 'question'],
  board: ['title', 'columns'],
  code: ['eyebrow', 'title', 'text', 'definition', 'lines'],
  close: ['question', 'action', 'address'],
};

export const asTemplate = (scene: DemoScene | undefined, template: DemoTemplate): DemoScene => {
  const from = (scene ?? {}) as Record<string, unknown>;
  const kept = Object.fromEntries(
    keptFields[template].filter((k) => from[k] !== undefined).map((k) => [k, from[k]]),
  );
  return { ...kept, template } as DemoScene;
};

const withField = (scene: DemoScene, field: SceneField, value: string): DemoScene =>
  Object.fromEntries([
    ...Object.entries(scene).filter(([k]) => k !== field),
    ...(value ? [[field, value]] : []),
  ]) as unknown as DemoScene;

const PageField = ({ value, onChange }: { value: string; onChange: (page: string) => void }) => {
  const t = useT();
  const bad = value.trim() !== '' && pageProblem(value.trim()) !== undefined;
  return (
    <Textfield
      data-size="sm"
      label={t('studio.page')}
      description={t('studio.pageHelp')}
      value={value}
      error={bad ? t('studio.pageInvalid') : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};

const SceneEditor = ({
  scene,
  step,
  look,
  onScene,
  onPage,
}: {
  scene: DemoScene | undefined;
  step: number;
  look: Look | undefined;
  onScene: (step: number, scene: DemoScene) => void;
  onPage: (step: number, page: string) => void;
}) => {
  const t = useT();
  const templateId = useId();
  const template = scene?.template ?? 'screen';
  const shown = scene ?? asTemplate(undefined, 'screen');
  const problem = scene ? sceneProblem(scene) : undefined;
  return (
    <>
      <div className="insp-field">
        <Label htmlFor={templateId}>{t('studio.template')}</Label>
        <Select
          id={templateId}
          data-size="sm"
          value={template}
          onChange={(e) => onScene(step, asTemplate(scene, e.target.value as DemoTemplate))}
        >
          {demoTemplates.map((k) => (
            <Select.Option key={k} value={k}>
              {t(sceneKindLabel[k])}
            </Select.Option>
          ))}
        </Select>
      </div>
      {template === 'screen' ? (
        <PageField value={look?.page ?? ''} onChange={(page) => onPage(step, page)} />
      ) : null}
      {fieldsOf[template].map((field) => (
        <Textfield
          key={field}
          data-size="sm"
          label={t(fieldLabel[field])}
          {...(field === 'definition' ? { description: t('studio.sceneDefinitionHelp') } : {})}
          value={String((shown as unknown as Record<string, unknown>)[field] ?? '')}
          onChange={(e) => onScene(step, withField(shown, field, e.target.value))}
        />
      ))}
      {template === 'board' ? (
        <Paragraph data-size="sm" className="muted">
          {t('studio.sceneBoardColumns')}
        </Paragraph>
      ) : null}
      {problem ? (
        <Paragraph data-size="sm" className="insp-problem" role="status">
          {t('studio.sceneInvalid')}
        </Paragraph>
      ) : null}
    </>
  );
};

export const StudioInspector = ({
  demo,
  recording,
  timeline,
  chapters,
  scenes,
  selection,
  says,
  onSay,
  looks,
  onScene,
  onPage,
  music,
}: {
  demo: DemoDetail;
  recording: DemoRecording | undefined;
  timeline: Timeline | undefined;
  chapters: Chapter[];
  scenes: Scene[];
  selection: Selection;
  says: string[];
  onSay: (step: number, text: string) => void;
  looks: Look[];
  onScene: (step: number, scene: DemoScene) => void;
  onPage: (step: number, page: string) => void;
  music: string | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const shownId = useId();
  const spokenId = useId();
  const span = (from: number, to: number) => t('studio.span', { from: clock(from), to: clock(to) });

  if (selection.kind === 'line') {
    const n = selection.step;
    const step = demo.steps[n - 1];
    if (!step) return null;
    const line = timeline?.lines.find((l) => l.step === n);
    const scene = scenes.find((s) => s.steps.includes(n));
    const score = scoreOf(recording, n);
    const provider = demoVoiceOf(demo.voice)?.provider;
    const spoken = provider ? step.spoken?.[provider] : undefined;
    const camera = timeline?.camera.find((c) => line && c.at >= line.from && c.at < line.to);
    const voice =
      demoVoiceOf(recording?.voice ?? demo.voice)?.name ?? recording?.voice ?? demo.voice;
    return (
      <div className="insp">
        <Section>
          <div className="insp-row">
            <Heading level={2} data-size="xs">
              {t('studio.lineHeading', { n })}
            </Heading>
            {score ? (
              <span className={`score is-${toneOf(score.score)}`}>{score.score}</span>
            ) : null}
            {line ? <span className="muted insp-end">{span(line.from, line.to)}</span> : null}
          </div>
          {scene ? (
            <span className="muted small">
              {t('studio.sceneOf', {
                n: scene.n,
                name: scene.name || t(sceneKindLabel[scene.kind]),
              })}
            </span>
          ) : null}
        </Section>
        <Section>
          <div className="insp-field">
            <Label htmlFor={shownId}>{t('studio.shownText')}</Label>
            <Textarea
              id={shownId}
              rows={3}
              value={says[n - 1] ?? ''}
              onChange={(e) => onSay(n, e.target.value)}
            />
          </div>
          <div className="insp-field">
            <Label htmlFor={spokenId}>{t('studio.spokenText')}</Label>
            <Textarea
              id={spokenId}
              rows={2}
              value={spoken ?? ''}
              placeholder={t('studio.spokenSame')}
              readOnly
              aria-describedby={`${spokenId}-help`}
            />
            <span id={`${spokenId}-help`} className="muted xs">
              {t('studio.spokenHelp')}
            </span>
          </div>
          <PageField value={looks[n - 1]?.page ?? ''} onChange={(page) => onPage(n, page)} />
        </Section>
        <Section>
          <div className="insp-row">
            <Heading level={3} data-size="2xs">
              {t('studio.takes')}
            </Heading>
            <span className="muted small insp-end">{t('studio.voiceIs', { voice })}</span>
          </div>
          {score ? (
            <Facts
              rows={[
                [t('studio.takesRead'), String(score.takes)],
                [
                  t('studio.difference'),
                  <span key="d" className={`score is-${toneOf(score.score)}`}>
                    {score.score}
                  </span>,
                ],
                [t('studio.missing'), score.missing.join(', ') || t('studio.none')],
                [t('studio.extra'), score.extra.join(', ') || t('studio.none')],
                ...(score.keyTermsMissing.length
                  ? [[t('studio.keyTerms'), score.keyTermsMissing.join(', ')] as [string, string]]
                  : []),
                ...(score.wordsPerSecond !== undefined
                  ? [
                      [
                        t('studio.pace'),
                        t('studio.paceValue', { pace: f.decimal(score.wordsPerSecond, 1) }),
                      ] as [string, string],
                    ]
                  : []),
              ]}
            />
          ) : (
            <Paragraph data-size="sm" className="muted">
              {recording ? t('studio.noScore') : t('studio.notRecorded')}
            </Paragraph>
          )}
        </Section>
        <Section>
          <Heading level={3} data-size="2xs">
            {t('studio.focus')}
          </Heading>
          {camera ? (
            <Facts
              rows={[
                [t('studio.target'), camera.why ?? t('studio.wholePage')],
                ...(camera.word
                  ? [[t('studio.onWord'), `«${camera.word}»`] as [string, string]]
                  : []),
                [t('studio.zoomLevel'), `${f.decimal(camera.zoom, 1)}×`],
              ]}
            />
          ) : (
            <Paragraph data-size="sm" className="muted">
              {t('studio.noCamera')}
            </Paragraph>
          )}
        </Section>
      </div>
    );
  }

  if (selection.kind === 'scene') {
    const scene = scenes.find((s) => s.n === selection.n);
    if (!scene) return null;
    const chapter =
      scene.kind === 'chapter'
        ? chapters.find((c) => c.name === scene.name && Math.abs(c.from - scene.from) < 0.5)
        : chapters.find((c) => scene.steps.some((s) => c.steps.includes(s)));
    const first = scene.steps[0];
    return (
      <div className="insp">
        <Section>
          <Heading level={2} data-size="xs">
            {t('studio.sceneOf', { n: scene.n, name: scene.name || t(sceneKindLabel[scene.kind]) })}
          </Heading>
          <span className="muted small">
            {span(scene.from, scene.to)} · {t('studio.linesCount', { count: scene.steps.length })}
          </span>
        </Section>
        <Section>
          {first !== undefined ? (
            <SceneEditor
              scene={scene.scene}
              step={first}
              look={looks[first - 1]}
              onScene={onScene}
              onPage={onPage}
            />
          ) : (
            <>
              <Facts
                rows={[
                  [t('studio.template'), t(sceneKindLabel[scene.kind])],
                  ...(scene.kind === 'chapter'
                    ? [
                        [t('studio.length'), `${f.decimal(chapterCardSeconds, 1)} s`] as [
                          string,
                          string,
                        ],
                      ]
                    : []),
                ]}
              />
              {scene.kind === 'chapter' ? (
                <Paragraph data-size="sm" className="muted">
                  {t('studio.chapterCardText')}
                </Paragraph>
              ) : null}
            </>
          )}
        </Section>
        {chapter ? (
          <Section>
            <Heading level={3} data-size="2xs">
              {t('studio.chapter')}
            </Heading>
            <span className="small">
              {chapter.n}. {chapter.name}
            </span>
          </Section>
        ) : null}
      </div>
    );
  }

  if (selection.kind === 'chapter') {
    const chapter = chapters.find((c) => c.n === selection.n);
    if (!chapter) return null;
    return (
      <div className="insp">
        <Section>
          <Heading level={2} data-size="xs">
            {t('studio.chapterHeading', { n: chapter.n })}
          </Heading>
          <span className="muted small">{span(chapter.from, chapter.to)}</span>
        </Section>
        <Section>
          <Facts
            rows={[
              [t('studio.name'), chapter.name],
              [t('studio.lines'), String(chapter.steps.length)],
            ]}
          />
          <div className="film-card-title is-small" aria-hidden="true">
            <small>{t('studio.chapterHeading', { n: chapter.n })}</small>
            <span>{chapter.name}</span>
          </div>
        </Section>
      </div>
    );
  }

  if (selection.kind === 'camera') {
    const camera = timeline?.camera[selection.i];
    if (!camera) return null;
    return (
      <div className="insp">
        <Section>
          <Heading level={2} data-size="xs">
            {t('studio.cameraAt', { time: clock(camera.at) })}
          </Heading>
          <span className="muted small">
            {camera.why
              ? t('studio.setByDirectorWhy', { why: camera.why })
              : t('studio.setByDirector')}
          </span>
        </Section>
        <Section>
          <Facts
            rows={[
              [t('studio.zoomLevel'), `${f.decimal(camera.zoom, 1)}×`],
              [t('studio.target'), camera.why ?? t('studio.wholePage')],
              ...(camera.word
                ? [[t('studio.onWord'), `«${camera.word}»`] as [string, string]]
                : []),
              [t('studio.lineOf'), t('studio.lineHeading', { n: camera.step })],
            ]}
          />
        </Section>
      </div>
    );
  }

  return (
    <div className="insp">
      <Section>
        <Heading level={2} data-size="xs">
          {t('studio.music')}
        </Heading>
        <span className="muted small">{t('studio.wholeFilm')}</span>
      </Section>
      <Section>
        <Facts
          rows={[
            [t('studio.track'), music ?? t('studio.noMusic')],
            ...(recording?.sound?.music !== undefined
              ? [
                  [t('studio.level'), `${f.decimal(recording.sound.music, 1)} LUFS`] as [
                    string,
                    string,
                  ],
                ]
              : []),
          ]}
        />
        <div>
          <Button asChild variant="secondary" data-size="sm">
            <a href={soundHref(demo.id)}>{t('studio.changeSound')}</a>
          </Button>
        </div>
      </Section>
    </div>
  );
};
