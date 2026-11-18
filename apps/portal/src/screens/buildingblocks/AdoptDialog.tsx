import { Alert, Button, Dialog, Heading, Paragraph, Textfield } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { changeOf, requestChange, type CatalogItem } from '../../api/building-blocks';
import { reasonProblem } from '../../components/ReasonField';
import { useT } from '../../i18n';
import { refusalOf } from '../../states';
import type { Flash } from './common';

export const needsApproval = (item: Pick<CatalogItem, 'status'>) =>
  item.status === 'requires_approval';

export const AdoptDialog = ({
  api,
  tenant,
  tenantName,
  item,
  onClose,
  onDone,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  item: CatalogItem;
  onClose: () => void;
  onDone: (flash: Flash, adopted: boolean) => void;
}) => {
  const t = useT();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const [problem, setProblem] = useState('');
  const approval = needsApproval(item);
  const reasonError = tried ? reasonProblem(reason, t) : undefined;

  const tryClose = () => {
    if (busy) return;
    if (reason.trim()) setAskDiscard(true);
    else onClose();
  };

  const confirm = async () => {
    setTried(true);
    if (reasonProblem(reason, t)) return;
    setBusy(true);
    setProblem('');
    try {
      if (approval) {
        const result = await api.buildingBlocks.requestApproval(tenant, item, reason);
        onDone(
          {
            kind: 'logged',
            text: t('blockPages.pendingMessage', { name: item.name }),
            change: requestChange(result),
          },
          false,
        );
      } else {
        const result = await api.buildingBlocks.adopt(tenant, item, reason);
        const text = t('blockPages.adoptedMessage', { name: item.name });
        const change = changeOf(result);
        onDone(change ? { kind: 'logged', text, change } : { kind: 'plain', text }, true);
      }
    } catch (error) {
      setProblem(refusalOf(error) ?? t('blocks.saveFailed'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      modal
      closeButton={t('blockPages.close')}
      onClose={tryClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          tryClose();
        }
      }}
      aria-labelledby="bb-adopt-h"
    >
      <div className="stack-md">
        <Heading level={2} data-size="sm" id="bb-adopt-h">
          {t('blockPages.adoptQuestion', { name: item.name })}
        </Heading>
        <Paragraph>
          {t('blockPages.adoptConsequence', { name: item.name, tenant: tenantName })}
        </Paragraph>
        {approval && item.policyBlock ? (
          <Alert data-color="warning" data-size="sm">
            {item.policyBlock.text}
          </Alert>
        ) : null}
        <Textfield
          multiline
          rows={3}
          label={t('blockPages.adoptReason')}
          description={t('blockPages.adoptReasonHelp')}
          value={reason}
          error={reasonError}
          onChange={(e) => {
            setReason(e.target.value);
            setAskDiscard(false);
          }}
        />
        {askDiscard ? (
          <Alert data-color="warning" data-size="sm" role="alert">
            <Paragraph data-size="sm">{t('blockPages.discardQuestion')}</Paragraph>
            <div className="actions">
              <Button variant="secondary" data-size="sm" onClick={() => setAskDiscard(false)}>
                {t('blockPages.keepWriting')}
              </Button>
              <Button variant="primary" data-size="sm" onClick={onClose}>
                {t('blockPages.discard')}
              </Button>
            </div>
          </Alert>
        ) : null}
        {problem ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {problem}
          </Alert>
        ) : null}
        <div className="actions">
          <Button variant="secondary" onClick={tryClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" aria-busy={busy} onClick={() => void confirm()}>
            {busy
              ? t('blockPages.adopting')
              : approval
                ? t('blockPages.sendForApproval')
                : t('blockPages.adopt')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
