import { Button, Heading, Tag, Textarea, Label } from '@digdir/designsystemet-react';
import { useId, useState, type ReactNode } from 'react';
import type { CatalogModel } from '../../api/models';
import type { PlaygroundOptions, PlaygroundResult, PlaygroundSetup } from '../../api/playground';
import {
  sentenceCount,
  setupDifferences,
  startLabel,
  withInstructions,
  type SetupPart,
} from '../../data/playground';
import type { AsyncState } from '../../hooks';
import { useT } from '../../i18n';
import { AnswerCard } from './AnswerCard';
import { SetupModel, StartPicker } from './PageSetup';
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
}: {
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
  const differs = setupDifferences(setup, other);
  const mark = (part: SetupPart) =>
    differs.includes(part) ? (
      <Tag data-size="sm" data-color="warning">
        {t('playground.different')}
      </Tag>
    ) : null;
  const row = (label: string, part: SetupPart | null, value: ReactNode) => (
    <div className="playground-side-row">
      <dt>
        {label}
        {part ? mark(part) : null}
      </dt>
      <dd>{value}</dd>
    </div>
  );
  const instructions = setup.instructions ?? '';
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
                <SetupModel
                  options={options}
                  setup={setup}
                  models={models}
                  tenantName={tenantName}
                  onChange={onChange}
                />,
              )}
              {setup.service
                ? null
                : row(
                    t('playground.instructions'),
                    'instructions',
                    <div className="playground-side-instructions">
                      <span>
                        {instructions.trim()
                          ? t('playground.sentences', { count: sentenceCount(instructions) })
                          : t('playground.instructionsDefault')}
                      </span>
                      <Button
                        variant="tertiary"
                        data-size="sm"
                        aria-expanded={editing}
                        aria-controls={editing ? `${id}-instructions` : undefined}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? t('playground.doneEditing') : t('playground.change')}
                      </Button>
                      {editing ? (
                        <div className="playground-side-edit">
                          <Label htmlFor={`${id}-instructions`} data-size="sm">
                            {t('playground.instructionsFor', { key })}
                          </Label>
                          <Textarea
                            id={`${id}-instructions`}
                            rows={4}
                            value={instructions}
                            onChange={(e) => onChange(withInstructions(setup, e.target.value))}
                          />
                        </div>
                      ) : null}
                    </div>,
                  )}
              {row(
                t('playground.knowledge'),
                'knowledge',
                names.length ? names.join(', ') : t('playground.knowledgeNone'),
              )}
            </dl>
          </div>
        ) : null}
      </div>
      <div className="playground-side-body">
        {result ? (
          <AnswerCard
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
      </div>
    </section>
  );
};
