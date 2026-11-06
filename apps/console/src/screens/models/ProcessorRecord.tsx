import {
  Alert,
  Button,
  Fieldset,
  FieldsetLegend,
  Heading,
  Paragraph,
  Textfield,
} from '@digdir/designsystemet-react';
import { useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useT, type T } from '../../i18n';
import type { EndpointProcessorRecord, ProcessorRecord } from '../../types';
import { SidePanel } from '../../ui';
import { reasonError, ReasonField } from './reason-field';

export interface ProcessorDraft {
  agreement: string;
  subProcessors: { name: string; location: string }[];
  days: string;
  note: string;
}

export const draftOf = (record: ProcessorRecord | null | undefined): ProcessorDraft => ({
  agreement: record?.agreement ?? '',
  subProcessors: record?.subProcessors.length
    ? record.subProcessors.map((s) => ({ ...s }))
    : [{ name: '', location: '' }],
  days: record ? String(record.retention.days) : '',
  note: record?.retention.note ?? '',
});

/** Checks a draft and gives the record to send, or an error per field path. */
export const recordOf = (
  draft: ProcessorDraft,
  t: T,
): { record: ProcessorRecord } | { errors: Record<string, string> } => {
  const errors: Record<string, string> = {};
  if (!draft.agreement.trim()) errors.agreement = t('endpoints.processorAgreementMissing');
  const rows = draft.subProcessors.filter((s) => s.name.trim() || s.location.trim());
  rows.forEach((s, i) => {
    if (!s.name.trim()) errors[`subProcessors.${i}.name`] = t('endpoints.processorNameMissing');
    if (!s.location.trim())
      errors[`subProcessors.${i}.location`] = t('endpoints.processorLocationMissing');
  });
  const days = Number(draft.days);
  if (!/^\d+$/.test(draft.days.trim()) || days > 3650)
    errors['retention.days'] = t('endpoints.processorDaysInvalid');
  if (Object.keys(errors).length) return { errors };
  return {
    record: {
      agreement: draft.agreement.trim(),
      subProcessors: rows.map((s) => ({ name: s.name.trim(), location: s.location.trim() })),
      retention: { days, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) },
    },
  };
};

const apiErrors = (error: unknown) =>
  error instanceof ApiError
    ? Object.fromEntries((error.problem?.errors ?? []).map((e) => [e.path ?? '', e.message]))
    : {};

export const ProcessorRecordForm = ({
  api,
  endpoint,
  current,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  endpoint: string;
  current: EndpointProcessorRecord | undefined;
  onClose: () => void;
  onSaved: (saved: EndpointProcessorRecord) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [draft, setDraft] = useState(() => draftOf(current?.record));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const row = (i: number, change: Partial<ProcessorDraft['subProcessors'][number]>) =>
    setDraft((d) => ({
      ...d,
      subProcessors: d.subProcessors.map((s, j) => (j === i ? { ...s, ...change } : s)),
    }));

  const save = async () => {
    setFailed(undefined);
    const checked = recordOf(draft, t);
    const missingReason = reasonError(reason, t);
    if ('errors' in checked || missingReason) {
      setErrors({
        ...('errors' in checked ? checked.errors : {}),
        ...(missingReason ? { 'change-reason': missingReason } : {}),
      });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      onSaved(await api.saveProcessorRecord(endpoint, checked.record, reason.trim()));
    } catch (error) {
      const placed = apiErrors(error);
      setErrors(placed);
      if (Object.keys(placed).length === 0)
        setFailed(tRef.current('endpoints.processorSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel labelledBy="processor-panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">{endpoint}</span>
        <Heading level={2} data-size="xs" id="processor-panel-h" tabIndex={-1}>
          {t('endpoints.processorTitle', { id: endpoint })}
        </Heading>
      </div>
      <div className="panel-body">
        <Paragraph data-size="sm">{t('endpoints.processorIntro')}</Paragraph>
        <Textfield
          label={t('endpoints.processorAgreement')}
          description={t('endpoints.processorAgreementHint')}
          value={draft.agreement}
          onChange={(e) => setDraft((d) => ({ ...d, agreement: e.target.value }))}
          error={errors.agreement}
        />
        <Fieldset>
          <FieldsetLegend>{t('endpoints.processorSubProcessors')}</FieldsetLegend>
          <Paragraph data-size="sm">{t('endpoints.processorSubProcessorsHint')}</Paragraph>
          {draft.subProcessors.map((s, i) => (
            <div key={i} className="stack-sm">
              <Textfield
                label={t('endpoints.processorName', { n: i + 1 })}
                value={s.name}
                onChange={(e) => row(i, { name: e.target.value })}
                error={errors[`subProcessors.${i}.name`]}
              />
              <Textfield
                label={t('endpoints.processorLocation', { n: i + 1 })}
                value={s.location}
                onChange={(e) => row(i, { location: e.target.value })}
                error={errors[`subProcessors.${i}.location`]}
              />
              {draft.subProcessors.length > 1 ? (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  className="align-start"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      subProcessors: d.subProcessors.filter((_, j) => j !== i),
                    }))
                  }
                >
                  {t('endpoints.processorRemoveRow', { n: i + 1 })}
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            variant="secondary"
            data-size="sm"
            className="align-start"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                subProcessors: [...d.subProcessors, { name: '', location: '' }],
              }))
            }
          >
            {t('endpoints.processorAddRow')}
          </Button>
        </Fieldset>
        <Textfield
          label={t('endpoints.processorDays')}
          description={t('endpoints.processorDaysHint')}
          inputMode="numeric"
          value={draft.days}
          onChange={(e) => setDraft((d) => ({ ...d, days: e.target.value }))}
          error={errors['retention.days']}
        />
        <Textfield
          label={t('endpoints.processorNote')}
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          error={errors['retention.note']}
        />
        <ReasonField value={reason} error={errors['change-reason']} onChange={setReason} />
        {failed ? (
          <Alert data-color="danger" role="alert">
            {failed}
          </Alert>
        ) : null}
      </div>
      <div className="panel-foot actions-row">
        <Button loading={busy} onClick={() => void save()}>
          {t('endpoints.processorSave')}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </SidePanel>
  );
};
