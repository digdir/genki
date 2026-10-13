import {
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Alert,
  Table,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import { Icon, icons } from '../../components/Icon';
import { NotDecided } from '../../components/NotDecided';
import {
  qualityCases,
  qualityRuns,
  qualityTags,
  splitFromCode,
  type CaseDetail,
  type CaseKind,
  type RunDetail,
  type SplitLabel,
} from '../../data/quality';
import { formatDateTime, usePortalFormat } from '../../format';
import type { Format, PlainKey, T } from '../../i18n';
import type { EvalRunSummary, TestSet } from '../../types';
import { kindKeys, langOf, type NewCase, type SetFlash } from './shared';

const splitColor: Record<SplitLabel, 'neutral' | 'info' | 'accent'> = {
  Trening: 'neutral',
  Validering: 'info',
  Låst: 'accent',
};

const splitNames: Record<SplitLabel, PlainKey> = {
  Trening: 'qualityTests.splitTrain',
  Validering: 'qualityTests.splitValidation',
  Låst: 'qualityTests.splitLocked',
};

const lastKeys: Record<string, PlainKey> = {
  Bestått: 'quality.passed',
  'Ikke bestått': 'quality.notPassed',
  'Ikke kjørt': 'qualityTests.notRun',
};

const expKeys: Record<CaseKind, PlainKey> = {
  kilder: 'qualityTests.expSources',
  kriterier: 'qualityTests.expCriteria',
  felter: 'qualityTests.expFields',
  avvis: 'qualityTests.expReject',
};

const importResult = (t: T, name: string) => ({
  ok: true,
  color: 'success' as const,
  text: t('qualityTests.importRead', { name }),
  errors: [t('qualityTests.importError1'), t('qualityTests.importError2')],
});

type Panel = 'new' | 'import' | 'run' | undefined;

interface Form {
  input: string;
  kind: CaseKind;
  exp: string;
  tags: string[];
  split: SplitLabel;
  tried: boolean;
}

const blankForm = (): Form => ({
  input: '',
  kind: 'kriterier',
  exp: '',
  tags: [],
  split: 'Validering',
  tried: false,
});

const inputText = (input: TestSet['spec']['cases'][number]['input']) =>
  typeof input === 'string' ? input : JSON.stringify(input.data ?? input.parts ?? '');

export const casesFrom = (sets: TestSet[], live = false): CaseDetail[] =>
  sets.flatMap((set) =>
    set.spec.cases.map((c) => {
      const known = live ? undefined : qualityCases.find((k) => k.id === c.id);
      if (known) return { ...known, input: inputText(c.input), split: splitFromCode[c.split] };
      const sources = (c.expected.sources ?? []).map(String);
      return {
        id: c.id,
        input: inputText(c.input),
        kind: sources.length ? 'kilder' : 'kriterier',
        ...(sources.length ? { exp: sources } : {}),
        crit: c.expected.referenceAnswer ?? '',
        tags: c.tags,
        split: splitFromCode[c.split],
        last: 'Ikke kjørt',
      } satisfies CaseDetail;
    }),
  );

interface RunRow {
  id: string;
  when: string;
  by: string;
  ver: string;
  commit: string;
  data: string;
  model: string;
  all: string;
  locked: string;
  tags: (number | undefined)[];
}

const rowsFrom = (
  runs: EvalRunSummary[],
  extra: RunDetail | undefined,
  live: boolean,
  f: Format,
  t: T,
): RunRow[] => {
  const fromApi = [...runs]
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    .map((r) => {
      const known = live ? undefined : qualityRuns.find((k) => k.id === r.id);
      const overall = r.metrics.rubric ?? Object.values(r.metrics)[0];
      return {
        id: r.id,
        when: known?.when ?? formatDateTime(r.endedAt, f),
        by: known?.by ?? t('qualityTests.unknown'),
        ver: known?.ver ?? t('qualityTests.unknownVersion'),
        commit: r.provenance.commit,
        data: known?.data ?? t('qualityTests.notStated'),
        model: known?.model ?? r.provenance.servedModels.join(', '),
        all: overall ? f.decimal(overall.mean, 2) : '–',
        locked: known ? f.decimal(known.locked, 2) : '–',
        tags: qualityTags.map((_, i) => known?.tags[i]),
      };
    });
  const first = extra
    ? [
        {
          ...extra,
          all: f.decimal(extra.all, 2),
          locked: f.decimal(extra.locked, 2),
          tags: extra.tags,
        },
      ]
    : [];
  return [...first, ...fromApi];
};

export const TestSetsTab = ({
  sets,
  runs,
  extraCases,
  onAddCase,
  setFlash,
  live = false,
}: {
  live?: boolean;
  sets: TestSet[];
  runs: EvalRunSummary[];
  extraCases: CaseDetail[];
  onAddCase: (c: NewCase) => string;
  setFlash: SetFlash;
}) => {
  const { t, f } = usePortalFormat();
  const [panel, setPanel] = useState<Panel>();
  const [form, setForm] = useState<Form>(blankForm);
  const [imp, setImp] = useState<
    ReturnType<typeof importResult> | { ok: false; color: 'danger'; text: string; errors: string[] }
  >();
  const [runId, setRunId] = useState('opg_5b2c');
  const [runErr, setRunErr] = useState('');
  const [running, setRunning] = useState(false);
  const [extraRun, setExtraRun] = useState<RunDetail>();
  const [splitFilter, setSplitFilter] = useState<'alle' | SplitLabel>('alle');
  const [resultFilter, setResultFilter] = useState<'alle' | 'feil' | 'ok'>('alle');
  const [openCase, setOpenCase] = useState<string | undefined>('T-014');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const all = [...extraCases, ...casesFrom(sets, live)];
  const count = (s: SplitLabel) => all.filter((c) => c.split === s).length;
  const rows = rowsFrom(runs, extraRun, live, f, t);
  const cases = all.filter(
    (c) =>
      (splitFilter === 'alle' || c.split === splitFilter) &&
      (resultFilter === 'alle' ||
        (resultFilter === 'feil' ? c.last === 'Ikke bestått' : c.last === 'Bestått')),
  );
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const errIn = form.tried && !form.input.trim() ? t('qualityTests.inputProblem') : '';
  const showForm = panel === 'new' || (panel === 'run' && Boolean(form.input));
  const canSave = panel !== 'import' || imp?.ok;

  const save = () => {
    if (panel === 'import') {
      setPanel(undefined);
      setFlash({ text: t('qualityTests.importDone'), color: 'success' });
      return;
    }
    if (!form.input.trim()) {
      set({ tried: true });
      return;
    }
    const id = onAddCase({
      input: form.input.trim(),
      kind: form.kind,
      crit: form.exp.trim(),
      tags: form.tags,
      split: form.split,
    });
    setPanel(undefined);
    setOpenCase(id);
    setFlash({
      text: t('qualityTests.caseAdded', { id, split: t(splitNames[form.split]).toLowerCase() }),
      color: 'success',
    });
  };

  const fetchRun = () => {
    if (!/^opg_[a-z0-9]{4,}$/i.test(runId.trim())) {
      setRunErr(t('qualityTests.runNotFound'));
      return;
    }
    set({
      input: 'Hvor mange tilsyn hadde vi i fjor?',
      kind: 'kriterier',
      exp: 'Oppgir tallet for 2025 med kilde fra Årsrapport 2025.',
      tags: ['Tall og statistikk', 'Tilsyn'],
    });
  };

  const runNow = () => {
    if (running) return;
    if (live) {
      setFlash({ text: t('qualityTests.runUnavailable'), color: 'warning' });
      return;
    }
    setRunning(true);
    setFlash({ text: t('qualityTests.running'), color: 'info' });
    timer.current = setTimeout(() => {
      setRunning(false);
      setExtraRun({
        id: 'ts-0613',
        when: 'I dag kl. 10.58',
        ver: 'v8-utkast',
        commit: 'c41e7a9',
        data: 'Kudos 6. okt',
        model: 'Borealis-27B v2.1',
        all: 0.81,
        locked: 0.82,
        by: 'Kari Nordmann',
        tags: [0.86, 0.8, 0.79, 0.78, 1.0],
      });
      setFlash({ text: t('qualityTests.runDone'), color: 'success' });
    }, 1500);
  };

  const open = (p: Panel) => {
    setPanel(p);
    setForm(blankForm());
    setImp(undefined);
    setRunErr('');
  };

  return (
    <div className="stack">
      <div className="quality-toolbar">
        <dl className="quality-counts">
          {[
            [t('quality.cases'), all.length],
            [t('qualityTests.splitTrain'), count('Trening')],
            [t('qualityTests.splitValidation'), count('Validering')],
            [t('qualityTests.splitLocked'), count('Låst')],
          ].map(([l, v]) => (
            <div key={l}>
              <dt>{l}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <Button variant="primary" onClick={() => open('new')}>
            {t('quality.newCase')}
          </Button>
          <Button variant="secondary" onClick={() => open('import')}>
            {t('qualityTests.importSheet')}
          </Button>
          <Button variant="secondary" onClick={() => open('run')}>
            {t('qualityTests.addFromRun')}
          </Button>
        </div>
      </div>
      <p className="quality-splits">
        {t.rich('qualityTests.splits', { strong: (c) => <strong>{c}</strong> })}
      </p>

      {panel ? (
        <section aria-labelledby="panel-h" className="quality-panel">
          <Heading level={2} data-size="xs" id="panel-h">
            {
              {
                new: t('quality.newCase'),
                import: t('qualityTests.importSheet'),
                run: t('qualityTests.addFromRun'),
              }[panel]
            }
          </Heading>
          {panel === 'import' ? (
            <div className="stack-sm">
              <Field>
                <Label htmlFor="imp-fil">{t('qualityTests.sheetLabel')}</Label>
                <Field.Description>
                  {t('qualityTests.sheetHelp')} <NotDecided />
                </Field.Description>
                <input
                  id="imp-fil"
                  type="file"
                  accept=".xlsx,.csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setImp(
                      /\.(xlsx|csv)$/i.test(file.name)
                        ? importResult(t, file.name)
                        : {
                            ok: false,
                            color: 'danger',
                            text: t('qualityTests.fileType'),
                            errors: [],
                          },
                    );
                  }}
                />
              </Field>
              <Button
                variant="tertiary"
                data-size="sm"
                className="align-start"
                onClick={() => setImp(importResult(t, 'testtilfeller-tilsyn.xlsx'))}
              >
                {t('qualityTests.useExample')}
              </Button>
              {imp ? (
                <div className="stack-sm">
                  <Alert data-color={imp.color} data-size="sm">
                    {imp.text}
                  </Alert>
                  {imp.errors.map((e) => (
                    <span key={e} className="small">
                      {e}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {panel === 'run' ? (
            <Field className="narrow-field">
              <Label htmlFor="run-id">{t('qualityTests.runId')}</Label>
              <Field.Description>{t('qualityTests.runIdHelp')}</Field.Description>
              <div className="row-wrap">
                <Input
                  id="run-id"
                  value={runId}
                  aria-invalid={runErr ? true : undefined}
                  onChange={(e) => {
                    setRunId(e.target.value);
                    setRunErr('');
                  }}
                />
                <Button variant="secondary" onClick={fetchRun}>
                  {t('qualityTests.fetch')}
                </Button>
              </div>
              {runErr ? <ValidationMessage>{runErr}</ValidationMessage> : null}
            </Field>
          ) : null}
          {showForm ? (
            <div className="stack-sm">
              <Field>
                <Label htmlFor="nc-in">{t('quality.input')}</Label>
                <Textarea
                  id="nc-in"
                  rows={2}
                  value={form.input}
                  aria-invalid={errIn ? true : undefined}
                  onChange={(e) => set({ input: e.target.value })}
                />
                {errIn ? <ValidationMessage>{errIn}</ValidationMessage> : null}
              </Field>
              <Fieldset>
                <Fieldset.Legend>{t('qualityTests.goodResultIs')}</Fieldset.Legend>
                <div className="tag-row">
                  {(Object.keys(kindKeys) as CaseKind[]).map((k) => (
                    <Chip.Radio
                      key={k}
                      name="nc-kind"
                      checked={form.kind === k}
                      onChange={() => set({ kind: k })}
                    >
                      {t(kindKeys[k])}
                    </Chip.Radio>
                  ))}
                </div>
              </Fieldset>
              <Field>
                <Label htmlFor="nc-exp">{t(expKeys[form.kind])}</Label>
                <Textarea
                  id="nc-exp"
                  rows={2}
                  value={form.exp}
                  onChange={(e) => set({ exp: e.target.value })}
                />
              </Field>
              <Fieldset>
                <Fieldset.Legend>{t('qualityTests.topics')}</Fieldset.Legend>
                <div className="tag-row">
                  {qualityTags.map((tag) => (
                    <Chip.Checkbox
                      key={tag}
                      checked={form.tags.includes(tag)}
                      onChange={() =>
                        set({
                          tags: form.tags.includes(tag)
                            ? form.tags.filter((x) => x !== tag)
                            : [...form.tags, tag],
                        })
                      }
                    >
                      {tag}
                    </Chip.Checkbox>
                  ))}
                </div>
              </Fieldset>
              <Fieldset>
                <Fieldset.Legend>{t('quality.part')}</Fieldset.Legend>
                <div className="tag-row">
                  {(['Trening', 'Validering', 'Låst'] as SplitLabel[]).map((x) => (
                    <Chip.Radio
                      key={x}
                      name="nc-split"
                      checked={form.split === x}
                      onChange={() => set({ split: x })}
                    >
                      {t(splitNames[x])}
                    </Chip.Radio>
                  ))}
                </div>
              </Fieldset>
            </div>
          ) : null}
          <div className="actions">
            {canSave ? (
              <Button variant="primary" onClick={save}>
                {t(panel === 'import' ? 'qualityTests.addImported' : 'quality.saveCase')}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setPanel(undefined)}>
              {t('quality.cancel')}
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="tema-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="tema-h">
          {t('qualityTests.scoresPerTopic')}
        </Heading>
        {rows.length === 0 ? (
          <Paragraph>{t('quality.notRunYet')}</Paragraph>
        ) : (
          <div tabIndex={0} role="region" aria-labelledby="tema-h" className="table-scroll">
            <Table className="heat-table">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('qualityTests.topic')}</Table.HeaderCell>
                  {rows.map((r) => (
                    <Table.HeaderCell scope="col" key={r.id} className="center">
                      <span className="col-head">
                        <span>{r.when.replace(' kl.', '')}</span>
                        <span className="meta">{r.ver}</span>
                      </span>
                    </Table.HeaderCell>
                  ))}
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {qualityTags.map((tag, ti) => (
                  <Table.Row key={tag}>
                    <Table.HeaderCell scope="row">{tag}</Table.HeaderCell>
                    {rows.map((r, ri) => {
                      const v = r.tags[ti];
                      const prev = rows[ri + 1]?.tags[ti];
                      if (v === undefined)
                        return (
                          <Table.Cell key={r.id} className="center">
                            –
                          </Table.Cell>
                        );
                      const drop = prev !== undefined && v - prev <= -0.04;
                      const tone = v >= 0.85 ? 'good' : v >= 0.75 ? undefined : 'bad';
                      return (
                        <Table.Cell
                          key={r.id}
                          className={['center', 'numeric', tone, drop ? 'drop' : '']
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {f.decimal(v, 2)}
                          {drop && prev !== undefined ? (
                            <span className="drop-mark">
                              {t('qualityTests.down', { value: f.decimal(prev - v, 2) })}
                            </span>
                          ) : null}
                        </Table.Cell>
                      );
                    })}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </section>

      <section aria-labelledby="kj-h" className="stack-sm">
        <div className="row-between">
          <Heading level={2} data-size="xs" id="kj-h">
            {t('qualityTests.lastRuns')}
          </Heading>
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={running || undefined}
            onClick={runNow}
          >
            {t('qualityTests.runNow')}
          </Button>
        </div>
        {rows.length === 0 ? (
          <Paragraph>{t('quality.notRunYet')}</Paragraph>
        ) : (
          <div tabIndex={0} role="region" aria-labelledby="kj-h" className="table-scroll">
            <Table className="runs-table">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('qualityTests.run')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">
                    {t('qualityTests.versionAndCommit')}
                  </Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('qualityTests.data')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('qualityTests.model')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('qualityTests.all')}
                  </Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('qualityTests.splitLocked')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {rows.map((r, i) => (
                  <Table.Row key={r.id}>
                    <Table.Cell>
                      <span className="col-head">
                        <strong className="medium">{r.when}</strong>
                        <span className="meta">
                          {r.id} · {r.by}
                        </span>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      {r.ver} · {r.commit}
                    </Table.Cell>
                    <Table.Cell>{r.data}</Table.Cell>
                    <Table.Cell>
                      <span className="tag-row">
                        {r.model}
                        {rows[i + 1] && rows[i + 1]?.model !== r.model ? (
                          <Tag data-size="sm" data-color="warning">
                            {t('qualityTests.newModel')}
                          </Tag>
                        ) : null}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="right numeric">{r.all}</Table.Cell>
                    <Table.Cell className="right numeric strong">{r.locked}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </section>

      <section aria-labelledby="cases-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="cases-h">
          {t('quality.cases')}
        </Heading>
        <div className="filter-row">
          <Fieldset>
            <Fieldset.Legend>{t('quality.part')}</Fieldset.Legend>
            <div className="tag-row">
              {(['alle', 'Trening', 'Validering', 'Låst'] as const).map((x) => (
                <Chip.Radio
                  key={x}
                  name="sf"
                  checked={splitFilter === x}
                  onChange={() => setSplitFilter(x)}
                >
                  {x === 'alle' ? t('qualityTests.all') : t(splitNames[x])}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
          <Fieldset>
            <Fieldset.Legend>{t('quality.result')}</Fieldset.Legend>
            <div className="tag-row">
              {(
                [
                  ['alle', t('qualityTests.all')],
                  ['feil', t('quality.notPassed')],
                  ['ok', t('quality.passed')],
                ] as const
              ).map(([k, l]) => (
                <Chip.Radio
                  key={k}
                  name="rf"
                  checked={resultFilter === k}
                  onChange={() => setResultFilter(k)}
                >
                  {l}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
        </div>
        {all.length === 0 ? (
          <div className="state empty">
            <Heading level={3} data-size="2xs">
              {t('quality.noCases')}
            </Heading>
            <Paragraph>{t('qualityTests.noCasesText')}</Paragraph>
          </div>
        ) : cases.length === 0 ? (
          <div className="state empty">
            <Paragraph>{t('qualityTests.noMatch')}</Paragraph>
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => {
                setSplitFilter('alle');
                setResultFilter('alle');
              }}
            >
              {t('qualityTests.resetFilters')}
            </Button>
          </div>
        ) : (
          <ul className="case-list">
            {cases.map((c) => {
              const o = openCase === c.id;
              return (
                <li key={c.id} className={o ? 'open' : undefined}>
                  <button
                    type="button"
                    aria-expanded={o}
                    onClick={() => setOpenCase(o ? undefined : c.id)}
                  >
                    <span className="case-id">{c.id}</span>
                    <span className="case-input" lang={langOf(c.input)}>
                      {c.input}
                    </span>
                    <span className="tag-row">
                      <Tag data-size="sm" data-color={splitColor[c.split]}>
                        {t(splitNames[c.split])}
                      </Tag>
                      <Tag
                        data-size="sm"
                        data-color={
                          c.last === 'Bestått'
                            ? 'success'
                            : c.last === 'Ikke bestått'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {lastKeys[c.last] ? t(lastKeys[c.last] as PlainKey) : c.last}
                      </Tag>
                    </span>
                    <span className={o ? 'chevron up' : 'chevron'}>
                      <Icon d={icons.chevronDown} size={18} />
                    </span>
                  </button>
                  {o ? (
                    <dl className="case-detail">
                      <dt>{t('qualityTests.goodResult')}</dt>
                      <dd>{t(kindKeys[c.kind])}</dd>
                      {c.exp ? (
                        <>
                          <dt>{t('quality.kindSources')}</dt>
                          <dd>{c.exp.join(', ')}</dd>
                        </>
                      ) : null}
                      <dt>{t('qualityTests.criteria')}</dt>
                      <dd>{c.crit || t('quality.notDescribed')}</dd>
                      <dt>{t('qualityTests.topics')}</dt>
                      <dd>{c.tags.join(', ') || t('qualityTests.none')}</dd>
                      {c.why ? (
                        <>
                          <dt>{t('qualityTests.lastRun')}</dt>
                          <dd className="danger-text">{c.why}</dd>
                        </>
                      ) : null}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
