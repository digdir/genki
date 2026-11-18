import {
  Alert,
  Button,
  Field,
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
import type { ChatPart, InputLimits } from '../../api/blocks';
import type { CatalogItem } from '../../api/building-blocks';
import { CopyButton } from '../../components/CopyButton';
import { BackLink } from '../../components/BackLink';
import type { SharedCapability } from '../../data/shared-services';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { UsageTag } from './UsageTag';
import { requestExample, type CodeLanguage } from './code';
import { languagesText, storageText, type SharedServiceFacts } from './price';
import { filePart, fileProblem, typeList } from './upload';

type Status = 'idle' | 'running' | 'done';

interface Props {
  api: ApiClient;
  tenant: string;
  capability: SharedCapability;
  publicName: string;
  block: CatalogItem | undefined;
  blockId: string;
  owner: string;
  price: string;
  service?: Pick<SharedServiceFacts, 'storage' | 'languages'>;
}

const codeLanguages = [
  ['curl', 'curl'],
  ['python', 'Python'],
  ['js', 'JavaScript'],
] as const;

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
  owner,
  price,
  service,
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
  const [inputs] = useAsync(
    async (signal) =>
      (await api.blocks.serviceInputs(signal).catch(() => [])).find((m) => m.id === publicName),
    [api, publicName],
  );
  const audio = c.kind === 'audio';
  const limits: InputLimits | undefined =
    inputs.status === 'ready' ? (audio ? inputs.data?._media : inputs.data?._files) : undefined;
  const [text, setText] = useState(c.sample ?? '');
  const [file, setFile] = useState<{ file: File; ok: boolean } | undefined>();
  const [fileError, setFileError] = useState('');
  const [inputError, setInputError] = useState('');
  const [runError, setRunError] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState('');
  const [language, setLanguage] = useState<CodeLanguage>('curl');
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const reset = () => {
    setText(c.sample ?? '');
    setFile(undefined);
    setFileError('');
    setInputError('');
    setRunError('');
    setStatus('idle');
    setResult('');
  };
  useEffect(reset, [c.id]);

  const tool = c.version ? `${c.tool}@${c.version}` : c.tool;
  const canBuild = useRights().has('manage-services');

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (!picked || !limits) return;
    const problem = fileProblem(picked, limits);
    setFile({ file: picked, ok: !problem });
    setInputError('');
    setFileError(
      problem === 'type'
        ? t('sharedServicesMore.fileType', { types: typeList(limits) })
        : problem === 'size'
          ? t('sharedServicesMore.fileTooBig', { size: f.bytes(limits.max_bytes) })
          : '',
    );
  };

  const run = async () => {
    if (status === 'running') return;
    const chosen = file?.ok ? file.file : undefined;
    if (audio && !chosen) {
      setFileError(t('sharedServicesMore.pickAudio'));
      return;
    }
    if (!audio && !text.trim() && !chosen) {
      setInputError(
        limits ? t('sharedServicesMore.writeOrUpload') : t('sharedServicesMore.writeFirst'),
      );
      return;
    }
    if (text.length > 20000) {
      setInputError(limits ? t('sharedServices.tooLong') : t('sharedServicesMore.tooLongNoFile'));
      return;
    }
    setRunError('');
    setResult('');
    setStatus('running');
    try {
      const parts: ChatPart[] = [
        ...(!audio && text.trim() ? [{ type: 'text' as const, text }] : []),
        ...(chosen ? [await filePart(chosen, audio)] : []),
      ];
      const reply = await api.blocks.runShared(publicName, chosen ? parts : text);
      if (!live.current) return;
      setResult(reply);
      setStatus('done');
    } catch {
      if (!live.current) return;
      setRunError(tRef.current('sharedServices.runFailed'));
      setStatus('idle');
    }
  };

  const meta = [t('sharedServices.doneLive'), modelAndPlace(t, c)].filter(Boolean).join(' · ');
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
    [t('sharedServicesMore.stored'), storageText(t, service?.storage)],
    [t('sharedServicesMore.price'), price],
    [t('sharedServicesMore.languages'), languagesText(t, service?.languages)],
    [
      t('sharedServices.responsible'),
      block ? block.publisher.name : t('sharedServicesMore.orgNumber', { org: owner }),
    ],
  ];

  return (
    <div className="stack">
      <BackLink label={t('sharedServices.back')} href="#/shared-services" />
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
                {audio ? (
                  limits ? (
                    <div id="prov-fil" className="drop-zone">
                      <Label htmlFor="lydfil">{t('sharedServices.uploadAudio')}</Label>
                      <input
                        id="lydfil"
                        type="file"
                        accept={limits.accepts.join(',')}
                        onChange={onFile}
                      />
                      <span className="meta">{typeList(limits)}</span>
                      {file ? (
                        <Tag data-size="sm" data-color={file.ok ? 'success' : 'danger'}>
                          {file.file.name}
                        </Tag>
                      ) : null}
                    </div>
                  ) : (
                    <Paragraph data-size="sm">{t('sharedServicesMore.noAudioYet')}</Paragraph>
                  )
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
                        {limits ? `${t('sharedServicesMore.pasteOrDocument')} ` : ''}
                        {t('sharedServices.charCount', { count: text.length, max: 20000 })}
                      </span>
                      {inputError ? <ValidationMessage>{inputError}</ValidationMessage> : null}
                    </Field>
                    {limits ? (
                      <div className="file-row">
                        <input
                          id="prov-fil-tekst"
                          className="visually-hidden"
                          type="file"
                          accept={limits.accepts.join(',')}
                          onChange={onFile}
                        />
                        <label
                          htmlFor="prov-fil-tekst"
                          className="ds-button"
                          data-variant="secondary"
                          data-size="sm"
                        >
                          {t('sharedServicesMore.chooseFile')}
                        </label>
                        <span className="meta" aria-live="polite">
                          {file ? file.file.name : t('sharedServicesMore.noFileChosen')}
                        </span>
                      </div>
                    ) : null}
                  </>
                )}
                {fileError ? <ValidationMessage>{fileError}</ValidationMessage> : null}
                {c.kind === 'audio' && inputError ? (
                  <ValidationMessage>{inputError}</ValidationMessage>
                ) : null}
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
                    {audio
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
                    <div className="result-text">{result}</div>
                    <span className="meta">{meta}</span>
                    <div className="actions">
                      <CopyButton text={result} label={t('sharedServices.copyResult')} />
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
