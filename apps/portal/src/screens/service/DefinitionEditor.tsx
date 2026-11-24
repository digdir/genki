import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import { parse } from 'yaml';
import type { ApiClient } from '../../api';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ApiError } from '../../api/error';
import { EmptyState, ErrorState, Loading } from '../../states';
import type { PublishedDefinition } from '../../types';
import { definitionYaml, problemErrors } from './definition';
import { clock } from './dev-format';
import { draftChanged } from './draft-events';
import { servicePath } from './sections';
import './sections.css';

type Check =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'valid'; at: string }
  | { kind: 'invalid'; errors: { path: string; message: string }[] };

interface Props {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  onPublished?: (published: PublishedDefinition) => void;
}

const checkDelayMs = 600;

const jumpKeys: [string, RegExp][] = [
  ['metadata', /^metadata:/],
  ['spec.purpose', /^ {2}purpose:/],
  ['spec.model', /^ {2}model:/],
  ['spec.knowledge', /^ {2}knowledge:/],
  ['spec.guardrails', /^ {2}guardrails:/],
  ['spec.limits', /^ {2}limits:/],
];

export const jumpTargets = (text: string) => {
  const lines = text.split('\n');
  const specAt = lines.findIndex((l) => /^spec:/.test(l));
  return jumpKeys.flatMap(([label, pattern]) => {
    const line = lines.findIndex(
      (l, i) => pattern.test(l) && (label === 'metadata' || (specAt >= 0 && i > specAt)),
    );
    return line < 0 ? [] : [{ label, line }];
  });
};

const Errors = ({ errors }: { errors: { path: string; message: string }[] }) => {
  const t = useT();
  return (
    <Alert data-color="danger" data-size="sm">
      <Paragraph data-size="sm">{t('serviceEditor.invalid')}</Paragraph>
      <ul className="bullets">
        {errors.map((e) => (
          <li key={`${e.path}${e.message}`}>
            {e.path ? <code>{e.path}</code> : null}
            {e.path ? ': ' : ''}
            {e.message}
          </li>
        ))}
      </ul>
    </Alert>
  );
};

const Editor = ({
  api,
  tenant,
  serviceId,
  initial,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  initial: { text: string; files: Record<string, string>; revision: number };
}) => {
  const { t, f } = usePortalFormat();
  const [text, setText] = useState(initial.text);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const saved = useRef(initial.text);
  const revision = useRef(initial.revision);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = text.split('\n');

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      setCheck({ kind: 'busy' });
      void (async () => {
        try {
          const result = await api.validate(text, initial.files);
          if (stale) return;
          if (!result.valid) return setCheck({ kind: 'invalid', errors: result.errors });
          if (text !== saved.current) {
            const draft = await api.quality.saveDraft(
              tenant,
              serviceId,
              {
                definition: parse(text) as Record<string, unknown>,
                files: initial.files,
                revision: revision.current,
              },
              t('services.draftSavedReason'),
            );
            revision.current = draft.revision;
            saved.current = text;
            draftChanged(tenant, serviceId);
          }
          if (!stale) setCheck({ kind: 'valid', at: new Date().toISOString() });
        } catch (error) {
          if (!stale) setCheck({ kind: 'invalid', errors: problemErrors(error, t) });
        }
      })();
    }, checkDelayMs);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [text]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${serviceId}.yaml`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const jump = (line: number) => {
    const el = area.current;
    if (!el) return;
    const at = lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(at, at);
    const height = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.scrollTop = Math.max(0, line * height - height);
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  return (
    <div className="stack">
      <div className="dv-head">
        <div className="stack-xs">
          <Heading level={2} data-size="md">
            {t('service.sectionDefinition')}
          </Heading>
          <Paragraph className="meta dv-lead">{t('serviceDev.definitionLead')}</Paragraph>
        </div>
        <div className="row-wrap">
          <Button variant="secondary" onClick={download}>
            {t('serviceDev.download')}
          </Button>
          <Button variant="secondary" asChild>
            <label>
              {t('serviceDev.pasteFile')}
              <input
                type="file"
                accept=".yaml,.yml,text/yaml,application/yaml"
                className="visually-hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void file.text().then(setText);
                }}
              />
            </label>
          </Button>
        </div>
      </div>
      <div className="dv-yaml-status" aria-live="polite">
        <span className={`dv-dot dv-dot-${check.kind}`} aria-hidden="true" />
        <span>
          {check.kind === 'valid' ? (
            <>
              <strong>{t('serviceDev.yamlValid')}</strong>{' '}
              {t('serviceDev.yamlChecked', { time: clock(check.at, f) })}
            </>
          ) : check.kind === 'invalid' ? (
            <strong>{t('serviceDev.yamlInvalid')}</strong>
          ) : (
            t('serviceDev.yamlChecking')
          )}
        </span>
        <a href={`#${servicePath(serviceId, 'setup', '/publish')}`}>{t('serviceDev.seeChanges')}</a>
      </div>
      {check.kind === 'invalid' ? <Errors errors={check.errors} /> : null}
      <div className="dv-yaml">
        <div className="dv-yaml-editor">
          <div ref={gutter} className="dv-yaml-gutter" aria-hidden="true">
            {lines.map((_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <textarea
            ref={area}
            aria-label={t('serviceDev.yamlLabel')}
            spellCheck={false}
            wrap="off"
            value={text}
            onScroll={(e) => {
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <nav aria-label={t('serviceDev.jumpTo')} className="dv-jump">
          <span className="meta">{t('serviceDev.jumpTo')}</span>
          {jumpTargets(text).map((j) => (
            <a
              key={j.label}
              href={`#${servicePath(serviceId, 'definition')}`}
              onClick={(e) => {
                e.preventDefault();
                jump(j.line);
              }}
            >
              {j.label}
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
};

export const DefinitionEditor = ({ api, tenant, serviceId }: Props) => {
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) => {
      const [definition, draft] = await Promise.all([
        api.getDefinition(tenant, 'Service', serviceId, signal),
        api.quality.draft(tenant, serviceId, signal).catch(() => undefined),
      ]);
      return { latest: definition.latest, draft };
    },
    [api, tenant, serviceId],
  );
  if (state.status === 'loading')
    return <Loading label={t('serviceEditor.loading')} shape="form" onRetry={retry} />;
  if (state.status === 'error')
    return state.error instanceof ApiError && state.error.status === 404 ? (
      <EmptyState title={t('serviceDev.yamlEmptyTitle')}>
        <p className="body-sm">{t('serviceDev.yamlEmptyBody')}</p>
      </EmptyState>
    ) : (
      <ErrorState error={state.error} onRetry={retry} />
    );
  const { latest, draft } = state.data;
  return (
    <Editor
      api={api}
      tenant={tenant}
      serviceId={serviceId}
      initial={{
        text: definitionYaml(draft?.definition ?? latest.definition),
        files: draft?.files ?? latest.files ?? {},
        revision: draft?.revision ?? 0,
      }}
    />
  );
};
