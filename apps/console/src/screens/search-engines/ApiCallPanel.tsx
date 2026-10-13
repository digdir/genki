import { Button, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import { useT, type T } from '../../i18n';
import { SidePanel } from '../../ui';

const apiBase = (
  (import.meta.env.VITE_PUBLIC_API_BASE as string | undefined) ?? 'http://localhost:8080'
).replace(/\/+$/, '');

export interface ApiCall {
  title: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const methodColor = { GET: 'info', POST: 'success', PUT: 'warning' } as const;

const headersOf = (call: ApiCall, t: T) => {
  const { 'change-reason': reason, ...rest } = Object.fromEntries(
    Object.entries(call.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ...(reason !== undefined
      ? { 'change-reason': encodeURIComponent(reason) }
      : call.method !== 'GET'
        ? { 'change-reason': `<${t('searchEngines.curlReason')}>` }
        : {}),
    ...rest,
  };
};

export const curlOf = (call: ApiCall, t: T) =>
  [
    `curl -X ${call.method} "${apiBase}${call.path}"`,
    '  -H "Authorization: Bearer $TOKEN"',
    ...Object.entries(headersOf(call, t)).map(
      ([name, value]) => `  -H "${name}: ${value.replace(/"/g, '\\"')}"`,
    ),
    ...(call.body === undefined
      ? []
      : ['  -H "Content-Type: application/json"', `  -d '${JSON.stringify(call.body, null, 2)}'`]),
  ].join(' \\\n');

export const ApiCallPanel = ({ call, onClose }: { call: ApiCall; onClose: () => void }) => {
  const t = useT();
  const id = useId();
  const [copied, setCopied] = useState('');
  const curl = curlOf(call, t);
  return (
    <SidePanel labelledBy={id} onClose={onClose}>
      <div className="panel-head api-call-head">
        <span className="meta">{t('searchEngines.apiCallFor', { title: call.title })}</span>
        <Heading level={2} data-size="xs" id={id} tabIndex={-1} className="api-call-title">
          <Tag data-size="sm" data-color={methodColor[call.method]}>
            {call.method}
          </Tag>
          <span className="api-call-path">{call.path}</span>
        </Heading>
      </div>
      <div className="panel-body stack-sm">
        <Paragraph data-size="sm">{t('searchEngines.apiCallNote')}</Paragraph>
        <div className="api-call-code">
          <div className="api-call-code-head">
            <span>curl</span>
            <span className="api-call-copy">
              <span role="status">{copied}</span>
              <Button
                variant="secondary"
                data-size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(curl).catch(() => undefined);
                  setCopied(t('searchEngines.copied'));
                }}
              >
                {t('searchEngines.copy')}
              </Button>
            </span>
          </div>
          <pre tabIndex={0} aria-label={t('searchEngines.requestLabel')}>
            <code>{curl}</code>
          </pre>
        </div>
      </div>
    </SidePanel>
  );
};
