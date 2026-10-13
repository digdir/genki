import { Alert, Button, Heading, Paragraph, Table, Tag } from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { CatalogProposal, ProposalMapping } from '../../api/building-blocks';
import { Icon, icons } from '../../components/Icon';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { kindLabel } from '../../data/building-blocks';
import { useT, type Format, type PlainKey, type T } from '../../i18n';
import { rightLabel, useRights } from '../../Shell';
import type { PortalRight } from '../../types';
import { ApiCallButton, PermissionList, useBlockRights, type Flash } from './common';
import { ReadsSummary } from './Connectors';

type Step = 'idle' | 'approve' | 'send';

const becomesLabel: Record<ProposalMapping['becomes'], PlainKey> = {
  document: 'blocks.becomesDocument',
  field: 'blocks.becomesField',
  attachment: 'blocks.becomesAttachment',
  excluded: 'blocks.becomesExcluded',
};

const createdText = (t: T, f: Format, proposal: CatalogProposal) => {
  const at = new Date(proposal.createdAt);
  const day = new Intl.DateTimeFormat(intlLocale(f.locale), {
    timeZone: 'Europe/Oslo',
    day: 'numeric',
    month: 'long',
  }).format(at);
  const service = proposal.forService.name;
  const params = { service, day, time: f.time(at) };
  return proposal.requestedBy
    ? t('blocks.createdAsked', { ...params, name: proposal.requestedBy })
    : t('blocks.created', params);
};

export const approvalRight = (proposal: Pick<CatalogProposal, 'level'>): PortalRight =>
  proposal.level === 3 ? 'register-building-blocks' : 'manage-services';

