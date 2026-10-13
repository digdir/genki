import { Alert, Button, Fieldset, Heading, Paragraph, Radio } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { DraftConflict } from '../../api/quality';
import { translator, useT, type T } from '../../i18n';
import { sectionOf } from '../service/publish';

export type ConflictPick = 'published' | 'draft';

interface Props {
  paths: string[];
  conflicts?: DraftConflict[];
  onRebase: () => Promise<DraftConflict[]>;
  onResolve: (picks: Record<string, ConflictPick>, conflicts: DraftConflict[]) => Promise<void>;
}

type Step =
  | { status: 'changed' }
  | { status: 'working'; conflicts?: DraftConflict[] }
  | { status: 'conflicts'; conflicts: DraftConflict[] }
  | { status: 'updated' }
  | { status: 'failed'; conflicts?: DraftConflict[] };

const nbT = translator('nb');

const shown = (value: unknown, t: T) =>
  value === undefined || value === null || value === ''
    ? t('services.unset')
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

const label = (path: string, t: T) => sectionOf(path, t) ?? path;

export const changedSections = (paths: string[], t: T = nbT) => [
  ...new Set(paths.map((path) => label(path, t))),
];

export const DraftOutdated = ({ paths, conflicts: initial, onRebase, onResolve }: Props) => {
  const t = useT();
  const [step, setStep] = useState<Step>(
    initial?.length ? { status: 'conflicts', conflicts: initial } : { status: 'changed' },
  );
  const [picks, setPicks] = useState<Record<string, ConflictPick>>(() =>
    Object.fromEntries((initial ?? []).map((c) => [c.path, 'draft' as const])),
  );
  const conflicts = 'conflicts' in step ? step.conflicts : undefined;

  const rebase = async () => {
    setStep({ status: 'working' });
    try {
      const found = await onRebase();
      setPicks(Object.fromEntries(found.map((c) => [c.path, 'draft' as const])));
      setStep(found.length ? { status: 'conflicts', conflicts: found } : { status: 'updated' });
    } catch {
      setStep({ status: 'failed' });
    }
  };

  const resolve = async (list: DraftConflict[]) => {
    setStep({ status: 'working', conflicts: list });
    try {
      await onResolve(picks, list);
      setStep({ status: 'updated' });
    } catch {
      setStep({ status: 'failed', conflicts: list });
    }
  };

  if (step.status === 'updated')
    return (
      <Alert data-color="success" data-size="sm">
        {t('services.outdatedUpdated')}
      </Alert>
    );

  return (
    <Alert data-color="warning" data-size="sm" role="alert">
      <div className="stack-sm">
        <Heading level={3} data-size="2xs">
          {t('services.outdatedTitle')}
        </Heading>
        {conflicts ? (
          <>
            <Paragraph data-size="sm">{t('services.outdatedConflicts')}</Paragraph>
            {conflicts.map((c) => (
              <Fieldset key={c.path} data-size="sm">
                <Fieldset.Legend>
                  {label(c.path, t)} <span className="meta">({c.path})</span>
                </Fieldset.Legend>
                <Radio
                  name={`conflict-${c.path}`}
                  label={t('services.keepDraft')}
                  description={shown(c.draft, t)}
                  checked={picks[c.path] !== 'published'}
                  onChange={() => setPicks((p) => ({ ...p, [c.path]: 'draft' }))}
                />
                <Radio
                  name={`conflict-${c.path}`}
                  label={t('services.usePublished')}
                  description={shown(c.published, t)}
                  checked={picks[c.path] === 'published'}
                  onChange={() => setPicks((p) => ({ ...p, [c.path]: 'published' }))}
                />
              </Fieldset>
            ))}
            <div className="row-wrap">
              <Button
                data-size="sm"
                variant="secondary"
                disabled={step.status === 'working'}
                onClick={() => void resolve(conflicts)}
              >
                {t('services.saveChoices')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Paragraph data-size="sm">{t('services.outdatedChanged')}</Paragraph>
            <ul className="bullets">
              {changedSections(paths, t).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <div className="row-wrap">
              <Button
                data-size="sm"
                variant="secondary"
                disabled={step.status === 'working'}
                onClick={() => void rebase()}
              >
                {t('services.updateDraft')}
              </Button>
            </div>
          </>
        )}
        {step.status === 'failed' ? (
          <Paragraph data-size="sm">{t('services.updateFailed')}</Paragraph>
        ) : null}
      </div>
    </Alert>
  );
};
