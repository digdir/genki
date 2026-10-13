import {
  Alert,
  Button,
  Dialog,
  Heading,
  Paragraph,
  Spinner,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { SkillPublishCheck, SkillUse } from '../../api/skills';
import { ApiCallLink } from '../../components/ApiCall';
import { useT } from '../../i18n';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { gateLabel, gateWhy } from '../../data/skills';

interface Props {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  draftVersion: number;
  publishedVersion: number | undefined;
  changes: string[];
  testFact: string;
  threshold: number;
  services: SkillUse[];
  shared: boolean;
  prepare: () => Promise<number | undefined>;
  onClose: () => void;
  onPublished: (version: number, reason: string) => void;
  onGoToTests: () => void;
}

export const PublishDialog = ({
  api,
  tenant,
  id,
  name,
  draftVersion,
  publishedVersion,
  changes,
  testFact,
  threshold,
  services,
  shared,
  prepare,
  onClose,
  onPublished,
  onGoToTests,
}: Props) => {
  const t = useT();
  const [check, setCheck] = useState<SkillPublishCheck | 'loading' | 'error'>('loading');
  const [revision, setRevision] = useState<number>();
  const [reason, setReason] = useState('');
  const [showError, setShowError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const load = async () => {
    setCheck('loading');
    try {
      const saved = await prepare();
      if (saved === undefined) throw new Error('draft not saved');
      setRevision(saved);
      setCheck(await api.skills.publishCheck(tenant, id));
    } catch {
      setCheck('error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const blocked = check === 'loading' || check === 'error' || check.blocked;
  const failedGates = typeof check === 'object' ? check.gates.filter((g) => !g.passed).length : 0;

  const confirm = async () => {
    if (blocked || busy || revision === undefined) return;
    setShowError(true);
    if (reasonProblem(reason, t)) return;
    setBusy(true);
    setFailed('');
    try {
      const published = await api.skills.publish(tenant, id, reason.trim());
      onPublished(published.version, reason.trim());
    } catch (error) {
      setFailed(
        error instanceof ApiError && error.status === 422 && 'requirements' in (error.problem ?? {})
          ? t('skills.publishRequirementsChanged')
          : t('skills.publishFailed'),
      );
      setBusy(false);
      void load();
    }
  };

  const serviceNote = services.length
    ? t('skills.publishServiceNote', {
        services: services.map((s) => s.name).join(', '),
        versions: services.map((s) => s.version).join(', '),
        draft: draftVersion,
      }) + (shared ? t('skills.publishSharedNote') : '')
    : t('skills.publishNoServices');

  return (
    <Dialog
      open
      modal
      closeButton={t('skills.close')}
      onClose={onClose}
      aria-labelledby="skill-pub-h"
      className="skill-publish-dialog"
    >
      <div className="stack-md">
        <Heading level={2} data-size="sm" id="skill-pub-h">
          {t('skills.publishTitle', {
            version: draftVersion,
            name: name || t('skills.publishNameFallback'),
          })}
        </Heading>
        <div className="stack-xs">
          <h3 className="skill-dialog-h">
            {publishedVersion
              ? t('skills.publishChangesSince', { version: publishedVersion })
              : t('skills.publishWhat')}
          </h3>
          <ul className="bullets">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <dl className="facts">
          <div>
            <dt>{t('skills.publishTestset')}</dt>
            <dd>{testFact}</dd>
          </div>
          <div>
            <dt>{t('skills.publishRequirement')}</dt>
            <dd>{t('skills.publishAtLeast', { percent: Math.round(threshold * 100) })}</dd>
          </div>
          <div>
            <dt>{t('skills.publishServices')}</dt>
            <dd>{services.length}</dd>
          </div>
        </dl>
        <div className="stack-xs">
          <h3 className="skill-dialog-h">{t('skills.publishGates')}</h3>
          {check === 'loading' ? (
            <span role="status" className="busy-note">
              <Spinner aria-hidden data-size="xs" />
              {t('skills.publishChecking')}
            </span>
          ) : null}
          {check === 'error' ? (
            <Alert data-color="danger" data-size="sm">
              {t('skills.publishCheckFailed')}
            </Alert>
          ) : null}
          {typeof check === 'object' ? (
            <ul className="plain-list skill-gates" aria-label={t('skills.publishGates')}>
              {check.gates.map((g) => {
                const why = gateWhy(t, g);
                return (
                  <li key={g.kind}>
                    <Tag data-size="sm" data-color={g.passed ? 'success' : 'danger'}>
                      {g.passed ? t('skills.publishMet') : t('skills.publishNotMet')}
                    </Tag>
                    <span>
                      {gateLabel(t, g, threshold)}
                      {why ? <span className="skill-gate-why">{why}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        {typeof check === 'object' && check.blocked ? (
          <Alert data-color="danger" data-size="sm">
            <Paragraph data-size="sm">
              {t('skills.publishBlocked', { count: failedGates })}
            </Paragraph>
            <Button variant="secondary" data-size="sm" onClick={onGoToTests}>
              {t('skills.publishGoToTests')}
            </Button>
          </Alert>
        ) : null}
        <Paragraph data-size="sm">{serviceNote}</Paragraph>
        <ReasonField
          value={reason}
          onChange={setReason}
          showError={showError}
          disabled={typeof check === 'object' && check.blocked}
        />
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed}
          </Alert>
        ) : null}
        <div className="actions">
          <Button
            variant="primary"
            aria-disabled={blocked || busy || undefined}
            onClick={() => void confirm()}
          >
            {t('skills.publishConfirm')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('skills.cancel')}
          </Button>
          <ApiCallLink
            call={{
              action: t('skills.publishAction'),
              method: 'POST',
              path: `${api.skills.skillPath(tenant, id)}/publish`,
              body: { reason: reason.trim() || '…' },
              right: t('skills.rightManage'),
            }}
          />
        </div>
      </div>
    </Dialog>
  );
};