export const MappingTable = ({ mapping }: { mapping: ProposalMapping[] }) => {
  const t = useT();
  return (
    <div tabIndex={0} role="region" aria-label={t('blocks.mappingLabel')} className="table-scroll">
      <Table data-size="sm">
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell scope="col">{t('blocks.mappingTable')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('blocks.mappingBecomes')}</Table.HeaderCell>
            <Table.HeaderCell scope="col">{t('blocks.mappingFields')}</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {mapping.map((m) => (
            <Table.Row key={m.table}>
              <Table.HeaderCell scope="row">{m.table}</Table.HeaderCell>
              <Table.Cell>{t(becomesLabel[m.becomes])}</Table.Cell>
              <Table.Cell>
                {m.becomes === 'excluded' ? (m.reason ?? '') : (m.fields ?? []).join(', ')}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

export const ProposalSection = ({
  api,
  tenant,
  proposal,
  onDone,
}: {
  api: ApiClient;
  tenant: string;
  proposal: CatalogProposal;
  onDone: (flash: Flash) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const headingId = useId();
  const { has } = useRights();
  const { readOnly } = useBlockRights();
  const [step, setStep] = useState<Step>('idle');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | false>(false);
  const right = approvalRight(proposal);
  const canApprove = has(right);
  const sent = proposal.state === 'sent_for_approval';
  const service = proposal.forService.name;
  const connector = proposal.level === 2;
  const name =
    proposal.item?.name ??
    (connector ? t('blocks.connectorFor', { service }) : t('blocks.newBlock'));
  const kind = proposal.item ? kindLabel(t, proposal.item.kind) : t('blocks.connectorKind');
  const allPassed = proposal.tests.every((test) => test.passed);
  const rightName = rightLabel(t, right);

  const decide = async (action: 'approve' | 'reject' | 'send-for-approval', text: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const { changedBy } = await api.buildingBlocks.decideProposal(
        tenant,
        proposal.id,
        action,
        text,
      );
      if (action === 'approve')
        onDone({
          kind: 'logged',
          text: t('blocks.proposalApproved', { name, service }),
          change: changedBy,
        });
      else if (action === 'reject')
        onDone({
          kind: 'plain',
          text: t('blocks.proposalRejected'),
        });
      else
        onDone({
          kind: 'logged',
          text: t('blocks.proposalSent', { right: rightName }),
          change: changedBy,
        });
    } catch (error) {
      const problem = error instanceof ApiError ? error.problem : undefined;
      const status = error instanceof ApiError ? error.status : 0;
      setFailed(
        problem && status === 422
          ? [problem.title, ...(problem.errors ?? []).map((e) => e.message)].join(': ')
          : problem && status === 403
            ? problem.title
            : t('blocks.choiceFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const confirm = (next: Exclude<Step, 'idle'>) => {
    if (step !== next) {
      setStep(next);
      setTried(false);
      return;
    }
    setTried(true);
    if (reasonProblem(reason, t)) return;
    void decide(next === 'approve' ? 'approve' : 'send-for-approval', reason);
  };

  const reject = () =>
    void decide('reject', reasonProblem(reason, t) ? t('blocks.rejectReason') : reason);

  const call = () =>
    canApprove
      ? {
          action: t('blocks.approveAdopt'),
          method: 'POST' as const,
          path: api.buildingBlocks.proposalsPath(
            tenant,
            `/${encodeURIComponent(proposal.id)}/approve`,
          ),
          body: { reason: reason.trim() || '…' },
          right: rightName,
        }
      : {
          action: t('blocks.sendForApproval'),
          method: 'POST' as const,
          path: api.buildingBlocks.proposalsPath(
            tenant,
            `/${encodeURIComponent(proposal.id)}/send-for-approval`,
          ),
          body: { reason: reason.trim() || '…' },
          right: rightLabel(t, 'manage-services'),
        };

  const reasonText =
    step === 'approve'
      ? t(connector ? 'blocks.reasonApproveConnector' : 'blocks.reasonApproveTool', { service })
      : t('blocks.reasonSend', { right: rightName });

  return (
    <section aria-labelledby={headingId} className="bb-proposal">
      <div className="tag-row">
        <Tag data-color="warning" data-size="sm">
          {t('blocks.proposedByAssistant')}
        </Tag>
        <Tag data-color="neutral" data-size="sm">
          {t('blocks.notActive')}
        </Tag>
        {sent ? (
          <Tag data-color="info" data-size="sm">
            {t('blocks.sentForApproval')}
          </Tag>
        ) : null}
      </div>
      <div className="bb-proposal-head">
        <Heading level={2} data-size="xs" id={headingId}>
          {name}
        </Heading>
        {proposal.item?.description ? <span>{proposal.item.description}</span> : null}
        <span className="bb-meta">
          {kind} · {createdText(t, f, proposal)}
        </span>
      </div>
      {proposal.mapping?.length ? <MappingTable mapping={proposal.mapping} /> : null}
      {proposal.source ? <ReadsSummary source={proposal.source} dataset={name} /> : null}
      <div className="bb-proposal-grid">
        <div className="stack-sm">
          <h3 className="bb-h3">{connector ? t('blocks.needsAccess') : t('blocks.asksAccess')}</h3>
          <PermissionList permissions={proposal.permissions} />
        </div>
        <div className="stack-sm">
          <h3 className="bb-h3">
            {connector ? t('blocks.testRead') : t('blocks.contractTest')}{' '}
            <Tag data-color={allPassed ? 'success' : 'danger'} data-size="sm">
              {connector
                ? allPassed
                  ? t('blocks.passed')
                  : t('blocks.notPassed')
                : allPassed
                  ? t('blocks.contractPassed')
                  : t('blocks.contractNotPassed')}
            </Tag>
          </h3>
          <ul className="bb-checks">
            {proposal.tests.map((test) => (
              <li key={test.name}>
                <span className={test.passed ? 'bb-check' : 'bb-cross'}>
                  <Icon d={test.passed ? icons.check : icons.close} size={18} strokeWidth={2} />
                </span>
                <span>
                  {test.name}
                  {test.passed ? null : (
                    <span className="visually-hidden"> ({t('blocks.failedLower')})</span>
                  )}
                  {test.reason ? <span className="bb-note">{test.reason}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {proposal.quality ? (
            <>
              <h3 className="bb-h3">{t('blocks.quality')}</h3>
              <Paragraph data-size="sm">{proposal.quality}</Paragraph>
            </>
          ) : null}
        </div>
      </div>
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          <Paragraph data-size="sm">{failed}</Paragraph>
        </Alert>
      ) : null}
      {readOnly && !canApprove ? (
        <Paragraph data-size="sm">{t('blocks.onlyRightApproves', { right: rightName })}</Paragraph>
      ) : !canApprove && sent ? (
        <Paragraph data-size="sm">{t('blocks.sentRightApproves', { right: rightName })}</Paragraph>
      ) : (
        <>
          {!canApprove ? (
            <Paragraph data-size="sm">
              {proposal.level === 3 ? t('blocks.noRightRegister') : t('blocks.noRightManage')}
            </Paragraph>
          ) : null}
          {step !== 'idle' ? (
            <div className="bb-reason">
              <ReasonField
                value={reason}
                onChange={setReason}
                showError={tried}
                description={reasonText}
              />
            </div>
          ) : null}
          <div className="actions">
            {canApprove ? (
              <>
                <Button
                  variant="primary"
                  onClick={() => confirm('approve')}
                  aria-disabled={busy || undefined}
                >
                  {step === 'approve' ? t('blocks.confirmAdopt') : t('blocks.approveAdopt')}
                </Button>
                <Button variant="secondary" onClick={reject} aria-disabled={busy || undefined}>
                  {t('blocks.reject')}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={() => confirm('send')}
                aria-disabled={busy || undefined}
              >
                {step === 'send' ? t('blocks.send') : t('blocks.sendForApproval')}
              </Button>
            )}
            <ApiCallButton call={call} />
          </div>
        </>
      )}
    </section>
  );
};
