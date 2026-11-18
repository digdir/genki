import {
  Alert,
  Button,
  Heading,
  Label,
  Link,
  Paragraph,
  Tag,
  Textarea,
} from '@digdir/designsystemet-react';
import { useId, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { ServiceDraft } from '../../api/quality';
import type { CatalogModel } from '../../api/models';
import type { PlaygroundOptions, PlaygroundResult, PlaygroundSetup } from '../../api/playground';
import {
  effectiveInstructions,
  modelOf,
  sentenceCount,
  setupDifferences,
  shortModelName,
  startLabel,
  strategyOf,
  takesInstructions,
  versionOf,
  withInstructions,
  workText,
  type SetupPart,
} from '../../data/playground';
import type { AsyncState } from '../../hooks';
import { useT } from '../../i18n';
import { ModelPicker } from '../ModelPicker';
import { AnswerCard } from './AnswerCard';
import { StartPicker, useWorkLanguage } from './PageSetup';
import { SaveToDraft } from './SaveToDraft';
import { ruleAlertFor } from './SetupForm';
import { LiveText, type LiveRun } from './RunView';
import { TimelineStrip } from './StepTimeline';

export type SideKey = 'a' | 'b';

export const CompareSide = ({
  side,
  options,
  setup,
  other,
  models,
  tenantName,
  run,
  result,
  saveExpanded,
  onChange,
  onSave,
  onShowCall,
  api,
  tenant,
  base,
  onSaved,
  otherBase,
}: {
  api?: ApiClient | undefined;
  onSaved?: ((service: string, saved: ServiceDraft) => void) | undefined;
  tenant?: string | undefined;
  base?: string | undefined;
  otherBase?: string | undefined;
  side: SideKey;
  options: PlaygroundOptions;
  setup: PlaygroundSetup;
  other: PlaygroundSetup;
  models: AsyncState<CatalogModel[]>;
  tenantName: string;
  run?: LiveRun | undefined;
  result?: PlaygroundResult | undefined;
  saveExpanded: boolean;
  onChange: (next: PlaygroundSetup) => void;
  onSave: () => void;
  onShowCall: () => void;
}) => {
  const t = useT();
  const id = useId();
  const key = side.toUpperCase();
  const [shown, setShown] = useState(true);
  const [editing, setEditing] = useState(false);
  const language = useWorkLanguage();
  const differs = setupDifferences(setup, other, base, otherBase);
  const mark = (part: SetupPart) =>
    differs.includes(part) ? (
      <Tag data-size="sm" data-color="warning">
        {t('playground.different')}
      </Tag>
    ) : null;
  const row = (label: string, part: SetupPart | null, value: ReactNode, action?: ReactNode) => (
    <div className="playground-side-row">
      <dt>{label}</dt>
      <dd>
        {value}
        {part ? mark(part) : null}
        {action}
      </dd>
    </div>
  );
  const instructions = effectiveInstructions(setup, base);
  const editable = !setup.service || takesInstructions(options, setup);
  const strategy = strategyOf(options, setup);
  const rule = ruleAlertFor(options, setup, tenantName, t);
  const found = versionOf(options, setup);
  const names = setup.datasets.map((d) => options.datasets.find((x) => x.id === d)?.name ?? d);
  const steps = run?.steps ?? result?.steps ?? [];
  return (
    <section aria-labelledby={`${id}-title`} className="playground-side" data-side={side}>
      <div className="playground-side-head">
        <div className="playground-side-title">
          <span className="playground-side-badge" aria-hidden="true">
            {key}
          </span>
          <Heading level={2} data-size="2xs" id={`${id}-title`}>
            <span className="visually-hidden">{t('playground.setupOf', { key })}: </span>
            {startLabel(options, setup, t)}
          </Heading>
          <Button
            variant="tertiary"
            data-size="sm"
            aria-expanded={shown}
            aria-controls={shown ? `${id}-setup` : undefined}
            onClick={() => setShown(!shown)}
          >
            {shown ? t('playground.hideSetup') : t('playground.showSetup')}
          </Button>
        </div>
        {shown ? (
          <div id={`${id}-setup`} className="playground-side-setup">
            <StartPicker
              options={options}
              setup={setup}
              onChange={onChange}
              label={`${t('playground.startFrom')} (${key})`}
            />
            <dl>
              {row(
                t('playground.model'),
                'model',
                <strong>{shortModelName(modelOf(options, setup.model).name)}</strong>,
                <span className="playground-side-picker">
                  <ModelPicker
                    models={models}
                    value={setup.model}
                    service={startLabel(options, setup, t)}
                    triggerLabel={t('playground.swapModel')}
                    onChange={(model) => onChange({ ...setup, model })}
                  />
                </span>,
              )}
              {row(
                t('playground.instructions'),
                'instructions',
                <span>
                  {!editable
                    ? t('playground.instructionsInSteps')
                    : instructions.trim()
                      ? t('playground.sentences', { count: sentenceCount(instructions) })
                      : t('playground.instructionsDefault')}
                </span>,
                editable ? (
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    className="playground-inline-action"
                    aria-expanded={editing}
                    aria-controls={editing ? `${id}-instructions` : undefined}
                    onClick={() => setEditing(!editing)}
                  >
                    {editing ? t('playground.doneEditing') : t('playground.change')}
                  </Button>
                ) : null,
              )}
              {row(
                t('playground.knowledge'),
                'knowledge',
                names.length ? names.join(', ') : t('playground.knowledgeNone'),
              )}
              {strategy
                ? row(t('playground.work'), null, workText(strategy, language, t, true))
                : null}
            </dl>
            {editing && editable ? (
              <div className="playground-side-edit">
                <Label htmlFor={`${id}-instructions`} data-size="sm">
                  {t('playground.instructionsFor', { key })}
                </Label>
                <Textarea
                  id={`${id}-instructions`}
                  rows={4}
                  value={setup.instructions ?? base ?? ''}
                  onChange={(e) => onChange(withInstructions(setup, e.target.value))}
                />
              </div>
            ) : null}
            {rule ? (
              <Alert data-color={rule.color} data-size="sm">
                <Heading level={3} data-size="2xs">
                  {rule.title}
                </Heading>
                <Paragraph data-size="sm">{rule.text}</Paragraph>
                <Link href={rule.href}>{rule.link}</Link>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="playground-side-body">
        {result ? (
          <AnswerCard
            layout="plain"
            result={result}
            saveExpanded={saveExpanded}
            onSave={onSave}
            onShowCall={onShowCall}
          />
        ) : run?.status === 'running' ? (
          <>
            <span className="playground-subtle">{t('playground.sideRunning', { key })}</span>
            <LiveText run={run} />
          </>
        ) : null}
        <TimelineStrip steps={steps} side={key} />
        {side === 'b' && found ? (
          <SaveToDraft
            api={api}
            tenant={tenant}
            options={options}
            setup={setup}
            base={base}
            label={t('playground.useInDraft', { key })}
            {...(onSaved ? { onSaved } : {})}
            primary
          />
        ) : null}
      </div>
    </section>
  );
};
