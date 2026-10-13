import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Field,
  Fieldset,
  Heading,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import {
  exampleDatasetNames,
  exampleImportRows,
  exampleServiceNames,
  slug,
  type SettingRow,
} from '../../data/settings';
import { isSet } from './model';
import { reasonProblem } from '../../components/ReasonField';
import { useT } from '../../i18n';

type Mode = 'export' | 'import';
type Resolution = 'skip' | 'over';

const today = () => new Date().toISOString().slice(0, 10);
const yamlKey = (name: string) => slug(name).replace(/-/g, '_');

const buildYaml = (
  rows: SettingRow[],
  include: { tenant: boolean; services: string[]; datasets: string[] },
  tenantName: string,
) => {
  const keyOf = (s: SettingRow) => s.apiKey ?? s.id;
  const lines = [
    '# Eksport fra Fellesløsning for generativ KI',
    `virksomhet: ${tenantName} (999 888 777)`,
    'plattformstandard: v12',
    `eksportert: ${today()}`,
    '',
  ];
  if (include.tenant) {
    lines.push('virksomhet_innstillinger:');
    rows
      .filter((s) => isSet(s.V))
      .forEach((s) =>
        lines.push(
          `  ${keyOf(s)}: ${s.type === 'secret' ? `keyvault://${slug(tenantName)}/${(s.id.split('.')[1] ?? s.id).replace(/_/g, '-')}` : JSON.stringify(s.V)}`,
        ),
      );
    lines.push('');
  }
  if (include.services.length) {
    lines.push('tjenester:');
    include.services.forEach((n) => {
      lines.push(`  ${yamlKey(n)}:`);
      const set = rows.filter((s) => s.svc[n] !== undefined);
      if (!set.length) lines.push('    {}  # arver alt');
      set.forEach((s) => lines.push(`    ${keyOf(s)}: ${JSON.stringify(s.svc[n])}`));
      rows
        .filter((s) => s.pins?.[n])
        .forEach((s) => lines.push(`    ${keyOf(s)}: { festet: ${s.pins?.[n]?.[0] ?? ''} }`));
    });
    lines.push('');
  }
  if (include.datasets.length) {
    lines.push('datasett:');
    include.datasets.forEach((n) => {
      lines.push(`  ${yamlKey(n)}:`);
      const set = rows.filter((s) => s.ds[n] !== undefined);
      if (!set.length) lines.push('    {}  # arver alt');
      set.forEach((s) => lines.push(`    ${keyOf(s)}: ${JSON.stringify(s.ds[n])}`));
    });
  }
  return lines.join('\n');
};

