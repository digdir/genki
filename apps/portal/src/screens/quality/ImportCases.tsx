import { Alert, Button, Heading, Label, Paragraph } from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import type { ServiceTestSet } from '../../api/quality';
import { useT, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { parseCaseFile, type ImportRow, type RowProblem } from './import-cases';
import { problemTitle, type SetFlash } from './shared';

interface Ready {
  file: string;
  unit: 'row' | 'case';
  rows: ImportRow[];
}

const whereOf = (t: T, unit: 'row' | 'case', n: number) =>
  unit === 'row' ? t('quality.importRow', { n }) : t('quality.importCase', { n });

const problemText = (t: T, p: RowProblem) => t(`quality.importProblem.${p}`);

export const ImportCases = ({
  api,
  tenant,
  testSet,
  existingIds,
  setFlash,
  onImported,
}: {
  api: ApiClient;
  tenant: string;
  testSet: ServiceTestSet;
  existingIds: readonly string[];
  setFlash: SetFlash;
  onImported: () => void;
}) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const inputId = useId();
  const helpId = useId();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<Ready>();
  const [problems, setProblems] = useState<string[]>();
  const [busy, setBusy] = useState(false);

  if (!canManage) return null;
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('quality.importCases')}
      </Button>
    );

  const read = async (file: File) => {
    setReady(undefined);
    setProblems(undefined);
    const result = parseCaseFile(file.name, await file.text(), existingIds);
    if (!result.ok) {
      setProblems([t(`quality.importFile.${result.problem}`)]);
      return;
    }
    const failing = result.rows.filter((r) => r.problems.length > 0);
    if (failing.length > 0) {
      setProblems(
        failing.map((r) =>
          t('quality.importLine', {
            where: whereOf(t, result.unit, r.row),
            problems: r.problems.map((p) => problemText(t, p)).join(', '),
          }),
        ),
      );
      return;
    }
    setReady({ file: file.name, unit: result.unit, rows: result.rows });
  };

  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const reason = t('quality.importReason', { file: ready.file, name: testSet.name });
    let done = 0;
    try {
      for (const row of ready.rows) {
        try {
          await api.quality.addCase(tenant, testSet.id, row.value, reason);
          done++;
        } catch (error) {
          setFlash({
            color: 'danger',
            text: t('quality.importStopped', {
              where: whereOf(t, ready.unit, row.row),
              problem: problemTitle(error, t),
              count: done,
              total: ready.rows.length,
            }),
          });
          return;
        }
      }
      setFlash({
        color: 'success',
        text: t('quality.importDone', { count: done, name: testSet.name }),
      });
      setReady(undefined);
      setOpen(false);
    } finally {
      setBusy(false);
      if (done > 0) onImported();
    }
  };

  return (
    <section className="quality-panel stack-sm" aria-label={t('quality.importCases')}>
      <Label htmlFor={inputId}>{t('quality.importFile')}</Label>
      <Paragraph data-size="sm" id={helpId}>
        {t('quality.importHelp')}
      </Paragraph>
      <input
        id={inputId}
        type="file"
        accept=".csv,.json,.yaml,.yml"
        aria-describedby={helpId}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void read(file);
        }}
      />
      {problems ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          <Heading level={3} data-size="2xs">
            {t('quality.importProblems')}
          </Heading>
          <ul className="bullets">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {ready ? (
        <Paragraph data-size="sm" role="status">
          {t('quality.importReady', { count: ready.rows.length, file: ready.file })}
        </Paragraph>
      ) : null}
      <div className="actions">
        {ready ? (
          <Button variant="primary" aria-disabled={busy || undefined} onClick={() => void run()}>
            {t('quality.importRun', { count: ready.rows.length })}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setReady(undefined);
            setProblems(undefined);
          }}
        >
          {t('quality.cancel')}
        </Button>
      </div>
    </section>
  );
};
