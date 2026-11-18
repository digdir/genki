import {
  Button,
  Heading,
  Paragraph,
  Spinner,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { useT, type PlainKey, type T } from '../../i18n';
import { rightLabel, useRights, useUserName } from '../../Shell';
import {
  API_BASE,
  fillPath,
  methodColor,
  rights,
  standardErrors,
  type Endpoint,
  type Param,
  type ParamType,
} from '../../data/api-reference';

const J = (o: unknown) => JSON.stringify(o, null, 2);

const whereKeys = {
  path: 'apiref.wherePath',
  query: 'apiref.whereQuery',
  header: 'apiref.whereHeader',
  body: 'apiref.whereBody',
} as const satisfies Record<Param[1], PlainKey>;

const typeKeys = {
  text: 'apiref.typeText',
  integer: 'apiref.typeInteger',
  boolean: 'apiref.typeBoolean',
} as const satisfies Record<ParamType, PlainKey>;

export const curlFor = (ep: Endpoint, values: Record<string, string>, t: T, body?: unknown) => {
  const reasonHeader = ep.params.some((p) => p[0] === 'change-reason');
  return [
    `curl -X ${ep.method} "${API_BASE}${fillPath(ep.path, values)}" \\`,
    '  -H "Authorization: Bearer $TOKEN"' + (reasonHeader || body !== undefined ? ' \\' : ''),
    ...(reasonHeader
      ? [`  -H "change-reason: ${t('apiref.curlReason')}"` + (body !== undefined ? ' \\' : '')]
      : []),
    ...(body !== undefined
      ? ['  -H "Content-Type: application/json" \\', `  -d '${J(body)}'`]
      : []),
  ].join('\n');
};

const exampleValues = (tenant: string): Record<string, string> => ({
  tenant,
  id: 'ka',
  version: '7',
  name: 'ka__default',
  key: 'search.top_k',
  task: 'opg_7f2kq9d1',
  tool: 'ka__default',
});

interface TryResult {
  status: string;
  color: 'success' | 'danger' | 'warning';
  note: string;
  body: string;
}

const CodeBlock = ({ label, code }: { label: string; code: string }) => {
  const t = useT();
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{label}</span>
        <CopyButton text={code} ariaLabel={t('apiref.copy', { what: label.toLowerCase() })} />
      </div>
      <pre tabIndex={0} aria-label={label}>
        <code>{code}</code>
      </pre>
    </div>
  );
};

const failureOf = (error: unknown, t: T): TryResult => {
  if (!(error instanceof ApiError))
    return { status: t('apiref.tryNoAnswer'), color: 'danger', note: '', body: '' };
  return {
    status: `${error.status} ${error.problem?.title ?? ''}`.trim(),
    color: error.status === 403 || error.status === 401 ? 'warning' : 'danger',
    note: error.status === 403 ? t('apiref.tryRefused') : '',
    body: error.problem ? J(error.problem) : '',
  };
};

