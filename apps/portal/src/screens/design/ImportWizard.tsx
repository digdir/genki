import {
  Button,
  Checkbox,
  Heading,
  Label,
  Paragraph,
  Radio,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { blockFixtures } from '@genai/contracts/block-fixtures';
import type { BlockState } from '@genai/contracts/blocks';
import { useLocale } from '@genai/i18n/react';
import { RefBlock } from '@genai/ui-assembly';
import '@genai/ui-assembly/styles.css';
import '@genai/ui-blocks/styles.css';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api';
import type { BlockPreview, ImportResult } from '../../api/design';
import { BusyButton } from '../../components/BusyButton';
import { useT, type PlainKey } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { BundleField } from './CodeUpload';
import { asBlockDraft, codeDefinition, type BlockDraft, type Bundle } from './definitions';
import { designPath, idFromName } from './naming';
import { Crumbs, Panel, Toast } from './parts';
import { Problems } from './Problems';
import { coreIssueLink, labelOf, propsOf } from './props';

type Step = 1 | 2 | 3 | 4;
type Source = 'claude' | 'sketch';
type Tier = 'declarative' | 'code';

const steps: { step: Step; key: PlainKey }[] = [
  { step: 1, key: 'design.stepSource' },
  { step: 2, key: 'design.stepImport' },
  { step: 3, key: 'design.stepType' },
  { step: 4, key: 'design.stepDraft' },
];

const stateKey: Partial<Record<BlockState, PlainKey>> = {
  empty: 'design.stateEmpty',
  loading: 'design.stateLoading',
  error: 'design.stateError',
};

const Check = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li>
    <span className="design-check" data-ok={ok} aria-hidden="true">
      {ok ? '✓' : '!'}
    </span>
    <span>{children}</span>
  </li>
);

