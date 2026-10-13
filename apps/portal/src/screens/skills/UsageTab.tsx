import {
  Alert,
  Button,
  Checkbox,
  Heading,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { SkillDetail, SkillUse } from '../../api/skills';
import { ApiCallLink, type ApiCallPreview } from '../../components/ApiCall';
import { useFormat } from '@genai/i18n/react';
import { changedWhen } from '../../components/ChangeLogged';
import { useT } from '../../i18n';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { publisherName } from '../../data/skills';

interface Props {
  detail: SkillDetail;
  services: SkillUse[];
  sharedWith: number;
  tenantName: string;
  canEdit: boolean;
  shareCall: (reason: string) => ApiCallPreview;
  onShare: (reason: string) => Promise<void>;
  onWithdraw: () => Promise<void>;
}

export const UsageTab = ({
  detail,
  services,
  sharedWith,
  tenantName,
  canEdit,
  shareCall,
  onShare,
  onWithdraw,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const [formOpen, setFormOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [reason, setReason] = useState('');
  const [showReasonError, setShowReasonError] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState('');
  const latest = detail.version;
  const notPublished = latest === undefined;

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
    try {
      await onShare(reason.trim());
      setFormOpen(false);
      setReason('');
      setConfirmed(false);
    } catch {
      setFailed(t('skills.shareSendFailed'));
    } finally {
      setSending(false);
    }
  };

  const withdraw = async () => {
    if (sending) return;
    setSending(true);
    setFailed('');
    try {
      await onWithdraw();
    } catch {
      setFailed(t('skills.shareWithdrawFailed'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="stack">
      <section aria-labelledby="skill-usage-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="skill-usage-h">
          {t('skills.usageTitle')}
        </Heading>
        <p className="subtle skill-text">{t('skills.usageNote')}</p>
        {services.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t('skills.usageServicesLabel')}
          >
            <Table className="skill-usage-table">
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('skills.usageColService')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('skills.usageColVersion')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('skills.colStatus')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {services.map((s) => (
                  <TableRow key={s.service}>
                    <th scope="row" className="case-input">
                      <a className="ds-link" href={`#/services/${encodeURIComponent(s.service)}`}>
                        {s.name}
                      </a>
                    </th>
                    <TableCell>{s.version}</TableCell>
                    <TableCell>
                      <Tag data-size="sm" data-color={s.version === latest ? 'success' : 'info'}>
                        {s.version === latest
                          ? t('skills.usageLatest')
                          : t('skills.usageUpdate', { version: latest ?? '' })}
                      </Tag>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Paragraph data-size="sm">{t('skills.usageNoServices')}</Paragraph>
        )}
      </section>

      <section aria-labelledby="skill-share-h" className="skill-section">
        <Heading level={2} data-size="xs" id="skill-share-h">
          {t('skills.shareTitle')}
        </Heading>
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed}
          </Alert>
        ) : null}
        {detail.share === 'none' || detail.share === 'rejected' ? (
          <>
            {detail.share === 'rejected' ? (
              <p className="skill-text">{t('skills.shareRejected')}</p>
            ) : null}
            <p className="skill-text">{t('skills.shareExplain', { tenant: tenantName })}</p>
            {notPublished ? (
              <p className="subtle skill-text">{t('skills.sharePublishFirst')}</p>
            ) : null}
            {canEdit && !formOpen ? (
              <Button
                variant="secondary"
                className="self-start"
                aria-disabled={notPublished || undefined}
                onClick={() => {
                  if (notPublished) return;
                  setFormOpen(true);
                  setConfirmed(false);
                  setConfirmError('');
                  setReason('');
                  setShowReasonError(false);
                }}
              >
                {t('skills.shareTitle')}
              </Button>
            ) : null}
            {canEdit && formOpen ? (
              <div className="skill-share-form">
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
                    aria-disabled={sending || undefined}
                    onClick={() => void send()}
                  >
                    {t('skills.shareSend')}
                  </Button>
                  <Button variant="secondary" onClick={() => setFormOpen(false)}>
                    {t('skills.cancel')}
                  </Button>
                  <ApiCallLink call={shareCall(reason)} />
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {detail.share === 'pending_digdir' ? (
          <Alert data-color="warning">
            <Heading level={3} data-size="2xs">
              {t('skills.sharePendingTitle')}
            </Heading>
            <Paragraph>
              {detail.shareRequest
                ? t('skills.sharePendingSent', {
                    when: changedWhen(new Date(detail.shareRequest.at), undefined, f, t),
                    by: detail.shareRequest.by,
                  })
                : t('skills.sharePendingToday')}
            </Paragraph>
            {canEdit ? (
              <Button
                variant="secondary"
                data-size="sm"
                aria-disabled={sending || undefined}
                onClick={() => void withdraw()}
              >
                {t('skills.shareWithdraw')}
              </Button>
            ) : null}
          </Alert>
        ) : null}
        {detail.share === 'shared' ? (
          <Alert data-color="success" data-size="sm">
            {detail.publisher.type === 'own'
              ? t('skills.shareSharedOwn', { count: sharedWith })
              : t('skills.shareSharedOther', {
                  publisher: publisherName(detail.publisher, tenantName),
                })}
          </Alert>
        ) : null}
      </section>
    </div>
  );
};