const TryPanel = ({
  ep,
  api,
  tenant,
  tenantName,
}: {
  ep: Endpoint;
  api: Pick<ApiClient, 'getJson'>;
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  const f = useFormat();
  const userName = useUserName();
  const { rights: held } = useRights();
  const heldText = held.length ? f.list(held.map((r) => rightLabel(t, r))) : t('apiref.heldNone');
  const pathParams = ep.params.filter((p) => p[1] === 'path');
  const defaults = exampleValues(tenant);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(pathParams.map((p) => [p[0], defaults[p[0]] ?? ''])),
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TryResult | undefined>();
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  if (ep.method !== 'GET')
    return (
      <section aria-labelledby="prov-h" className="ar-try">
        <Heading level={5} data-size="2xs" id="prov-h">
          {t('apiref.tryHeading')}
        </Heading>
        <Paragraph data-size="sm">{t('apiref.tryReadOnly')}</Paragraph>
      </section>
    );

  const send = async () => {
    if (sending) return;
    const missing = pathParams.find((p) => !(values[p[0]] ?? '').trim());
    if (missing) {
      setResult({
        status: t('apiref.invalidRequest'),
        color: 'danger',
        note: t('apiref.fillIn', { name: missing[0] ?? '' }),
        body: '',
      });
      return;
    }
    setSending(true);
    setResult(undefined);
    let next: TryResult;
    try {
      const body = await api.getJson(fillPath(ep.path, values));
      next = { status: '200 OK', color: 'success', note: '', body: J(body) };
    } catch (error) {
      next = failureOf(error, t);
    }
    if (!alive.current) return;
    setSending(false);
    setResult(next);
  };

  return (
    <section aria-labelledby="prov-h" className="ar-try">
      <Heading level={5} data-size="2xs" id="prov-h">
        {t('apiref.tryHeading')}
      </Heading>
      <Paragraph data-size="sm">
        {userName
          ? t.rich('apiref.tryAs', {
              name: userName,
              tenant: tenantName,
              held: heldText,
              strong: (c) => <strong>{c}</strong>,
            })
          : t('apiref.tryAnonymous', { tenant: tenantName, held: heldText })}
      </Paragraph>
      {pathParams.map((p) => (
        <Textfield
          key={p[0]}
          id={`try-${p[0]}`}
          className="ar-try-field"
          data-size="sm"
          label={p[0]}
          value={values[p[0]] ?? ''}
          onChange={(e) => setValues({ ...values, [p[0]]: e.target.value })}
        />
      ))}
      <div className="actions">
        <Button data-size="sm" aria-disabled={sending || undefined} onClick={() => void send()}>
          {t('apiref.send')}
        </Button>
        <span role="status" className="row-wrap">
          {sending ? (
            <>
              <Spinner aria-hidden data-size="xs" />
              {t('apiref.sending')}
            </>
          ) : null}
        </span>
      </div>
      {result ? (
        <div className="stack-sm">
          <div className="row-wrap">
            <Tag data-size="sm" data-color={result.color}>
              {result.status}
            </Tag>
          </div>
          {result.note ? <Paragraph data-size="sm">{result.note}</Paragraph> : null}
          {result.body ? (
            <pre tabIndex={0} aria-label={t('apiref.response')} className="code ar-try-res">
              <code>{result.body}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

export const EndpointDetail = ({
  ep,
  api,
  tenant,
  tenantName,
}: {
  ep: Endpoint;
  api: Pick<ApiClient, 'getJson'>;
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  const curl = curlFor(ep, exampleValues(tenant), t, ep.body);
  const blocks: [string, string][] = [
    ...(ep.body !== undefined
      ? ([[t('apiref.requestExample'), J(ep.body)]] as [string, string][])
      : []),
    [t('apiref.responseExample', { status: ep.status ?? 200 }), J(ep.response)],
    ['curl', curl],
  ];
  return (
    <article aria-labelledby="ep-h" className="ar-detail">
      <div className="stack-sm">
        <span className="meta">{t(`apiref.area.${ep.area}`)}</span>
        <Heading level={4} data-size="sm" id="ep-h">
          {t(ep.summary)}
        </Heading>
        <p className="api-line">
          <Tag data-size="sm" data-color={methodColor[ep.method]}>
            {ep.method}
          </Tag>
          <code className="ar-path">{ep.path}</code>
        </p>
        <Paragraph>{t(ep.desc)}</Paragraph>
        <span className="small">
          <strong>{t('apiref.requires')}</strong> {t(rights[ep.right])}
        </span>
      </div>
      {ep.params.length ? (
        <div tabIndex={0} role="region" aria-label={t('apiref.params')} className="table-scroll">
          <Table data-size="sm">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('apiref.colParameter')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colWhere')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colType')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('apiref.colDescription')}</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {ep.params.map(([n, w, type, d]) => (
                <Table.Row key={n}>
                  <Table.HeaderCell scope="row">
                    <code>{n}</code>
                  </Table.HeaderCell>
                  <Table.Cell>{t(whereKeys[w])}</Table.Cell>
                  <Table.Cell>{t(typeKeys[type])}</Table.Cell>
                  <Table.Cell>{t(d)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      ) : null}
      <div className="stack-sm">
        {blocks.map(([label, code]) => (
          <CodeBlock key={label} label={label} code={code} />
        ))}
      </div>
      <div className="stack-sm">
        <Heading level={5} data-size="2xs">
          {t('apiref.errors')}
        </Heading>
        <dl className="ar-errors">
          {[...(ep.errors ?? []), ...standardErrors].map(([title, text]) => (
            <div key={title}>
              <dt>{t(title)}</dt>
              <dd>{t(text)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <TryPanel key={ep.id} ep={ep} api={api} tenant={tenant} tenantName={tenantName} />
    </article>
  );
};
