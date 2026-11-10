import { Card, Details, Link, List } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { RobotIcon } from '@navikt/aksel-icons';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.js';

export type ApproachStatus = 'done' | 'active' | 'waiting';

export interface ApproachDocument {
  title: string;
  /** Where in the document, for example the pages. */
  detail?: string;
}

export interface ApproachStep {
  id: string;
  /** As the platform sent it, or translated by the app. */
  title: string;
  description?: string;
  status: ApproachStatus;
  documents?: readonly ApproachDocument[];
  /** How many documents the step read in all, when more than are listed. */
  documentsRead?: number;
  /** The source numbers the answer used, as in its footnotes. */
  sourcesUsed?: readonly number[];
  /** The step says what the assistant did not find, and can link to more about it. */
  missing?: boolean;
}

export interface ApproachProps {
  steps: readonly ApproachStep[];
  /** True while the assistant works on the answer. */
  working: boolean;
  /** When the assistant started, in milliseconds since the epoch. */
  startedAt: number;
  finishedAt?: number;
  /** Documents read in all, for the line at the bottom once the answer is done. */
  read?: number;
  /** Sources used in the answer. */
  used?: number;
  /** Shows the link to everything a step read. Where it leads is up to the app. */
  onShowRead?: (stepId: string) => void;
  /** Shows the link to more about what the assistant did not find. */
  onExplainMissing?: (stepId: string) => void;
}

const useSeconds = (startedAt: number, finishedAt: number | undefined, working: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  return Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1000));
};

const StepBody = ({
  step,
  onShowRead: show,
  onExplainMissing: explain,
}: {
  step: ApproachStep;
  onShowRead: ApproachProps['onShowRead'];
  onExplainMissing: ApproachProps['onExplainMissing'];
}) => {
  const t = useT();
  const f = useFormat();
  const more = step.documentsRead ?? step.documents?.length ?? 0;
  return (
    <>
      {step.description ? (
        <p className="uib-approach-step-description">{step.description}</p>
      ) : null}
      {step.documents?.length ? (
        <List.Unordered className="uib-approach-step-documents">
          {step.documents.map((d, i) => (
            <List.Item key={`${d.title}-${i}`}>
              {d.detail ? t('approach.document', { title: d.title, detail: d.detail }) : d.title}
            </List.Item>
          ))}
        </List.Unordered>
      ) : null}
      {show && more ? (
        <Link
          href="#"
          className="uib-approach-step-link"
          onClick={(event) => {
            event.preventDefault();
            show(step.id);
          }}
        >
          {step.status === 'active'
            ? t('approach.showReadSoFar', { count: more })
            : t('approach.showRead', { count: more })}
        </Link>
      ) : null}
      {step.missing && explain ? (
        <Link
          href="#"
          className="uib-approach-step-link"
          onClick={(event) => {
            event.preventDefault();
            explain(step.id);
          }}
        >
          {t('approach.explainMissing')}
        </Link>
      ) : null}
      {step.sourcesUsed?.length ? (
        <p className="uib-approach-step-description">
          {t('approach.usedInAnswer', {
            sources: f.list(step.sourcesUsed.map(String)),
          })}
        </p>
      ) : null}
    </>
  );
};

/** How the assistant worked on an answer, as a card above it. Open while it works, closed when it is done. */
export const Approach = ({
  steps,
  working,
  startedAt,
  finishedAt,
  read,
  used,
  onShowRead,
  onExplainMissing,
}: ApproachProps) => {
  const t = useT();
  const [open, setOpen] = useState(working);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) setOpen(false);
    wasWorking.current = working;
  }, [working]);

  const seconds = useSeconds(startedAt, finishedAt, working);
  const activeIndex = steps.findIndex((s) => s.status === 'active');
  const active = steps[activeIndex];
  const knowsTotal = steps.some((s) => s.status === 'waiting');
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (!active) return;
    const n = activeIndex + 1;
    setAnnounced(
      knowsTotal
        ? t('approach.stepOf', { n, total: steps.length, title: active.title })
        : t('approach.step', { n, title: active.title }),
    );
  }, [active?.id, active?.title]);

  const readText = read === undefined ? undefined : t('approach.read', { count: read });
  const summary =
    readText === undefined
      ? used === undefined
        ? undefined
        : t('approach.usedOnly', { count: used })
      : used === undefined
        ? readText
        : t('approach.readAndUsed', {
            read: readText,
            used: t('approach.used', { count: used }),
          });
  const footer = working
    ? t('approach.workingFor', { count: seconds })
    : summary === undefined
      ? t('approach.tookOnly', { count: seconds })
      : t('approach.footer', { summary, took: t('approach.took', { count: seconds }) });

  return (
    <div className="uib-approach">
      <Card data-color="neutral" variant="default" className="uib-approach-card">
        <Details
          aria-label={t('approach.title')}
          open={open}
          onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
        >
          <Details.Summary>
            <span className="uib-approach-summary">
              <RobotIcon aria-hidden fontSize="18px" />
              {t('approach.title')}
            </span>
          </Details.Summary>
          <Details.Content>
            <List.Ordered className="uib-approach-steps">
              {steps.map((step) => (
                <List.Item
                  key={step.id}
                  data-status={step.status}
                  aria-current={step.status === 'active' ? 'step' : undefined}
                >
                  <span className="uib-approach-step-title">{step.title}</span>
                  {step.status === 'done' ? (
                    <span className="uib-visually-hidden">
                      {' '}
                      {t('approach.hiddenStatus', { status: t('approach.done') })}
                    </span>
                  ) : (
                    <span className="uib-approach-step-status">
                      {' '}
                      {t('approach.shownStatus', { status: t(`approach.${step.status}`) })}
                    </span>
                  )}
                  {step.status === 'waiting' ? null : (
                    <StepBody
                      step={step}
                      onShowRead={onShowRead}
                      onExplainMissing={onExplainMissing}
                    />
                  )}
                </List.Item>
              ))}
            </List.Ordered>
            <p className="uib-approach-footer">{footer}</p>
          </Details.Content>
        </Details>
      </Card>
      <p className="uib-visually-hidden" aria-live="polite">
        {working ? announced : ''}
      </p>
    </div>
  );
};
