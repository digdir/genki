import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { reasonProblem } from '../../components/ReasonField';
import type { SettingRow } from '../../data/settings';
import { useT, type PlainKey, type T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import type { EffectiveSetting } from '../../types';
import { lastSaveOf, savedByText, settingErrorText } from './model';

interface Choice {
  key: string;
  section: 'answers' | 'data';
  label: PlainKey;
  help: PlainKey;
  options: readonly (readonly [string, PlainKey])[];
}

const choices: readonly Choice[] = [
  {
    key: 'answers.writtenStandard',
    section: 'answers',
    label: 'settings.commonLanguage',
    help: 'settings.commonLanguageHelp',
    options: [
      ['user', 'settings.wsUser'],
      ['bokmal', 'settings.wsBokmal'],
      ['nynorsk', 'settings.wsNynorsk'],
    ],
  },
  {
    key: 'retention.class',
    section: 'data',
    label: 'settings.commonRetention',
    help: 'settings.commonRetentionHelp',
    options: [
      ['transient', 'settings.commonRetentionTransient'],
      ['standard', 'settings.commonRetentionStandard'],
      ['case', 'settings.commonRetentionCase'],
    ],
  },
];

export const quotaKey = 'usage.monthlyTokens';

const rowFor = (rows: SettingRow[], key: string) => rows.find((r) => r.apiKey === key);

const valueOf = (row: SettingRow | undefined) => {
  const v = row?.V ?? row?.P;
  return typeof v === 'string' ? v : undefined;
};

type Problem =
  | { kind: 'refused' }
  | { kind: 'conflict'; theirs: { key: string; value: string }[]; by: string[] }
  | { kind: 'failed'; text: string };

const failureOf = (error: unknown, t: T): Problem => {
  if (error instanceof ApiError && error.status === 403) return { kind: 'refused' };
  const details = error instanceof ApiError ? error.problem?.errors : undefined;
  return {
    kind: 'failed',
    text: details?.length
      ? details.map((d) => settingErrorText(d.message, t)).join(' ')
      : t('settings.commonFailed'),
  };
};

export const CommonSettings = ({
  api,
  tenant,
  live,
  rows,
  onSaved,
  onDirty,
  now = () => new Date(),
}: {
  api: Pick<ApiClient, 'setTenantSetting' | 'tenantEffectiveSettings' | 'audit'>;
  tenant: string;
  live: boolean;
  rows: SettingRow[];
  onSaved: (rows: SettingRow[]) => void;
  onDirty: (dirty: boolean) => void;
  now?: () => Date;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const canEdit = useRights().has('manage-services');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [reasonShown, setReasonShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const [savedAt, setSavedAt] = useState<Date>();
  const present = choices.filter((c) => {
    const row = rowFor(rows, c.key);
    return row && valueOf(row) !== undefined;
  });
  const savedOf = (key: string) => valueOf(rowFor(rows, key)) ?? '';
  const changed = present.filter(
    (c) => draft[c.key] !== undefined && draft[c.key] !== savedOf(c.key),
  );
  const dirty = changed.length > 0;
  const quota = rowFor(rows, quotaKey);
  const quotaValue = quota?.V ?? quota?.P;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const withValues = (values: { key: string; value: string }[]) =>
    rows.map((r) => {
      const hit = values.find((v) => v.key === r.apiKey);
      return hit ? { ...r, V: hit.value } : r;
    });

  const discard = () => {
    setDraft({});
    setReason('');
    setReasonShown(false);
    setProblem(undefined);
  };

  const save = async () => {
    if (busy || !dirty) return;
    if (reasonProblem(reason, t)) {
      setReasonShown(true);
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const done: { key: string; value: string }[] = [];
    try {
      for (const c of changed) {
        const value = draft[c.key] ?? '';
        if (live) await api.setTenantSetting(tenant, c.key, value, reason.trim());
        done.push({ key: c.key, value });
      }
    } catch (error) {
      if (done.length) onSaved(withValues(done));
      if (error instanceof ApiError && error.status === 409) {
        const current: Record<string, EffectiveSetting> | undefined = await api
          .tenantEffectiveSettings(tenant)
          .catch(() => undefined);
        const open = changed.filter((c) => !done.some((d) => d.key === c.key));
        const saves = await Promise.all(open.map((c) => lastSaveOf(api, tenant, c.key)));
        const theirs = open.flatMap((c) => {
          const value = current?.[c.key]?.value;
          return typeof value === 'string' ? [{ key: c.key, value }] : [];
        });
        const by = saves.map((save) => savedByText(save, tRef.current, f)).filter(Boolean);
        setProblem({ kind: 'conflict', theirs, by });
      } else setProblem(failureOf(error, tRef.current));
      setBusy(false);
      return;
    }
    onSaved(withValues(done));
    setDraft({});
    setReason('');
    setReasonShown(false);
    setBusy(false);
    setSavedAt(now());
  };

  const takeTheirs = (theirs: { key: string; value: string }[]) => {
    onSaved(withValues(theirs));
    setDraft((d) =>
      Object.fromEntries(Object.entries(d).filter(([k]) => !theirs.some((x) => x.key === k))),
    );
    setProblem(undefined);
  };

  const optionLabel = (c: Choice, value: string) => {
    const hit = c.options.find(([v]) => v === value);
    return hit ? t(hit[1]) : value;
  };

  const field = (c: Choice) => {
    const row = rowFor(rows, c.key);
    const value = draft[c.key] ?? savedOf(c.key);
    const id = `common-${c.key.replace(/\W+/g, '-')}`;
    if (row?.setByDigdir)
      return (
        <div key={c.key} className="stack-xs">
          <span className="panel-label">{t(c.label)}</span>
          <Paragraph>{optionLabel(c, value)}</Paragraph>
          <Paragraph data-size="sm" className="meta">
            {t('settings.commonSetByDigdir')}
          </Paragraph>
        </div>
      );
    return (
      <Field key={c.key} className="common-field">
        <Label htmlFor={id}>{t(c.label)}</Label>
        <Field.Description>{t(c.help)}</Field.Description>
        <Select
          id={id}
          value={value}
          disabled={!canEdit}
          onChange={(e) => {
            setDraft((d) => ({ ...d, [c.key]: e.target.value }));
            setSavedAt(undefined);
            setProblem(undefined);
          }}
        >
          {c.options.map(([v, label]) => (
            <Select.Option key={v} value={v}>
              {t(label)}
            </Select.Option>
          ))}
        </Select>
      </Field>
    );
  };

  const reasonError = reasonShown ? reasonProblem(reason, t) : undefined;

  return (
    <div className="common-settings stack">
      {canEdit ? null : (
        <Alert data-color="info" data-size="sm">
          {t('settings.commonReadOnly')} {needsRight('manage-services', t)}
        </Alert>
      )}
      <div aria-live="polite">
        {savedAt ? (
          <Alert data-color="success" data-size="sm">
            {t('settings.commonSaved', { time: f.time(savedAt) })}{' '}
            <a href="#/log/changes">{t('settings.commonSeeLog')}</a>
          </Alert>
        ) : null}
      </div>
      <section aria-labelledby="common-answers" className="stack-sm">
        <Heading level={2} data-size="xs" id="common-answers">
          {t('settings.commonAnswers')}
        </Heading>
        {present.filter((c) => c.section === 'answers').map(field)}
      </section>
      <section aria-labelledby="common-data" className="stack-sm">
        <Heading level={2} data-size="xs" id="common-data">
          {t('settings.commonData')}
        </Heading>
        {present.filter((c) => c.section === 'data').map(field)}
        <Paragraph data-size="sm">
          <a href="#/data-handling">{t('settings.commonDataHandling')}</a>
        </Paragraph>
      </section>
      {typeof quotaValue === 'number' ? (
        <section aria-labelledby="common-quota" className="stack-sm">
          <Heading level={2} data-size="xs" id="common-quota">
            {t('settings.commonQuota')}
          </Heading>
          <Paragraph>
            {t('settings.commonQuotaValue', { tokens: f.number(quotaValue) })}{' '}
            <a href="#/statistics">{t('settings.commonSeeUsage')}</a>
          </Paragraph>
        </section>
      ) : null}
      <Paragraph data-size="sm">
        {t.rich('settings.commonAllLink', { all: (c) => <a href="#/settings/all">{c}</a> })}
      </Paragraph>
      {dirty ? (
        <section className="common-save-bar stack-sm" aria-label={t('settings.commonUnsaved')}>
          {problem?.kind === 'conflict' ? (
            <Alert data-color="warning" data-size="sm">
              <Paragraph data-size="sm">
                {t('settings.commonConflict')}{' '}
                {problem.theirs
                  .map((x) => {
                    const c = choices.find((y) => y.key === x.key);
                    return c
                      ? t('settings.commonConflictValue', {
                          label: t(c.label),
                          value: optionLabel(c, x.value),
                        })
                      : '';
                  })
                  .concat(problem.by)
                  .join(' ')}
              </Paragraph>
              <div className="actions">
                <Button data-size="sm" variant="primary" onClick={() => void save()}>
                  {t('settings.commonSaveMineAnyway')}
                </Button>
                {problem.theirs.length ? (
                  <Button
                    data-size="sm"
                    variant="secondary"
                    onClick={() => takeTheirs(problem.theirs)}
                  >
                    {t('settings.commonUseTheirs')}
                  </Button>
                ) : null}
              </div>
            </Alert>
          ) : problem ? (
            <Alert data-color={problem.kind === 'refused' ? 'warning' : 'danger'} data-size="sm">
              {problem.kind === 'refused'
                ? t('settings.commonRefused', { right: t('rights.manageServices') })
                : t('settings.commonFailedWith', { why: problem.text })}
            </Alert>
          ) : null}
          <strong>{t('settings.commonUnsaved')}</strong>
          <Textfield
            id="common-reason"
            data-size="sm"
            label={t('settings.commonReason')}
            description={t('settings.commonReasonHelp')}
            value={reason}
            error={reasonError}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="actions">
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {t('settings.commonSave')}
            </Button>
            <Button variant="secondary" onClick={discard}>
              {t('settings.commonDiscard')}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
};
