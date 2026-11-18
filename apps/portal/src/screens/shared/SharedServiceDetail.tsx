import { ChevronLeftIcon } from '@navikt/aksel-icons';
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
  Tabs,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { CatalogItem } from '../../api/building-blocks';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import type { SharedCapability } from '../../data/shared-services';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { UsageTag } from './UsageTag';
import { requestExample, type CodeLanguage } from './code';

type Status = 'idle' | 'running' | 'done';

interface Props {
  api: ApiClient;
  tenant: string;
  capability: SharedCapability;
  publicName: string;
  block: CatalogItem | undefined;
  blockId: string;
}

const codeLanguages = [
  ['curl', 'curl'],
  ['python', 'Python'],
  ['js', 'JavaScript'],
] as const;

const initialOptions = (c: SharedCapability) => ({ [c.options[0] ?? '']: true });

const given = (t: T, value: string) =>
  value !== 'Ikke oppgitt' && value !== t('sharedServices.notGiven');

const modelAndPlace = (t: T, c: SharedCapability) =>
  [c.model, c.location].filter((x) => given(t, x)).join(', ');

export const SharedServiceDetail = ({
  api,
  tenant,
  capability: c,
  publicName,
  block,
  blockId,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const [versions] = useAsync(
    (signal) =>
      block
        ? api.buildingBlocks.versions(tenant, { kind: 'shared_service', id: blockId }, signal)
        : Promise.resolve([]),
    [api, tenant, blockId, !!block],
  );
  const published =
    versions.status === 'ready'
      ? versions.data.find((v) => v.source === 'publisher' && v.version === c.version)
      : undefined;
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
  const tool = c.version ? `${c.tool}@${c.version}` : c.tool;
  const canBuild = useRights().has('manage-services');

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
  const users = block?.usedBy ?? [];
  const versionLine = c.version
    ? published?.at
      ? t('sharedServices.versionUpdated', { version: c.version, date: f.date(published.at) })
      : t('blocks.versionLower', { version: c.version })
    : '';
  const byline = [
    block ? t('sharedServices.fromPublisher', { publisher: block.publisher.name }) : '',
    versionLine,
  ]
    .filter(Boolean)
    .join(' · ');
  const facts: [string, ReactNode][] = [
    [t('sharedServices.model'), c.model],
    [
      t('sharedServices.whereProcessed'),
      <>
        {c.location} <a href="#/data-handling">{t('sharedServices.howDataIsHandled')}</a>
      </>,
    ],
    ...(block
      ? ([[t('sharedServices.responsible'), block.publisher.name]] as [string, string][])
      : []),
  ];

  return (
    <div className="stack">
      <a href="#/shared-services" className="back-link">
        <Icon icon={ChevronLeftIcon} size={18} />
        {t('sharedServices.back')}
      </a>
      <div className="page-head-text">
        <div className="row-wrap">
          <Heading level={1} data-size="md">
            {c.name}
          </Heading>
          <UsageTag block={block} />
        </div>
        {byline ? <p className="meta">{byline}</p> : null}
        <p className="intro" lang={c.longLang}>
          {c.long}
        </p>
      </div>

      <div className="shared-columns">
        <div className="shared-main">
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
            <Heading level={2} data-size="sm" id="kode-h">
              {t('sharedServices.callTitle')}
            </Heading>
            <Paragraph>
              {t('sharedServices.keyNote', { name: c.name })}{' '}
              <a href="#/developer/keys">{t('sharedServices.makeKey')}</a>
            </Paragraph>
            <Tabs value={language} onChange={(v) => setLanguage(v as CodeLanguage)}>
              <Tabs.List aria-label={t('sharedServices.language')}>
                {codeLanguages.map(([id, label]) => (
                  <Tabs.Tab key={id} value={id}>
                    {label}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {codeLanguages.map(([id]) => (
                <Tabs.Panel key={id} value={id}>
                  {id === language ? (
                    <pre
                      className="shared-code"
                      tabIndex={0}
                      role="region"
                      aria-label={t('sharedServices.requestExample')}
                    >
                      <code>{request}</code>
                    </pre>
                  ) : null}
                </Tabs.Panel>
              ))}
            </Tabs>
            <div className="actions">
              <CopyButton text={request} label={t('sharedServices.copyCode')} />
            </div>
          </section>

          <section aria-labelledby="bruk-h" className="use-box">
            <div className="stack-xs use-text">
              <Heading level={2} data-size="xs" id="bruk-h">
                {t('sharedServices.useTitle')}
              </Heading>
              <Paragraph>{t('sharedServices.useBody', { name: c.name.toLowerCase() })}</Paragraph>
              {users.length ? (
                <Paragraph data-size="sm">
                  {t('sharedServices.usedTodayBy')}{' '}
                  {users.map((u, i) => (
                    <span key={u.id}>
                      {i > 0 ? ', ' : ''}
                      <a href={`#/services/${encodeURIComponent(u.id)}`}>{u.name}</a>
                    </span>
                  ))}
                  .
                </Paragraph>
              ) : null}
              <span className="meta">{t('sharedServices.toolName', { tool })}</span>
            </div>
            {canBuild ? (
              <a className="ds-button" data-variant="secondary" href="#/services/new">
                {t('sharedServices.openBuilder')}
              </a>
            ) : (
              <Paragraph data-size="sm">{needsRight('manage-services', t)}</Paragraph>
            )}
          </section>
        </div>

        <aside aria-labelledby="fakta-h" className="shared-facts">
          <Heading level={2} data-size="xs" id="fakta-h">
            {t('sharedServices.facts')}
          </Heading>
          <dl className="shared-facts-list">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </div>
  );
};
