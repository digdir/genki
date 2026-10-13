import {
  Button,
  Checkbox,
  Dialog,
  ErrorSummary,
  Fieldset,
  Heading,
  Paragraph,
  Textfield,
} from '@digdir/designsystemet-react';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { frontendServiceChoices, scopes } from '../../data/integrations';
import { useT, type T } from '../../i18n';

export type DialogKind = 'sys' | 'scope' | 'fe' | 'key';

export interface FormValues {
  id?: string;
  name?: string;
  client?: string;
  redirect?: string;
  key?: string;
  scopes?: string[];
  services?: string[];
}

interface FieldDef {
  id: string;
  label: string;
  key: 'name' | 'client' | 'redirect' | 'key';
  help?: string;
  placeholder?: string;
  error: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const definition = (kind: DialogKind, f: FormValues, t: T) => {
  if (kind === 'sys' || kind === 'scope') {
    const errName = !(f.name ?? '').trim() ? t('integrations.systemNameProblem') : '';
    const errId = !uuid.test((f.client ?? '').trim()) ? t('integrations.clientIdProblem') : '';
    const errScopes = !(f.scopes ?? []).length ? t('integrations.scopesProblem') : '';
    const fields: FieldDef[] =
      kind === 'scope'
        ? []
        : [
            {
              id: 'f-name',
              label: t('integrations.systemName'),
              key: 'name',
              error: errName,
            },
            {
              id: 'f-client',
              label: t('integrations.clientIdMaskinporten'),
              key: 'client',
              error: errId,
            },
          ];
    return {
      title:
        kind === 'scope'
          ? t('integrations.scopesFor', { name: f.name ?? '' })
          : t('integrations.connectSystem'),
      intro: t('integrations.systemIntro'),
      fields,
      checkLegend: t('integrations.scopesLegend'),
      checkKey: 'scopes' as const,
      checks: scopes.map(([value, label, desc]) => ({
        value,
        label: `${t(label)} · ${value}`,
        desc: t(desc),
      })),
      errors:
        kind === 'scope'
          ? { scopes: errScopes }
          : { name: errName, client: errId, scopes: errScopes },
      saveLabel: kind === 'scope' ? t('common.save') : t('integrations.connect'),
    };
  }
  if (kind === 'fe') {
    const errName = !(f.name ?? '').trim() ? t('integrations.frontendNameProblem') : '';
    const url = (f.redirect ?? '').trim();
    const errUrl =
      !/^https:\/\/\S+\.\S+/.test(url) && !/^http:\/\/localhost/.test(url)
        ? t('integrations.redirectProblem')
        : '';
    return {
      title: t('integrations.addFrontend'),
      intro: t('integFrontends.dialogIntro'),
      fields: [
        { id: 'f-name', label: t('integrations.name'), key: 'name', error: errName },
        {
          id: 'f-redirect',
          label: t('integrations.redirectLabel'),
          key: 'redirect',
          help: t('integrations.redirectHelp'),
          placeholder: 'https://',
          error: errUrl,
        },
      ] as FieldDef[],
      checkLegend: t('integFrontends.whichService'),
      checkKey: 'services' as const,
      checks: frontendServiceChoices.map(([value, label, desc]) => ({ value, label, desc })),
      errors: { name: errName, redirect: errUrl },
      saveLabel: t('integrations.register'),
    };
  }
  const errKey = (f.key ?? '').trim().length < 20 ? t('integrations.keyProblem') : '';
  return {
    title: t('integrations.newQueueKey'),
    intro: t('integrations.queueKeyIntro'),
    fields: [
      { id: 'f-key', label: t('integrations.accessKey'), key: 'key', error: errKey },
    ] as FieldDef[],
    checkLegend: '',
    checkKey: 'scopes' as const,
    checks: [],
    errors: { key: errKey },
    saveLabel: t('integrations.saveAndRead'),
  };
};

export const FormDialog = ({
  kind,
  initial,
  onSave,
  onClose,
}: {
  kind: DialogKind;
  initial: FormValues;
  onSave: (values: FormValues) => void;
  onClose: () => void;
}) => {
  const t = useT();
  const [form, setForm] = useState<FormValues>(initial);
  const [tried, setTried] = useState(false);
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const def = definition(kind, form, t);
  const errors = Object.entries(def.errors).filter(([, v]) => v);
  useEffect(() => {
    if (tried && errors.length) summary.current?.focus();
  }, [tried]);

  const save = () => {
    if (errors.length) {
      setTried(true);
      summary.current?.focus();
      return;
    }
    onSave(form);
  };

  const checked = form[def.checkKey] ?? [];
  return (
    <Dialog
      open
      modal
      closeButton={t('common.close')}
      onClose={onClose}
      aria-labelledby="dlg-h"
      className="int-dialog"
    >
      <div className="stack-dialog">
        <Heading level={2} data-size="xs" id="dlg-h">
          {def.title}
        </Heading>
        <Paragraph data-size="sm" className="meta">
          {def.intro}
        </Paragraph>
        {tried && errors.length ? (
          <ErrorSummary ref={summary} tabIndex={-1}>
            <ErrorSummary.Heading>{t('integrations.fixThese')}</ErrorSummary.Heading>
            <ErrorSummary.List>
              {errors.map(([k, v]) => (
                <ErrorSummary.Item key={k}>
                  <ErrorSummary.Link
                    href={k === 'scopes' || k === 'services' ? '#f-checks' : `#f-${k}`}
                  >
                    {v}
                  </ErrorSummary.Link>
                </ErrorSummary.Item>
              ))}
            </ErrorSummary.List>
          </ErrorSummary>
        ) : null}
        {def.fields.map((fd) => (
          <Textfield
            key={fd.id}
            id={fd.id}
            label={fd.label}
            description={fd.help}
            placeholder={fd.placeholder}
            value={form[fd.key] ?? ''}
            error={tried && fd.error ? fd.error : undefined}
            onChange={(e) => setForm({ ...form, [fd.key]: e.target.value })}
          />
        ))}
        {def.checks.length ? (
          <Fieldset id="f-checks">
            <Fieldset.Legend>{def.checkLegend}</Fieldset.Legend>
            {def.checks.map((o) => (
              <Checkbox
                key={o.value}
                label={o.label}
                description={o.desc}
                checked={checked.includes(o.value)}
                onChange={() =>
                  setForm({
                    ...form,
                    [def.checkKey]: checked.includes(o.value)
                      ? checked.filter((x) => x !== o.value)
                      : [...checked, o.value],
                  })
                }
              />
            ))}
          </Fieldset>
        ) : null}
        <div className="actions">
          <Button variant="primary" onClick={save}>
            {def.saveLabel}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