export const Transfer = ({
  rows,
  tenantName,
  onFlash,
}: {
  rows: SettingRow[];
  tenantName: string;
  onFlash: (text: string) => void;
}) => {
  const t = useT();
  const ids = { file: useId(), reason: useId() };
  const [mode, setMode] = useState<Mode>('export');
  const [step, setStep] = useState(1);
  const [incTenant, setIncTenant] = useState(true);
  const [incServices, setIncServices] = useState<string[]>(exampleServiceNames);
  const [incDatasets, setIncDatasets] = useState<string[]>(['Kudos-rapporter']);
  const [file, setFile] = useState('');
  const [fileErr, setFileErr] = useState('');
  const [itemErr, setItemErr] = useState('');
  const [glob, setGlob] = useState<Resolution>('skip');
  const [res, setRes] = useState<Record<number, Resolution>>({});
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');

  const toggle = (list: string[], set: (v: string[]) => void, name: string) =>
    set(list.includes(name) ? list.filter((x) => x !== name) : [...list, name]);
  const count = (pick: (s: SettingRow) => boolean) => rows.filter(pick).length;
  const tenantCount = count((s) => isSet(s.V));
  const secrets = count((s) => isSet(s.V) && s.type === 'secret');
  const items = [
    {
      label: t('settings.itemTenant'),
      desc: t('settings.itemTenantDesc', { count: tenantCount, secrets }),
      checked: incTenant,
      toggle: () => setIncTenant((v) => !v),
      nested: false,
    },
    ...exampleServiceNames.map((n) => {
      const c = count((s) => s.svc[n] !== undefined);
      return {
        label: t('settings.itemService', { name: n }),
        desc: c ? t('settings.itemServiceSet', { count: c }) : t('settings.itemInheritsAll'),
        checked: incServices.includes(n),
        toggle: () => toggle(incServices, setIncServices, n),
        nested: true,
      };
    }),
    ...exampleDatasetNames.map((n) => {
      const c = count((s) => s.ds[n] !== undefined);
      return {
        label: t('settings.itemDataset', { name: n }),
        desc: c ? t('settings.itemDatasetSet', { count: c }) : t('settings.itemDatasetInherits'),
        checked: incDatasets.includes(n),
        toggle: () => toggle(incDatasets, setIncDatasets, n),
        nested: true,
      };
    }),
  ];
  const anyIncluded = incTenant || incServices.length > 0 || incDatasets.length > 0;
  const yaml = buildYaml(
    rows,
    { tenant: incTenant, services: incServices, datasets: incDatasets },
    tenantName,
  );
  const fileName = `${slug(tenantName)}-innstillinger-${today()}.yaml`;
  const exportCount = yaml
    .split('\n')
    .filter((l) => /^\s{2,4}[a-zA-Z]+\.[a-zA-Z_]+:/.test(l)).length;

  const dryRows = exampleImportRows.map(([where, , label, now, next, act, note], i) => {
    const choice = res[i] ?? glob;
    const conflict = act === 'konflikt';
    const action = conflict
      ? t(choice === 'over' ? 'settings.actConflictOverwrite' : 'settings.actConflictSkip')
      : t(
          (
            {
              endres: 'settings.actChanged',
              uendret: 'settings.actUnchanged',
              opprettes: 'settings.actCreated',
              hoppes: 'settings.actSkipped',
            } as const
          )[act as 'endres'] ?? 'settings.actSkipped',
        );
    return {
      i,
      where,
      label,
      now,
      next,
      conflict,
      choice,
      act,
      action,
      color: conflict
        ? 'warning'
        : act === 'endres'
          ? 'info'
          : act === 'opprettes'
            ? 'success'
            : 'neutral',
      note: note ?? (conflict ? t('settings.conflictNote') : ''),
    } as const;
  });
  const counts = {
    created: dryRows.filter((r) => r.act === 'opprettes').length,
    changed: dryRows.filter((r) => r.act === 'endres' || (r.conflict && r.choice === 'over'))
      .length,
    skipped: dryRows.filter(
      (r) => r.act === 'uendret' || r.act === 'hoppes' || (r.conflict && r.choice === 'skip'),
    ).length,
    conflicts: dryRows.filter((r) => r.conflict).length,
  };
  const steps =
    mode === 'export'
      ? [t('settings.stepChoose'), t('settings.stepReviewDownload')]
      : [t('settings.stepChoose'), t('settings.stepDryRun'), t('settings.stepDone')];
  const nextLabel =
    step === 3
      ? ''
      : mode === 'export'
        ? step === 1
          ? t('settings.nextNext')
          : t('settings.nextDownload')
        : step === 1
          ? t('settings.nextDryRun')
          : t('settings.nextApply');

  const next = () => {
    if (step === 1) {
      if (!anyIncluded) {
        setItemErr(t('settings.includeNothing'));
        return;
      }
      if (mode === 'import' && (!file || fileErr)) {
        setFileErr(fileErr || t('settings.fileRequired'));
        return;
      }
      setItemErr('');
      setStep(2);
      return;
    }
    if (mode === 'export') {
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
        a.download = fileName;
        a.click();
      } catch {
        // jsdom and old browsers lack createObjectURL
      }
      onFlash(t('settings.downloaded'));
      return;
    }
    const reasonError = reasonProblem(reason, t);
    if (reasonError) {
      setReasonErr(reasonError);
      return;
    }
    setStep(3);
  };

  return (
    <div className="transfer stack">
      <Fieldset>
        <Fieldset.Legend>{t('settings.transferWhat')}</Fieldset.Legend>
        <div className="tag-row">
          {(
            [
              ['export', t('settings.transferExport')],
              ['import', t('settings.transferImport')],
            ] as const
          ).map(([id, label]) => (
            <Chip.Radio
              key={id}
              name="transfer-mode"
              checked={mode === id}
              onChange={() => {
                setMode(id);
                setStep(1);
                setRes({});
                setFileErr('');
                setItemErr('');
              }}
            >
              {label}
            </Chip.Radio>
          ))}
        </div>
      </Fieldset>
      <ol aria-label={t('settings.transferSteps')} className="transfer-steps plain-list">
        {steps.map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? 'step' : undefined}
            className={step > i + 1 ? 'done' : step === i + 1 ? 'current' : undefined}
          >
            <span aria-hidden="true" className="step-dot">
              {i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <Alert data-color="info" data-size="sm">
        {t('settings.secretsNeverExported')}
      </Alert>

      {step === 1 ? (
        <div className="stack-sm">
          {mode === 'import' ? (
            <Field>
              <Label htmlFor={ids.file}>{t('settings.fileYaml')}</Label>
              <input
                id={ids.file}
                type="file"
                accept=".yaml,.yml"
                className="file-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setFile(f.name);
                  setFileErr(/\.ya?ml$/i.test(f.name) ? '' : t('settings.fileMustBeYaml'));
                }}
              />
              <Button
                variant="tertiary"
                data-size="sm"
                className="align-start"
                onClick={() => {
                  setFile('testetaten-test-2026-10-06.yaml');
                  setFileErr('');
                }}
              >
                {t('settings.useExample')}
              </Button>
              {file ? (
                <Tag
                  data-size="sm"
                  data-color={fileErr ? 'danger' : 'success'}
                  className="align-start"
                >
                  {file}
                </Tag>
              ) : null}
              {fileErr ? <ValidationMessage>{fileErr}</ValidationMessage> : null}
            </Field>
          ) : null}
          <Fieldset>
            <Fieldset.Legend>{t('settings.include')}</Fieldset.Legend>
            <div className="include-list">
              {items.map((item) => (
                <Checkbox
                  key={item.label}
                  className={item.nested ? 'nested' : 'top'}
                  label={item.label}
                  description={item.desc}
                  checked={item.checked}
                  onChange={item.toggle}
                />
              ))}
            </div>
          </Fieldset>
          {itemErr ? <ValidationMessage>{itemErr}</ValidationMessage> : null}
        </div>
      ) : null}

      {mode === 'export' && step === 2 ? (
        <div className="export-file">
          <div className="export-file-head">
            <span className="strong">{fileName}</span>
            <span>{t('settings.exportCount', { count: exportCount })}</span>
          </div>
          <pre tabIndex={0} aria-label={t('settings.exportContent')}>
            <code>{yaml}</code>
          </pre>
        </div>
      ) : null}

      {mode === 'import' && step === 2 ? (
        <div className="stack-sm">
          <Heading level={2} data-size="xs">
            {t('settings.dryRunTitle')}
          </Heading>
          <ul aria-label={t('settings.summary')} className="tag-row plain-list">
            <li>
              <Tag data-color="success">
                {t('settings.summaryCreated', { count: counts.created })}
              </Tag>
            </li>
            <li>
              <Tag data-color="info">{t('settings.summaryChanged', { count: counts.changed })}</Tag>
            </li>
            <li>
              <Tag data-color="neutral">
                {t('settings.summarySkipped', { count: counts.skipped })}
              </Tag>
            </li>
            <li>
              <Tag data-color="warning">
                {t('settings.summaryConflicts', { count: counts.conflicts })}
              </Tag>
            </li>
          </ul>
          <Fieldset>
            <Fieldset.Legend>{t('settings.onConflictAll')}</Fieldset.Legend>
            <div className="tag-row">
              {(
                [
                  ['skip', t('settings.skip')],
                  ['over', t('settings.overwrite')],
                ] as const
              ).map(([k, l]) => (
                <Chip.Radio
                  key={k}
                  name="conflict-all"
                  checked={glob === k}
                  onChange={() => {
                    setGlob(k);
                    setRes({});
                  }}
                >
                  {l}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label={t('settings.dryRegion')}
          >
            <Table data-size="sm" className="dry-table">
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('settings.colWhere')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('settings.colSetting')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('settings.colNow')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('settings.colFromFile')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('settings.colResult')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {dryRows.map((r) => (
                  <TableRow key={r.i} className={r.conflict ? 'conflict' : undefined}>
                    <TableCell>{r.where}</TableCell>
                    <TableHeaderCell scope="row" className="row-head-plain">
                      {r.label}
                    </TableHeaderCell>
                    <TableCell>{r.now}</TableCell>
                    <TableCell className="break">{r.next}</TableCell>
                    <TableCell>
                      <span className="stack-xs align-start">
                        <Tag data-size="sm" data-color={r.color}>
                          {r.action}
                        </Tag>
                        {r.conflict ? (
                          <span
                            role="radiogroup"
                            aria-label={t('settings.onConflictFor', { name: r.label })}
                            className="tag-row"
                          >
                            {(
                              [
                                ['skip', t('settings.skip')],
                                ['over', t('settings.overwrite')],
                              ] as const
                            ).map(([k, l]) => (
                              <Chip.Radio
                                key={k}
                                data-size="sm"
                                name={`conflict-${r.i}`}
                                checked={r.choice === k}
                                onChange={() => setRes((x) => ({ ...x, [r.i]: k }))}
                              >
                                {l}
                              </Chip.Radio>
                            ))}
                          </span>
                        ) : null}
                        {r.note ? <span className="meta">{r.note}</span> : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Field className="reason-field">
            <Label htmlFor={ids.reason}>{t('common.reason')}</Label>
            <Textarea
              id={ids.reason}
              rows={2}
              value={reason}
              aria-invalid={reasonErr ? true : undefined}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonErr('');
              }}
            />
            {reasonErr ? <ValidationMessage>{reasonErr}</ValidationMessage> : null}
          </Field>
        </div>
      ) : null}

      {step === 3 ? (
        <Alert data-color="success">
          <Heading level={2} data-size="2xs">
            {t('settings.importDone')}
          </Heading>
          <p className="no-margin">
            {t('settings.importDoneText', {
              created: counts.created,
              changed: counts.changed,
              skipped: counts.skipped,
            })}
          </p>
        </Alert>
      ) : null}

      <div className="actions transfer-actions">
        {step === 2 ? (
          <Button variant="secondary" onClick={() => setStep(1)}>
            {t('settings.prev')}
          </Button>
        ) : null}
        {nextLabel ? (
          <Button variant="primary" onClick={next}>
            {nextLabel}
          </Button>
        ) : null}
        {step === 3 ? (
          <Button
            variant="secondary"
            onClick={() => {
              setStep(1);
              setRes({});
              setReason('');
              setFile('');
            }}
          >
            {t('settings.restart')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
