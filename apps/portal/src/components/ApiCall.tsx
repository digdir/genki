import { Alert, Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { useT } from '../i18n';
import { publicApiBase } from '../public-api';
import { CopyButton } from './CopyButton';
import { Icon, icons } from './Icon';
import { SidePanel } from './SidePanel';

export interface ApiCallPreview {
  action: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  needsReason?: boolean;
  right: string;
  endpoint?: string;
  notDecided?: { what: string; note?: string };
}

export type ApiCallWidth = 480 | 520;

const methodColor = {
  GET: 'info',
  POST: 'success',
  PUT: 'warning',
  PATCH: 'warning',
  DELETE: 'danger',
} as const;

export const reasonPlaceholder = '<begrunnelse>';

const headersFor = (call: ApiCallPreview) => {
  const { 'change-reason': reason, ...rest } = Object.fromEntries(
    Object.entries(call.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ...(reason !== undefined
      ? { 'change-reason': encodeURIComponent(reason) }
      : (call.needsReason ?? call.method !== 'GET')
        ? { 'change-reason': reasonPlaceholder }
        : {}),
    ...rest,
  };
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const curlFor = (call: ApiCallPreview) => {
  const lines = [
    `curl -X ${call.method} "${publicApiBase}${call.path}"`,
    '  -H "Authorization: Bearer $TOKEN"',
    ...Object.entries(headersFor(call)).map(
      ([name, value]) => `  -H ${shellQuote(`${name}: ${value}`)}`,
    ),
    ...(call.body === undefined
      ? []
      : ['  -H "Content-Type: application/json"', `  -d ${shellQuote(JSON.stringify(call.body))}`]),
  ];
  return lines.join(' \\\n');
};

export const ApiCallPanel = ({
  call,
  onClose,
  width = 480,
}: {
  call: ApiCallPreview;
  onClose: () => void;
  width?: ApiCallWidth | undefined;
}) => {
  const t = useT();
  const curl = curlFor(call);
  return (
    <SidePanel
      title={call.action}
      eyebrow={t('apiCall.eyebrow', { action: call.action })}
      onClose={onClose}
      width={width}
    >
      {call.notDecided ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            <Tag data-color="warning" data-size="sm">
              {t('components.notDecided')}
            </Tag>{' '}
            {t('apiCall.notDecidedFor', { what: call.notDecided.what })}{' '}
            {call.notDecided.note ?? t('apiCall.notDecidedNote')}
          </Paragraph>
        </Alert>
      ) : null}
      <Paragraph data-size="sm">{t('apiCall.intro')}</Paragraph>
      <p className="api-line">
        <Tag data-color={methodColor[call.method]} data-size="sm">
          {call.method}
        </Tag>
        <code>{call.path}</code>
      </p>
      <div className="code-block">
        <div className="code-block-head">
          <span>curl</span>
          <CopyButton text={curl} ariaLabel={t('apiCall.copyRequest')} />
        </div>
        <pre tabIndex={0} aria-label={t('apiCall.request')}>
          {curl}
        </pre>
      </div>
      <dl className="kv">
        <dt>{t('apiCall.rightRequired')}</dt>
        <dd>{call.right}</dd>
      </dl>
      <Paragraph data-size="sm">
        {t('apiCall.replaceToken')}
        {curl.includes(reasonPlaceholder)
          ? ` ${t('apiCall.replaceReason', { placeholder: reasonPlaceholder })}`
          : null}
      </Paragraph>
      {call.notDecided ? null : (
        <Link href={`#/api-reference${call.endpoint ? `?endpoint=${call.endpoint}` : ''}`}>
          {t('apiCall.seeEndpoint')}
        </Link>
      )}
    </SidePanel>
  );
};

export const ApiCallLink = ({ call, width }: { call: ApiCallPreview; width?: ApiCallWidth }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="api-call-link"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon d={icons.code} size={16} />
        {t('common.apiCall')}
      </button>
      {open ? <ApiCallPanel call={call} width={width} onClose={() => setOpen(false)} /> : null}
    </>
  );
};
