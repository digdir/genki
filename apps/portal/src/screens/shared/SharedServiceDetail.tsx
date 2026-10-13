import {
  Alert,
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Spinner,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { Icon, icons } from '../../components/Icon';
import type { SharedCapability } from '../../data/shared-services';
import { useT, type T } from '../../i18n';
import { requestExample, responseExample, type CodeLanguage } from './code';

const back = 'M15 6l-6 6 6 6';

type Status = 'idle' | 'running' | 'done';

interface Props {
  api: ApiClient;
  capability: SharedCapability;
  publicName: string;
}

const initialOptions = (c: SharedCapability) => ({ [c.options[0] ?? '']: true });

const given = (t: T, value: string) =>
  value !== 'Ikke oppgitt' && value !== t('sharedServices.notGiven');

const modelAndData = (t: T, c: SharedCapability) => {
  const model = given(t, c.model) ? c.model : '';
  const located = given(t, c.location);
  if (model && located)
    return t('sharedServices.modelProcessedIn', { model, location: c.location });
  if (model) return model;
  return located
    ? t('sharedServices.processedIn', { location: c.location })
    : t('sharedServices.notGiven');
};

const modelAndPlace = (t: T, c: SharedCapability) =>
  [c.model, c.location].filter((x) => given(t, x)).join(', ');

export const SharedServiceDetail = ({ api, capability: c, publicName }: Props) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [text, setText] = useState(c.sample ?? '');
  const [options, setOptions] = useState<Record<string, boolean>>(initialOptions(c));
  const [file, setFile] = useState<{ name: string; ok: boolean } | undefined>();
  const [fileError, setFileError] = useState('');
  const [inputError, setInputError] = useState('');
  const [runError, setRunError] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [liveResult, setLiveResult] = useState<string | undefined>();
  const [language, setLanguage] = useState<CodeLanguage>('curl');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const reset = () => {
    setText(c.sample ?? '');
    setOptions(initialOptions(c));
    setFile(undefined);
    setFileError('');
    setInputError('');
    setRunError('');
    setStatus('idle');
    setLiveResult(undefined);
  };
  useEffect(reset, [c.id]);

  const selected = Object.keys(options).filter((k) => options[k]);
  const builderHref = `#/services/new?tool=${c.tool}@${c.version}`;

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0];
    if (!f) return;
    const allowed = c.kind === 'audio' ? /\.(mp3|m4a|wav)$/i : /\.(pdf|docx|txt)$/i;
    if (!allowed.test(f.name)) {
      setFile({ name: f.name, ok: false });
      setFileError(
        c.kind === 'audio' ? t('sharedServices.fileAudioType') : t('sharedServices.fileDocType'),
      );
      return;
    }
    if (f.size > 200 * 1048576) {
      setFile({ name: f.name, ok: false });
      setFileError(t('sharedServices.fileTooBig'));
      return;
    }
    setFile({ name: f.name, ok: true });
    setFileError('');
  };

  const run = async () => {
    if (status === 'running') return;
    const hasFile = file?.ok === true;
    if (c.kind === 'audio' && !hasFile) {
      setFileError(t('sharedServices.pickAudio'));
      return;
    }
    if (c.kind !== 'audio' && !text.trim() && !hasFile) {
      setInputError(t('sharedServices.pasteOrUpload'));
      return;
    }
    if (c.multi && selected.length === 0) {
      setInputError(t('sharedServices.pickOneKind'));
      return;
    }
    if (text.length > 20000) {
      setInputError(t('sharedServices.tooLong'));
      return;
    }
    setRunError('');
    setLiveResult(undefined);
    setStatus('running');
    const useLive = c.kind === 'text' && !c.fields && text.trim() !== '' && text !== c.sample;
    if (useLive) {
      try {
        const reply = await api.chat(publicName, [{ role: 'user', content: text }]);
        setLiveResult(reply);
        setStatus('done');
      } catch {
        setRunError(tRef.current('sharedServices.runFailed'));
        setStatus('idle');
      }
      return;
    }
    timer.current = setTimeout(() => setStatus('done'), c.kind === 'audio' ? 1800 : 1100);
  };

  const resultText = liveResult ?? c.result ?? '';
  const copyText = liveResult ?? c.result ?? (c.fields ?? []).map((f) => f.join(': ')).join('\n');
  const place = modelAndPlace(t, c);
  const meta = (
    liveResult
      ? [t('sharedServices.doneLive'), place]
      : [
          t('sharedServices.doneIn', { seconds: c.seconds }),
          c.tokens !== '–' ? t('sharedServices.tokensPart', { tokens: c.tokens }) : '',
          place,
        ]
  )
    .filter(Boolean)
    .join(' · ');
  const request = requestExample(c, publicName, language, t('sharedServices.audioUrlPlaceholder'));
  const response = responseExample(c, publicName);

  return (
    <div className="stack">
      <a href="#/shared-services" className="back-link">
        <Icon d={back} size={18} />
        {t('sharedServices.back')}
      </a>
      <div className="page-head">
        <div className="page-head-text">
          <div className="row-wrap">
            <Heading level={1} data-size="md">
              {c.name}
            </Heading>
            <Tag data-color="neutral">{t('sharedServices.versionN', { version: c.version })}</Tag>
          </div>
          <p className="intro" lang={c.longLang}>
            {c.long}
          </p>
        </div>
        <a className="ds-button" data-variant="primary" href={builderHref}>
          <Icon d={icons.plus} />
          {t('sharedServices.useInService')}
        </a>
      </div>
      <dl className="facts">
        {[
          [t('sharedServices.input'), c.input],
          [t('sharedServices.output'), c.output],
          [t('sharedServices.modelAndData'), modelAndData(t, c)],
          [
            t('sharedServices.qualityOnTestSet'),
            c.score
              ? t('sharedServices.scoreOf', { score: c.score })
              : t('sharedServices.notMeasured'),
          ],
          ...(c.price === '–'
            ? []
            : [
                [
                  t('sharedServices.per1000'),
                  t('sharedServices.priceWithNote', {
                    price: c.price,
                    note: c.priceNote.toLowerCase(),
                  }),
                ],
              ]),
        ].map(([l, v]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd className="fact-text">{v}</dd>
          </div>
        ))}
      </dl>
      {c.scoreAlert ? (
        <Alert data-color="warning" data-size="sm">
          {c.scoreAlert}
        </Alert>
      ) : null}

      <section aria-labelledby="prov-h" className="try-box">
        <div className="stack-xs">
          <Heading level={2} data-size="sm" id="prov-h">
            {t('sharedServices.tryNow')}
          </Heading>
          <p className="meta">{t('sharedServices.tryNote')}</p>
        </div>
        <div className="try-grid">
          <div className="stack-sm">
            {c.kind === 'audio' ? (
              <div id="prov-fil" className="drop-zone">
                <Label htmlFor="lydfil">{t('sharedServices.uploadAudio')}</Label>
                <input id="lydfil" type="file" accept=".mp3,.m4a,.wav" onChange={onFile} />
                <span className="meta">{t('sharedServices.audioHelp')}</span>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  onClick={() => {
                    setFile({ name: t('sharedServices.sampleRecordingName'), ok: true });
                    setFileError('');
                  }}
                >
                  {t('sharedServices.useSampleRecording')}
                </Button>
                {file ? (
                  <Tag data-size="sm" data-color={file.ok ? 'success' : 'danger'}>
                    {file.name}
                  </Tag>
                ) : null}
              </div>
            ) : (
              <>
                <Field>
                  <Label htmlFor="prov-tekst">{c.inputLabel}</Label>
                  <Textarea
                    id="prov-tekst"
                    rows={9}
                    value={text}
                    aria-invalid={inputError ? true : undefined}
                    aria-describedby="prov-tekst-hjelp"
                    onChange={(e) => {
                      setText(e.target.value);
                      setInputError('');
                    }}
                  />
                  <span id="prov-tekst-hjelp" className="meta">
                    {t('sharedServices.charCount', { count: text.length, max: 20000 })}
                  </span>
                  {inputError ? <ValidationMessage>{inputError}</ValidationMessage> : null}
                </Field>
                <div className="file-row">
                  <label htmlFor="prov-fil-tekst">{t('sharedServices.orUploadFile')}</label>
                  <input
                    id="prov-fil-tekst"
                    type="file"
                    accept=".pdf,.docx,.txt"
                    onChange={onFile}
                  />
                </div>
                {file ? (
                  <Tag data-size="sm" data-color={file.ok ? 'success' : 'danger'}>
                    {file.name}
                  </Tag>
                ) : null}
              </>
            )}
            {fileError ? <ValidationMessage>{fileError}</ValidationMessage> : null}
            {c.kind === 'audio' && inputError ? (
              <ValidationMessage>{inputError}</ValidationMessage>
            ) : null}
            {c.options.length < 2 ? null : (
              <Fieldset>
                <Fieldset.Legend>{c.optionLabel}</Fieldset.Legend>
                <div className="tag-row">
                  {c.options.map((o) =>
                    c.multi ? (
                      <Chip.Checkbox
                        key={o}
                        name="valg"
                        checked={!!options[o]}
                        onChange={() => {
                          setOptions((x) => ({ ...x, [o]: !x[o] }));
                          setInputError('');
                        }}
                      >
                        {o}
                      </Chip.Checkbox>
                    ) : (
                      <Chip.Radio
                        key={o}
                        name="valg"
                        checked={!!options[o]}
                        onChange={() => setOptions({ [o]: true })}
                      >
                        {o}
                      </Chip.Radio>
                    ),
                  )}
                </div>
              </Fieldset>
            )}
            <div className="actions">
              <Button
                variant="primary"
                aria-disabled={status === 'running' || undefined}
                onClick={() => void run()}
              >
                {t('sharedServices.run')}
              </Button>
              <Button variant="tertiary" onClick={reset}>
                {t('sharedServices.reset')}
              </Button>
            </div>
          </div>
          <div aria-live="polite" className="result-box">
            <span className="result-title">{t('sharedServices.result')}</span>
            {status === 'idle' && !runError ? (
              <p className="meta">{t('sharedServices.resultPlaceholder')}</p>
            ) : null}
            {status === 'running' ? (
              <span role="status" className="row-wrap">
                <Spinner aria-hidden="true" data-size="sm" />
                {c.kind === 'audio'
                  ? t('sharedServices.transcribing')
                  : t('sharedServices.running', { name: c.name.toLowerCase() })}
              </span>
            ) : null}
            {runError ? (
              <Alert data-color="danger" data-size="sm">
                {runError}
              </Alert>
            ) : null}
            {status === 'done' ? (
              <div className="stack-sm">
                {c.fields && !liveResult ? (
                  <dl className="result-fields">
                    {c.fields.map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <div className="result-text" lang={liveResult ? undefined : c.resultLang}>
                    {resultText}
                  </div>
                )}
                {c.notes.length && !liveResult ? (
                  <ul className="result-notes" lang={c.notesLang}>
                    {c.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : null}
                <span className="meta">{meta}</span>
                <div className="actions">
                  <CopyButton text={copyText} label={t('sharedServices.copyResult')} />
                  <a className="ds-button" data-variant="tertiary" data-size="sm" href="#/log">
                    {t('sharedServices.viewTimeline')}
                  </a>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section aria-labelledby="kode-h" className="stack-sm">
        <div className="code-head">
          <div className="stack-xs">
            <Heading level={2} data-size="sm" id="kode-h">
              {t('sharedServices.callTitle')}
            </Heading>
            <p className="meta">
              {t('sharedServices.tokenNote')}{' '}
              <a href="#/integrations">{t('sharedServices.moreOnIntegrations')}</a>
            </p>
          </div>
          <Fieldset>
            <Fieldset.Legend>{t('sharedServices.language')}</Fieldset.Legend>
            <div className="tag-row">
              {(
                [
                  ['curl', 'curl'],
                  ['python', 'Python'],
                  ['js', 'JavaScript'],
                ] as const
              ).map(([id, label]) => (
                <Chip.Radio
                  key={id}
                  name="kodesprak"
                  checked={language === id}
                  onChange={() => setLanguage(id)}
                >
                  {label}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
        </div>
        <div className="code-grid">
          <div className="code-block">
            <div className="code-block-head">
              <strong>{t('sharedServices.request')}</strong>
              <CopyButton text={request} />
            </div>
            <pre tabIndex={0} role="region" aria-label={t('sharedServices.requestExample')}>
              <code>{request}</code>
            </pre>
          </div>
          <div className="code-block">
            <div className="code-block-head">
              <span className="row-wrap">
                <Tag data-size="sm" data-color="success">
                  200 OK
                </Tag>
                <strong>{t('sharedServices.responseExample')}</strong>
              </span>
              <CopyButton text={response} />
            </div>
            <pre tabIndex={0} role="region" aria-label={t('sharedServices.responseExample')}>
              <code>{response}</code>
            </pre>
            <Paragraph data-size="sm">{t('sharedServices.exampleNote')}</Paragraph>
          </div>
        </div>
      </section>

      <section aria-labelledby="bruk-h" className="use-box">
        <div className="stack-xs use-text">
          <Heading level={2} data-size="xs" id="bruk-h">
            {t('sharedServices.useTitle')}
          </Heading>
          <Paragraph>{t('sharedServices.useBody', { name: c.name.toLowerCase() })}</Paragraph>
          <span className="meta">
            {t('sharedServices.toolName', { tool: `${c.tool}@${c.version}` })}
          </span>
        </div>
        <a className="ds-button" data-variant="primary" href={builderHref}>
          {t('sharedServices.openBuilder', { name: c.name })}
        </a>
      </section>
    </div>
  );
};
