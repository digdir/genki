import {
  Alert,
  Button,
  Dialog,
  Heading,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { SkillPublishCheck, SkillUse } from '../../api/skills';
import { reasonProblem } from '../../components/ReasonField';
import { gateLabel, gateWhy } from '../../data/skills';
import { Loading } from '../../states';
import { useT } from '../../i18n';

interface Props {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  draftVersion: number;
  threshold: number;
  services: SkillUse[];
  shared: boolean;
  prepare: () => Promise<number | undefined>;
  onClose: () => void;
  onPublished: (version: number, reason: string) => void;
  onGoToTests: () => void;
}

type Failure = 'refused' | 'nothing' | 'requirements' | 'other';

export const PublishDialog = ({
  api,
  tenant,
  id,
  name,
  draftVersion,
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
  const [failed, setFailed] = useState<Failure>();

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
  const reasonError = showError ? reasonProblem(reason, t) : undefined;

  const confirm = async () => {
    if (blocked || busy || revision === undefined) return;
    setShowError(true);
    if (reasonProblem(reason, t)) return;
    setBusy(true);
    setFailed(undefined);
    try {
      const published = await api.skills.publish(tenant, id, reason.trim());
      onPublished(published.version, reason.trim());
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      setFailed(
        status === 403
          ? 'refused'
          : status === 409
            ? 'nothing'
            : status === 422 && error instanceof ApiError && 'requirements' in (error.problem ?? {})
              ? 'requirements'
              : 'other',
      );
      setBusy(false);
      if (status !== 403 && status !== 409) void load();
    }
  };

  const lead =
    t('skills.publishWillBeUsed', { version: draftVersion }) +
    ' ' +
    (services.length
      ? t('skills.publishServicesGet', { services: services.map((s) => s.name).join(', ') })
      : t('skills.publishNoServices')) +
    (shared ? t('skills.publishSharedNote') : '');

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
          {t('skills.publishDialogTitle', { name })}
        </Heading>
        <Paragraph>{lead}</Paragraph>
        {check === 'loading' ? (
          <Loading label={t('skills.publishChecking')} shape="list" rows={1} headingLevel={3} />
        ) : null}
        {check === 'error' ? (
          <Alert data-color="danger" data-size="sm">
            {t('skills.publishCheckFailed')}
          </Alert>
        ) : null}
        {typeof check === 'object' && check.blocked ? (
          <Alert data-color="danger" data-size="sm">
            <Paragraph data-size="sm">
              {t('skills.publishBlocked', { count: failedGates })}
            </Paragraph>
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
            <Button variant="secondary" data-size="sm" onClick={onGoToTests}>
              {t('skills.publishGoToTests')}
            </Button>
          </Alert>
        ) : null}
        <Textfield
          multiline
          rows={2}
          label={t('skills.publishWhy')}
          value={reason}
          error={reasonError}
          aria-invalid={reasonError ? true : undefined}
          disabled={typeof check === 'object' && check.blocked}
          onChange={(e) => setReason(e.target.value)}
        />
        {failed === 'refused' ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            <Heading level={3} data-size="2xs">
              {t('skills.publishRefusedTitle')}
            </Heading>
            <Paragraph data-size="sm">{t('skills.publishRefusedText')}</Paragraph>
          </Alert>
        ) : failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed === 'nothing'
              ? t('skills.publishNoChanges')
              : failed === 'requirements'
                ? t('skills.publishRequirementsChanged')
                : t('skills.publishFailed')}
          </Alert>
        ) : null}
        <div className="actions skill-dialog-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('skills.cancel')}
          </Button>
          <Button
            variant="primary"
            aria-disabled={blocked || busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy
              ? t('skills.publishing')
              : t('skills.publishVersionButton', { version: draftVersion })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