/** «Importer fra Claude»: source, import, type, and a draft on test. */
export const ImportWizard = ({ api, tenant, tenantName }: ScreenProps) => {
  const t = useT();
  const { locale } = useLocale();
  const ids = useId();
  const [step, setStep] = useState<Step>(1);
  const [source, setSource] = useState<Source>('claude');
  const [name, setName] = useState('');
  const [html, setHtml] = useState('');
  const [fileName, setFileName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [imported, setImported] = useState<ImportResult | undefined>(undefined);
  const [preview, setPreview] = useState<BlockPreview | undefined>(undefined);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [tier, setTier] = useState<Tier>('declarative');
  const [bundle, setBundle] = useState<Bundle | undefined>(undefined);
  const [saved, setSaved] = useState<{ id: string; definition: BlockDraft } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [missing, setMissing] = useState<PlainKey | undefined>(undefined);
  const id = idFromName(name);
  const text = source === 'claude' ? html : fileName ? html : '';
  const props = imported ? propsOf(imported.definition) : {};
  const propKeys = Object.keys(props);
  const allConfirmed = propKeys.every((k) => confirmed.includes(k));

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (step !== 2 || imported) return;
    void run(async () => {
      const result = await api.design.importDesign(tenant, { html: text, id, title: name.trim() });
      setImported(result);
      setPreview(await api.design.preview(tenant, result.definition, result.files));
    });
  }, [step]);

  const next = () => {
    setMissing(undefined);
    if (step === 1) {
      if (!name.trim() || !id) return setMissing('design.nameMissing');
      if (!text.trim()) return setMissing('design.designMissing');
      setImported(undefined);
      setPreview(undefined);
      setConfirmed([]);
      return setStep(2);
    }
    if (step === 2) return imported && allConfirmed ? setStep(3) : undefined;
    if (step === 3) return void save();
  };

  const save = () =>
    run(async () => {
      if (!imported) return;
      if (tier === 'code' && !bundle) return setMissing('design.bundleMissing');
      const taken = await api.design.detail(tenant, tenant, id).then(
        () => true,
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return false;
          throw e;
        },
      );
      if (taken) return setMissing('design.idTaken');
      const summary = purpose.trim() ? { summary: { nb: purpose.trim() } } : {};
      const draft =
        tier === 'code' && bundle
          ? codeDefinition(tenant, id, name.trim(), bundle)
          : asBlockDraft(imported.definition);
      const definition: BlockDraft = {
        ...draft,
        metadata: { ...draft.metadata, tenant, id, name: name.trim() },
        spec: { ...draft.spec, ...summary, sharing: 'organisation' },
      };
      const files = tier === 'code' && bundle ? { 'block/bundle.js': bundle.text } : imported.files;
      await api.design.save(
        definition as unknown as Record<string, unknown>,
        files,
        t('design.firstReason'),
      );
      setSaved({ id, definition });
      setStep(4);
    });

  const nbTexts = imported
    ? Object.keys(asBlockDraft(imported.definition).spec.texts?.nb ?? {})
    : [];
  const enTexts = imported ? (asBlockDraft(imported.definition).spec.texts?.en ?? {}) : {};
  const englishMissing = nbTexts.filter((k) => !enTexts[k]).length;
  const dataNotes = imported?.report.filter((n) => n.kind === 'data') ?? [];
  const declared = imported ? (asBlockDraft(imported.definition).spec.states ?? []) : [];

  return (
    <div className="design-page">
      <div className="stack-xs">
        <Crumbs
          items={[
            { label: t('design.title'), href: '#/design' },
            { label: t('design.importFromClaude') },
          ]}
        />
        <Heading level={1} data-size="lg">
          {t('design.importFromClaude')}
        </Heading>
      </div>
      <ol className="design-wizard" aria-label={t('design.importSteps')}>
        {steps.map((s) => (
          <li
            key={s.step}
            data-state={s.step === step ? 'on' : s.step < step ? 'done' : undefined}
            aria-current={s.step === step ? 'step' : undefined}
          >
            {t(s.key)}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <div className="stack">
          <fieldset className="design-choice">
            <legend className="visually-hidden">{t('design.stepSource')}</legend>
            <label className="design-choice-card" data-on={source === 'claude'}>
              <Radio
                name="source"
                value="claude"
                checked={source === 'claude'}
                onChange={() => setSource('claude')}
                aria-label={t('design.fromClaude')}
              />
              <span>
                <strong>{t('design.fromClaude')}</strong>{' '}
                <Tag data-size="sm" data-color="warning">
                  {t('design.recommended')}
                </Tag>
                <span className="meta design-block">{t('design.fromClaudeHelp')}</span>
              </span>
            </label>
            <label className="design-choice-card" data-on={source === 'sketch'}>
              <Radio
                name="source"
                value="sketch"
                checked={source === 'sketch'}
                onChange={() => setSource('sketch')}
                aria-label={t('design.fromSketch')}
              />
              <span>
                <strong>{t('design.fromSketch')}</strong>
                <span className="meta design-block">{t('design.fromSketchHelp')}</span>
              </span>
            </label>
          </fieldset>
          <Textfield
            label={t('design.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...(missing === 'design.nameMissing' ? { error: t(missing) } : {})}
          />
          {source === 'claude' ? (
            <Textfield
              multiline
              rows={5}
              className="design-code"
              label={t('design.claudeDesign')}
              description={t('design.claudeDesignHint')}
              value={html}
              onChange={(e) => {
                setFileName('');
                setHtml(e.target.value);
              }}
              {...(missing === 'design.designMissing' ? { error: t(missing) } : {})}
            />
          ) : (
            <div className="design-drop">
              <Paragraph>
                <strong>{fileName || t('design.dropSketch')}</strong>
              </Paragraph>
              <Paragraph data-size="sm" className="meta">
                {t('design.dropSketchHint')}
              </Paragraph>
              <Label
                htmlFor={`${ids}-file`}
                className="ds-button"
                data-variant="secondary"
                data-size="sm"
              >
                {t('design.chooseFile')}
              </Label>
              <input
                id={`${ids}-file`}
                className="visually-hidden"
                type="file"
                accept=".html,.dc.html,text/html"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setFileName(file.name);
                  setHtml(await file.text());
                }}
              />
              {missing === 'design.designMissing' ? (
                <Paragraph data-size="sm" className="design-missing" role="alert">
                  {t(missing)}
                </Paragraph>
              ) : null}
            </div>
          )}
          <Textfield
            multiline
            rows={2}
            label={t('design.purpose')}
            description={t('design.purposeHint')}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>
      ) : null}

      {step === 2 ? (
        imported && preview ? (
          <div className="stack">
            <ul className="design-checks-list">
              {imported.report.map((note, i) => (
                <Check
                  key={`${i}:${note.code}`}
                  ok={note.kind !== 'data' && note.kind !== 'dropped'}
                >
                  {note.message}
                </Check>
              ))}
            </ul>
            <div className="design-grid2">
              <div className="stack-xs">
                <Paragraph data-size="sm">
                  <strong>{t('design.manifest')}</strong>
                </Paragraph>
                <pre className="design-pre">
                  {JSON.stringify(imported.definition.spec, null, 2)}
                </pre>
              </div>
              <div className="stack-xs">
                <Paragraph data-size="sm">
                  <strong>{t('design.previewData')}</strong>
                </Paragraph>
                <div className="design-stage">
                  <div className="design-stage-inner" data-size="sm">
                    {preview.render ? (
                      <RefBlock
                        payload={preview.render}
                        data={blockFixtures.filled}
                        state="filled"
                        locale={locale}
                        level={2}
                      />
                    ) : (
                      <Paragraph>{t('design.noPreview')}</Paragraph>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="design-grid2">
              <Panel
                title={t('design.propsConfirm')}
                aside={
                  propKeys.length ? (
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      onClick={() => setConfirmed(propKeys)}
                    >
                      {t('design.confirmAll')}
                    </Button>
                  ) : undefined
                }
              >
                {propKeys.length ? (
                  <div className="stack-xs">
                    {propKeys.map((k) => (
                      <Checkbox
                        key={k}
                        label={labelOf(k, props[k] ?? {}, locale)}
                        checked={confirmed.includes(k)}
                        onChange={() =>
                          setConfirmed((c) =>
                            c.includes(k) ? c.filter((x) => x !== k) : [...c, k],
                          )
                        }
                      />
                    ))}
                    <Paragraph data-size="sm" className="meta">
                      {t(allConfirmed ? 'design.confirmDone' : 'design.confirmLeft')}
                    </Paragraph>
                  </div>
                ) : (
                  <Paragraph data-size="sm" className="meta">
                    {t('design.noPropsFound')}
                  </Paragraph>
                )}
              </Panel>
              <Panel title={t('design.states')}>
                <ul className="design-checks-list">
                  <Check ok>{t('design.stateFilled')}</Check>
                  {(['loading', 'error', 'empty'] as const).map((s) =>
                    declared.includes(s) ? (
                      <Check key={s} ok>
                        {t(stateKey[s] ?? 'design.stateFilled')}
                      </Check>
                    ) : (
                      <Check key={s} ok={false}>
                        {t('design.stateMissing', {
                          state: t(stateKey[s] ?? 'design.stateFilled'),
                        })}
                      </Check>
                    ),
                  )}
                </ul>
              </Panel>
              <Panel title={t('design.texts')}>
                <div className="design-table">
                  <Table data-size="sm">
                    <Table.Head>
                      <Table.Row>
                        <Table.HeaderCell scope="col">{t('design.colNb')}</Table.HeaderCell>
                        <Table.HeaderCell scope="col">{t('design.colEn')}</Table.HeaderCell>
                      </Table.Row>
                    </Table.Head>
                    <Table.Body>
                      {nbTexts.map((k) => (
                        <Table.Row key={k}>
                          <Table.Cell>
                            {asBlockDraft(imported.definition).spec.texts?.nb?.[k]}
                          </Table.Cell>
                          <Table.Cell>{enTexts[k] ?? '–'}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              </Panel>
              <Panel title={t('design.dataAndChannels')}>
                <ul className="design-checks-list">
                  <Check ok>
                    {preview.reads.length
                      ? t('design.dataOk', { fields: preview.reads.join(', ') })
                      : t('design.dataNone')}
                  </Check>
                  {dataNotes.map((n, i) => (
                    <Check key={`${i}:${n.code}`} ok={false}>
                      {n.message}
                    </Check>
                  ))}
                </ul>
                {dataNotes.length ? (
                  <div className="design-core" role="note">
                    <Paragraph data-size="sm">
                      <strong>{t('design.coreTitle')}</strong>{' '}
                      {t('design.coreBody', { fields: dataNotes.map((n) => n.where).join(', ') })}
                    </Paragraph>
                    <a
                      className="ds-button"
                      data-variant="secondary"
                      data-size="sm"
                      href={coreIssueLink(
                        t('design.coreIssueTitle', { name: name.trim() }),
                        dataNotes.map((n) => n.message).join('\n'),
                      )}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('design.coreIssue')}
                    </a>
                  </div>
                ) : null}
              </Panel>
            </div>
          </div>
        ) : busy ? (
          <Paragraph role="status">{t('design.importing')}</Paragraph>
        ) : null
      ) : null}

      {step === 3 ? (
        <div className="stack">
          <Paragraph>
            {t('design.typeLead', { tier: t('design.withoutCode').toLocaleLowerCase(locale) })}
          </Paragraph>
          <fieldset className="design-choice">
            <legend className="visually-hidden">{t('design.stepType')}</legend>
            <label className="design-choice-card" data-on={tier === 'declarative'}>
              <Radio
                name="tier"
                value="declarative"
                checked={tier === 'declarative'}
                onChange={() => setTier('declarative')}
                aria-label={t('design.withoutCode')}
              />
              <span>
                <strong>{t('design.withoutCode')}</strong>
                <span className="meta design-block">{t('design.typeDeclarativeHelp')}</span>
              </span>
            </label>
            <label className="design-choice-card" data-on={tier === 'code'}>
              <Radio
                name="tier"
                value="code"
                checked={tier === 'code'}
                onChange={() => setTier('code')}
                aria-label={t('design.withCode')}
              />
              <span>
                <strong>{t('design.withCode')}</strong>
                <span className="meta design-block">{t('design.typeCodeHelp')}</span>
              </span>
            </label>
          </fieldset>
          {tier === 'code' ? <BundleField bundle={bundle} onBundle={setBundle} /> : null}
        </div>
      ) : null}

      {step === 4 && saved ? (
        <div className="stack">
          <Panel title={t('design.checks')}>
            <ul className="design-checks-list">
              <Check ok>{t('design.checkValid')}</Check>
              {saved.definition.spec.tier === 'code' ? (
                <Check ok>{t('design.checkSandbox')}</Check>
              ) : (
                <>
                  <Check ok>{t('design.checkTexts')}</Check>
                  <Check ok={englishMissing === 0}>
                    {englishMissing
                      ? t('design.checkEnglish', { count: englishMissing })
                      : t('design.checkEnglishOk')}
                  </Check>
                </>
              )}
            </ul>
          </Panel>
          <Toast>
            {t('design.savedNew', { org: tenantName })}{' '}
            <a href={`#${designPath(tenant, saved.id)}`}>{t('design.openStudio')}</a>{' '}
            <a href="#/design">{t('design.toCatalogue')}</a>
          </Toast>
        </div>
      ) : null}

      {missing && missing !== 'design.nameMissing' && missing !== 'design.designMissing' ? (
        <Paragraph data-size="sm" className="design-missing" role="alert">
          {t(missing)}
        </Paragraph>
      ) : null}
      {error ? <Problems error={error} /> : null}

      {step < 4 ? (
        <div className="design-wizard-nav">
          <Button
            variant="tertiary"
            aria-disabled={step === 1 || undefined}
            onClick={() => step > 1 && setStep((step - 1) as Step)}
          >
            {t('design.back')}
          </Button>
          <BusyButton
            busy={busy}
            busyLabel={t('design.saving')}
            aria-disabled={(step === 2 && (!imported || !allConfirmed)) || undefined}
            onClick={next}
          >
            {step === 3 ? t('design.saveDraft') : t('design.next')}
          </BusyButton>
        </div>
      ) : null}
    </div>
  );
};
