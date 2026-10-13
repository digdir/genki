import {
  Alert,
  Button,
  Checkbox,
  Field,
  Heading,
  Label,
  Paragraph,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import { useT } from '../i18n';
import { ApiCallLink, type ApiCallPreview } from './ApiCall';
import { Icon, icons } from './Icon';
import { reasonProblem } from './ReasonField';

export interface QualityGate {
  name: string;
  value: string;
  passed: boolean;
  explanation?: string;
}

export interface UpdateAvailable {
  id: string;
  name: string;
  kind: string;
  score: string;
}

export interface PublishInput {
  reason: string;
  include: string[];
}

interface Props {
  tenantName: string;
  currentVersion: number;
  nextVersion: number;
  changes: string[];
  updates: UpdateAvailable[];
  facts: { label: string; value: string }[];
  gates: QualityGate[];
  apiCall: ApiCallPreview;
  fixAction?: { label: string; onClick: () => void };
  blockedBy?: string | undefined;
  inTest?: boolean;
  headingLevel?: 2 | 3;
  onPublish: (input: PublishInput) => Promise<void> | void;
  onPublishToTest?: (input: PublishInput) => Promise<void> | void;
  onCancel?: () => void;
}

type Flash = { text: string; color: 'success' | 'warning' | 'info' | 'danger' } | undefined;

export const PublishSummary = ({
  tenantName,
  currentVersion,
  nextVersion,
  changes,
  updates,
  facts,
  gates,
  apiCall,
  fixAction,
  blockedBy,
  inTest = true,
  headingLevel = 2,
  onPublish,
  onPublishToTest,
  onCancel,
}: Props) => {
  const t = useT();
  const ids = { reason: useId(), help: useId() };
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [include, setInclude] = useState<string[]>([]);
  const [published, setPublished] = useState(false);
  const [flash, setFlash] = useState<Flash>();
  const failed = gates.filter((g) => !g.passed);
  const blocked = failed.length > 0 || published || !!blockedBy;
  const sub = headingLevel === 2 ? 3 : 4;
  const input = () => ({ reason: reason.trim(), include });

  const publish = async () => {
    const first = failed[0];
    if (first) {
      setFlash({
        text: t('publish.lockedByGate'),
        color: 'warning',
      });
      return;
    }
    if (published) return;
    if (blockedBy) {
      setFlash({ text: blockedBy, color: 'warning' });
      return;
    }
    const reasonError = reasonProblem(reason, t);
    if (reasonError) {
      setError(reasonError);
      return;
    }
    try {
      await onPublish(input());
      setPublished(true);
      setFlash({
        text:
          currentVersion === 0
            ? t('publish.publishedFirst', { next: nextVersion })
            : t('publish.publishedNext', { next: nextVersion, current: currentVersion }),
        color: 'success',
      });
    } catch {
      setFlash({ text: t('publish.failed'), color: 'danger' });
    }
  };

  const publishToTest = async () => {
    try {
      await onPublishToTest?.(input());
      setFlash({
        text: t('publish.publishedToTest', { next: nextVersion }),
        color: 'success',
      });
    } catch {
      setFlash({ text: t('publish.failed'), color: 'danger' });
    }
  };

  return (
    <div className="publish-summary">
      <div aria-live="polite">
        {flash ? (
          <Alert data-color={flash.color} data-size="sm">
            {flash.text}
          </Alert>
        ) : null}
      </div>
      {updates.length > 0 ? (
        <section className="update-available" aria-label={t('publish.updateAvailable')}>
          <div className="row-wrap">
            <Heading level={headingLevel} data-size="xs">
              {t('publish.updateAvailable')}
            </Heading>
            <Tag data-size="sm" data-color="info">
              {t('publish.fromDigdir')}
            </Tag>
          </div>
          <Paragraph data-size="sm">{t('publish.updateIntro')}</Paragraph>
          <ul className="plain-list update-list">
            {updates.map((u) => (
              <li key={u.id}>
                <span className="update-name">
                  <strong>{u.name}</strong>
                  <span className="meta">{u.kind}</span>
                </span>
                <span className="numeric">{t('publish.testSet', { score: u.score })}</span>
                <Checkbox
                  label={
                    <>
                      {t('publish.include', { next: nextVersion })}
                      <span className="visually-hidden">: {u.name}</span>
                    </>
                  }
                  checked={include.includes(u.id)}
                  onChange={() =>
                    setInclude((all) =>
                      all.includes(u.id) ? all.filter((x) => x !== u.id) : [...all, u.id],
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="stack-sm" aria-label={t('publish.changes')}>
        <Heading level={headingLevel} data-size="xs">
          {currentVersion === 0
            ? t('publish.firstVersion', { next: nextVersion })
            : t(inTest ? 'publish.changedSinceInTest' : 'publish.changedSince', {
                next: nextVersion,
                current: currentVersion,
              })}
        </Heading>
        <ul className="bullets">
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
          {updates
            .filter((u) => include.includes(u.id))
            .map((u) => (
              <li key={u.id}>{t('publish.updateFromDigdir', { name: u.name })}</li>
            ))}
        </ul>
        <dl className="facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="stack-sm" aria-label={t('publish.gates')}>
        <Heading level={headingLevel} data-size="xs">
          {t('publish.gates')}
        </Heading>
        <ul className="gate-list">
          {gates.map((g) => (
            <li key={g.name} className={g.passed ? undefined : 'failed'}>
              <div className="row-wrap">
                <Tag data-size="sm" data-color={g.passed ? 'success' : 'danger'}>
                  <Icon d={g.passed ? icons.check : icons.close} size={14} strokeWidth={2} />
                  {g.passed ? t('publish.passed') : t('publish.notPassed')}
                </Tag>
                <span className="gate-name">{g.name}</span>
                <span className="numeric">{g.value}</span>
              </div>
              {!g.passed && g.explanation ? (
                <Paragraph data-size="sm">{g.explanation}</Paragraph>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      {failed[0] ? (
        <Alert data-color="danger">
          <Heading level={sub} data-size="2xs">
            {t('publish.cannotPublishYet')}
          </Heading>
          <Paragraph>
            {t('publish.gatesNotMet', {
              failed: failed.length,
              count: gates.length,
              name: failed[0].name.toLowerCase(),
              tenant: tenantName,
            })}
          </Paragraph>
        </Alert>
      ) : null}
      <Field className="reason-field">
        <Label htmlFor={ids.reason}>{t('publish.reasonLabel')}</Label>
        <Field.Description>{t('publish.reasonHelp')}</Field.Description>
        <Textarea
          id={ids.reason}
          rows={2}
          value={reason}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setReason(e.target.value);
            setError('');
          }}
        />
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Field>
      {currentVersion > 0 ? (
        <Alert data-color="info" data-size="sm">
          {t('publish.previousStays', { current: currentVersion })}
        </Alert>
      ) : null}
      <div className="actions">
        <Button
          variant="primary"
          aria-disabled={blocked || undefined}
          aria-describedby={ids.help}
          onClick={() => void publish()}
        >
          {t('publish.publish')}
        </Button>
        {onPublishToTest ? (
          <Button variant="secondary" onClick={() => void publishToTest()}>
            {t('publish.publishToTest')}
          </Button>
        ) : null}
        {fixAction ? (
          <Button variant="tertiary" onClick={fixAction.onClick}>
            {fixAction.label}
          </Button>
        ) : null}
        {onCancel ? (
          <Button variant="tertiary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <ApiCallLink call={apiCall} />
        <span id={ids.help} className="meta">
          {published
            ? t('publish.statusPublished', { next: nextVersion })
            : failed.length
              ? t('publish.statusLocked')
              : (blockedBy ?? t('publish.statusAllPassed'))}
        </span>
      </div>
    </div>
  );
};
