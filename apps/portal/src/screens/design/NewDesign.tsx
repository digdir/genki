import {
  Details,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Radio,
  Tag,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useId, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type { ImportResult } from '../../api/design';
import { BackLink } from '../../components/BackLink';
import { BusyButton } from '../../components/BusyButton';
import { navigate } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { BundleField } from './CodeUpload';
import {
  asBlockDraft,
  codeDefinition,
  starterDeclarative,
  type BlockDraft,
  type Bundle,
} from './definitions';
import { designPath, idFromName } from './naming';
import { ImportPreview } from './ImportPreview';
import { Problems } from './Problems';

type Kind = 'declarative' | 'code' | 'design';

const kinds: { kind: Kind; title: PlainKey; help: PlainKey }[] = [
  { kind: 'declarative', title: 'design.withoutCode', help: 'design.withoutCodeHelp' },
  { kind: 'code', title: 'design.withCode', help: 'design.withCodeHelp' },
  { kind: 'design', title: 'design.fromDesign', help: 'design.fromDesignHelp' },
];

/** «Lag et designelement»: without code, with code, or from a design; every save is an edition. */
export const NewDesign = ({ api, tenant }: ScreenProps) => {
  const t = useT();
  const [kind, setKind] = useState<Kind>('declarative');
  const [name, setName] = useState('');
  const [typedId, setTypedId] = useState<string | undefined>(undefined);
  const [bundle, setBundle] = useState<Bundle | undefined>(undefined);
  const [html, setHtml] = useState('');
  const [fileName, setFileName] = useState('');
  const [imported, setImported] = useState<ImportResult | undefined>(undefined);
  const [missing, setMissing] = useState<PlainKey | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const fileId = useId();
  const id = typedId || idFromName(name);
  const conversion = useRef(0);

  const run = async (work: () => Promise<void>) => {
    setError(undefined);
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = (definition: BlockDraft, files: Record<string, string> = {}) =>
    run(async () => {
      const taken = await api.design.detail(tenant, tenant, definition.metadata.id).then(
        () => true,
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return false;
          throw e;
        },
      );
      if (taken) return setMissing('design.idTaken');
      await api.design.save(
        definition as unknown as Record<string, unknown>,
        files,
        t('design.firstReason'),
      );
      navigate(`${designPath(tenant, definition.metadata.id)}?tab=content`);
    });

  const needName = () => {
    if (name.trim() && id) return false;
    setMissing('design.nameMissing');
    return true;
  };

  const proceed = () => {
    setMissing(undefined);
    if (needName()) return;
    if (kind === 'declarative') return void save(starterDeclarative(tenant, id, name.trim()));
    if (kind === 'code') {
      if (!bundle) return setMissing('design.bundleMissing');
      return void save(codeDefinition(tenant, id, name.trim(), bundle), {
        'block/bundle.js': bundle.text,
      });
    }
  };

  const convert = () => {
    setMissing(undefined);
    if (needName()) return;
    if (!html.trim()) return setMissing('design.designMissing');
    const asked = ++conversion.current;
    void run(async () => {
      const result = await api.design.importDesign(tenant, { html, id, title: name.trim() });
      if (asked === conversion.current) setImported(result);
    });
  };

  const saveImported = () => {
    if (!imported) return;
    const definition = asBlockDraft(imported.definition);
    void save(
      { ...definition, metadata: { ...definition.metadata, tenant, id, name: name.trim() } },
      imported.files,
    );
  };

  return (
    <div className="design-page design-new">
      <div className="stack-xs">
        <BackLink label={t('design.title')} href="#/design" />
        <Heading level={1} data-size="lg">
          {t('design.create')}
        </Heading>
      </div>
      <Fieldset>
        <Fieldset.Legend>{t('design.how')}</Fieldset.Legend>
        <div className="design-kinds">
          {kinds.map((k) => (
            <Radio
              key={k.kind}
              name="design-kind"
              className="design-kind"
              label={t(k.title)}
              description={t(k.help)}
              value={k.kind}
              checked={kind === k.kind}
              onChange={() => {
                setKind(k.kind);
                setMissing(undefined);
              }}
            />
          ))}
        </div>
      </Fieldset>
      <div className="design-name-field">
        <Textfield
          label={t('design.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...(missing === 'design.nameMissing' ? { error: t(missing) } : {})}
        />
        <Details>
          <Details.Summary>{t('design.showId')}</Details.Summary>
          <Details.Content>
            <Textfield
              label={t('design.id')}
              className="design-id"
              value={id}
              onChange={(e) => setTypedId(e.target.value)}
            />
          </Details.Content>
        </Details>
      </div>
      {kind === 'code' ? <BundleField bundle={bundle} onBundle={setBundle} /> : null}
      {kind === 'design' ? (
        <section className="design-section stack" aria-labelledby={`${fileId}-heading`}>
          <Heading level={2} data-size="sm" id={`${fileId}-heading`}>
            {t('design.designHeading')}
          </Heading>
          <div className="stack-xs">
            <Label htmlFor={fileId}>{t('design.designFile')}</Label>
            <input
              id={fileId}
              type="file"
              accept=".html,.dc.html,text/html"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFileName(file.name);
                setHtml(await file.text());
                conversion.current += 1;
                setImported(undefined);
              }}
            />
            {fileName ? (
              <Paragraph data-size="sm" className="meta">
                {fileName}
              </Paragraph>
            ) : null}
          </div>
          <div className="stack-xs">
            <Label htmlFor={`${fileId}-paste`}>{t('design.designPaste')}</Label>
            <Textarea
              id={`${fileId}-paste`}
              rows={3}
              className="design-code"
              value={fileName ? '' : html}
              onChange={(e) => {
                setFileName('');
                setHtml(e.target.value);
                conversion.current += 1;
                setImported(undefined);
              }}
            />
          </div>
          <div>
            <BusyButton
              variant="secondary"
              busy={busy}
              busyLabel={t('common.loading')}
              onClick={convert}
            >
              {t('design.convert')}
            </BusyButton>
          </div>
          {imported ? (
            <div className="stack">
              <Tag data-color="info" className="design-self-start">
                {t('design.becameDeclarative')}
              </Tag>
              <ImportPreview api={api} tenant={tenant} result={imported} />
              {imported.report.length > 0 ? (
                <ul className="design-notes">
                  {imported.report.map((note, i) => (
                    <li key={`${i}:${note.code}`}>{note.message}</li>
                  ))}
                </ul>
              ) : null}
              <div>
                <BusyButton busy={busy} busyLabel={t('design.saving')} onClick={saveImported}>
                  {t('design.saveFirst')}
                </BusyButton>
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <div>
          <BusyButton busy={busy} busyLabel={t('design.saving')} onClick={proceed}>
            {kind === 'code' ? t('design.saveFirst') : t('design.continue')}
          </BusyButton>
        </div>
      )}
      {missing && missing !== 'design.nameMissing' ? (
        <Paragraph data-size="sm" className="design-missing" role="alert">
          {t(missing)}
        </Paragraph>
      ) : null}
      {error ? <Problems error={error} /> : null}
    </div>
  );
};
