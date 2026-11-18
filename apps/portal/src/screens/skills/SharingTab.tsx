import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Tag,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { SkillDetail, SkillUse } from '../../api/skills';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { publisherName } from '../../data/skills';
import { useT } from '../../i18n';

interface Props {
  detail: SkillDetail;
  services: SkillUse[];
  tenantName: string;
  canEdit: boolean;
  onShare: (reason: string) => Promise<void>;
  onWithdraw: () => Promise<void>;
}

type Choice = 'org' | 'all';

export const SharingTab = ({
  detail,
  services,
  tenantName,
  canEdit,
  onShare,
  onWithdraw,
}: Props) => {
  const t = useT();
  const [formOpen, setFormOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [reason, setReason] = useState('');
  const [showReasonError, setShowReasonError] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState('');
  const [status, setStatus] = useState('');
  const own = detail.publisher.type === 'own';
  const notPublished = detail.version === undefined;
  const sharing = detail.share === 'pending_digdir' || detail.share === 'shared';
  const choice: Choice = sharing || formOpen ? 'all' : 'org';

  const choose = async (next: Choice) => {
    if (sending || next === choice) return;
    setFailed('');
    if (next === 'all') {
      setFormOpen(true);
      setConfirmed(false);
      setConfirmError('');
      setReason('');
      setShowReasonError(false);
      return;
    }
    if (formOpen && !sharing) {
      setFormOpen(false);
      return;
    }
    setSending(true);
    setStatus(t('skills.shareSaving'));
    try {
      await onWithdraw();
      setStatus(t('skills.shareWithdrawn'));
    } catch {
      setStatus('');
      setFailed(t('skills.shareWithdrawFailed'));
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (sending) return;
    if (!confirmed) {
      setConfirmError(t('skills.shareConfirmProblem'));
      return;
    }
    if (reasonProblem(reason, t)) {
      setShowReasonError(true);
      return;
    }
    setSending(true);
    setFailed('');
    setStatus(t('skills.shareSaving'));
    try {
      await onShare(reason.trim());
      setFormOpen(false);
      setStatus(t('skills.shareSent'));
    } catch {
      setStatus('');
      setFailed(t('skills.shareSendFailed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="skill-sharing">
      <section aria-labelledby="skill-usage-h" className="skill-sharing-usage">
        <Heading level={2} data-size="xs" id="skill-usage-h">
          {t('skills.usedInCount', { count: services.length })}
        </Heading>
        {services.length ? (
          <ul className="plain-list skill-usage-list">
            {services.map((s) => (
              <li key={s.service}>
                <a className="ds-link" href={`#/services/${encodeURIComponent(s.service)}`}>
                  {s.name}
                </a>
                <span className="skill-help">
                  {t('skills.usesVersion', { version: s.version })}
                </span>
                {detail.version !== undefined && s.version !== detail.version ? (
                  <Tag data-size="sm" data-color="info">
                    {t('skills.usageUpdate', { version: detail.version })}
                  </Tag>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="skill-help">{t('skills.usageNoServices')}</p>
        )}
      </section>

      {own ? (
        <div className="skill-share-block">
          <Fieldset className="skill-share-fieldset" disabled={!canEdit || undefined}>
            <Fieldset.Legend>{t('skills.whoCanUse')}</Fieldset.Legend>
            {detail.share === 'rejected' ? (
              <Paragraph data-size="sm">{t('skills.shareRejected')}</Paragraph>
            ) : null}
            <Radio
              name="skill-share"
              value="org"
              checked={choice === 'org'}
              label={t('skills.shareOnlyUs', { tenant: tenantName })}
              description={t('skills.shareOnlyUsHelp', { tenant: tenantName })}
              onChange={() => void choose('org')}
            />
            <Radio
              name="skill-share"
              value="all"
              checked={choice === 'all'}
              disabled={notPublished && !sharing}
              label={t('skills.shareAll')}
              description={
                notPublished && !sharing
                  ? t('skills.sharePublishFirst')
                  : detail.share === 'pending_digdir'
                    ? t('skills.shareAllPending')
                    : detail.share === 'shared'
                      ? t('skills.shareSharedOwn', { count: detail.sharedWith })
                      : t('skills.shareAllHelp')
              }
              onChange={() => void choose('all')}
            />
            {formOpen && !sharing ? (
              <div className="skill-share-form">
                <Paragraph data-size="sm">
                  {t('skills.shareExplain', { tenant: tenantName })}
                </Paragraph>
                <Checkbox
                  label={t('skills.shareConfirm')}
                  checked={confirmed}
                  aria-invalid={confirmError ? true : undefined}
                  onChange={(e) => {
                    setConfirmed(e.target.checked);
                    setConfirmError('');
                  }}
                />
                {confirmError ? <ValidationMessage>{confirmError}</ValidationMessage> : null}
                <ReasonField
                  value={reason}
                  onChange={setReason}
                  showError={showReasonError}
                  description={t('skills.shareReasonHelp')}
                />
                <div className="actions">
                  <Button
                    variant="primary"
                    aria-busy={sending || undefined}
                    onClick={() => void send()}
                  >
                    {t('skills.shareSend')}
                  </Button>
                  <Button variant="secondary" onClick={() => setFormOpen(false)}>
                    {t('skills.cancel')}
                  </Button>
                </div>
              </div>
            ) : null}
            <span aria-live="polite" className="skill-flash">
              {status}
            </span>
            {failed ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {failed}
              </Alert>
            ) : null}
          </Fieldset>
        </div>
      ) : (
        <section aria-labelledby="skill-share-h">
          <Heading level={2} data-size="xs" id="skill-share-h">
            {t('skills.whoCanUse')}
          </Heading>
          <Paragraph>
            {t('skills.shareSharedOther', {
              publisher: publisherName(detail.publisher, tenantName),
            })}
          </Paragraph>
        </section>
      )}
    </div>
  );
};
